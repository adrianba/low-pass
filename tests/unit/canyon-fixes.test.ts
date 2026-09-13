import { describe, expect, it } from 'vitest';
import { initialPose, planEncounter, poseAt, Run, launchFrom } from '../../src/game/run';
import { canyonSurface } from '../../src/terrain/surface';
import { chaseView, projectChase, targetInChaseView } from '../../src/simulation/chase-camera';
import type { ChaseView } from '../../src/simulation/chase-camera';
import { TARGET_RADIUS, STEP } from '../../src/config/game';
import { distance } from '../../src/simulation/math';
import { contactAccuracy, predictImpact } from '../../src/simulation/ballistics';

describe('canyon acquisition regression', () => {
  it('sees all target rings before the dive deadline on sequential courses', () => {
    const failures: object[] = [];
    for (let seed = 0; seed < 8; seed++) {
      let previous = initialPose();
      for (let count = 0; count < 40; count++) {
        const encounter = planEncounter(count, seed, previous, canyonSurface);
        const deadline = encounter.canyon!.diveAt;
        let view: ChaseView | null = null;
        for (let t = deadline - 3; t <= deadline - 0.1 + 1e-6; t += 0.1) {
          view = chaseView(poseAt(encounter, t, count), canyonSurface, view?.position ?? null, 0.1);
        }
        if (!view) throw new Error('Missing test view.');
        const screen = projectChase(encounter.target, view, 16 / 9);
        const range = distance(view.position, encounter.target);
        const occluded = [[0, 0], [-TARGET_RADIUS, 0], [TARGET_RADIUS, 0], [0, -TARGET_RADIUS], [0, TARGET_RADIUS]]
          .some(([dx, dz]) => canyonSurface.ground(view!.position,
            { x: encounter.target.x + dx!, y: encounter.target.y + 0.5, z: encounter.target.z + dz! }));
        if (!screen || screen.x < 0.05 || screen.x > 0.95 || screen.y < 0.1 || screen.y > 0.94
          || range > encounter.canyon!.sightDistance || occluded) failures.push({ seed, pass: count + 1,
          target: encounter.target, range, allowed: encounter.canyon!.sightDistance, screen, occluded });
        encounter.visibleAt = deadline - 0.3;
        previous = poseAt(encounter, encounter.canyon!.endAt, count);
      }
    }
    expect(failures.length, JSON.stringify(failures[0])).toBe(0);
  }, 30_000);
  it('retains fair release windows with interpolation, slow frames and narrow windows', () => {
    for (const frames of [[1 / 60], [1 / 30], [0.1], [1 / 60, 0.1, 1 / 30, 0.067]]) {
      for (const aspect of [0.75, 16 / 9, 32 / 9]) {
        let previous = initialPose();
        for (let count = 0; count < 24; count++) {
          const run = new Run(3, 'river-canyon');
          run.encounter = planEncounter(count, run.seed, previous, run.surface);
          const deadline = run.encounter.canyon!.diveAt;
          run.encounter.time = deadline - 3;
          let view: ChaseView | null = null, frame = 0;
          while (run.encounter.time <= deadline) {
            const dt = frames[frame++ % frames.length]!;
            view = chaseView(poseAt(run.encounter, run.encounter.time - STEP, count),
              run.surface, view?.position ?? null, dt);
            if (targetInChaseView(run.encounter.target, view, run.surface, aspect, run.encounter.canyon!.sightDistance)) {
              run.seeTarget();
              break;
            }
            run.encounter.time += dt;
          }
          expect(run.encounter.visibleAt, `pass ${count + 1}, aspect ${aspect}, frames ${frames}`).not.toBeNull();
          expect(run.encounter.visibleAt!).toBeLessThanOrEqual(deadline - 0.1);
          for (const t of [-0.03, 0, 0.03]) {
            const impact = predictImpact(launchFrom(poseAt(run.encounter, t, count)), run.surface);
            expect(contactAccuracy(impact, run.encounter.target, run.surface)).toBeGreaterThan(0);
          }
          expect(contactAccuracy(predictImpact(launchFrom(poseAt(run.encounter, 0, count)), run.surface),
            run.encounter.target, run.surface)).toBe(100);
          previous = poseAt(run.encounter, run.encounter.canyon!.endAt, count);
        }
      }
    }
  }, 30_000);
});
