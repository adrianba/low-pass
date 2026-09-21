import { beforeAll, describe, expect, it } from 'vitest';
import { STEP } from '../../src/config/game';
import type { TerrainTheme } from '../../src/config/terrain';
import { planFormation } from '../../src/game/formation/approved';
import type { FormationPlan } from '../../src/game/formation/approved';
import { initialFormationPoses } from '../../src/game/formation/initial';
import { HostSession, MAX_SESSION_EVENTS, MAX_SESSION_PLANS } from '../../src/game/multiplayer/session';
import type { PlayerSlot, SessionEvent } from '../../src/game/multiplayer/session';
import { contactAccuracy, predictImpact } from '../../src/simulation/ballistics';
import { launchFrom } from '../../src/simulation/pose';
import { surfaceFor } from '../../src/terrain/surface';
import { FormationTrack } from '../../src/game/formation/track';
import { initialPose } from '../../src/simulation/pose';

const slots = [0, 1] as const;
const courses: TerrainTheme[] = ['green-valley', 'desert', 'river-canyon'];
const plans = new Map<TerrainTheme, FormationPlan[]>();

beforeAll(() => {
  for (const terrain of courses) {
    const chain: FormationPlan[] = [];
    for (let count = 0; count < 6; count++) {
      const previous = chain.at(-1), time = previous?.handoffAt ?? 0;
      const result = planFormation({ encounterId: `session-${count}`, terrain, count, seed: 7, startAt: time,
        previous: previous ? [
          previous.attempts[0].track.at(time - previous.attempts[0].releaseAt),
          previous.attempts[1].track.at(time - previous.attempts[1].releaseAt),
        ] : initialFormationPoses(terrain),
        previousViews: previous ? [
          previous.attempts[0].camera.at(time - previous.attempts[0].releaseAt),
          previous.attempts[1].camera.at(time - previous.attempts[1].releaseAt),
        ] : [null, null],
      });
      if (!result.ok) throw new Error(JSON.stringify(result.failures));
      chain.push(result.plan);
    }
    plans.set(terrain, chain);
  }
}, 120_000);

function chain(terrain: TerrainTheme = 'green-valley') { return plans.get(terrain)!; }
function settle(session: HostSession, plan: FormationPlan, hits: readonly PlayerSlot[], sequence: number): SessionEvent[] {
  for (const slot of hits) {
    expect(session.advanceTo(plan.attempts[slot].releaseAt).ok).toBe(true);
    expect(session.release(slot, sequence)).toEqual({ ok: true });
  }
  session.advanceTo(plan.handoffAt);
  return session.drainEvents();
}
function next(session: HostSession, sequence: number, terrain: TerrainTheme = 'green-valley'): FormationPlan {
  const plan = chain(terrain)[sequence]!;
  session.installPlan(sequence, plan);
  session.advanceTo(plan.startAt + 5.5);
  for (const old of session.snapshot().encounters) if (old.sequence < sequence) session.retirePlan(old.sequence);
  return plan;
}

// Stationary, short-flight fixtures stress bookkeeping, not the approved flight planner.
function fixture(sequence: number, height = 15, duration = 8): FormationPlan {
  const base = chain()[0]!;
  if (base.terrain === 'river-canyon') throw new Error('Expected valley fixture.');
  const startAt = sequence * duration, handoffAt = startAt + duration, coverageEndAt = handoffAt + 5.5;
  const pose = initialPose({ x: 0, y: height, z: 0 });
  pose.velocity = { x: 0, y: 0, z: 0 };
  const attempt = (slot: PlayerSlot) => {
    const releaseAt = handoffAt - 2 + slot * 0.1;
    const track = new FormationTrack({ version: 1, knots: [startAt - releaseAt, 0, coverageEndAt - releaseAt]
      .map(time => ({ time, phase: time, pose })) });
    return { ...base.attempts[slot], encounterId: `fixture-${sequence}`, slot, track, acquireAt: startAt,
      releaseAt, cutoffAt: handoffAt - 1.5, endAt: handoffAt - 0.5 };
  };
  return { ...base, encounterId: `fixture-${sequence}`, startAt, handoffAt, coverageEndAt,
    target: { x: 0, y: 12, z: 0 }, attempts: [attempt(0), attempt(1)] };
}

describe('independent host session outcomes', () => {
  it.each(courses)('settles both %s bombs exactly like the predictor and retains a shared wreck', terrain => {
    const plan = chain(terrain)[0]!, session = new HostSession(plan);
    const events = settle(session, plan, slots, 0);
    const resolved = events.filter(e => e.type === 'resolved');
    expect(resolved).toHaveLength(2);
    for (const slot of slots) {
      const prediction = predictImpact(launchFrom(plan.attempts[slot].track.at(0)), surfaceFor(terrain));
      expect(resolved.find(e => e.result.slot === slot)?.result).toMatchObject({ slot, sequence: 0, points: 100, impact: prediction });
    }
    expect(session.snapshot().players.map(p => [p.score, p.misses])).toEqual([[100, 0], [100, 0]]);
    expect(session.snapshot().encounters[0]!.destroyed).toBe(true);
    expect(new Set(events.map(e => e.eventId)).size).toBe(events.length);
    expect(session.drainEvents()).toEqual([]);
    expect(session.release(1, 0)).toEqual({ ok: false, reason: 'resolved' });
  });

  it.each(slots)('keeps the survivor in their original slot after player %i dies', dead => {
    const survivor = dead === 0 ? 1 : 0, session = new HostSession(chain()[0]!);
    const all: SessionEvent[] = [];
    session.setAssistance(dead, true);
    session.setAssistance(dead, false);
    for (let sequence = 0; sequence < 6; sequence++) {
      const plan = sequence ? next(session, sequence) : chain()[0]!;
      const before = session.pose(survivor);
      expect(before).toEqual(plan.attempts[survivor].track.at(session.time - plan.attempts[survivor].releaseAt));
      all.push(...settle(session, plan, sequence < 3 ? [survivor] : [], sequence));
      if (sequence === 2) {
        expect(session.status).toBe('running');
        expect(session.snapshot().players[dead]!.completion).toMatchObject({ score: 0, misses: 3, assisted: true });
        expect(session.snapshot().players[survivor]!.completion).toBeNull();
        expect(session.release(dead, sequence)).toEqual({ ok: false, reason: 'eliminated' });
      }
      if (sequence > 2) {
        expect(session.snapshot().encounters.at(-1)!.attempts[dead]!.skipped).toBe(true);
        expect(session.snapshot().players[dead]!.misses).toBe(3);
      }
    }
    expect(session.status).toBe('over');
    expect(session.winner).toBe(survivor);
    expect(all.filter(e => e.type === 'eliminated')).toHaveLength(2);
    expect(all.filter(e => e.type === 'ended')).toHaveLength(1);
    expect(session.snapshot().players[survivor]!.completion).toMatchObject({ score: 300, misses: 3, assisted: false });
    const ended = session.snapshot();
    session.pause();
    expect(session.resume()).toEqual({ ok: false, reason: 'over' });
    expect(session.advanceTo(session.time + STEP)).toEqual({ ok: false, reason: 'over' });
    expect(session.snapshot()).toEqual(ended);
  });

  it('keeps cumulative misses through hits and ends equal scores in a draw', () => {
    const session = new HostSession(chain()[0]!);
    for (let sequence = 0; sequence < 4; sequence++) {
      const plan = sequence ? next(session, sequence) : chain()[0]!;
      settle(session, plan, sequence === 1 ? slots : [], sequence);
      expect(session.snapshot().players.map(p => p.misses)).toEqual(Array(2).fill(sequence === 0 ? 1 : sequence));
    }
    expect(session.winner).toBe('draw');
    expect(session.snapshot().players.map(p => p.score)).toEqual([100, 100]);
  });

  it('freezes time and bombs on pause and rejects early, duplicate, late and unknown releases', () => {
    const plan = chain()[0]!, session = new HostSession(plan);
    session.installPlan(1, chain()[1]!);
    expect(session.release(0, 1)).toEqual({ ok: false, reason: 'not_acquired' });
    expect(session.release(0, 99)).toEqual({ ok: false, reason: 'unknown_encounter' });
    session.advanceTo(plan.attempts[0].releaseAt);
    expect(session.release(0, 0).ok).toBe(true);
    expect(session.release(0, 0)).toEqual({ ok: false, reason: 'already_released' });
    session.advanceTo(session.time + STEP * 5);
    session.pause();
    const paused = session.snapshot();
    expect(session.advanceTo(session.time + 1)).toEqual({ ok: false, reason: 'paused' });
    expect(session.release(1, 0)).toEqual({ ok: false, reason: 'paused' });
    expect(session.snapshot()).toEqual(paused);
    session.resume();
    session.advanceTo(plan.attempts[1].cutoffAt + 0.000001);
    expect(session.release(1, 0)).toEqual({ ok: false, reason: 'cutoff' });
    session.advanceTo(plan.handoffAt);
    session.advanceTo(chain()[1]!.startAt + 5.5);
    session.retirePlan(0);
    expect(session.release(0, 0)).toEqual({ ok: false, reason: 'stale_encounter' });
    expect(() => session.release(0, NaN)).toThrow('sequence');
  });

  it('owns supplied metadata, snapshots, poses, event data and immutable completion results', () => {
    const original = chain()[0]!, target = { ...original.target };
    const plan = { ...original, target }, session = new HostSession(plan);
    target.x += 500;
    expect(session.snapshot().encounters[0]!.target).toEqual(original.target);
    const snapshot = session.snapshot();
    snapshot.players[0]!.pose.position.x += 400;
    snapshot.players[0]!.score = 500;
    session.pose(0).velocity.z = 0;
    expect(session.snapshot().players[0]!.score).toBe(0);
    expect(session.pose(0)).toEqual(original.attempts[0].track.at(-original.attempts[0].releaseAt));
    const events = settle(session, original, slots, 0);
    const event = events.find(e => e.type === 'resolved')!;
    event.result.points = -100;
    event.result.impact!.x += 700;
    expect(session.snapshot().encounters[0]!.attempts[0]!.result!.points).toBe(100);
  });

  it('retains attribution across installed later plans and bounds retention with explicit failures', () => {
    const session = new HostSession(chain()[0]!);
    for (let i = 1; i < MAX_SESSION_PLANS; i++) session.installPlan(i, chain()[i]!);
    expect(() => session.installPlan(MAX_SESSION_PLANS, chain()[MAX_SESSION_PLANS]!)).toThrow('capacity');
    expect(() => session.retirePlan(0)).toThrow('owns');
    settle(session, chain()[0]!, slots, 0);
    expect(session.snapshot().encounters.map(e => e.destroyed)).toEqual([true, false, false, false]);
    session.advanceTo(chain()[1]!.startAt + 5.5);
    session.retirePlan(0);
    session.installPlan(4, chain()[4]!);
    expect(session.snapshot().encounters.map(e => e.sequence)).toEqual([1, 2, 3, 4]);
  });

  it('blocks missing coverage without inventing a stationary continuation, and resumes after installing it', () => {
    const session = new HostSession(chain()[0]!);
    const before = session.pose(0);
    expect(() => session.advanceTo(chain()[0]!.handoffAt + STEP)).toThrow('next shared plan');
    expect(session.time).toBe(0);
    expect(session.pose(0)).toEqual(before);
    expect(session.resume()).toEqual({ ok: false, reason: 'coverage' });
    session.installPlan(1, chain()[1]!);
    expect(session.resume()).toEqual({ ok: true });
    session.advanceTo(chain()[0]!.handoffAt);
    expect(session.pose(0)).toEqual(chain()[1]!.attempts[0].track.at(chain()[1]!.startAt - chain()[1]!.attempts[0].releaseAt));
  });

  it('rejects malformed timing, skipped sequences, changed course and discontinuous handoffs atomically', () => {
    const session = new HostSession(chain()[0]!), second = chain()[1]!, snapshot = session.snapshot();
    if (second.terrain === 'river-canyon') throw new Error('Expected valley fixture.');
    expect(() => session.installPlan(2, second)).toThrow('sequence');
    expect(() => session.installPlan(1, { ...second, startAt: second.startAt + 1 })).toThrow('handoff');
    expect(() => session.installPlan(1, { ...second, terrain: 'desert' })).toThrow('metadata');
    expect(() => session.installPlan(1, { ...second, target: { ...second.target, x: NaN } })).toThrow('metadata');
    expect(() => session.installPlan(1, { ...second, attempts: [second.attempts[1], second.attempts[0]] })).toThrow('identity');
    const changed = second.attempts[0].track.toData();
    const track = new FormationTrack({ ...changed, knots: changed.knots.map((knot, i) => i ? knot :
      { ...knot, pose: { ...knot.pose, acceleration: { ...knot.pose.acceleration, x: knot.pose.acceleration.x + 1 } } }) });
    expect(() => session.installPlan(1, { ...second, attempts: [{ ...second.attempts[0], track }, second.attempts[1]] })).toThrow('motion');
    expect(() => session.advanceTo(NaN)).toThrow('clock');
    expect(() => session.advanceTo(61)).toThrow('clock');
    expect(session.snapshot()).toEqual(snapshot);
  });

  it('records actual canyon water contact as one miss with no target destruction', () => {
    const plan = chain('river-canyon')[0]!, surface = surfaceFor('river-canyon');
    const attempt = plan.attempts[0];
    let releaseAt: number | null = null;
    for (let time = attempt.acquireAt; time < attempt.cutoffAt; time += STEP * 10) {
      const impact = predictImpact(launchFrom(attempt.track.at(time - attempt.releaseAt)), surface);
      if (impact.kind === 'water') { releaseAt = time; break; }
    }
    expect(releaseAt).not.toBeNull();
    const session = new HostSession(plan);
    session.advanceTo(releaseAt!);
    session.release(0, 0);
    session.advanceTo(plan.handoffAt);
    const result = session.snapshot().encounters[0]!.attempts[0]!.result!;
    expect(result.impact!.kind).toBe('water');
    expect(result.points).toBe(0);
    expect(contactAccuracy(result.impact!, plan.target, surface)).toBe(0);
    expect(session.snapshot().players[0]!.misses).toBe(1);
    expect(session.snapshot().encounters[0]!.destroyed).toBe(false);
  });

  it('keeps old bombs after handoff without allowing a second active bomb or misattributing the impact', () => {
    const first = fixture(0, 100), second = fixture(1, 100), session = new HostSession(first);
    session.installPlan(1, second);
    session.advanceTo(first.attempts[0].releaseAt);
    session.release(0, 0);
    session.advanceTo(second.startAt);
    expect(session.snapshot().players[0]!.bomb!.sequence).toBe(0);
    expect(session.release(0, 1)).toEqual({ ok: false, reason: 'active_bomb' });
    session.advanceTo(second.startAt + 1);
    const snapshot = session.snapshot();
    expect(snapshot.encounters[0]!.attempts[0]!.result).toMatchObject({ sequence: 0, points: 100 });
    expect(snapshot.encounters[1]!.attempts[0]!.result).toBeNull();
    expect(snapshot.encounters[1]!.destroyed).toBe(false);
    expect(session.release(0, 1)).toEqual({ ok: true });
  });

  it('lets the follower release and score after the first hit has already wrecked the shared target', () => {
    const plan = fixture(0), session = new HostSession(plan);
    session.advanceTo(plan.attempts[0].releaseAt);
    session.release(0, 0);
    session.advanceTo(plan.attempts[0].releaseAt + 0.3);
    expect(session.snapshot().encounters[0]!.destroyed).toBe(true);
    expect(session.release(1, 0)).toEqual({ ok: true });
    session.advanceTo(plan.handoffAt);
    expect(session.snapshot().players.map(p => p.score)).toEqual([100, 100]);
  });

  it('settles simultaneous impacts once each without replacing one result with the other', () => {
    const plan = fixture(0), session = new HostSession(plan);
    session.advanceTo(plan.attempts[1].releaseAt);
    for (const slot of slots) session.release(slot, 0);
    session.advanceTo(plan.handoffAt);
    const resolved = session.drainEvents().filter(e => e.type === 'resolved');
    expect(resolved).toHaveLength(2);
    expect(resolved[0]!.result.time).toBe(resolved[1]!.result.time);
    expect(session.snapshot().players.map(p => p.score)).toEqual([100, 100]);
    session.advanceTo(plan.handoffAt);
    expect(session.drainEvents()).toEqual([]);
  });

  it('is independent of render/update frequency including overlapping bomb physics steps', () => {
    const plan = chain('river-canyon')[0]!, a = new HostSession(plan), b = new HostSession(plan);
    for (const slot of slots) {
      const end = plan.attempts[slot].releaseAt;
      a.advanceTo(end);
      while (b.time < end) b.advanceTo(Math.min(end, b.time + 1 / 37));
      a.release(slot, 0); b.release(slot, 0);
    }
    a.advanceTo(plan.handoffAt);
    while (b.time < plan.handoffAt) b.advanceTo(Math.min(plan.handoffAt, b.time + 1 / 61));
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.drainEvents()).toEqual(b.drainEvents());
  });

  it('fails explicitly at the bomb lifetime bound rather than silently fabricating a miss', () => {
    const first = fixture(0, 100_000, 30), session = new HostSession(first);
    session.installPlan(1, fixture(1, 100_000, 30));
    session.advanceTo(first.attempts[0].releaseAt);
    session.release(0, 0);
    expect(() => session.advanceTo(session.time + 20)).toThrow('lifetime');
    expect(session.snapshot().failure!.code).toBe('bomb_lifetime');
    expect(session.snapshot().players[0]!.misses).toBe(0);
    expect(session.resume()).toEqual({ ok: false, reason: 'bomb_lifetime' });
  });

  it('applies backpressure without losing an impact, then resumes after the bounded event queue is drained', () => {
    const session = new HostSession(fixture(0));
    for (let sequence = 0; sequence < MAX_SESSION_EVENTS / 4; sequence++) {
      const plan = fixture(sequence);
      if (sequence) {
        session.installPlan(sequence, plan);
        session.advanceTo(plan.startAt + 5.5);
        session.retirePlan(sequence - 1);
      }
      const hits = sequence === MAX_SESSION_EVENTS / 4 - 1 ? [0] as const : slots;
      for (const slot of hits) {
        session.advanceTo(plan.attempts[slot].releaseAt);
        session.release(slot, sequence);
      }
      session.advanceTo(plan.handoffAt);
    }
    const sequence = MAX_SESSION_EVENTS / 4, plan = fixture(sequence);
    session.installPlan(sequence, plan);
    session.advanceTo(plan.attempts[0].releaseAt);
    session.release(0, sequence);
    expect(() => session.advanceTo(plan.handoffAt)).toThrow('Drain');
    expect(session.snapshot().players[0]!.bomb).not.toBeNull();
    const old = session.drainEvents();
    expect(old).toHaveLength(MAX_SESSION_EVENTS);
    expect(session.resume()).toEqual({ ok: true });
    session.advanceTo(plan.handoffAt);
    const events = session.drainEvents();
    expect(events.filter(e => e.type === 'resolved')).toHaveLength(2);
    expect(session.snapshot().players[0]!.score).toBe((sequence + 1) * 100);
    expect(session.snapshot().players[1]!.misses).toBe(2);
    expect(new Set([...old, ...events].map(e => e.eventId)).size).toBe(old.length + events.length);
  });
});
