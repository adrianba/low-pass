import { beforeAll, describe, expect, it } from 'vitest';
import { byteLength, encodeMessage } from '../../shared/protocol/codec.js';
import { payload, snapshot, stampAt } from '../../shared/protocol/game.js';
import type { Payload, Snapshot } from '../../shared/protocol/game.js';
import type { WireMessage } from '../../shared/protocol/messages.js';
import { MAX_WIRE_BYTES } from '../../shared/protocol/limits.js';
import type { TerrainTheme } from '../../src/config/terrain.js';
import type { FormationPlan } from '../../src/game/formation/approved.js';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler.js';
import { HostSession } from '../../src/game/multiplayer/session.js';
import { authorCombatPlan } from '../../src/game/multiplayer/combat-plan.js';
import { STEP } from '../../src/config/game.js';
import type { SessionEvent } from '../../src/game/multiplayer/session.js';
import { formationData } from '../../src/network/formation-data.js';
import { createTransfer, TransferReceiver } from '../../src/network/transfer.js';
import type { CompletedTransfer } from '../../src/network/transfer.js';
import { sessionSnapshot } from '../../src/network/session-snapshot.js';
import { PlanPublication } from '../../src/network/plan-publication.js';
import { GuestReplica } from '../../src/network/replica.js';
import { FormationPlayback, ReplicaPlans } from '../../src/network/replica-plans.js';
import { base, versions } from './protocol-fixtures.js';
import { FaultNetwork } from '../helpers/fault-transport.js';

const terrains: TerrainTheme[] = ['green-valley', 'desert', 'river-canyon'];
const courses = new Map<TerrainTheme, { plans: FormationPlan[]; transfers: CompletedTransfer[] }>();
const manifest = (terrain: TerrainTheme) => ({ compatibility: versions, terrain, seed: 7,
  grid: terrain === 'river-canyon' ? 8 as const : 16 as const, triangle: 'shared-diagonal-v1' as const });
async function verified(data: Payload, id: string): Promise<CompletedTransfer> {
  const outgoing = await createTransfer(data, id);
  const receiver = new TransferReceiver(() => 0, { maxTransfers: 2, maxBytes: 32 * 1024 * 1024, ttlMs: 30_000 });
  receiver.offer(outgoing.offer);
  let complete: CompletedTransfer | null = null;
  for (const chunk of outgoing.chunks) complete = await receiver.accept(chunk);
  if (!complete) throw new Error('Missing verified transfer.');
  return complete;
}
beforeAll(async () => {
  for (const terrain of terrains) {
    const scheduler = new FormationScheduler(terrain, 7), plans: FormationPlan[] = [], transfers: CompletedTransfer[] = [];
    for (let sequence = 0; sequence < 3; sequence++) {
      const plan = scheduler.plan(); plans.push(plan);
      transfers.push(await verified({ kind: 'formation', data: formationData(plan, sequence) }, `${terrain}-${sequence}`));
      for (const slot of [0, 1] as const) { scheduler.advanceTo(plan.attempts[slot].releaseAt); scheduler.session.release(slot, sequence); }
      scheduler.advanceTo(plan.handoffAt); scheduler.session.drainEvents();
    }
    courses.set(terrain, { plans, transfers });
  }
}, 60_000);

function setup(terrain: TerrainTheme = 'green-valley') {
  const { plans, transfers } = courses.get(terrain)!;
  const session = new HostSession(plans[0]!); session.installPlan(1, plans[1]!);
  const publication = new PlanPublication(), replica = new GuestReplica(base.sessionId, 0, manifest(terrain));
  for (let sequence = 0; sequence < 2; sequence++) {
    publication.stage(sequence, transfers[sequence]!.reference);
    const ready = replica.installVerified(transfers[sequence]!); publication.acknowledge(ready.transfer);
  }
  const commit = publication.commit([0, 1]);
  replica.receive({ ...base, ...commit });
  const lastInputs: [number, number] = [0, 0];
  const take = (eventSequence = 0): Snapshot => snapshot.parse(JSON.parse(JSON.stringify(sessionSnapshot(session, {
    plans: publication.references, planRevision: publication.revision, eventSequence,
    coreEventId: session.lastEventId, lastInputs, effects: [],
  }))));
  const initial = take();
  replica.receive({ ...base, sequence: 2, type: 'snapshot', sampledAt: 0, state: initial });
  return { session, publication, replica, initial, plans, transfers, take, lastInputs };
}
function events(source: SessionEvent[], publication: PlanPublication, start = 0): Extract<WireMessage, { type: 'event' }>[] {
  return source.map((event, index) => {
    if (event.type !== 'released' && event.type !== 'resolved') throw new Error('Unexpected fixture completion.');
    return { ...base, sequence: start + index + 3, type: 'event', planRevision: publication.revision, eventSequence: start + index + 1,
      event: event.type === 'released' ? { action: 'released', slot: event.slot, sequence: event.sequence, inputSequence: 1,
        plan: publication.references.get(event.sequence)!, at: stampAt(event.time) } : { action: 'resolved', result: event.result } };
  });
}
function finishFirst(state: ReturnType<typeof setup>) {
  for (const slot of [0, 1] as const) {
    state.session.advanceTo(state.plans[0]!.attempts[slot].releaseAt); state.session.release(slot, 0);
    state.lastInputs[slot] = 1;
  }
  state.session.advanceTo(state.plans[0]!.handoffAt);
  return events(state.session.drainEvents(), state.publication);
}

describe('verified plan-driven replicas', () => {
  it('requires a verified new-epoch checkpoint while preserving the previous authoritative totals', async () => {
    const state = setup(), emitted = finishFirst(state), final = state.take(emitted.length);
    for (const event of emitted) state.replica.receive(event);
    state.replica.receive({ ...base, sequence: 30, type: 'snapshot', sampledAt: 20_000, state: final });
    const plans = state.replica.plans;
    state.replica.advanceEpoch(1);
    const paused: Snapshot = { ...final, status: 'paused' };
    state.replica.receive({ ...base, epoch: 1, sequence: 1, type: 'snapshot', sampledAt: 21_000, state: paused });
    expect(state.replica.presentationState).toBeNull();
    expect(state.replica.waitReason).toBe('initial_state');
    expect(state.replica.state).toEqual(final);
    const checkpoint = await verified({ kind: 'checkpoint', data: { version: 1, sessionId: base.sessionId,
      epoch: 1, snapshotSequence: 0, manifest: manifest('green-valley'), state: paused } }, 'paused-state');
    state.replica.installVerified(checkpoint);
    expect(state.replica.presentationState).toBeNull();
    state.replica.receive({ ...base, epoch: 1, sequence: 2, type: 'checkpoint-commit', checkpoint: checkpoint.reference,
      planRevision: paused.planRevision, eventSequence: paused.eventSequence, snapshotSequence: 0 });
    expect(state.replica.presentationState).toEqual(paused);
    expect(state.replica.plans).toBe(plans);
    expect(state.replica.watermarks).toEqual({ planRevision: paused.planRevision, eventSequence: paused.eventSequence, snapshotSequence: 1 });
  });

  it('rejects a score reset inside an otherwise valid new-epoch checkpoint', async () => {
    const state = setup(), emitted = finishFirst(state), final = state.take(emitted.length);
    for (const event of emitted) state.replica.receive(event);
    state.replica.receive({ ...base, sequence: 30, type: 'snapshot', sampledAt: 20_000, state: final });
    state.replica.advanceEpoch(1);
    const reset = structuredClone(final);
    reset.status = 'paused'; reset.results = []; reset.wrecks = [];
    reset.players[0].score = 0; reset.players[0].lastResolved = null;
    const checkpoint = await verified({ kind: 'checkpoint', data: { version: 1, sessionId: base.sessionId,
      epoch: 1, snapshotSequence: 0, manifest: manifest('green-valley'), state: reset } }, 'invalid-reset');
    state.replica.installVerified(checkpoint);
    expect(() => state.replica.receive({ ...base, epoch: 1, sequence: 1, type: 'checkpoint-commit', checkpoint: checkpoint.reference,
      planRevision: reset.planRevision, eventSequence: reset.eventSequence, snapshotSequence: 0 })).toThrow('regression');
    expect(state.replica.state).toEqual(final);
    expect(state.replica.presentationState).toBeNull();
  });

  it.each(terrains)('reconstructs exact %s motion and camera data without running encounter selection', terrain => {
    const { plans, transfers } = courses.get(terrain)!;
    for (let index = 0; index < plans.length; index++) {
      const plan = plans[index]!, transfer = transfers[index]!;
      if (transfer.payload.kind !== 'formation') throw new Error('Expected formation.');
      const copy = structuredClone(transfer.payload.data), playback = new FormationPlayback(copy);
      copy.target.x += 100; copy.attempts[0].track.knots[0]!.pose.position.x += 100;
      for (const slot of [0, 1] as const) for (const time of [plan.startAt, plan.attempts[slot].releaseAt + 0.00037, plan.handoffAt]) {
        expect(playback.pose(slot, time)).toEqual(plan.attempts[slot].track.at(time - plan.attempts[slot].releaseAt));
        expect(playback.view(slot, time)).toEqual(plan.attempts[slot].camera.at(time - plan.attempts[slot].releaseAt));
      }
      expect(playback.toData().target).toEqual(plan.target);
      expect(() => playback.pose(0, plan.coverageEndAt + 1)).toThrow('coverage');
    }
  });

  it('holds a cross-channel snapshot, orders reliable events, converges, and cannot replay scores', () => {
    const state = setup('river-canyon'), emitted = finishFirst(state), final = state.take(emitted.length);
    state.replica.receive({ ...base, sequence: 30, type: 'snapshot', sampledAt: 20_000, state: final });
    expect(state.replica.waitReason).toBe('missing_event');
    expect(state.replica.state).toEqual(state.initial);
    for (const event of [...emitted].reverse()) state.replica.receive(event);
    expect(state.replica.state).toEqual(final);
    for (const event of emitted) state.replica.receive(event);
    state.replica.receive({ ...base, sequence: 2, type: 'snapshot', sampledAt: 0, state: state.initial });
    expect(state.replica.state).toEqual(final); expect(state.replica.waitReason).toBeNull();
    expect(state.replica.pendingCount).toBe(0);
    const copy = state.replica.state!; copy.players[0].score = 0;
    expect(state.replica.state!.players[0].score).toBe(100);
    expect(byteLength(encodeMessage({ ...base, type: 'snapshot', sampledAt: 20_000, state: final }))).toBeLessThan(MAX_WIRE_BYTES);
  });

  it('replicates an active bomb with its exact canonical integration step, not a guessed snapshot-relative phase', () => {
    const state = setup('river-canyon'), at = state.plans[0]!.attempts[0].releaseAt;
    state.session.advanceTo(at); state.session.release(0, 0); state.lastInputs[0] = 1;
    const emitted = events(state.session.drainEvents(), state.publication);
    for (const event of emitted) state.replica.receive(event);
    expect(state.replica.state!.players[0].bomb).not.toBeNull();
    expect(state.replica.presentationState).toEqual(state.initial);
    state.session.advanceTo(at + 10 * STEP + 0.003);
    const active = state.take(emitted.length);
    expect(active.players[0].bomb?.steps).toBe(10);
    state.replica.receive({ ...base, sequence: 20, type: 'snapshot', sampledAt: 5000, state: active });
    expect(state.replica.state).toEqual(active);
    expect(state.replica.presentationState).toEqual(active);
    expect(state.replica.state!.players[0].bomb!.position).toEqual(state.session.snapshot().players[0]!.bomb!.value.position);
  });

  it('requires exact plan acknowledgements, permits future preparation, and retires only a committed old plan', () => {
    const state = setup(), publication = state.publication;
    const pending = state.transfers[2]!;
    state.session.installPlan(2, state.plans[2]!);
    publication.stage(2, pending.reference);
    expect(() => publication.commit([0, 1, 2])).toThrow('verified');
    expect(() => publication.acknowledge({ ...pending.reference, digest: 'b'.repeat(64) })).toThrow('acknowledgement');
    expect(state.take().plans).toHaveLength(2);
    const ready = state.replica.installVerified(pending); publication.acknowledge(ready.transfer);
    const commit = publication.commit([2, 0, 1]);
    expect(commit.planRevision).toBe(1); expect(publication.commit([0, 1, 2]).planRevision).toBe(1);
    state.replica.receive({ ...base, sequence: 3, ...commit });
    const emitted = finishFirst(state).map(event => ({ ...event, sequence: event.sequence + 1 }));
    for (const event of emitted) state.replica.receive(event);
    state.session.advanceTo(state.plans[1]!.startAt + 5.5); state.session.retireReadyPlans();
    const retired = publication.commit([1, 2]);
    state.replica.receive({ ...base, sequence: 20, ...retired });
    const final = state.take(emitted.length);
    state.replica.receive({ ...base, sequence: 21, type: 'snapshot', sampledAt: 30_000, state: final });
    expect(state.replica.state).toEqual(final);
    expect(state.replica.plans.count).toBe(3);
    expect(state.replica.presentationAt(0)).toEqual(state.initial);
    for (let index = 0; index < 32; index++) {
      state.session.advanceTo(state.session.time + 0.01);
      state.replica.receive({ ...base, sequence: 22 + index, type: 'snapshot', sampledAt: 30_001 + index, state: state.take(emitted.length) });
    }
    expect(state.replica.plans.count).toBe(2);
    expect(state.replica.plans.at(state.session.time).sequence).toBe(1);
    expect(() => state.replica.plans.at(0)).toThrow('coverage');
  });

  it('applies a verified checkpoint over a missing initial snapshot and does not resurrect an eliminated player', async () => {
    const state = setup(), emitted = finishFirst(state), final = state.take(emitted.length);
    const fresh = new GuestReplica(base.sessionId, 0, manifest('green-valley'));
    for (const transfer of state.transfers.slice(0, 2)) fresh.installVerified(transfer);
    fresh.receive({ ...base, ...state.publication.commit([0, 1]) });
    fresh.receive(emitted.at(-1)!);
    expect(fresh.waitReason).toBe('initial_state');
    const checkpoint = await verified({ kind: 'checkpoint', data: { version: 1, sessionId: base.sessionId, epoch: 0,
      snapshotSequence: 30, manifest: manifest('green-valley'), state: final } }, 'checkpoint-1');
    fresh.installVerified(checkpoint);
    fresh.receive({ ...base, sequence: 31, type: 'checkpoint-commit', checkpoint: checkpoint.reference,
      planRevision: final.planRevision, eventSequence: final.eventSequence, snapshotSequence: 30 });
    expect(fresh.state).toEqual(final); expect(fresh.waitReason).toBeNull();
    expect(fresh.clockAnchor).toBeNull();
    const dying = setup();
    dying.session.installPlan(2, dying.plans[2]!); dying.publication.stage(2, dying.transfers[2]!.reference);
    dying.publication.acknowledge(dying.replica.installVerified(dying.transfers[2]!).transfer);
    dying.replica.receive({ ...base, sequence: 3, ...dying.publication.commit([0, 1, 2]) });
    for (const plan of dying.plans) dying.session.advanceTo(plan.handoffAt);
    const dead = dying.take(dying.session.lastEventId);
    const restored = await verified({ kind: 'checkpoint', data: { version: 1, sessionId: base.sessionId, epoch: 0,
      snapshotSequence: 40, manifest: manifest('green-valley'), state: dead } }, 'checkpoint-2');
    dying.replica.installVerified(restored);
    dying.replica.receive({ ...base, sequence: 41, type: 'checkpoint-commit', checkpoint: restored.reference,
      planRevision: dead.planRevision, eventSequence: dead.eventSequence, snapshotSequence: 40 });
    const before = dying.replica.watermarks, revived = structuredClone(dead);
    revived.status = 'running'; revived.winner = null;
    revived.players[0].misses = 2; revived.players[0].eliminated = false; revived.players[0].lastResolved = 1;
    revived.results = revived.results.filter(result => result.slot !== 0 || result.sequence < 2);
    expect(() => dying.replica.receive({ ...base, sequence: 42, type: 'snapshot', sampledAt: 30_000, state: revived })).toThrow('regression');
    expect(dying.replica.state).toEqual(dead); expect(dying.replica.watermarks).toEqual(before);
  });

  it('holds combat-dependent events and keeps presentation data until complete snapshots retire it', async () => {
    const state = setup(), plan = state.plans[0]!;
    state.session.advanceTo(plan.attempts[0].cutoffAt + STEP * 2);
    const core = state.session.drainEvents();
    const resolved = core.find(event => event.type === 'resolved');
    if (!resolved || resolved.type !== 'resolved') throw new Error('Expected missed attempt.');
    const combat = authorCombatPlan(resolved.result, plan, 7, undefined, undefined, state.plans[1]);
    if (!combat) throw new Error('Expected damage missile.');
    const transfer = await verified(payload.parse({ kind: 'combat', data: combat }), 'damage-0');
    const resultEvent = events([resolved], state.publication)[0]!;
    state.replica.receive(resultEvent);
    const effectEvent: Extract<WireMessage, { type: 'event' }> = { ...base, sequence: 4,
      type: 'event', eventSequence: 2, planRevision: 0,
      event: { action: 'combat', slot: 0, effect: transfer.reference, at: stampAt(combat.bornAt) } };
    state.replica.receive(effectEvent);
    expect(state.replica.waitReason).toBe('missing_plan');
    expect(state.replica.presentationState).toEqual(state.initial);
    const complete = state.take(2);
    complete.effects = [{ ...transfer.reference, bornAt: combat.bornAt }];
    state.replica.receive({ ...base, sequence: 5, type: 'snapshot', sampledAt: 10_000, state: complete });
    state.replica.installVerified(transfer);
    expect(state.replica.waitReason).toBeNull();
    expect(state.replica.presentationState).toEqual(complete);
    expect(state.replica.presentationAt(0)).toEqual(state.initial);
    const returned = state.replica.presentationAt(state.session.time);
    returned.effects.length = 0;
    expect(state.replica.presentationState!.effects).toHaveLength(1);

    const without = structuredClone(complete);
    without.effects = [];
    without.at = stampAt(state.session.time + 3);
    state.replica.receive({ ...base, sequence: 6, type: 'snapshot', sampledAt: 13_000, state: without });
    expect(state.replica.plans.has(transfer.reference)).toBe(true);
    for (let index = 0; index < 32; index++) state.replica.receive({ ...base, sequence: index + 7,
      type: 'snapshot', sampledAt: 13_010 + index * 10, state: { ...without, at: stampAt(state.session.time + 3.01 + index * 0.01) } });
    expect(state.replica.plans.has(transfer.reference)).toBe(false);
    expect(() => state.replica.presentationAt(0)).toThrow('plan');
  });

  it('rejects discontinuous commits without retiring the existing playable course', () => {
    const state = setup(), before = state.replica.watermarks;
    state.replica.installVerified(state.transfers[2]!);
    expect(() => state.replica.receive({ ...base, sequence: 3, type: 'plan-commit', planRevision: 1,
      plans: [state.transfers[0]!.reference, state.transfers[2]!.reference] })).toThrow('Discontinuous');
    expect(state.replica.watermarks).toEqual(before);
    expect(state.replica.plans.references()).toEqual(state.initial.plans);
    expect(state.replica.presentationState).toEqual(state.initial);
  });

  it('bounds missing-event queues and verified-plan staging without silently discarding reliable outcomes', () => {
    const state = setup(), emitted = finishFirst(state), future = emitted.at(-1)!;
    for (let index = 0; index < 64; index++) state.replica.receive({ ...future, sequence: index + 100, eventSequence: index + 100 });
    expect(state.replica.pendingCount).toBe(64);
    expect(() => state.replica.receive({ ...future, sequence: 200, eventSequence: 200 })).toThrow('capacity');
    const store = new ReplicaPlans(), transfer = state.transfers[0]!;
    for (let index = 0; index < 6; index++) store.installVerified({ ...transfer, reference: { ...transfer.reference, id: `copy-${index}` } });
    expect(() => store.installVerified({ ...transfer, reference: { ...transfer.reference, id: 'overflow' } })).toThrow('budget');
    expect(() => state.take(-1)).toThrow();
    state.session.advanceTo(state.session.time + 0.1);
    expect(() => sessionSnapshot(state.session, { planRevision: 0, eventSequence: 0, coreEventId: 0,
      plans: state.publication.references, effects: [], lastInputs: [0, 0] })).toThrow('core events');
  });

  it.each([10, 20, 30])('converges at %i experimental snapshots/sec under jitter, loss, replay and clock skew', rate => {
    const state = setup('desert'), emitted = finishFirst(state), final = state.take(emitted.length);
    const network = new FaultNetwork({ seed: rate, sessionId: base.sessionId, epoch: 0,
      maxPackets: 128, maxBufferedBytes: 128 * 1024, maxInbox: 256,
      clocks: { host: { offsetMs: 1000, driftPpm: 100 }, guest: { offsetMs: -3000, driftPpm: -100 } } });
    network.setFaults('control', { latencyMs: 80, jitterMs: 60, loss: 0.15, duplicate: 0.3, retryMs: 30 });
    network.setFaults('state', { latencyMs: 20, jitterMs: 20, loss: 0.4, duplicate: 0.5 });
    for (const event of emitted) network.peers.host.send(event);
    for (let time = 0, sequence = 100; time <= 1000; time += 1000 / rate) {
      network.advanceTo(time);
      network.peers.host.send({ ...base, sequence: sequence++, type: 'snapshot', sampledAt: time + 1000, state: final });
      network.advanceTo(time);
      for (const event of network.peers.guest.drain()) if (event.type === 'message' &&
        (event.message.type === 'snapshot' || event.message.type === 'event')) state.replica.receive(event.message);
      expect(state.replica.pendingCount).toBeLessThanOrEqual(5);
    }
    network.advanceTo(2000);
    for (const event of network.peers.guest.drain()) if (event.type === 'message' &&
      (event.message.type === 'snapshot' || event.message.type === 'event')) state.replica.receive(event.message);
    expect(state.replica.state).toEqual(final); expect(state.replica.waitReason).toBeNull();
    expect(network.pendingPackets).toBe(0);
  });
});
