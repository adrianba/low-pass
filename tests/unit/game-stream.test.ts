import { describe, expect, it } from 'vitest';
import { secondsAt } from '../../shared/protocol/game.js';
import type { WireMessage } from '../../shared/protocol/messages.js';
import { byteLength, encodeMessage } from '../../shared/protocol/codec.js';
import { HostGame } from '../../src/network/host-game.js';
import { GuestGame } from '../../src/network/guest-game.js';
import { prepareHostCourse } from '../../src/network/prepared-course.js';
import { TransferReceiver } from '../../src/network/transfer.js';
import type { CompletedTransfer } from '../../src/network/transfer.js';
import { base, versions } from './protocol-fixtures.js';
import type { TerrainTheme } from '../../src/config/terrain.js';

async function setup(terrain: TerrainTheme = 'green-valley', sampledAt?: (time: number) => number) {
  const prepared = await prepareHostCourse(terrain, 7, 0);
  const verified: CompletedTransfer[] = [];
  const receiver = new TransferReceiver(() => 0, { maxTransfers: 2, maxBytes: 32 * 1024 * 1024, ttlMs: 30_000 });
  for (const transfer of prepared.transfers) {
    receiver.offer(transfer.offer);
    for (const chunk of transfer.chunks) {
      const complete = await receiver.accept(chunk);
      if (complete) verified.push(complete);
    }
  }
  let wall = 0, wire = 0, input = 0, budget = Infinity, blocked = false, holdAcks = false, dropSnapshots = false;
  let lost: (message: WireMessage) => boolean = () => false;
  const outgoing: WireMessage[] = [], acknowledgements: WireMessage[] = [], sent: WireMessage[] = [];
  const manifest = { compatibility: versions, terrain, seed: 7, grid: terrain === 'river-canyon' ? 8 as const : 16 as const,
    triangle: 'shared-diagonal-v1' as const };
  const host: HostGame = new HostGame(prepared, base.sessionId, 0, () => wall, body => {
    if (blocked) return { ok: false, reason: 'backpressure' };
    const message = { ...base, epoch: host.epoch, sequence: wire + 1, ...body };
    const bytes = byteLength(encodeMessage(message));
    if ((body.type === 'transfer-offer' || body.type === 'transfer-chunk') && bytes > budget) return { ok: false, reason: 'backpressure' };
    if (body.type === 'transfer-offer' || body.type === 'transfer-chunk') budget -= bytes;
    if ((body.type !== 'snapshot' || !dropSnapshots) && !lost(message)) outgoing.push(message);
    sent.push(message); wire++;
    return { ok: true };
  }, (_slot, view, range) => ({ ...view, range, aspect: 1.15 }), [false, true], manifest, undefined, sampledAt);
  const guest: GuestGame = new GuestGame({ formations: [verified[0]!, verified[1]!], course: { type: 'course-manifest', revision: 0,
    manifest,
    plans: [verified[0]!.reference, verified[1]!.reference] } }, base.sessionId, 0, () => wall, body => {
    const message = { ...base, epoch: guest.epoch, sender: 'guest' as const, sequence: ++input, ...body };
    if (message.type === 'transfer-ready') {
      if (holdAcks) acknowledgements.push(message); else host.receive(message);
    } else if (message.type === 'command') host.receive(message);
    else throw new Error('Unexpected guest stream message.');
    return { ok: true };
  });
  const drain = async () => {
    for (const message of outgoing.splice(0)) await guest.receive(message);
    guest.pump();
  };
  const pump = async (target = host.scheduler.session.time) => {
    wall += 50; budget = 16 * 1024;
    const result = await host.pump(target);
    await drain(); return result;
  };
  const advance = async (target: number) => {
    for (let work = 0; host.scheduler.session.time < target && host.scheduler.session.status !== 'over'; work++) {
      if (work > 20_000) throw new Error('Stream failed to advance.');
      const next = Math.min(target, host.scheduler.session.time + 0.05);
      await pump(next);
    }
    await pump();
  };
  const release = async (slot: 0 | 1) => {
    const time = host.scheduler.plan().attempts[slot].releaseAt;
    await advance(time);
    if (slot === 0) expect(host.release(time).accepted).toBe(true);
    else {
      guest.frame(time, 7);
      expect(guest.release()).toBe(true);
      guest.pump();
    }
    await pump();
    const ack = [...sent].reverse().find(message => message.type === 'ack' && message.slot === slot);
    expect(ack, JSON.stringify(ack)).toMatchObject({ decision: { accepted: true } });
  };
  return { host, guest, sent, pump, advance, release, drain,
    lose(predicate: (message: WireMessage) => boolean) { lost = predicate; },
    replaceTransport() { outgoing.length = 0; acknowledgements.length = 0; holdAcks = false; wire = input = 0; },
    elapse(ms: number) { wall += ms; },
    dropSnapshots(value: boolean) { dropSnapshots = value; },
    block(value: boolean) { blocked = value; },
    hold(value: boolean) {
      holdAcks = value;
      if (!value) for (const message of acknowledgements.splice(0)) {
        if (message.type === 'transfer-ready') host.receive(message);
      }
    },
  };
}

describe('host/guest gameplay stream ownership', () => {
  it('does not commit a recovered checkpoint before its missing flight is acknowledged', async () => {
    const state = await setup();
    try {
      await state.pump(); await state.pump();
      state.host.journal.authority.beginPause(); state.elapse(751); state.host.journal.authority.sealPause();
      const missing = state.host.reference(0), inventory = state.guest.replica.plans.inventory().filter(ref => ref.id !== missing.id);
      state.host.recoverEpoch(1, inventory); state.guest.recoverEpoch(1);
      state.hold(true);
      for (let work = 0; work < 150; work++) await state.pump();
      expect(state.host.ready).toBe(false);
      expect(state.sent.some(message => message.type === 'checkpoint-commit' && message.epoch === 1)).toBe(false);
      state.hold(false);
      for (let work = 0; work < 10 && !state.host.ready; work++) await state.pump();
      expect(state.host.ready).toBe(true);
      expect(state.guest.replica.presentationState?.status).toBe('paused');
    } finally { state.host.close(); state.guest.close(); }
  });
  it.each(['unacknowledged', 'partial-event'] as const)('recovers a %s outcome without resetting scores or waiting on the dead transport', async boundary => {
    const state = await setup();
    try {
      await state.pump(); await state.pump();
      if (boundary === 'unacknowledged') state.hold(true);
      else state.lose(message => message.type === 'snapshot' || message.type === 'event' && message.event.action === 'combat');
      await state.advance(state.host.scheduler.plan().attempts[0].cutoffAt + 0.8);
      expect(state.guest.replica.presentationState!.players[0].misses).toBe(0);
      if (boundary === 'unacknowledged') expect(state.host.journal.canSnapshot).toBe(false);
      else expect(state.guest.replica.state!.players[0].misses).toBe(1);
      const scheduler = state.host.scheduler, journal = state.host.journal, core = scheduler.session.lastEventId;
      journal.authority.beginPause(); state.elapse(751); journal.authority.sealPause();
      const inventory = state.guest.replica.plans.inventory();
      state.replaceTransport(); state.lose(() => false);
      state.host.recoverEpoch(1, inventory); state.guest.recoverEpoch(1);
      expect(state.guest.replica.presentationState).toBeNull();
      for (let work = 0; work < 100 && !state.host.ready; work++) await state.pump();
      expect(state.host.ready).toBe(true);
      expect(state.host.scheduler).toBe(scheduler); expect(state.host.journal).toBe(journal);
      expect(scheduler.session.lastEventId).toBe(core);
      expect(state.guest.replica.presentationState).toMatchObject({ status: 'paused', players: [{ misses: 1 }, { misses: 0 }] });
      const newOffers = state.sent.filter(message => message.epoch === 1 && message.type === 'transfer-offer');
      expect(newOffers).toHaveLength(1);
      expect(newOffers[0]).toMatchObject({ transfer: { kind: 'checkpoint' } });
    } finally { state.host.close(); state.guest.close(); }
  });
  it('survives a lost pause barrier and a second interruption during checkpoint restoration', async () => {
    const state = await setup();
    try {
      await state.pump(); await state.pump(); await state.release(1);
      const bomb = state.host.player(1).bomb!.value;
      state.host.journal.authority.beginPause(); state.elapse(751); state.host.journal.authority.sealPause();
      state.host.advanceEpoch(1, false);
      expect(state.guest.epoch).toBe(0);
      const inventory = state.guest.replica.plans.inventory();
      state.host.recoverEpoch(2, inventory); state.guest.recoverEpoch(2);
      expect(() => state.guest.advanceEpoch(3)).toThrow('restored');
      state.replaceTransport();
      state.host.recoverEpoch(3, inventory); state.guest.recoverEpoch(3);
      for (let work = 0; work < 20 && !state.host.ready; work++) await state.pump();
      expect(state.host.ready).toBe(true);
      expect(state.guest.frame(state.host.scheduler.session.time, 7).aircraft[1].bomb).toEqual(bomb);
      expect(() => state.guest.recoverEpoch(3)).toThrow('newer');
      expect(() => state.guest.recoverEpoch(2)).toThrow('newer');
      state.host.advanceEpoch(4, true); state.guest.advanceEpoch(4);
      for (let work = 0; work < 20 && !state.host.ready; work++) await state.pump();
      await state.advance(state.host.scheduler.session.time + 0.2);
      expect(state.guest.replica.presentationState!.players[1].bomb).not.toBeNull();
    } finally { state.host.close(); state.guest.close(); }
  });
  it('retains exact old finale dependencies without retransmitting already verified frozen effects', async () => {
    const state = await setup();
    try {
      await state.pump(); await state.pump();
      for (let sequence = 0; sequence < 6; sequence++) {
        await state.release(1);
        await state.advance(state.host.scheduler.plan().handoffAt);
      }
      for (let work = 0; work < 160; work++) await state.pump();
      expect(state.host.counts.retainedFlights).toBeGreaterThan(state.host.counts.flights);
      expect(state.host.counts.retainedFlights).toBeLessThanOrEqual(10);
      const before = state.guest.frame(state.host.scheduler.session.time, 7);
      expect(before.aircraft[0].destroyed).toBe(true);
      expect(state.host.player(1).completion).toBeNull();
      const inventory = state.guest.replica.plans.inventory();
      const copied = state.guest.replica.plans.inventory(); copied[0]!.digest = '0'.repeat(64);
      expect(state.guest.replica.plans.inventory()).toEqual(inventory);
      state.host.journal.authority.beginPause(); state.elapse(751); state.host.journal.authority.sealPause();
      expect(() => state.host.recoverEpoch(1, [...inventory, inventory[0]!])).toThrow('Duplicate');
      const active = state.host.reference(state.host.scheduler.sequence);
      expect(() => state.host.recoverEpoch(1, [{ ...active, digest: '0'.repeat(64) }])).toThrow('identity');
      expect(state.host.epoch).toBe(0);
      state.host.recoverEpoch(1, inventory); state.guest.recoverEpoch(1);
      for (let work = 0; work < 20 && !state.host.ready; work++) await state.pump();
      expect(state.host.ready).toBe(true);
      expect(state.guest.frame(state.host.scheduler.session.time, 7).aircraft).toEqual(before.aircraft);
      expect(state.sent.filter(message => message.epoch === 1 && message.type === 'transfer-offer'))
        .toEqual([expect.objectContaining({ transfer: expect.objectContaining({ kind: 'checkpoint' }) })]);
    } finally { state.host.close(); state.guest.close(); }
  }, 30_000);
  it('publishes a rejected in-transit command before constructing the new paused checkpoint', async () => {
    const state = await setup();
    try {
      await state.pump(); await state.pump();
      await state.advance(state.host.scheduler.plan().attempts[1].releaseAt);
      const drawn = state.guest.frame(state.host.scheduler.session.time, 7);
      state.host.journal.authority.beginPause();
      state.elapse(751); state.host.journal.authority.sealPause();
      state.host.advanceEpoch(1, false); state.guest.advanceEpoch(1);
      expect(state.guest.release(drawn)).toBe(true);
      state.guest.pump();
      expect(state.host.journal.canSnapshot).toBe(false);
      for (let work = 0; work < 20 && !state.host.ready; work++) await state.pump();
      expect(state.host.ready).toBe(true);
      expect(state.sent.find(message => message.type === 'ack' && message.epoch === 1))
        .toMatchObject({ decision: { accepted: false, reason: 'paused' } });
      expect(state.guest.replica.presentationState).toMatchObject({ status: 'paused', lastInputs: [0, 1] });
      expect(state.guest.replica.presentationState!.players[1]).toMatchObject({ score: 0, bomb: null });
    } finally { state.host.close(); state.guest.close(); }
  });
  it.each(['bomb', 'handoff', 'over'] as const)('restores a paused and resumed %s checkpoint without resetting the game', async boundary => {
    const state = await setup();
    try {
      await state.pump(); await state.pump();
      if (boundary === 'over') {
        for (let index = 0; index < 3; index++) await state.advance(state.host.scheduler.plan().handoffAt);
        expect(state.host.scheduler.session.status).toBe('over');
      } else {
        await state.release(1);
        await state.advance(boundary === 'bomb' ? state.host.scheduler.session.time + 0.2 : state.host.scheduler.plan().handoffAt + 0.1);
      }
      const scheduler = state.host.scheduler, journal = state.host.journal, frozen = scheduler.session.snapshot();
      const events = journal.eventSequence, published = state.sent.filter(message => message.type === 'event').length;
      state.guest.frame(frozen.time + 0.1, 7);
      const displayedTime = state.guest.combat.time;
      journal.authority.beginPause();
      await state.pump();
      expect(() => state.host.advanceEpoch(1, false)).toThrow('sealed');
      state.elapse(751); journal.authority.sealPause();
      state.host.advanceEpoch(1, false); state.guest.advanceEpoch(1);
      expect(state.guest.replica.presentationState).toBeNull();
      expect(state.guest.combat.time).toBe(displayedTime);
      expect(state.guest.replica.state!.players[1].score).toBe(frozen.players[1]!.score);
      expect(() => state.guest.advanceEpoch(2)).toThrow('restored');
      for (let work = 0; work < 200 && (!state.host.ready || boundary === 'handoff' &&
        state.guest.replica.plans.references().length < 3); work++) await state.pump();
      expect(state.host.ready).toBe(true);
      const paused = state.guest.replica.presentationState!;
      expect(paused.status).toBe(boundary === 'over' ? 'over' : 'paused');
      expect(secondsAt(paused.at)).toBeCloseTo(frozen.time, 10);
      expect(paused.players.map(player => [player.score, player.misses, player.assisted]))
        .toEqual(frozen.players.map(player => [player.score, player.misses, player.assisted]));
      expect(paused.eventSequence).toBe(events);
      if (boundary === 'bomb') expect(paused.players[1].bomb!.position).toEqual(frozen.players[1]!.bomb!.value.position);
      if (boundary === 'handoff') expect(paused.planRevision).toBeGreaterThan(0);
      const frozenFrame = state.guest.frame(frozen.time, 7);
      state.elapse(5000); await state.pump();
      expect(state.guest.frame(frozen.time, 7)).toEqual(frozenFrame);
      expect(scheduler.session.time).toBe(frozen.time);
      state.host.advanceEpoch(2, true); state.guest.advanceEpoch(2);
      for (let work = 0; work < 20 && !state.host.ready; work++) await state.pump();
      expect(state.host.ready).toBe(true);
      expect(state.host.scheduler).toBe(scheduler); expect(state.host.journal).toBe(journal);
      expect(state.guest.replica.presentationState!.status).toBe(boundary === 'over' ? 'over' : 'running');
      expect(state.sent.filter(message => message.type === 'event')).toHaveLength(published);
      expect(state.guest.replica.watermarks.eventSequence).toBe(events);
      if (boundary === 'over') expect(state.guest.frame(frozen.time + 0.5, 7).time).toBe(frozen.time + 0.5);
      else await state.advance(frozen.time + 0.2);
      const oldSnapshot = state.sent.find(message => message.type === 'snapshot' && message.epoch === 0)!;
      await expect(state.guest.receive(oldSnapshot)).rejects.toThrow('epoch');
    } finally { state.host.close(); state.guest.close(); }
  }, 30_000);
  it('permits a new keypress after a rejected local drop and rejects conflicting acknowledgements', async () => {
    const state = await setup();
    try {
      await state.pump(); await state.pump();
      const time = state.host.scheduler.plan().attempts[1].releaseAt;
      await state.advance(time);
      const displayed = state.guest.frame(time, 7);
      state.host.scheduler.session.pause();
      expect(state.guest.release(displayed)).toBe(true);
      state.guest.pump(); await state.pump();
      expect(state.sent.find(message => message.type === 'ack' && message.slot === 1))
        .toMatchObject({ decision: { accepted: false, reason: 'paused' } });
      expect(state.host.scheduler.session.resume().ok).toBe(true);
      expect(state.guest.release(displayed)).toBe(true);
      expect(state.guest.lastInputSequence).toBe(2);
      state.guest.pump(); await state.pump();
      const ack = state.sent.find(message => message.type === 'ack' && message.slot === 1 && message.inputSequence === 2)!;
      expect(ack).toMatchObject({ decision: { accepted: true } });
      await state.guest.receive(ack);
      await expect(state.guest.receive({ ...base, type: 'ack', slot: 1, inputSequence: 2,
        decision: { accepted: false, reason: 'paused' } })).rejects.toThrow('Conflicting');
    } finally { state.host.close(); state.guest.close(); }
  });
  it('timestamps catch-up snapshots at their represented state and releases the actually displayed guest frame', async () => {
    const state = await setup('green-valley', time => 10_000 + time * 1000);
    await state.pump(); await state.pump();
    const releaseAt = state.host.scheduler.plan().attempts[1].releaseAt;
    await state.advance(releaseAt);
    const displayed = state.guest.frame(releaseAt, 7);
    await state.advance(releaseAt + 0.05);
    state.guest.frame(releaseAt + 0.05, 7);
    expect(state.guest.release(displayed)).toBe(true);
    state.guest.pump();
    expect(state.host.scheduler.session.snapshot().encounters[0]!.attempts[1]!.releasedAt).toBeCloseTo(releaseAt, 10);
    for (const message of state.sent) if (message.type === 'snapshot') {
      expect(message.sampledAt).toBeCloseTo(10_000 + secondsAt(message.state.at) * 1000, 8);
    }
    state.host.close(); state.guest.close();
  });

  it.each((['green-valley', 'desert', 'river-canyon'] as const).flatMap(terrain =>
    ([0, 1] as const).map(firstDead => ({ terrain, firstDead }))))('streams $terrain with player $firstDead eliminated first', async ({ terrain, firstDead }) => {
    const state = await setup(terrain);
    const survivor = firstDead === 0 ? 1 : 0;
    await state.pump(); await state.pump();
    for (let sequence = 0; sequence < 5; sequence++) {
      const plan = state.host.scheduler.plan();
      expect(state.host.scheduler.sequence).toBe(sequence);
      if (sequence < 2) await state.release(survivor);
      await state.advance(plan.handoffAt);
      for (let attempt = 0; attempt < 10 && state.host.journal.pendingCount; attempt++) await state.pump();
      const host = state.host.scheduler.session.snapshot(), guest = state.guest.replica.presentationState!;
      for (const ref of guest.effects) {
        const plan = state.guest.replica.plans.combatPlan(ref);
        expect(state.guest.replica.plans.combatPlan(ref)).toBe(plan);
        expect(Object.isFrozen(plan)).toBe(true);
        const copy = state.guest.replica.plans.combat(ref);
        copy.bornAt++;
        expect(state.guest.replica.plans.combatPlan(ref).bornAt).toBe(plan.bornAt);
      }
      expect(guest.players.map(p => [p.score, p.misses, p.assisted])).toEqual(host.players.map(p => [p.score, p.misses, p.assisted]));
      expect(state.host.counts.flights).toBeLessThanOrEqual(4);
      expect(state.guest.replica.plans.count).toBeLessThanOrEqual(12);
      const frame = state.guest.frame(secondsAt(guest.at), 7);
      if (!guest.players[1].eliminated) expect(frame.aircraft[1].pose).toEqual(state.host.scheduler.session.pose(1));
      if (sequence === 2) {
        expect(guest.players[firstDead].eliminated).toBe(true); expect(guest.players[survivor].eliminated).toBe(false);
        expect(guest.status).toBe('running');
      }
    }
    expect(state.guest.replica.state).toMatchObject({ status: 'over', winner: survivor });
    expect(state.host.scheduler.session.status).toBe('over');
    expect(state.sent.filter(m => m.type === 'event' && m.event.action === 'ended')).toHaveLength(1);
    for (const age of [0, 1.69, 1.71, 5.5]) {
      const time = state.host.scheduler.session.time + age;
      const hostFrame = state.host.frame(time), guestFrame = state.guest.frame(secondsAt(state.guest.replica.presentationState!.at) + age, 7);
      for (const slot of [0, 1] as const) {
        for (const key of ['position', 'velocity', 'acceleration'] as const) for (const axis of ['x', 'y', 'z'] as const) {
          expect(guestFrame.aircraft[slot].pose[key][axis]).toBeCloseTo(hostFrame.aircraft[slot].pose[key][axis], 8);
        }
        expect(guestFrame.aircraft[slot].pose.bank).toBeCloseTo(hostFrame.aircraft[slot].pose.bank, 8);
        expect(guestFrame.aircraft[slot].pose.pitch).toBeCloseTo(hostFrame.aircraft[slot].pose.pitch, 8);
      }
      expect(guestFrame.aircraft.map(aircraft => aircraft.destroyed)).toEqual(hostFrame.aircraft.map(aircraft => aircraft.destroyed));
    }
  }, 120_000);

  it('retries blocked commits and holds unpublished outcomes without losing events', async () => {
    const state = await setup();
    state.block(true);
    expect(await state.pump(0.05)).toBe('backpressure');
    expect(state.host.scheduler.session.time).toBe(0);
    state.block(false); await state.pump(); await state.pump();
    state.hold(true);
    await state.advance(state.host.scheduler.plan().attempts[0].cutoffAt + 0.8);
    expect(state.host.journal.pendingCount).toBeGreaterThan(0);
    const before = state.host.scheduler.session.time;
    for (let attempt = 0; attempt < 12; attempt++) await state.pump(before);
    expect(await state.pump(before + 0.05)).toBe('publication');
    expect(state.host.scheduler.session.time).toBe(before);
    expect(state.guest.replica.presentationState!.players[0].misses).toBe(0);
    state.hold(false); await state.pump();
    expect(state.guest.replica.presentationState!.players[0].misses).toBe(1);
    expect(state.host.journal.pendingCount).toBe(0);
  });

  it('bootstraps reliable events even when the initial unreliable snapshot is lost', async () => {
    const state = await setup();
    state.dropSnapshots(true);
    await state.pump(); await state.pump();
    expect(state.guest.replica.state?.players.map(player => player.score)).toEqual([0, 0]);
    expect(state.guest.replica.clockAnchor).toBeNull();
    await state.release(0);
    expect(state.guest.replica.state?.players[0].bomb).not.toBeNull();
    state.dropSnapshots(false); await state.pump();
    expect(state.guest.replica.waitReason).toBeNull();
    expect(state.guest.replica.clockAnchor).not.toBeNull();
  });

  it('cancels in-flight hashing without publishing after close', async () => {
    const state = await setup();
    await state.pump(); await state.pump();
    const plan = state.host.scheduler.plan();
    await state.advance(plan.attempts[0].cutoffAt + 0.74);
    const before = state.sent.length;
    const pending = state.host.pump(state.host.scheduler.session.time + 0.05);
    state.host.close();
    expect(await pending).toBe('not_open');
    expect(state.sent.length).toBe(before);
    expect(state.host.counts).toMatchObject({ flights: 0, effects: 0 });
    expect(() => state.host.release(0)).toThrow();
  });
});
