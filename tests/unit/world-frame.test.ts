import { describe, expect, it } from 'vitest';
import { Run } from '../../src/game/run';
import { soloTargetFrame, soloWorldFrame } from '../../src/rendering/solo-frame';
import { contactAccuracy } from '../../src/simulation/ballistics';
import { hash } from '../../src/simulation/math';
import { shouldFlyby } from '../../src/game/missile';
import { targetSightDistance } from '../../src/config/game';

describe('solo render-frame boundary', () => {
  it.each(['green-valley', 'desert', 'river-canyon'] as const)(
    'owns frozen %s presentation data without freezing the simulation', terrain => {
      const run = new Run(7, terrain);
      run.encounter.time = run.encounter.canyon?.acquireAt ?? -6;
      run.seeTarget();
      run.encounter.time = 0;
      const pose = run.pose, prediction = run.prediction;
      const ready = soloWorldFrame(run, pose, prediction);
      expect(ready.ready).toBe(true);
      expect(ready.prediction?.hit).toBe(contactAccuracy(prediction, run.encounter.target, run.surface) > 0);
      expect(ready.target).toEqual({
        id: run.encounter.id, position: run.encounter.target, kind: run.encounter.targetKind,
        heading: hash(run.encounter.id, 7, run.seed) * Math.PI * 2,
        sightDistance: run.encounter.canyon?.sightDistance ?? targetSightDistance(0),
        canyon: run.surface.canyon,
      });
      expect(run.release()).toBe(true);
      const bomb = soloWorldFrame(run, pose, prediction);
      expect(bomb.ready).toBe(false);
      expect(bomb.aircraft.released).toBe(true);
      expect(bomb.aircraft.bomb).toEqual(run.bomb);
      expect(bomb.aircraft.bomb).not.toBe(run.bomb);
      const saved = structuredClone(bomb);
      expect(Reflect.set(bomb.aircraft.pose.position, 'x', 1000)).toBe(false);
      expect(Reflect.set(bomb.aircraft.bomb!.velocity, 'y', 1000)).toBe(false);
      expect(Reflect.set(bomb.target.position, 'z', 1000)).toBe(false);
      expect(Reflect.set(bomb.prediction!.position, 'x', 1000)).toBe(false);
      pose.position.x += 1;
      prediction.z += 1;
      run.tick(false);
      expect(bomb).toEqual(saved);
      expect(Object.isFrozen(run.bomb)).toBe(false);
      expect(Object.isFrozen(run.encounter.target)).toBe(false);

      for (let tick = 0; tick < 2000 && !run.result; tick++) run.tick(false);
      expect(run.result?.points).toBe(100);
      const result = soloWorldFrame(run, run.pose, null);
      expect(result.result).toEqual({ ...run.result, flyby: shouldFlyby(run.encounter.id, run.seed) });
      expect(result.result!.impact).not.toBe(run.result!.impact);
      expect(Reflect.set(result.result!.impact!.normal, 'y', 0)).toBe(false);
      expect(Object.isFrozen(run.result!.impact!.normal)).toBe(false);
    });

  it.each(['green-valley', 'desert', 'river-canyon'] as const)(
    'leaves exact %s simulation, scores and events unchanged through hits, misses and ending', terrain => {
      const rendered = new Run(19, terrain), control = new Run(19, terrain);
      const state = (run: Run) => ({
        pose: run.pose, status: run.status, bomb: run.bomb, result: run.result, score: run.score,
        misses: run.misses, resolved: run.resolved, assisted: run.assisted, events: run.events,
        id: run.encounter.id, time: run.encounter.time, released: run.encounter.released,
      });
      for (let tick = 0; tick < 30_000 && control.status !== 'over'; tick++) {
        for (const run of [rendered, control]) {
          if (run.encounter.visibleAt === null && run.encounter.time >= (run.encounter.canyon?.acquireAt ?? -6)) run.seeTarget();
          if (run.encounter.id === 1 && run.encounter.time >= 0) run.release();
        }
        const before = state(rendered);
        soloWorldFrame(rendered, rendered.pose, null);
        soloTargetFrame(rendered);
        expect(state(rendered)).toEqual(before);
        rendered.tick(false); control.tick(false);
        if (tick % 120 === 0) expect(state(rendered)).toEqual(state(control));
      }
      expect(control.status).toBe('over');
      expect(control.score).toBeGreaterThan(0);
      expect(control.misses).toBe(3);
      expect(state(rendered)).toEqual(state(control));
      const ending = soloWorldFrame(rendered, rendered.pose, null);
      expect(ending.over).toBe(true);
      expect(ending.ready).toBe(false);
      expect(ending.result?.points).toBe(0);
    });
});
