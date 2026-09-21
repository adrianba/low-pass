import { describe, expect, it } from 'vitest';
import { AircraftMotion } from '../../src/game/aircraft-motion';
import { FLYBY_DURATION, MISSILE_INTERCEPT_TIME } from '../../src/game/combat-timing';
import { planFormation } from '../../src/game/formation/approved';
import { initialFormationPoses } from '../../src/game/formation/initial';
import { Run, poseAt } from '../../src/game/run';
import { joinMotion } from '../../src/simulation/curves';
import { initialPose } from '../../src/simulation/pose';
import type { Pose } from '../../src/simulation/pose';

const ages = [0, 0.01, 0.05, 0.1, 0.7, MISSILE_INTERCEPT_TIME, 2, FLYBY_DURATION];

function legacyContinuation(start: Pose, run: Run, age: number): Pose {
  const initial = run.pose, next = poseAt(run.encounter, run.encounter.time + age, run.encounter.id - 1);
  for (const axis of ['x', 'y', 'z'] as const) {
    const correction = joinMotion({
      position: start.position[axis] - initial.position[axis],
      velocity: start.velocity[axis] - initial.velocity[axis],
      acceleration: start.acceleration[axis] - initial.acceleration[axis],
    }, { position: 0, velocity: 0, acceleration: 0 }, MISSILE_INTERCEPT_TIME, age);
    next.position[axis] += correction.position;
    next.velocity[axis] += correction.velocity;
    next.acceleration[axis] += correction.acceleration;
  }
  next.bank = start.bank + (next.bank - start.bank) * Math.min(1, age / 0.1);
  next.pitch = start.pitch + (next.pitch - start.pitch) * Math.min(1, age / 0.1);
  return next;
}

describe('frozen numeric combat aircraft motion', () => {
  it('owns tangent source and returned poses while preserving the legacy continuation', () => {
    const start = initialPose(), original = structuredClone(start), motion = AircraftMotion.tangent(start);
    start.position.z += 100;
    start.velocity.x = 100;
    for (const age of ages) {
      const expected = structuredClone(original);
      for (const axis of ['x', 'y', 'z'] as const) expected.position[axis] += expected.velocity[axis] * age;
      expect(motion.at(age)).toEqual(expected);
    }
    motion.at(0).acceleration.y = 200;
    expect(motion.at(0)).toEqual(original);
    const imported = AircraftMotion.fromData(JSON.parse(JSON.stringify(motion.toData())));
    for (const age of ages) expect(imported.at(age)).toEqual(motion.at(age));
  });

  it('preserves solo Canyon entry joins and full-motion corrections without borrowing a live Run', () => {
    const run = new Run(7, 'river-canyon');
    const times = [run.encounter.time, run.encounter.canyon!.entryEnd - 0.1, 0, 2.2, run.encounter.canyon!.endAt];
    const anchors = structuredClone(run.encounter.canyon!.track.knots);
    for (const time of times) {
      run.encounter.time = time;
      const start = run.pose;
      start.position.x += 0.2; start.velocity.y -= 0.3; start.acceleration.z += 0.1;
      start.bank += 0.01; start.pitch -= 0.02;
      const expected = ages.map(age => legacyContinuation(start, run, age));
      const motion = AircraftMotion.fromSoloCanyon(start, run.encounter);
      const imported = AircraftMotion.fromData(JSON.parse(JSON.stringify(motion.toData())));
      run.encounter.time += 100;
      start.position.y = 1000;
      for (const [i, age] of ages.entries()) {
        expect(motion.at(age)).toEqual(expected[i]);
        expect(imported.at(age)).toEqual(expected[i]);
      }
      const detached = motion.at(0);
      detached.position.x += 500;
      detached.velocity.y = 500;
      expect(motion.at(0)).toEqual(expected[0]);
    }
    expect(run.encounter.canyon!.track.knots).toEqual(anchors);
  });

  it.each(['green-valley', 'desert', 'river-canyon'] as const)('retains both authored %s attitude evaluators through JSON', terrain => {
    const result = planFormation({ terrain, seed: 7, count: 0, encounterId: 'combat-motion-0', startAt: 0,
      previous: initialFormationPoses(terrain), previousViews: [null, null] });
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    const plan = result.plan;
    for (const slot of [0, 1] as const) for (const startAt of [plan.startAt, plan.attempts[slot].releaseAt, plan.handoffAt]) {
      const motion = AircraftMotion.fromFormation(plan, slot, startAt);
      const imported = AircraftMotion.fromData(JSON.parse(JSON.stringify(motion.toData())));
      for (const age of ages) {
        const expected = plan.attempts[slot].track.at(startAt - plan.attempts[slot].releaseAt + age);
        // The original 0.1-second attitude join starts at the exact supplied pose.
        if (age >= 0.1 || age === 0) {
          expect(motion.at(age).position).toEqual(expected.position);
          expect(motion.at(age).velocity).toEqual(expected.velocity);
          expect(motion.at(age).acceleration).toEqual(expected.acceleration);
          expect(motion.at(age).bank).toBeCloseTo(expected.bank, 14);
          expect(motion.at(age).pitch).toBeCloseTo(expected.pitch, 14);
        }
        expect(imported.at(age)).toEqual(motion.at(age));
      }
    }
  });

  it('rejects malformed versions, joins, coverage, vectors and query ages explicitly', () => {
    const run = new Run(7, 'river-canyon'), motion = AircraftMotion.fromSoloCanyon(run.pose, run.encounter), data = motion.toData();
    if (data.kind !== 'track') throw new Error('Expected track data.');
    for (const invalid of [
      null, [], { ...data, version: 2 }, { ...data, kind: 'unknown' }, { ...data, style: 'unknown' },
      { ...data, offset: NaN }, { ...data, offset: data.track.knots.at(-1)!.time },
      { ...data, entry: { ...data.entry, endAt: data.entry!.startAt } },
      { ...data, start: { ...data.start, velocity: { x: Infinity, y: 0, z: 0 } } },
    ]) expect(() => AircraftMotion.fromData(invalid)).toThrow();
    for (const age of [-1, NaN, Infinity, FLYBY_DURATION + 0.001]) expect(() => motion.at(age)).toThrow('age');
    expect(Reflect.set(data.start.position, 'x', 100)).toBe(false);
    expect(Reflect.set(data.track.knots, '0', null)).toBe(false);
    expect(() => AircraftMotion.fromSoloCanyon(initialPose(), new Run().encounter)).toThrow('Missing solo');
  });
});
