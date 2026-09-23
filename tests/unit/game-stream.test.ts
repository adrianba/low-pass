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
  const outgoing: WireMessage[] = [], acknowledgements: WireMessage[] = [], sent: WireMessage[] = [];
  const manifest = { compatibility: versions, terrain, seed: 7, grid: terrain === 'river-canyon' ? 8 as const : 16 as const,
    triangle: 'shared-diagonal-v1' as const };
  const host = new HostGame(prepared, base.sessionId, 0, () => wall, body => {
    if (blocked) return { ok: false, reason: 'backpressure' };
    const message = { ...base, sequence: wire + 1, ...body };
    const bytes = byteLength(encodeMessage(message));
    if ((body.type === 'transfer-offer' || body.type === 'transfer-chunk') && bytes > budget) return { ok: false, reason: 'backpressure' };
    if (body.type === 'transfer-offer' || body.type === 'transfer-chunk') budget -= bytes;
    if (body.type !== 'snapshot' || !dropSnapshots) outgoing.push(message);
    sent.push(message); wire++;
    return { ok: true };
  }, (_slot, view, range) => ({ ...view, range, aspect: 1.15 }), [false, true], manifest, undefined, sampledAt);
  const guest = new GuestGame({ formations: [verified[0]!, verified[1]!], course: { type: 'course-manifest', revision: 0,
    manifest,
    plans: [verified[0]!.reference, verified[1]!.reference] } }, base.sessionId, 0, () => wall, body => {
    const message = { ...base, sender: 'guest' as const, sequence: ++input, ...body };
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
