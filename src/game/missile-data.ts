import { readFlightVector } from '../simulation/flight-track-data';
import type { Vec3 } from '../simulation/math';
import { readAircraftMotionData } from './aircraft-motion';
import type { AircraftMotionData } from './aircraft-motion';
import { readCanyonMissileData } from './canyon-missile-data';
import type { CanyonMissileData } from './canyon-missile-data';
import { FLYBY_DURATION, MISSILE_INTERCEPT_TIME } from './combat-timing';
import type { MissileKind } from './combat-timing';

export interface MissilePlanData {
  readonly version: 1;
  readonly kind: MissileKind;
  readonly side: -1 | 1;
  readonly motion: AircraftMotionData;
  readonly curve:
    | { readonly kind: 'valley'; readonly launch: Readonly<Vec3>; readonly intercept: Readonly<Vec3>; readonly control: Readonly<Vec3> }
    | { readonly kind: 'canyon'; readonly plan: CanyonMissileData };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid missile plan object.');
  return value as Record<string, unknown>;
}
export function readMissilePlanData(value: unknown): MissilePlanData {
  const data = record(value), curve = record(data.curve);
  if (data.version !== 1) throw new Error('Unsupported missile plan version.');
  if (data.kind !== 'damage' && data.kind !== 'flyby' && data.kind !== 'finale') throw new Error('Invalid missile kind.');
  if (data.side !== -1 && data.side !== 1) throw new Error('Invalid missile side.');
  const motion = readAircraftMotionData(data.motion);
  const canyonMotion = motion.kind === 'track' && motion.style === 'canyon';
  const common = { version: 1, kind: data.kind, side: data.side, motion } satisfies
    Pick<MissilePlanData, 'version' | 'kind' | 'side' | 'motion'>;
  if (curve.kind === 'canyon') {
    const plan = readCanyonMissileData(curve.plan);
    if (!canyonMotion || plan.arrival !== MISSILE_INTERCEPT_TIME || plan.duration !== FLYBY_DURATION) {
      throw new Error('Canyon missile motion or timing does not match the combat contract.');
    }
    return Object.freeze({ ...common, curve: Object.freeze({ kind: 'canyon', plan }) });
  }
  if (curve.kind !== 'valley' || canyonMotion) throw new Error('Invalid missile curve or motion style.');
  return Object.freeze({ ...common, curve: Object.freeze({ kind: 'valley',
    launch: readFlightVector(curve.launch, 'missile launch'), intercept: readFlightVector(curve.intercept, 'missile intercept'),
    control: readFlightVector(curve.control, 'missile control') }) });
}
