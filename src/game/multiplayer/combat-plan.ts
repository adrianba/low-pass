import { MAX_MISSES } from '../../config/game';
import { hash } from '../../simulation/math';
import type { Pose } from '../../simulation/pose';
import { surfaceFor } from '../../terrain/surface';
import { AircraftMotion } from '../aircraft-motion';
import type { MissileView } from '../canyon-missile';
import { FLYBY_DURATION, MISSILE_INTERCEPT_TIME } from '../combat-timing';
import type { FormationPlan } from '../formation/approved';
import { MissileFlight, shouldFlyby } from '../missile';
import { readMissilePlanData } from '../missile-data';
import type { MissilePlanData } from '../missile-data';
import type { AttemptResult, PlayerSlot } from './session';

export interface CombatPlanData {
  readonly version: 1;
  readonly id: number;
  readonly slot: PlayerSlot;
  readonly sequence: number;
  readonly bornAt: number;
  readonly damageLevel: 0 | 1 | 2;
  readonly missile: MissilePlanData;
}

export function readCombatPlanData(value: unknown): CombatPlanData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid combat plan object.');
  const data = value as Record<string, unknown>;
  if (data.version !== 1) throw new Error('Unsupported combat plan version.');
  if ((data.slot !== 0 && data.slot !== 1) || typeof data.sequence !== 'number' ||
    !Number.isSafeInteger(data.sequence) || data.sequence < 0 || data.sequence > 100_000 ||
    data.id !== data.sequence * 2 + data.slot + 1 ||
    typeof data.bornAt !== 'number' || !Number.isFinite(data.bornAt) || data.bornAt < 0 || data.bornAt > 1e8 ||
    (data.damageLevel !== 0 && data.damageLevel !== 1 && data.damageLevel !== 2)) {
    throw new Error('Invalid combat identity, time or damage level.');
  }
  const missile = readMissilePlanData(data.missile);
  if ((missile.kind === 'finale' && data.damageLevel !== 2) || (missile.kind === 'damage' && data.damageLevel === 0)) {
    throw new Error('Combat kind does not match its damage state.');
  }
  return Object.freeze({ version: 1, id: data.id, slot: data.slot, sequence: data.sequence,
    bornAt: data.bornAt, damageLevel: data.damageLevel, missile });
}

export function authorCombatPlan(result: AttemptResult, current: FormationPlan, seed: number,
  view?: MissileView, renderedPose?: Pose, next?: FormationPlan): CombatPlanData | null {
  if (!Number.isSafeInteger(seed) || !Number.isInteger(result.points) || result.points < 0 || result.points > 100 ||
    !Number.isSafeInteger(result.sequence) || result.sequence < 0 || result.sequence > 100_000 ||
    (result.slot !== 0 && result.slot !== 1) || result.id !== result.sequence * 2 + result.slot + 1 ||
    !Number.isSafeInteger(result.score) || result.score < result.points || result.score > (result.sequence + 1) * 100 ||
    typeof result.assisted !== 'boolean' || (result.points > 0 && result.impact?.kind !== 'ground') ||
    !Number.isInteger(result.misses) || result.misses < 0 || result.misses > MAX_MISSES ||
    result.misses > result.sequence + 1 ||
    (!result.points && !result.misses) || (result.points > 0 && result.misses === MAX_MISSES)) {
    throw new Error('Invalid combat result or seed.');
  }
  const kind = result.points ? 'flyby' : result.misses === MAX_MISSES ? 'finale' : 'damage';
  if (!Number.isFinite(result.time) || result.time < current.startAt || result.time > current.handoffAt) {
    throw new Error('Invalid combat result time.');
  }
  const side = hash(result.sequence + 1, 18, seed) < 0.5 ? -1 : 1;
  const damageLevel = result.misses === 0 ? 0 : result.misses === 1 ? 1 : 2;
  const data = { version: 1, id: result.id, slot: result.slot, sequence: result.sequence, bornAt: result.time, damageLevel };
  if (result.points && !shouldFlyby(result.sequence + 1, seed)) return null;
  if (kind !== 'finale' && result.time + FLYBY_DURATION > current.handoffAt && !next) {
    throw new Error('Live combat continuation requires the next scheduled track.');
  }
  const motion = AircraftMotion.fromFormation(current, result.slot, result.time, renderedPose, kind === 'finale' ? undefined : next);
  const flight = new MissileFlight(kind, motion.at(0), motion.at(MISSILE_INTERCEPT_TIME).position,
    side, surfaceFor(current.terrain), motion, view);
  return readCombatPlanData({ ...data, missile: flight.toData() });
}
