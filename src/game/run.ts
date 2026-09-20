import { ATTACK_HEIGHT, CRUISE_HEIGHT, FLOOR, GRAVITY, MAX_MISSES, STEP, difficulty } from '../config/game';
import { contactAccuracy, advanceBomb, predictImpact } from '../simulation/ballistics';
import type { Bomb } from '../simulation/ballistics';
import { clamp, hash } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import { valleyCenter, valleySlope, valleyCurvature } from '../terrain/heightfield';
import { joinMotion } from '../simulation/curves';
import type { Motion } from '../simulation/curves';
import { selectTargetKind } from './targets';
import type { TargetKind } from './targets';
import type { TerrainTheme } from '../config/terrain';
import { surfaceFor, valleySurface } from '../terrain/surface';
import type { Contact, Surface } from '../terrain/surface';
import { canyonPose, planCanyon } from './canyon-flight';
import type { CanyonFlight } from './canyon-flight';
import { initialPose, launchFrom } from '../simulation/pose';
import type { Pose } from '../simulation/pose';
export { aircraftPoint, initialPose, interpolatePose, launchFrom } from '../simulation/pose';
export type { Pose } from '../simulation/pose';

export const APPROACH_DURATION = 3;
const ENCOUNTER_START = -8;

export type RunStatus = 'running' | 'paused' | 'over';
export interface Result { points: number; impact: Contact | null; id: number }
export interface Encounter {
  id: number;
  readonly targetKind: TargetKind;
  readonly surface: Surface;
  readonly canyon?: CanyonFlight;
  time: number;
  origin: number;
  phase: number;
  start: Pose;
  visibleAt: number | null;
  target: Vec3;
  released: boolean;
  resolvedAt: number | null;
}

export function poseAt(encounter: Encounter, time: number, count: number): Pose {
  if (encounter.canyon) return canyonPose(encounter, time);
  const { amplitude, frequency, speed, diveDuration } = difficulty(count);
  const nominal = (t: number): Record<keyof Vec3, Motion> => {
    const z = encounter.origin + speed * t;
    const phase = t * frequency + encounter.phase;
    return {
      x: {
        position: valleyCenter(z) + amplitude * Math.sin(phase),
        velocity: valleySlope(z) * speed + amplitude * frequency * Math.cos(phase),
        acceleration: valleyCurvature(z) * speed * speed - amplitude * frequency * frequency * Math.sin(phase),
      },
      y: { position: FLOOR + CRUISE_HEIGHT, velocity: 0, acceleration: 0 },
      z: { position: z, velocity: speed, acceleration: 0 },
    };
  };
  const approach = (t: number): Record<keyof Vec3, Motion> => {
    if (t >= ENCOUNTER_START + APPROACH_DURATION) return nominal(t);
    const end = nominal(ENCOUNTER_START + APPROACH_DURATION);
    for (const axis of ['x', 'y', 'z'] as const) {
      end[axis] = joinMotion({
        position: encounter.start.position[axis],
        velocity: encounter.start.velocity[axis],
        acceleration: encounter.start.acceleration[axis],
      }, end[axis], APPROACH_DURATION, t - ENCOUNTER_START);
    }
    return end;
  };
  const motion = approach(time);
  if (encounter.visibleAt !== null && time >= encounter.visibleAt) {
    const low = { position: FLOOR + ATTACK_HEIGHT, velocity: 0, acceleration: 0 };
    motion.y = time < 2.2
      ? joinMotion(approach(encounter.visibleAt).y, low, diveDuration, time - encounter.visibleAt)
      : joinMotion(low, { position: FLOOR + CRUISE_HEIGHT, velocity: 0, acceleration: 0 }, 3, time - 2.2);
  }
  const position = { x: motion.x.position, y: motion.y.position, z: motion.z.position };
  const velocity = { x: motion.x.velocity, y: motion.y.velocity, z: motion.z.velocity };
  const acceleration = { x: motion.x.acceleration, y: motion.y.acceleration, z: motion.z.acceleration };
  return { position, velocity, acceleration, bank: clamp(-acceleration.x / 32, -0.65, 0.65),
    pitch: -Math.atan2(velocity.y, velocity.z) };
}

export function planEncounter(count: number, seed: number, previous: Pose, surface = valleySurface): Encounter {
  if (surface.canyon) return planCanyon(count, seed, previous);
  const d = difficulty(count);
  const encounter: Encounter = {
    id: count + 1, targetKind: selectTargetKind(count, seed), surface, time: ENCOUNTER_START,
    origin: previous.position.z - d.speed * ENCOUNTER_START - (d.speed - previous.velocity.z) * APPROACH_DURATION / 2,
    phase: hash(count, 71, seed) * Math.PI * 2,
    start: { ...previous, position: { ...previous.position }, velocity: { ...previous.velocity }, acceleration: { ...previous.acceleration } },
    visibleAt: null,
    target: { x: 0, y: FLOOR, z: 0 }, released: false, resolvedAt: null,
  };
  const planned = { ...encounter, visibleAt: -6 };
  const ideal = launchFrom(poseAt(planned, 0, count));
  const impact = predictImpact(ideal);
  encounter.target = { x: impact.x, y: FLOOR, z: impact.z };
  if (Math.abs(impact.x - valleyCenter(impact.z)) > 140 || Math.abs(impact.y - FLOOR) > 0.01) {
    throw new Error('Cannot construct a safe target in the flight corridor.');
  }
  return encounter;
}

export class Run {
  status: RunStatus = 'running';
  score = 0;
  misses = 0;
  resolved = 0;
  assisted = false;
  encounter: Encounter;
  bomb: Bomb | null = null;
  result: Result | null = null;
  readonly events: Array<'release' | 'hit' | 'miss' | 'splash' | 'over' | 'target'> = [];
  readonly surface: Surface;

  constructor(readonly seed = 1, readonly terrain: TerrainTheme = 'green-valley') {
    this.surface = surfaceFor(terrain);
    const start = this.surface.canyon ? { x: this.surface.center(600), y: FLOOR + CRUISE_HEIGHT, z: 600 } : undefined;
    this.encounter = planEncounter(0, seed, initialPose(start), this.surface);
  }

  get pose(): Pose { return poseAt(this.encounter, this.encounter.time, this.encounter.id - 1); }
  private get pastTarget(): boolean {
    return this.encounter.canyon ? this.encounter.time > this.encounter.canyon.cutoffAt
      : this.pose.position.z > this.encounter.target.z + 90;
  }
  get ready(): boolean {
    return this.status === 'running' && this.encounter.visibleAt !== null && !this.encounter.released
      && this.encounter.resolvedAt === null && !this.pastTarget;
  }
  get prediction(): Contact { return predictImpact(launchFrom(this.pose), this.surface); }

  seeTarget(): void {
    if (this.status !== 'running' || this.encounter.visibleAt !== null) return;
    if (this.encounter.time > (this.encounter.canyon?.diveAt ?? -difficulty(this.encounter.id - 1).diveDuration - 0.5)) {
      throw new Error('Target was not visible early enough for a fair attack pass.');
    }
    this.encounter.visibleAt = this.encounter.time;
    this.events.push('target');
  }

  release(): boolean {
    if (!this.ready) return false;
    this.encounter.released = true;
    this.bomb = launchFrom(this.pose);
    this.events.push('release');
    return true;
  }

  private finish(impact: Contact | null): void {
    if (this.encounter.resolvedAt !== null) return;
    const points = impact ? contactAccuracy(impact, this.encounter.target, this.surface) : 0;
    this.encounter.resolvedAt = this.encounter.time;
    this.score += points;
    this.resolved++;
    if (!points) this.misses++;
    this.result = { points, impact, id: this.encounter.id };
    this.events.push(points ? 'hit' : impact?.kind === 'water' ? 'splash' : 'miss');
    if (this.misses >= MAX_MISSES) {
      this.status = 'over';
      this.events.push('over');
    }
  }

  tick(assist: boolean): void {
    if (this.status !== 'running') return;
    this.assisted ||= assist;
    this.encounter.time += STEP;
    if (this.bomb) {
      const impact = advanceBomb(this.bomb, STEP, this.surface);
      if (impact) { this.bomb = null; this.finish(impact); }
      else if (this.bomb.age > 20) throw new Error('Active bomb exceeded the supported flight duration.');
    }
    if (!this.encounter.released && this.pastTarget) this.finish(null);
    if (this.misses >= MAX_MISSES) return;
    if (this.encounter.resolvedAt !== null && this.encounter.time >= Math.max(this.encounter.canyon?.endAt ?? 7, this.encounter.resolvedAt + 3)) {
      this.encounter = planEncounter(this.resolved, this.seed, this.pose, this.surface);
      this.result = null;
    }
  }
}

export const idealFallTime = Math.sqrt(2 * (ATTACK_HEIGHT - 2.2) / GRAVITY);
