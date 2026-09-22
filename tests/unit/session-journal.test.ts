import { beforeAll, describe, expect, it } from 'vitest';
import { snapshot, stampAt } from '../../shared/protocol/game.js';
import type { Payload } from '../../shared/protocol/game.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import type { TerrainTheme } from '../../src/config/terrain.js';
import { STEP } from '../../src/config/game.js';
import type { FormationPlan } from '../../src/game/formation/approved.js';
import { authorCombatPlan } from '../../src/game/multiplayer/combat-plan.js';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler.js';
import { HostSession } from '../../src/game/multiplayer/session.js';
import type { SessionEvent } from '../../src/game/multiplayer/session.js';
import { combatTransferData } from '../../src/network/combat-data.js';
import { formationData } from '../../src/network/formation-data.js';
import { PlanPublication } from '../../src/network/plan-publication.js';
import { GuestReplica } from '../../src/network/replica.js';
import { RELEASE_GRACE_SECONDS, releaseIntent } from '../../src/network/release-authority.js';
import { SessionJournal } from '../../src/network/session-journal.js';
import { createTransfer, TransferReceiver } from '../../src/network/transfer.js';
import type { CompletedTransfer } from '../../src/network/transfer.js';
import { base, versions } from './protocol-fixtures.js';
import { FaultNetwork } from '../helpers/fault-transport.js';

const courses = new Map<TerrainTheme, { plans: FormationPlan[]; transfers: CompletedTransfer[] }>();
async function verify(value: Payload, id: string) {
  const outgoing = await createTransfer(value, id);
  const receiver = new TransferReceiver(() => 0, { maxTransfers: 2, maxBytes: 32 * 1024 * 1024, ttlMs: 30_000 });
  receiver.offer(outgoing.offer);
  let complete: CompletedTransfer | null = null;
  for (const chunk of outgoing.chunks) complete = await receiver.accept(chunk);
  if (!complete) throw new Error('Missing journal test payload.');
  return complete;
}
beforeAll(async () => {
  for (const terrain of ['green-valley', 'desert', 'river-canyon'] as const) {
    const scheduler = new FormationScheduler(terrain, 7), plans: FormationPlan[] = [], transfers: CompletedTransfer[] = [];
    for (let sequence = 0; sequence < 3; sequence++) {
      const plan = scheduler.plan(); plans.push(plan);
      transfers.push(await verify({ kind: 'formation', data: formationData(plan, sequence) }, `flight-${sequence}`));
      for (const slot of [0, 1] as const) {
        scheduler.advanceTo(plan.attempts[slot].releaseAt); scheduler.session.release(slot, sequence);
      }
      scheduler.advanceTo(plan.handoffAt); scheduler.session.drainEvents();
    }
    courses.set(terrain, { plans, transfers });
  }
}, 60_000);

function setup(terrain: TerrainTheme = 'green-valley') {
  const { plans, transfers } = courses.get(terrain)!;
  const session = new HostSession(plans[0]!, { releaseGraceSeconds: RELEASE_GRACE_SECONDS });
  session.installPlan(1, plans[1]!);
  const publication = new PlanPublication(), replica = new GuestReplica(base.sessionId, 0, {
    compatibility: versions, terrain, seed: 7, grid: terrain === 'river-canyon' ? 8 : 16, triangle: 'shared-diagonal-v1',
  });
  for (let index = 0; index < 2; index++) {
    publication.stage(index, transfers[index]!.reference);
    publication.acknowledge(replica.installVerified(transfers[index]!).transfer);
  }
  let sequence = 1;
  const sent: WireMessage[] = [];
  const send = (body: MessageBody) => {
    const message = { ...base, sequence: sequence++, ...body };
    sent.push(message);
    if (message.type === 'event' || message.type === 'snapshot' || message.type === 'plan-commit') replica.receive(message);
    return { ok: true as const };
  };
  send(publication.commit([0, 1]));
  const journal = new SessionJournal(session, base.sessionId, 0, () => session.time * 1000, publication);
  send(journal.snapshot(0));
  const command = (slot: 0 | 1, inputSequence = 1): Extract<WireMessage, { type: 'command' }> => ({
    ...base, sender: slot === 0 ? 'host' : 'guest', type: 'command', slot, inputSequence,
    command: releaseIntent(0, transfers[0]!.reference, plans[0]!.attempts[slot].releaseAt),
  });
  const prepare = async (events: SessionEvent[], acknowledge = true) => {
    const staged: CompletedTransfer[] = [];
    for (const event of events) if (event.type === 'resolved') {
      const current = [...plans].reverse().find(plan => plan.startAt <= event.result.time && event.result.time <= plan.handoffAt)!;
      const attempt = current.attempts[event.result.slot], next = plans.find(plan => plan.startAt === current.handoffAt);
      const data = authorCombatPlan(event.result, current, 7,
        { ...attempt.camera.at(event.result.time - attempt.releaseAt), aspect: 1.15, range: 2500 }, undefined, next);
      if (!data) { journal.prepareOutcome(event.eventId, null); continue; }
      const sources = transfers.map(transfer => {
        if (transfer.payload.kind !== 'formation') throw new Error('Expected flight.');
        return { reference: transfer.reference, data: transfer.payload.data };
      });
      const transfer = await verify({ kind: 'combat', data: combatTransferData(data, sources) }, `effect-${data.id}`);
      journal.prepareOutcome(event.eventId, { reference: transfer.reference, data });
      staged.push(transfer);
      if (acknowledge) journal.acknowledgeEffect(replica.installVerified(transfer).transfer);
    }
    return staged;
  };
  return { session, publication, replica, journal, plans, transfers, command, send, sent, prepare };
}

describe('authoritative publication journal', () => {
  it.each(['green-valley', 'desert', 'river-canyon'] as const)('maps %s releases to actual wire events after combat inserts extra events', async terrain => {
    const state = setup(terrain), plan = state.plans[0]!;
    state.session.advanceTo(plan.attempts[0].acquireAt);
    expect(state.journal.receiveRelease('host', { ...state.command(0),
      command: releaseIntent(0, state.transfers[0]!.reference, state.session.time) }).accepted).toBe(true);
    state.session.advanceTo(plan.attempts[1].releaseAt + 0.2);
    await state.prepare(state.journal.collect());
    expect(state.journal.flush(state.send).blocked).toBeNull();
    expect(state.journal.eventSequence).toBeGreaterThan(state.journal.coreEventId);
    const wireBefore = state.journal.eventSequence, coreBefore = state.session.lastEventId;
    const command = state.command(1);
    state.session.advanceTo(Math.max(state.session.time, plan.attempts[1].releaseAt + 0.2));
    const decision = state.journal.receiveRelease('guest', command);
    expect(decision).toEqual({ accepted: true, releaseEventId: coreBefore + 1 });
    state.journal.collect();
    expect(() => state.journal.snapshot(100)).toThrow('complete');
    const before = state.journal.eventSequence;
    expect(state.journal.flush(() => ({ ok: false, reason: 'backpressure' }))).toEqual({ sent: 0, blocked: 'backpressure' });
    expect(state.journal.eventSequence).toBe(before);
    state.journal.flush(state.send);
    const acknowledgement = [...state.sent].reverse().find(message => message.type === 'ack');
    expect(acknowledgement).toMatchObject({ decision: { accepted: true, eventSequence: wireBefore + 1 } });
    expect(wireBefore + 1).not.toBe(coreBefore + 1);
    expect(state.journal.receiveRelease('guest', command)).toEqual(decision);
    state.journal.flush(state.send);
    expect(state.sent.filter(message => message.type === 'event' && message.event.action === 'released')).toHaveLength(2);
    state.session.advanceTo(plan.handoffAt);
    await state.prepare(state.journal.collect()); state.journal.flush(state.send);
    const complete = state.journal.snapshot(20_000); state.send(complete);
    expect(state.replica.state).toEqual(snapshot.parse(JSON.parse(JSON.stringify(complete.state))));
    expect(state.replica.state!.players.map(player => player.score)).toEqual([0, 100]);
  });

  it('retains accepted input metadata beyond rejected-command floods, without contradictory retry decisions', () => {
    const state = setup(), command = state.command(0);
    state.session.advanceTo(state.plans[0]!.attempts[0].releaseAt);
    const accepted = state.journal.receiveRelease('host', command);
    expect(accepted.accepted).toBe(true);
    for (let input = 2; input < 90; input++) {
      expect(state.journal.receiveRelease('host', state.command(0, input)).accepted).toBe(false);
      state.journal.flush(state.send);
    }
    expect(state.journal.receiveRelease('host', command)).toEqual(accepted);
    expect(() => state.journal.receiveRelease('guest', command)).toThrow('role');
    state.journal.collect(); state.journal.flush(state.send);
    expect(state.sent.filter(message => message.type === 'event')).toHaveLength(1);
    expect([...state.sent].reverse().find(message => message.type === 'ack')).toMatchObject({
      inputSequence: 1, decision: { accepted: true, eventSequence: 1 },
    });
    const conflicting = { ...command, command: { ...releaseIntent(0, state.transfers[0]!.reference, state.session.time + 0.001) } };
    expect(state.journal.receiveRelease('host', conflicting)).toEqual({ accepted: false, reason: 'duplicate' });
  });

  it('gates entire outcome groups on verified effects and never snapshots a partially sent group', async () => {
    const state = setup(), initial = state.replica.presentationState;
    state.session.advanceTo(state.plans[0]!.attempts[0].cutoffAt + RELEASE_GRACE_SECONDS + STEP * 2);
    const events = state.journal.collect(), staged = await state.prepare(events, false);
    expect(staged).toHaveLength(1);
    expect(state.journal.flush(state.send)).toEqual({ sent: 0, blocked: 'outcome' });
    expect(state.journal.coreEventId).toBe(0);
    expect(() => state.journal.acknowledgeEffect({ ...staged[0]!.reference, digest: 'b'.repeat(64) })).toThrow('acknowledgement');
    state.journal.acknowledgeEffect(state.replica.installVerified(staged[0]!).transfer);
    expect(state.journal.flush(state.send, 1)).toEqual({ sent: 1, blocked: 'budget' });
    expect(state.journal.coreEventId).toBe(0);
    expect(state.replica.state!.players[0].misses).toBe(1);
    expect(state.replica.presentationState).toEqual(initial);
    expect(() => state.journal.snapshot(10_000)).toThrow('complete');
    state.journal.flush(state.send);
    expect(state.journal.coreEventId).toBe(events.at(-1)!.eventId);
    state.send(state.journal.snapshot(10_000));
    expect(state.replica.presentationState!.effects).toHaveLength(1);
  });

  it('publishes both destruction timelines and finality without resuming the ended session', async () => {
    const state = setup('river-canyon');
    state.session.installPlan(2, state.plans[2]!);
    state.publication.stage(2, state.transfers[2]!.reference);
    state.publication.acknowledge(state.replica.installVerified(state.transfers[2]!).transfer);
    state.send(state.publication.commit([0, 1, 2])); state.journal.authorizePlans();
    for (const plan of state.plans) {
      state.session.advanceTo(plan.handoffAt);
      await state.prepare(state.journal.collect());
      while (state.journal.pendingCount) expect(state.journal.flush(state.send).blocked).not.toBe('outcome');
      state.send(state.journal.snapshot(state.session.time * 1000));
    }
    const final = state.replica.presentationState!;
    expect(final.status).toBe('over'); expect(final.winner).toBe('draw');
    expect(final.players.map(player => player.misses)).toEqual([3, 3]);
    expect(final.effects).toHaveLength(2);
    for (const effect of final.effects) expect(state.replica.plans.combat(effect).missile.kind).toBe('finale');
    expect(state.sent.filter(message => message.type === 'event' && message.event.action === 'eliminated')).toHaveLength(2);
    expect(state.sent.filter(message => message.type === 'event' && message.event.action === 'ended')).toHaveLength(1);
    expect(state.session.status).toBe('over'); expect(state.journal.canSnapshot).toBe(true);
    expect(final.at).toEqual(stampAt(state.session.time));
  });

  it('bounds acknowledgements before accepting more input and detects a competing event consumer', () => {
    const state = setup();
    for (let input = 1; input <= 64; input++) state.journal.receiveRelease('guest', state.command(1, input));
    const before = state.journal.authority.lastInputs;
    expect(() => state.journal.receiveRelease('guest', state.command(1, 65))).toThrow('budget');
    expect(state.journal.authority.lastInputs).toEqual(before);
    expect(state.journal.pendingCount).toBe(64);
    state.session.advanceTo(state.plans[0]!.attempts[0].cutoffAt + RELEASE_GRACE_SECONDS + STEP);
    state.session.drainEvents();
    expect(() => state.journal.collect()).toThrow('Only the publication');
  });

  it('converges under reliable retries, duplicate input, state loss and bounded backpressure', async () => {
    const state = setup('river-canyon'), plan = state.plans[0]!;
    const network = new FaultNetwork({ seed: 73, sessionId: base.sessionId, epoch: 0,
      maxPackets: 128, maxBufferedBytes: 64 * 1024, maxInbox: 256 });
    network.setFaults('control', { latencyMs: 40, jitterMs: 30, loss: 0.2, duplicate: 0.5, retryMs: 30 });
    network.setFaults('state', { latencyMs: 5, jitterMs: 5, loss: 0.3, duplicate: 0.3 });
    let wireSequence = 100;
    const received: WireMessage[] = [];
    const send = (body: MessageBody) => {
      const result = network.peers.host.send({ ...base, sequence: wireSequence, ...body });
      if (result.ok) wireSequence++;
      return result;
    };
    state.session.advanceTo(plan.attempts[0].acquireAt);
    state.journal.receiveRelease('host', { ...state.command(0),
      command: releaseIntent(0, state.transfers[0]!.reference, state.session.time) });
    const start = plan.attempts[1].releaseAt;
    state.session.advanceTo(start);
    expect(network.peers.guest.send(state.command(1)).ok).toBe(true);
    const drain = () => {
      for (const event of network.peers.host.drain()) {
        if (event.type !== 'message' || event.message.type !== 'command') throw new Error('Unexpected host fault traffic.');
        expect(state.journal.receiveRelease('guest', event.message).accepted).toBe(true);
      }
      for (const event of network.peers.guest.drain()) {
        if (event.type !== 'message') throw new Error('Unexpected guest fault traffic.');
        received.push(event.message);
        if (event.message.type === 'event' || event.message.type === 'snapshot') state.replica.receive(event.message);
      }
    };
    for (let time = 0; time <= 750; time += 10) {
      network.advanceTo(time); state.session.advanceTo(start + time / 1000); drain();
      await state.prepare(state.journal.collect());
      state.journal.flush(send);
      if (state.journal.canSnapshot) send(state.journal.snapshot(time));
    }
    state.session.advanceTo(plan.handoffAt); await state.prepare(state.journal.collect());
    network.setFaults('state', { latencyMs: 5, loss: 0 });
    let finalSent = false;
    for (let step = 0; step < 200; step++) {
      network.advanceTo(network.time + 25); drain(); state.journal.flush(send);
      if (!finalSent && state.journal.canSnapshot) finalSent = send(state.journal.snapshot(network.time)).ok;
      if (finalSent && !network.pendingPackets && !state.journal.pendingCount) break;
    }
    expect(network.pendingPackets).toBe(0); expect(state.replica.waitReason).toBeNull();
    expect(state.replica.state!.players.map(player => player.score)).toEqual([0, 100]);
    const acknowledgements = received.filter(message => message.type === 'ack').filter(message => message.slot === 1);
    expect(acknowledgements.length).toBeGreaterThan(0);
    expect(new Set(acknowledgements.map(message => JSON.stringify(message.decision))).size).toBe(1);
    expect(state.journal.coreEventId).toBe(state.session.lastEventId);
    expect(network.stats.duplicated).toBeGreaterThan(0);
  });
});
