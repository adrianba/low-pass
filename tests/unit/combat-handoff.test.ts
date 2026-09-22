import { describe, expect, it } from 'vitest';
import { AircraftMotion } from '../../src/game/aircraft-motion';
import { FLYBY_DURATION, MISSILE_INTERCEPT_TIME } from '../../src/game/combat-timing';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler';
import { authorCombatPlan } from '../../src/game/multiplayer/combat-plan';
import { MissileFlight } from '../../src/game/missile';
import { distance } from '../../src/simulation/math';
import { surfaceFor } from '../../src/terrain/surface';

describe('combat through shared course handoffs', () => {
  it.each(['green-valley', 'desert', 'river-canyon'] as const)('meets the actual next %s track for both surviving aircraft', terrain => {
    const scheduler = new FormationScheduler(terrain, 7);
    for (let sequence = 0; sequence < 15; sequence++) {
      const plan = scheduler.plan(), next = scheduler.plan(sequence + 1), bornAt = plan.handoffAt - 0.75;
      for (const slot of [0, 1] as const) {
        const result = { id: sequence * 2 + slot + 1, slot, sequence, time: bornAt,
          points: 0, score: sequence * 100, misses: 1, assisted: false, impact: null };
        const view = { ...plan.attempts[slot].camera.at(bornAt - plan.attempts[slot].releaseAt), aspect: 16 / 9, range: 2200 };
        expect(() => authorCombatPlan(result, plan, 7, view)).toThrow('next scheduled');
        const event = authorCombatPlan(result, plan, 7, view, undefined, next)!;
        const motion = AircraftMotion.fromData(JSON.parse(JSON.stringify(event.missile.motion)));
        for (const age of [0, 0.1, 0.749, 0.75, 0.751, MISSILE_INTERCEPT_TIME, FLYBY_DURATION]) {
          const source = bornAt + age >= next.startAt ? next : plan;
          const expected = source.attempts[slot].track.at(bornAt + age - source.attempts[slot].releaseAt);
          const actual = motion.at(age);
          for (const key of ['position', 'velocity', 'acceleration'] as const) {
            expect(distance(actual[key], expected[key])).toBeLessThan(1e-7);
          }
        }
        const flight = MissileFlight.fromData(event.missile);
        flight.advance(MISSILE_INTERCEPT_TIME);
        const actualAircraft = next.attempts[slot].track.at(bornAt + MISSILE_INTERCEPT_TIME - next.attempts[slot].releaseAt);
        expect(distance(flight.intercept, actualAircraft.position)).toBeLessThan(1e-7);
        const flyby = new MissileFlight('flyby', motion.at(0), motion.at(MISSILE_INTERCEPT_TIME).position,
          slot ? -1 : 1, surfaceFor(terrain), motion, view);
        for (let i = 0; i <= 28; i++) {
          const age = i / 10, aircraft = motion.at(age).position;
          expect(distance(flyby.positionAt(age, aircraft), aircraft)).toBeGreaterThanOrEqual(18 - 1e-8);
        }
      }
      for (const slot of [0, 1] as const) {
        scheduler.advanceTo(plan.attempts[slot].releaseAt); scheduler.session.release(slot, sequence);
      }
      scheduler.advanceTo(plan.handoffAt); scheduler.session.drainEvents();
    }
  }, 120_000);

  it('keeps finales frozen on their safe continuation instead of resuming a dead pilot on the next track', () => {
    const scheduler = new FormationScheduler('green-valley', 7), plan = scheduler.plan(), next = scheduler.plan(1);
    const time = plan.handoffAt - 0.75, slot = 0;
    const result = { id: 5, sequence: 2, slot, time, points: 0, score: 0, misses: 3, assisted: false, impact: null } as const;
    const event = authorCombatPlan(result, plan, 7, undefined, undefined, next)!;
    const motion = AircraftMotion.fromData(event.missile.motion);
    expect(motion.at(1.7)).toEqual(AircraftMotion.fromFormation(plan, slot, time).at(1.7));
    expect(distance(motion.at(1.7).position, next.attempts[slot].track.at(time + 1.7 - next.attempts[slot].releaseAt).position))
      .toBeGreaterThan(0.001);
  });

  it('rejects malformed or discontinuous imported handoffs', () => {
    const scheduler = new FormationScheduler('green-valley', 7), plan = scheduler.plan(), next = scheduler.plan(1);
    const data = AircraftMotion.fromFormation(plan, 0, plan.handoffAt - 0.5, undefined, next).toData();
    if (data.kind !== 'track' || !data.next) throw new Error('Missing numeric handoff.');
    const handoff = data.next;
    for (const invalid of [
      { ...data, next: { ...handoff, age: -1 } },
      { ...data, next: { ...handoff, offset: handoff.offset - 10 } },
      { ...data, next: { ...handoff, from: handoff.from + 1 } },
      { ...data, next: { ...handoff, track: { ...handoff.track, knots: handoff.track.knots.map((k, i) => i ? k :
        { ...k, pose: { ...k.pose, velocity: { ...k.pose.velocity, x: k.pose.velocity.x + 1 } } }) } } },
    ]) expect(() => AircraftMotion.fromData(invalid)).toThrow();
  });
});
