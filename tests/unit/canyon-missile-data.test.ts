import { describe, expect, it, vi } from 'vitest';
import { Run, poseAt, planEncounter } from '../../src/game/run';
import { CanyonMissilePlan, planCanyonMissile } from '../../src/game/canyon-missile';
import { readCanyonMissileData } from '../../src/game/canyon-missile-data';
import { FLYBY_CLEARANCE, FLYBY_DURATION, MISSILE_INTERCEPT_TIME } from '../../src/game/missile';
import { chaseView } from '../../src/simulation/chase-camera';
import { canyonSurface } from '../../src/terrain/surface';

function plan() {
  const run = new Run(7, 'river-canyon');
  run.encounter.time = 2.2;
  return planCanyonMissile({ kind: 'flyby', side: 1, surface: run.surface,
    aircraftAt: age => poseAt(run.encounter, 2.2 + age, 0),
    view: { ...chaseView(run.pose, run.surface, null, 0), aspect: 16 / 9, range: 2200 },
    interceptTime: MISSILE_INTERCEPT_TIME, duration: FLYBY_DURATION, clearance: FLYBY_CLEARANCE });
}

describe('numeric Canyon missile curves', () => {
  it('round-trips all outcome paths at arbitrary times through sequential tiers', () => {
    const run = new Run(7, 'river-canyon');
    let previous = run.pose;
    for (let count = 0; count < 15; count++) {
      const encounter = planEncounter(count, 7, previous, canyonSurface);
      const motion = (age: number) => poseAt(encounter, 2.2 + age, count);
      const view = { ...chaseView(motion(0), canyonSurface, null, 0), aspect: 16 / 9, range: 2200 };
      for (const kind of ['damage', 'finale', 'flyby'] as const) {
        const authored = planCanyonMissile({ kind, side: count % 2 ? -1 : 1, surface: canyonSurface,
          aircraftAt: motion, view, interceptTime: MISSILE_INTERCEPT_TIME, duration: FLYBY_DURATION, clearance: FLYBY_CLEARANCE });
        const encoded = JSON.stringify(authored.toData()), imported = CanyonMissilePlan.fromData(JSON.parse(encoded));
        expect(encoded.length).toBeLessThan(700);
        expect(imported.launch).toEqual(authored.launch);
        expect(imported.intercept).toEqual(authored.intercept);
        for (let index = 0; index <= 280; index++) {
          expect(imported.positionAt(index / 100)).toEqual(authored.positionAt(index / 100));
        }
      }
      previous = poseAt(encounter, encounter.canyon!.endAt, count);
    }
  });

  it('imports without rerunning terrain/launch selection and owns all returned data', () => {
    const authored = plan(), wire = JSON.parse(JSON.stringify(authored.toData()));
    const ground = vi.spyOn(canyonSurface, 'ground').mockImplementation(() => { throw new Error('Unexpected terrain selection.'); });
    try {
      const imported = CanyonMissilePlan.fromData(wire), before = imported.positionAt(0.8);
      wire.launch.y += 500; wire.targetAlong += 500;
      expect(imported.positionAt(0.8)).toEqual(before);
      const data = imported.toData();
      expect(Object.isFrozen(data)).toBe(true);
      expect(Object.isFrozen(data.launch)).toBe(true);
      expect(Reflect.set(data.launch, 'y', 1000)).toBe(false);
      const point = imported.positionAt(0.8); point.x += 500;
      expect(imported.positionAt(0.8)).toEqual(before);
      expect(imported.positionAt(-1)).toEqual(imported.positionAt(0));
      expect(ground).not.toHaveBeenCalled();
    } finally { ground.mockRestore(); }
  });

  it('rejects malformed, nonfinite and degenerate data and query times explicitly', () => {
    const authored = plan(), data = authored.toData();
    for (const value of [null, [], { ...data, version: 2 }, { ...data, power: 1 },
      { ...data, arrival: 0 }, { ...data, duration: data.arrival },
      { ...data, duration: 31 }, { ...data, forward: -1 },
      { ...data, targetAlong: Infinity }, { ...data, lateral: 1e10 },
      { ...data, intercept: { x: 0, y: NaN, z: 0 } }]) {
      expect(() => CanyonMissilePlan.fromData(value)).toThrow();
    }
    for (const value of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) expect(() => authored.positionAt(value)).toThrow(/query time/);
    const zero = readCanyonMissileData({ ...data, lateral: -0 });
    expect(Object.is(zero.lateral, -0)).toBe(false);
  });
});
