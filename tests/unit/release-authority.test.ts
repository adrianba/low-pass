import { beforeAll, describe, expect, it } from 'vitest';
import { STEP } from '../../src/config/game.js';
import type { TerrainTheme } from '../../src/config/terrain.js';
import type { FormationPlan } from '../../src/game/formation/approved.js';
import { FormationTrack } from '../../src/game/formation/track.js';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler.js';
import { HostSession } from '../../src/game/multiplayer/session.js';
import type { PlayerSlot } from '../../src/game/multiplayer/session.js';
import { initialPose, launchFrom } from '../../src/simulation/pose.js';
import { contactAccuracy, predictImpact } from '../../src/simulation/ballistics.js';
import { surfaceFor } from '../../src/terrain/surface.js';
import { secondsAt } from '../../shared/protocol/game.js';
import type { WireMessage } from '../../shared/protocol/messages.js';
import { ReleaseAuthority, RELEASE_DECISIONS, RELEASE_GRACE_SECONDS, releaseAcknowledgement, releaseIntent } from '../../src/network/release-authority.js';
import { SessionClock } from '../../src/network/session-clock.js';
import { base, hash } from './protocol-fixtures.js';
import { FaultNetwork } from '../helpers/fault-transport.js';

const courses: TerrainTheme[] = ['green-valley', 'desert', 'river-canyon'];
const plans = new Map<TerrainTheme, FormationPlan[]>();
const options = { releaseGraceSeconds: RELEASE_GRACE_SECONDS };
beforeAll(() => {
  for (const terrain of courses) {
    const scheduler = new FormationScheduler(terrain, 7, undefined, options), selected: FormationPlan[] = [];
    for (let sequence = 0; sequence < 15; sequence++) {
      const plan = scheduler.plan();
      if ([0, 12, 14].includes(sequence)) selected.push(plan);
      for (const slot of [0, 1] as const) {
        scheduler.advanceTo(plan.attempts[slot].releaseAt);
        expect(scheduler.session.release(slot, sequence).ok).toBe(true);
      }
      scheduler.advanceTo(plan.handoffAt); scheduler.session.drainEvents();
      expect(scheduler.retainedSequences.length).toBeLessThanOrEqual(4);
    }
    plans.set(terrain, selected);
  }
}, 120_000);
const ref = (plan: FormationPlan) => ({ id: plan.encounterId, digest: hash });
function setup(plan: FormationPlan, wall = { time: 0 }) {
  const session = new HostSession(plan, options);
  const authority = new ReleaseAuthority(session, base.sessionId, 0, () => wall.time);
  authority.registerPlan(0, ref(plan));
  return { session, authority, wall };
}
function input(plan: FormationPlan, slot: PlayerSlot, time: number, sequence = 0, inputSequence = 1): Extract<WireMessage, { type: 'command' }> {
  return { ...base, sender: slot === 0 ? 'host' : 'guest', type: 'command', slot, inputSequence,
    command: releaseIntent(sequence, ref(plan), time) };
}
function stampTime(message: Extract<WireMessage, { type: 'command' }>) {
  if (message.command.action !== 'release') throw new Error('Expected release.');
  return secondsAt(message.command.displayedAt);
}
function fixture(sequence: number, miss = false): FormationPlan {
  const base = plans.get('green-valley')![0]!;
  if (base.terrain === 'river-canyon') throw new Error('Expected valley.');
  const startAt = sequence * 8, handoffAt = startAt + 8, coverageEndAt = handoffAt + 5.5;
  const releaseAt = startAt + 2;
  const track = new FormationTrack({ version: 1, knots: [startAt - releaseAt, 0, coverageEndAt - releaseAt].map(time => {
    const pose = initialPose({ x: time + releaseAt, y: 15, z: 0 });
    pose.velocity = { x: 1, y: 0, z: 0 };
    return { phase: time, time, pose };
  }) });
  const encounterId = `short-${sequence}`;
  const attempt = (slot: PlayerSlot) => ({ ...base.attempts[slot], slot, encounterId,
    acquireAt: startAt, releaseAt, cutoffAt: startAt + 3, endAt: startAt + 4, track });
  return { ...base, encounterId, startAt, handoffAt, coverageEndAt,
    target: { x: miss ? 1000 : releaseAt, y: 12, z: 0 },
    attempts: [attempt(0), attempt(1)] };
}

describe('timestamped release settlement', () => {
  it.each(courses)('preserves exact %s contacts and scores at both slots, speed-cap tiers and every accepted delay', terrain => {
    for (const plan of plans.get(terrain)!) for (const slot of [0, 1] as const) {
      for (const fraction of [0, 0.00037, 0.0025]) {
        const message = input(plan, slot, plan.attempts[slot].releaseAt + fraction), at = stampTime(message);
        const baseline = setup(plan);
        baseline.session.advanceTo(at);
        expect(baseline.authority.receive(message.sender, message).accepted).toBe(true);
        baseline.session.advanceTo(plan.handoffAt);
        const expected = baseline.session.snapshot().encounters[0]!.attempts[slot]!.result;
        const surface = surfaceFor(terrain);
        const impact = predictImpact(launchFrom(plan.attempts[slot].track.at(at - plan.attempts[slot].releaseAt)), surface);
        expect(expected).toMatchObject({ points: contactAccuracy(impact, plan.target, surface), impact });
        if (fraction === 0) expect(expected!.points).toBe(100);
        for (const delay of [0.05, 0.2, 0.5, RELEASE_GRACE_SECONDS]) {
          const late = setup(plan);
          late.session.advanceTo(at + delay);
          expect(late.authority.receive(message.sender, message).accepted).toBe(true);
          late.session.advanceTo(plan.handoffAt);
          expect(late.session.snapshot().encounters[0]!.attempts[slot]!.result).toEqual(expected);
          expect(late.session.drainEvents().filter(event => event.type === 'released')).toHaveLength(1);
        }
      }
    }
  }, 30_000);

  it('replays a completed historical bomb without changing the clock, score twice, or historical elimination pose', () => {
    const plan = fixture(0), message = input(plan, 1, plan.attempts[1].releaseAt + 0.00037), at = stampTime(message);
    const onTime = setup(plan), late = setup(plan);
    onTime.session.advanceTo(at); onTime.authority.receive('guest', message);
    onTime.session.advanceTo(at + 0.7);
    late.session.advanceTo(at + 0.7);
    const accepted = late.authority.receive('guest', message);
    expect(accepted.accepted).toBe(true);
    expect(late.session.snapshot()).toEqual(onTime.session.snapshot());
    const events = late.session.drainEvents();
    expect(events.map(event => event.type)).toEqual(['released', 'resolved']);
    expect(late.authority.receive('guest', { ...message, sequence: 99 })).toEqual(accepted);
    expect(late.session.drainEvents()).toEqual([]);
    expect(releaseAcknowledgement(1, 1, accepted, id => id + 10)).toMatchObject({ decision: { accepted: true, eventSequence: 11 } });
    expect(() => releaseAcknowledgement(1, 1, accepted, () => 0)).toThrow();
  });

  it('uses displayed plan time through delayed, replayed reliable traffic and different peer clocks', () => {
    const plan = plans.get('river-canyon')![2]!, request = input(plan, 1, plan.attempts[1].releaseAt + 0.00037);
    const at = stampTime(request), network = new FaultNetwork({ seed: 73, sessionId: base.sessionId, epoch: 0,
      maxPackets: 128, maxBufferedBytes: 128 * 1024, maxInbox: 256,
      clocks: { host: { offsetMs: -1500, driftPpm: 100 }, guest: { offsetMs: 4000, driftPpm: -200 } } });
    network.setFaults('control', { latencyMs: 120, jitterMs: 60, loss: 0.2, duplicate: 1, retryMs: 40 });
    const session = new HostSession(plan, options), authority = new ReleaseAuthority(session, base.sessionId, 0, () => network.peers.host.now());
    authority.registerPlan(0, ref(plan));
    session.advanceTo(at); expect(network.peers.guest.send(request).ok).toBe(true);
    const decisions = [];
    for (let time = 0; time <= 750; time += 10) {
      network.advanceTo(time); session.advanceTo(at + time / 1000);
      for (const event of network.peers.host.drain()) if (event.type === 'message' && event.message.type === 'command') {
        decisions.push(authority.receive('guest', event.message));
      }
    }
    expect(decisions.length).toBeGreaterThan(1);
    expect(decisions.every(decision => decision.accepted)).toBe(true);
    session.advanceTo(plan.handoffAt);
    const baseline = setup(plan);
    baseline.session.advanceTo(at); baseline.authority.receive('guest', request); baseline.session.advanceTo(plan.handoffAt);
    expect(session.snapshot()).toEqual(baseline.session.snapshot());
    expect(session.drainEvents().filter(event => event.type === 'released')).toHaveLength(1);
  });

  it('keeps the real cutoff inclusive without granting extra flight time, and postpones third-miss finality', () => {
    const plan = fixture(0);
    for (const offset of [-0.000001, 0, 0.000001]) {
      const state = setup(plan), message = input(plan, 0, plan.attempts[0].cutoffAt + offset);
      state.session.advanceTo(plan.attempts[0].cutoffAt + 0.7);
      expect(state.session.snapshot().players[0]!.misses).toBe(0);
      expect(state.authority.receive('host', message)).toMatchObject(offset <= 0
        ? { accepted: true } : { accepted: false, reason: 'cutoff' });
    }
    for (const miss of [false, true]) {
      const state = setup(fixture(0, miss));
      for (let sequence = 0; sequence < 3; sequence++) {
        const current = fixture(sequence, miss);
        if (sequence) {
          state.session.installPlan(sequence, current); state.authority.registerPlan(sequence, ref(current));
          state.session.advanceTo(current.startAt + 0.5);
          state.session.retireReadyPlans();
        }
        if (sequence < 2) { state.session.advanceTo(current.handoffAt); state.session.drainEvents(); continue; }
        const cutoff = current.attempts[0].cutoffAt;
        state.session.advanceTo(cutoff + 0.7);
        expect(state.session.snapshot().players[0]!.completion).toBeNull();
        expect(state.session.snapshot().players[0]!.misses).toBe(2);
        const request = input(current, 0, cutoff, sequence);
        expect(state.authority.receive('host', request).accepted).toBe(true);
        const snapshot = state.session.snapshot(), result = snapshot.encounters.at(-1)!.attempts[0]!.result!;
        expect(result.time).toBeLessThan(state.session.time);
        if (miss) {
          expect(snapshot.players[0]!.completion?.pose).toEqual(current.attempts[0].track.at(result.time - current.attempts[0].releaseAt));
          expect(snapshot.players[0]!.completion?.pose.position.x).not.toBe(state.session.pose(1).position.x);
        } else expect(snapshot.players[0]!.misses).toBe(2);
      }
    }
  });

  it('rejects invalid ownership, plans, future/old times and conflicting duplicates without adding attempts', () => {
    const plan = fixture(0), state = setup(plan), at = plan.attempts[0].releaseAt;
    state.session.advanceTo(at);
    const request = input(plan, 0, at);
    expect(() => state.authority.receive('guest', request)).toThrow('role');
    expect(state.authority.receive('host', { ...request, epoch: 1 })).toEqual({ accepted: false, reason: 'epoch' });
    const badPlan = input({ ...plan, encounterId: 'different' }, 0, at);
    expect(state.authority.receive('host', badPlan)).toEqual({ accepted: false, reason: 'plan' });
    expect(state.authority.receive('host', request)).toEqual({ accepted: false, reason: 'duplicate' });
    expect(state.authority.receive('host', input(plan, 0, at + 0.001, 0, 2))).toEqual({ accepted: false, reason: 'future' });
    expect(state.authority.receive('host', input(plan, 0, at - 0.751, 0, 3))).toEqual({ accepted: false, reason: 'too_old' });
    expect(state.authority.receive('host', input(plan, 0, at, 0, 4)).accepted).toBe(true);
    expect(state.session.drainEvents().filter(event => event.type === 'released')).toHaveLength(1);
    for (let i = 5; i < RELEASE_DECISIONS + 20; i++) state.authority.receive('host', input(plan, 0, at, 0, i));
    expect(state.authority.rememberedDecisions).toBe(RELEASE_DECISIONS);
    expect(state.authority.receive('host', badPlan)).toEqual({ accepted: false, reason: 'duplicate' });
    expect(state.session.drainEvents()).toEqual([]);
    expect(() => state.authority.registerPlan(0, { ...ref(plan), digest: 'b'.repeat(64) })).toThrow('replace');
  });

  it('settles pre-pause input while frozen, seals its wall-clock deadline, and rejects old epochs after resume', () => {
    const plan = fixture(0), state = setup(plan);
    state.session.advanceTo(2.2); state.authority.beginPause();
    state.wall.time = 500;
    expect(state.authority.receive('guest', input(plan, 1, 2)).accepted).toBe(true);
    expect(state.session.time).toBe(2.2); expect(state.session.status).toBe('paused');
    expect(() => state.authority.sealPause()).toThrow('incomplete');
    state.wall.time = 751; state.authority.sealPause();
    expect(state.authority.receive('host', input(plan, 0, 2.2))).toEqual({ accepted: false, reason: 'paused' });
    state.authority.resume(1);
    expect(state.authority.receive('guest', input(plan, 1, 2))).toEqual({ accepted: false, reason: 'epoch' });
    const next = { ...input(plan, 0, 2.2, 0, 2), epoch: 1 };
    expect(state.authority.receive('host', next).accepted).toBe(true);
    expect(state.authority.lastInputs).toEqual([2, 1]);
    state.wall.time = 750;
    expect(() => state.authority.receive('host', next)).toThrow('backwards');
  });

  it('finalizes one timeout only after its settlement horizon and never undoes it', () => {
    const plan = fixture(0), state = setup(plan), cutoff = plan.attempts[0].cutoffAt;
    state.session.advanceTo(cutoff + RELEASE_GRACE_SECONDS);
    expect(state.session.snapshot().players[0]!.misses).toBe(0);
    state.session.advanceTo(cutoff + RELEASE_GRACE_SECONDS + STEP * 2);
    expect(state.session.snapshot().players[0]!.misses).toBe(1);
    const before = state.session.snapshot();
    expect(state.authority.receive('host', input(plan, 0, cutoff))).toEqual({ accepted: false, reason: 'too_old' });
    expect(state.session.snapshot()).toEqual(before);
    expect(() => new HostSession(plan, { releaseGraceSeconds: 15 })).toThrow('allowance');
  });
});

describe('pause-aware session clock', () => {
  it('maps only monotonic elapsed time, keeps sub-ticks, and rebases every resume without a clock jump', () => {
    let wall = 1000;
    const clock = new SessionClock(() => wall);
    wall += 1000;
    expect(secondsAt(clock.sample().at)).toBe(0);
    clock.start(1); wall += 123.456;
    expect(secondsAt(clock.pause().at)).toBeCloseTo(0.123456, 12);
    wall += 30_000;
    expect(clock.sample()).toMatchObject({ running: false, epoch: 1 });
    expect(secondsAt(clock.sample().at)).toBeCloseTo(0.123456, 12);
    expect(() => clock.start(1)).toThrow('epoch');
    clock.start(2); wall += 100;
    expect(secondsAt(clock.sample().at)).toBeCloseTo(0.223456, 12);
    wall -= 1;
    expect(() => clock.sample()).toThrow('backwards');
  });
});
