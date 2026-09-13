import { describe, expect, it } from 'vitest';
import { FLOOR, STEP } from '../../src/config/game';
import { Run, planEncounter, poseAt } from '../../src/game/run';
import { MissileFlight, MISSILE_INTERCEPT_TIME, FLYBY_DURATION, FLYBY_CLEARANCE } from '../../src/game/missile';
import { chaseView, projectChase } from '../../src/simulation/chase-camera';
import type { ChaseView } from '../../src/simulation/chase-camera';
import { distance } from '../../src/simulation/math';
import { projectRoute } from '../../src/terrain/canyon-route';

describe('canyon-floor missiles', () => {
  it('requires explicit future motion and a camera for canyon planning', () => {
    const run = new Run(7, 'river-canyon');
    expect(() => new MissileFlight('damage', run.pose, run.pose.position, 1, run.surface)).toThrow('aircraft motion and a chase view');
  });
  it('selects reproducible low paths, joins flyby exits smoothly, and rejects invisible sites explicitly', () => {
    const run = new Run(7, 'river-canyon');
    run.encounter.time = 2.2;
    const motion = (age: number) => poseAt(run.encounter, 2.2 + age, 0);
    const view = { ...chaseView(run.pose, run.surface, null, 0), aspect: 16 / 9, range: 1500 };
    const create = () => new MissileFlight('flyby', run.pose, motion(MISSILE_INTERCEPT_TIME).position,
      1, run.surface, motion, view);
    const first = create(), second = create();
    expect(first.launch).toEqual(second.launch);
    for (const age of [0, 0.25, 1.5, 1.7, 2, 2.8]) expect(first.positionAt(age)).toEqual(second.positionAt(age));
    const h = 0.0001, t = MISSILE_INTERCEPT_TIME;
    const left = first.positionAt(t - h), center = first.positionAt(t), right = first.positionAt(t + h);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(Math.abs((right[axis] - center[axis]) / h - (center[axis] - left[axis]) / h)).toBeLessThan(0.05);
    }
    view.target = { ...view.position, y: view.position.y + 100 };
    expect(create).toThrow('Cannot plan a canyon-floor flyby missile');
  });
  it('rises from visible dry banks across tiers, bends, outcomes and both bank preferences', () => {
    let cases = 0, longest = 0;
    const banks = new Set<number>();
    for (const seed of [3, 7]) {
      const run = new Run(seed, 'river-canyon');
      let previous = run.pose;
      for (let count = 0; count < 20; count++) {
        const encounter = planEncounter(count, seed, previous, run.surface);
        for (const time of [encounter.canyon!.diveAt + 0.2, -1, 0, 2.2, encounter.canyon!.cutoffAt,
          encounter.canyon!.endAt - 1, (encounter.time + encounter.canyon!.acquireAt) / 2]) {
          const motion = (age: number) => poseAt(encounter, time + age, count);
          let camera: ChaseView | null = null;
          for (let t = time - 2; t < time; t += 0.1) camera = chaseView(poseAt(encounter, t, count), run.surface, camera?.position ?? null, 0.1);
          const view = { ...camera!, aspect: count % 2 ? 0.75 : 16 / 9, range: 2200 };
          for (const kind of ['damage', 'finale', 'flyby'] as const) for (const side of [-1, 1]) {
            const started = performance.now();
            const flight = new MissileFlight(kind, motion(0), motion(MISSILE_INTERCEPT_TIME).position, side, run.surface, motion, view);
            longest = Math.max(longest, performance.now() - started);
            banks.add(Math.sign(projectRoute(flight.launch.x, flight.launch.z).lateral));
            expect(flight.launch.y).toBeCloseTo(FLOOR + 8, 4);
            expect(run.surface.wet(flight.launch.x, flight.launch.z)).toBe(false);
            expect(run.surface.normal(flight.launch.x, flight.launch.z).y).toBeGreaterThan(0.99);
            const screen = projectChase(flight.launch, view, view.aspect)!;
            expect(screen.x).toBeGreaterThan(0.04); expect(screen.x).toBeLessThan(0.96);
            expect(screen.y).toBeGreaterThan(0.06); expect(screen.y).toBeLessThan(0.96);
            expect(run.surface.ground(view.position, flight.launch)).toBeNull();
            let height = flight.launch.y;
            for (let age = 0; age <= (kind === 'flyby' ? FLYBY_DURATION : MISSILE_INTERCEPT_TIME); age += STEP * 2) {
              const p = flight.positionAt(age), aircraft = motion(age);
              expect(p.y).toBeGreaterThanOrEqual(height - 1e-8);
              expect(p.y - run.surface.height(p.x, p.z)).toBeGreaterThan(3.4);
              if (kind !== 'flyby' && age < MISSILE_INTERCEPT_TIME - 0.001) expect(p.y).toBeLessThan(aircraft.position.y);
              if (kind === 'flyby') expect(distance(p, aircraft.position)).toBeGreaterThan(FLYBY_CLEARANCE + 2);
              height = p.y;
            }
            if (kind !== 'flyby') {
              expect(distance(flight.positionAt(MISSILE_INTERCEPT_TIME), motion(MISSILE_INTERCEPT_TIME).position)).toBeLessThan(1e-7);
              const vy = (flight.positionAt(MISSILE_INTERCEPT_TIME).y - flight.positionAt(MISSILE_INTERCEPT_TIME - 0.0001).y) / 0.0001;
              expect(vy).toBeGreaterThan(motion(MISSILE_INTERCEPT_TIME).velocity.y);
            } else expect(flight.intercept.y - motion(MISSILE_INTERCEPT_TIME).position.y).toBeCloseTo(12, 10);
            cases++;
          }
        }
        previous = poseAt(encounter, encounter.canyon!.endAt, count);
      }
    }
    expect(banks.size).toBe(2);
    console.info('Low-bank missile cases and maximum planner milliseconds', cases, longest);
  }, 120_000);
});
