import type { Run } from '../game/run';
import type { Pose } from '../simulation/pose';
import type { Vec3 } from '../simulation/math';
import { hash } from '../simulation/math';
import { targetSightDistance } from '../config/game';
import { contactAccuracy } from '../simulation/ballistics';
import { shouldFlyby } from '../game/missile';
import { snapshotTarget, snapshotWorldFrame } from './world-frame';
import type { TargetFrame, WorldFrame } from './world-frame';

export function soloTargetFrame(run: Run): TargetFrame {
  const { encounter } = run;
  if (run.surface.canyon && !encounter.canyon) throw new Error('Missing canyon acquisition plan.');
  return snapshotTarget({
    id: encounter.id, position: encounter.target, kind: encounter.targetKind,
    heading: hash(encounter.id, 7, run.seed) * Math.PI * 2,
    sightDistance: encounter.canyon?.sightDistance ?? targetSightDistance(encounter.id - 1),
    canyon: run.surface.canyon,
  });
}

export function soloWorldFrame(run: Run, pose: Pose, prediction: Vec3 | null): WorldFrame {
  return snapshotWorldFrame({
    aircraft: { pose, bomb: run.bomb, released: run.encounter.released },
    target: soloTargetFrame(run),
    prediction: prediction ? { position: prediction, hit: contactAccuracy(prediction, run.encounter.target, run.surface) > 0 } : null,
    ready: run.ready, over: run.status === 'over',
    result: run.result ? { ...run.result, flyby: shouldFlyby(run.encounter.id, run.seed) } : null,
  });
}
