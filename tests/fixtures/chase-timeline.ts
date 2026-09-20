import { World } from '../../src/rendering/world';
import { Run, poseAt } from '../../src/game/run';
import type { TerrainTheme } from '../../src/config/terrain';
import { difficulty, targetSightDistance } from '../../src/config/game';
import { ChaseTimeline } from '../../src/simulation/chase-timeline';
import { projectChase } from '../../src/simulation/chase-camera';
import { distance } from '../../src/simulation/math';
import { seededCourse } from '../helpers/flight-probe';
import { soloWorldFrame } from '../../src/rendering/solo-frame';

declare global {
  interface Window {
    authoredChaseProbe(terrain: TerrainTheme): Promise<{
      checked: number; verified: boolean; projectionError: number;
      rebased: boolean; paused: boolean; pauseError: number; resizeReason: string; cameraClearance: number;
    }>;
  }
}

window.authoredChaseProbe = async terrain => {
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Missing authored-chase canvas.');
  const world = new World(canvas, 'low', terrain);
  const result = { checked: 0, verified: true, projectionError: 0, rebased: false,
    paused: true, pauseError: 0, resizeReason: '', cameraClearance: Infinity };
  const unexpectedEffect = () => { throw new Error('Acquisition fixture must not request combat effects.'); };
  const effects = { finale: unexpectedEffect, flyby: unexpectedEffect, damage: unexpectedEffect };
  try {
    await world.load(() => {});
    const run = new Run(7, terrain);
    for (const encounter of seededCourse(7, terrain, 14)) {
      if (![1, 2, 13, 14].includes(encounter.id)) continue;
      run.encounter = encounter;
      const count = encounter.id - 1;
      const deadline = encounter.canyon?.diveAt ?? -difficulty(count).diveDuration - 0.5;
      const timeline = new ChaseTimeline(time => poseAt(encounter, time, count), run.surface, encounter.time, 0.1);
      const window = { target: encounter.target, range: encounter.canyon?.sightDistance ?? targetSightDistance(count),
        viewport: { minAspect: 0.75, maxAspect: 32 / 9 }, earliest: Math.max(encounter.time, deadline - 3),
        deadline, margin: 0.1 };
      const acquired = timeline.acquire(window);
      for (const [width, height] of [[720, 960], [960, 540], [1200, 360]]) {
        world.engine.setSize(width!, height!);
        const aspect = world.engine.getRenderWidth() / world.engine.getRenderHeight();
        for (const [index, dt] of [1 / 60, 0.1, 1 / 30].entries()) {
          const time = acquired + index * 0.035;
          encounter.time = time;
          const frame = soloWorldFrame(run, poseAt(encounter, time, count), null);
          world.updateFrame(frame, dt, effects, timeline.at(time));
          const actual = world.chaseSnapshot();
          result.verified &&= timeline.verify(time, actual, aspect, window).ok;
          result.verified &&= world.targetFrameVisible(frame.target);
          const predicted = projectChase(encounter.target, timeline.at(time), aspect);
          const rendered = world.projectPoint(encounter.target);
          if (!predicted || !rendered) throw new Error('Authored target was not projected.');
          result.projectionError = Math.max(result.projectionError,
            Math.abs(predicted.x - rendered.x), Math.abs(predicted.y - rendered.y));
          result.cameraClearance = Math.min(result.cameraClearance, actual.position.y -
            run.surface.height(actual.position.x, actual.position.z));
          const target = world.scene.getTransformNodeByName('Encounter target');
          if (!target) throw new Error('Missing shared target root.');
          result.rebased ||= Math.abs(encounter.target.z - target.position.z) > 4096;
          world.updateFrame(frame, 0, effects, timeline.at(time));
          const paused = world.chaseSnapshot();
          result.pauseError = Math.max(result.pauseError, distance(paused.position, actual.position), distance(paused.target, actual.target));
          result.paused &&= JSON.stringify(paused.position) === JSON.stringify(actual.position);
          result.checked++;
        }
      }
      world.engine.setSize(100, 1000);
      const check = timeline.verify(encounter.time, world.chaseSnapshot(), 0.1, window);
      result.resizeReason = check.ok ? '' : check.reason;
    }
    await world.scene.whenReadyAsync();
    world.render();
    return result;
  } finally { world.dispose(); }
};
