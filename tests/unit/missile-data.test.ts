import { describe, expect, it, vi } from 'vitest';
import { AircraftMotion } from '../../src/game/aircraft-motion';
import { planFormation } from '../../src/game/formation/approved';
import { initialFormationPoses } from '../../src/game/formation/initial';
import { MissileFlight, MISSILE_INTERCEPT_TIME, FLYBY_DURATION, FINALE_DURATION } from '../../src/game/missile';
import { readMissilePlanData } from '../../src/game/missile-data';
import { Run } from '../../src/game/run';
import { soloFinalePlan } from '../../src/game/solo-combat';
import { chaseView } from '../../src/simulation/chase-camera';
import { initialPose } from '../../src/simulation/pose';
import { canyonSurface, surfaceFor, valleySurface } from '../../src/terrain/surface';

describe('complete numeric missile plans', () => {
  it.each(['green-valley', 'desert', 'river-canyon'] as const)('round-trips both %s aircraft and every missile kind across sequential tiers', terrain => {
    let previous = initialFormationPoses(terrain), startAt = 0;
    let previousViews: Parameters<typeof planFormation>[0]['previousViews'] = [null, null];
    for (let count = 0; count < 15; count++) {
      const result = planFormation({ terrain, count, seed: 7, startAt, previous, previousViews, encounterId: `missile-${count}` });
      if (!result.ok) throw new Error(JSON.stringify(result.failures));
      const plan = result.plan;
      for (const slot of [0, 1] as const) for (const kind of ['flyby', 'damage', 'finale'] as const) {
        const time = plan.attempts[slot].releaseAt + 2.2;
        const motion = AircraftMotion.fromFormation(plan, slot, time);
        const view = { ...plan.attempts[slot].camera.at(time - plan.attempts[slot].releaseAt),
          aspect: count % 2 ? 0.75 : 16 / 9, range: 2200 };
        const authored = new MissileFlight(kind, motion.at(0), motion.at(MISSILE_INTERCEPT_TIME).position,
          slot ? -1 : 1, surfaceFor(terrain), motion, view);
        const wire = JSON.stringify(authored.toData()), imported = MissileFlight.fromData(JSON.parse(wire));
        expect(imported.toData()).toEqual(authored.toData());
        expect(imported.launch).toEqual(authored.launch);
        expect(imported.intercept).toEqual(authored.intercept);
        for (const age of [0, 0.05, 0.25, 0.7, 1.5, MISSILE_INTERCEPT_TIME, 2, FLYBY_DURATION, FINALE_DURATION]) {
          expect(imported.positionAt(age)).toEqual(authored.positionAt(age));
        }
        for (const dt of [0, 0.01, 0.69, 1, 0, FLYBY_DURATION, FINALE_DURATION]) {
          expect(imported.advance(dt)).toEqual(authored.advance(dt));
          expect(imported.aircraftPose()).toEqual(authored.aircraftPose());
          expect(imported.finalePhase).toBe(authored.finalePhase);
          expect(imported.finished).toBe(authored.finished);
        }
      }
      startAt = plan.handoffAt;
      previous = [plan.attempts[0].track.at(startAt - plan.attempts[0].releaseAt),
        plan.attempts[1].track.at(startAt - plan.attempts[1].releaseAt)];
      previousViews = [plan.attempts[0].camera.at(startAt - plan.attempts[0].releaseAt),
        plan.attempts[1].camera.at(startAt - plan.attempts[1].releaseAt)];
    }
  }, 120_000);

  it('imports without terrain selection, freezes nested data and owns every returned pose', () => {
    const run = new Run(7, 'river-canyon');
    run.encounter.time = 2.2;
    const plan = soloFinalePlan(run.pose, run, { ...chaseView(run.pose, run.surface, null, 0), aspect: 16 / 9, range: 2200 });
    const ground = vi.spyOn(canyonSurface, 'ground').mockImplementation(() => { throw new Error('Unexpected terrain selection.'); });
    try {
      const wire = JSON.parse(JSON.stringify(plan)), imported = MissileFlight.fromData(wire);
      const before = imported.aircraftPose();
      wire.motion.start.position.y += 500;
      wire.curve.plan.launch.y += 500;
      imported.start.position.y += 400;
      imported.aircraftPose().velocity.z = 0;
      imported.aircraftPose().acceleration.x = 100;
      expect(imported.aircraftPose()).toEqual(before);
      expect(imported.toData()).toEqual(plan);
      expect(Reflect.set(imported.launch, 'y', 500)).toBe(false);
      expect(Object.isFrozen(imported.toData().motion.start.position)).toBe(true);
      expect(imported.positionAt(-1)).toEqual(imported.positionAt(0));
      expect(ground).not.toHaveBeenCalled();
    } finally { ground.mockRestore(); }
  });

  it('preserves the original Valley quadratic, extension and tangent finale without reselection', () => {
    const start = initialPose(), plan = soloFinalePlan(start), flight = MissileFlight.fromData(plan);
    const launch = { x: start.position.x + 100, y: valleySurface.height(100, 210) + 2, z: start.position.z + 210 };
    const intercept = { x: start.position.x, y: start.position.y, z: start.position.z + start.velocity.z * MISSILE_INTERCEPT_TIME };
    const control = { x: (launch.x + intercept.x) / 2, y: Math.max(launch.y + 55, intercept.y * 0.7),
      z: (launch.z + intercept.z) / 2 };
    for (const age of [0, 0.5, 1.7, 2.8]) {
      const t = age / MISSILE_INTERCEPT_TIME, u = Math.min(t, 1), v = 1 - u;
      for (const axis of ['x', 'y', 'z'] as const) {
        let expected = v * v * launch[axis] + 2 * v * u * control[axis] + u * u * intercept[axis];
        if (t > 1) expected += 2 * (intercept[axis] - control[axis]) * (t - 1);
        expect(flight.positionAt(age)[axis]).toBe(expected);
      }
    }
  });

  it('rejects malformed fields, mismatched Canyon timing and invalid clock inputs explicitly', () => {
    const data = soloFinalePlan(initialPose());
    for (const value of [null, [], { ...data, version: 2 }, { ...data, kind: 'unknown' }, { ...data, side: 0 },
      { ...data, motion: null }, { ...data, curve: { kind: 'unknown' } },
      { ...data, curve: { ...data.curve, control: { x: NaN, y: 0, z: 0 } } }]) {
      expect(() => readMissilePlanData(value)).toThrow();
    }
    const run = new Run(7, 'river-canyon');
    run.encounter.time = 2.2;
    const canyon = soloFinalePlan(run.pose, run, { ...chaseView(run.pose, run.surface, null, 0), aspect: 16 / 9, range: 2200 });
    if (canyon.curve.kind !== 'canyon') throw new Error('Expected Canyon curve.');
    const curve = canyon.curve;
    expect(() => readMissilePlanData({ ...canyon, motion: data.motion })).toThrow('motion or timing');
    expect(() => readMissilePlanData({ ...canyon, curve: { ...curve, plan: { ...curve.plan, arrival: 2 } } }))
      .toThrow('motion or timing');
    const flight = MissileFlight.fromData(data);
    for (const time of [-1, NaN, Infinity]) expect(() => flight.advance(time)).toThrow('time');
    for (const time of [NaN, Infinity, Number.MAX_VALUE]) expect(() => flight.positionAt(time)).toThrow();
    expect(flight.age).toBe(0);
  });
});
