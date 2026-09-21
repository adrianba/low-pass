import { hash } from '../simulation/math';
import type { Pose } from '../simulation/pose';
import { AircraftMotion } from './aircraft-motion';
import type { MissileView } from './canyon-missile';
import { MissileFlight, finaleFlight, MISSILE_INTERCEPT_TIME } from './missile';
import type { MissilePlanData } from './missile-data';
import { poseAt } from './run';
import type { Run } from './run';

export function soloIncomingPlan(kind: 'flyby' | 'damage', run: Run, view?: MissileView): MissilePlanData {
  const future = poseAt(run.encounter, run.encounter.time + MISSILE_INTERCEPT_TIME, run.encounter.id - 1);
  return new MissileFlight(kind, run.pose, future.position, hash(run.encounter.id, 18, run.seed) < 0.5 ? -1 : 1,
    run.surface, run.surface.canyon ? AircraftMotion.fromSoloCanyon(run.pose, run.encounter) : undefined, view).toData();
}

export function soloFinalePlan(pose: Pose, run?: Run, view?: MissileView): MissilePlanData {
  if (!run?.surface.canyon) return finaleFlight(pose).toData();
  const motion = AircraftMotion.fromSoloCanyon(pose, run.encounter);
  return new MissileFlight('finale', pose, motion.at(MISSILE_INTERCEPT_TIME).position, 1, run.surface, motion, view).toData();
}
