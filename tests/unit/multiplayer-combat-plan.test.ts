import { describe, expect, it } from 'vitest';
import { MAX_MISSES } from '../../src/config/game';
import { FLYBY_CLEARANCE, MISSILE_INTERCEPT_TIME } from '../../src/game/combat-timing';
import { MissileFlight, shouldFlyby } from '../../src/game/missile';
import { authorCombatPlan, readCombatPlanData } from '../../src/game/multiplayer/combat-plan';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler';
import { latestBombSettlement } from '../../src/game/multiplayer/schedule-bounds';
import { distance } from '../../src/simulation/math';
import { surfaceFor } from '../../src/terrain/surface';

describe('host-authored per-player combat events', () => {
  it.each(['green-valley', 'desert', 'river-canyon'] as const)('authors both %s damage sequences and finales from the result-time state', terrain => {
    const scheduler = new FormationScheduler(terrain, 7), surface = surfaceFor(terrain);
    for (let sequence = 0; sequence < MAX_MISSES; sequence++) {
      const plan = scheduler.plan();
      scheduler.advanceTo(plan.handoffAt);
      const results = scheduler.session.drainEvents().filter(e => e.type === 'resolved');
      expect(results).toHaveLength(2);
      for (const { result } of results) {
        expect(result.misses).toBe(sequence + 1);
        expect(result.score).toBe(0);
        const attempt = plan.attempts[result.slot];
        const view = { ...attempt.camera.at(result.time - attempt.releaseAt), aspect: sequence % 2 ? 0.75 : 16 / 9, range: 2200 };
        const event = authorCombatPlan(result, plan, 7, view)!;
        expect(event).toMatchObject({ id: result.id, slot: result.slot, sequence, bornAt: result.time,
          damageLevel: Math.min(2, sequence + 1) });
        expect(event.missile.kind).toBe(sequence === 2 ? 'finale' : 'damage');
        const imported = readCombatPlanData(JSON.parse(JSON.stringify(event)));
        expect(imported).toEqual(event);
        const flight = MissileFlight.fromData(imported.missile);
        expect(flight.advance(MISSILE_INTERCEPT_TIME)).toBe(sequence === 2 ? 'destroyed' : 'damaged');
        expect(distance(flight.positionAt(MISSILE_INTERCEPT_TIME), flight.aircraftPose().position)).toBeLessThan(1e-8);
        if (terrain === 'river-canyon') {
          expect(flight.launch.y).toBeCloseTo(20, 5);
          expect(surface.wet(flight.launch.x, flight.launch.z)).toBe(false);
        }
      }
    }
    expect(scheduler.session.status).toBe('over');
  });

  it.each(['green-valley', 'river-canyon'] as const)('authors independent harmless first-hit flybys in %s', terrain => {
    const scheduler = new FormationScheduler(terrain, 7), plan = scheduler.plan();
    for (const slot of [0, 1] as const) {
      scheduler.advanceTo(plan.attempts[slot].releaseAt);
      scheduler.session.release(slot, 0);
    }
    scheduler.advanceTo(plan.handoffAt);
    const results = scheduler.session.drainEvents().filter(e => e.type === 'resolved');
    expect(results).toHaveLength(2);
    for (const { result } of results) {
      const attempt = plan.attempts[result.slot];
      const view = { ...attempt.camera.at(result.time - attempt.releaseAt), aspect: 16 / 9, range: 2200 };
      const event = authorCombatPlan(result, plan, 7, view)!;
      expect(event.missile.kind).toBe('flyby');
      expect(event.damageLevel).toBe(0);
      const flight = MissileFlight.fromData(event.missile);
      flight.advance(MISSILE_INTERCEPT_TIME);
      expect(distance(flight.positionAt(MISSILE_INTERCEPT_TIME), flight.aircraftPose().position)).toBeGreaterThan(FLYBY_CLEARANCE);
    }
    expect(results.map(e => e.result.score)).toEqual([100, 100]);
    expect(scheduler.session.snapshot().players.every(p => p.misses === 0)).toBe(true);
  });

  it('uses the current flight continuation but preserves the old encounter identity for a late bomb', () => {
    const scheduler = new FormationScheduler('green-valley', 7), old = scheduler.plan();
    scheduler.advanceTo(old.attempts[1].cutoffAt);
    scheduler.session.release(1, 0);
    scheduler.advanceTo(latestBombSettlement(old, 1));
    const result = scheduler.session.drainEvents().find(e => e.type === 'resolved' && e.result.slot === 1);
    if (!result || result.type !== 'resolved') throw new Error('Missing late result.');
    expect(scheduler.sequence).toBe(1);
    const current = scheduler.plan(), event = authorCombatPlan(result.result, current, 7)!;
    expect(event.sequence).toBe(0);
    const flight = MissileFlight.fromData(event.missile);
    flight.advance(MISSILE_INTERCEPT_TIME);
    const expected = current.attempts[1].track.at(result.result.time - current.attempts[1].releaseAt + MISSILE_INTERCEPT_TIME);
    expect(flight.aircraftPose().position).toEqual(expected.position);
    expect(flight.intercept).toEqual(expected.position);
  });

  it('validates identity before a no-flyby decision and rejects missing Canyon cameras', () => {
    const scheduler = new FormationScheduler('river-canyon', 7), plan = scheduler.plan();
    const result = { id: 1, slot: 0 as const, sequence: 0, time: plan.attempts[0].releaseAt + 2.2,
      points: 100, score: 100, misses: 0, assisted: false,
      impact: { ...plan.target, kind: 'ground' as const, normal: { x: 0, y: 1, z: 0 } } };
    expect(() => authorCombatPlan(result, plan, 7)).toThrow('chase view');
    const sequence = Array.from({ length: 40 }, (_, i) => i + 1).find(i => !shouldFlyby(i + 1, 7))!;
    expect(authorCombatPlan({ ...result, sequence, id: sequence * 2 + 1 }, plan, 7)).toBeNull();
    expect(() => authorCombatPlan({ ...result, sequence, id: 0 }, plan, 7)).toThrow('result');
    expect(() => authorCombatPlan({ ...result, points: 0, misses: 0 }, plan, 7)).toThrow('result');
  });

  it('rejects malformed event envelopes and preserves owned nested data', () => {
    const scheduler = new FormationScheduler('green-valley', 7), plan = scheduler.plan();
    scheduler.advanceTo(plan.handoffAt);
    const resolved = scheduler.session.drainEvents().find(e => e.type === 'resolved')!;
    const event = authorCombatPlan(resolved.result, plan, 7)!;
    for (const value of [null, [], { ...event, version: 2 }, { ...event, id: 0 }, { ...event, slot: 2 },
      { ...event, sequence: -1 }, { ...event, bornAt: NaN }, { ...event, damageLevel: 3 },
      { ...event, damageLevel: 0 }, { ...event, missile: { ...event.missile, kind: 'finale' } }]) {
      expect(() => readCombatPlanData(value)).toThrow();
    }
    const wire = JSON.parse(JSON.stringify(event)), imported = readCombatPlanData(wire);
    wire.missile.motion.start.position.y = 10000;
    expect(imported).toEqual(event);
    expect(Reflect.set(imported, 'slot', 1)).toBe(false);
    expect(Reflect.set(imported.missile.motion.start.position, 'y', 1000)).toBe(false);
  });
});
