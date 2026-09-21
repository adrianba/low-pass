import type { Pose } from '../simulation/pose';
import { clamp, distance, hash } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import { valleySurface } from '../terrain/surface';
import type { Surface } from '../terrain/surface';
import { planCanyonMissile } from './canyon-missile';
import type { MissileView } from './canyon-missile';
import { CanyonMissilePlan } from './canyon-missile-data';
import { AircraftMotion } from './aircraft-motion';
import { readFlightPose, readFlightVector } from '../simulation/flight-track-data';
import { readMissilePlanData } from './missile-data';
import type { MissilePlanData } from './missile-data';
import { MISSILE_INTERCEPT_TIME, FLYBY_DURATION, FINALE_DURATION, FLYBY_CLEARANCE } from './combat-timing';
import type { MissileKind, CombatCue, FinalePhase } from './combat-timing';
export { MISSILE_INTERCEPT_TIME, FLYBY_DURATION, FINALE_DURATION, FLYBY_CLEARANCE } from './combat-timing';
export type { MissileKind, CombatCue, FinalePhase } from './combat-timing';

export const shouldFlyby = (encounter: number, seed: number): boolean => encounter === 1 || hash(encounter, 113, seed) < 0.5;

function authorPlan(kind: MissileKind, start: Pose, future: Vec3, side: number, surface: Surface,
  continuation?: AircraftMotion, view?: MissileView): MissilePlanData {
  if (side !== -1 && side !== 1) throw new Error('Invalid missile side.');
  readFlightPose(start);
  readFlightVector(future, 'missile future');
  const motion = continuation ?? AircraftMotion.tangent(start);
  const initial = motion.at(0);
  if ((['position', 'velocity', 'acceleration'] as const).some(key =>
    (['x', 'y', 'z'] as const).some(axis => Math.abs(initial[key][axis] - start[key][axis]) > 1e-8)) ||
    Math.abs(initial.bank - start.bank) > 1e-8 || Math.abs(initial.pitch - start.pitch) > 1e-8) {
    throw new Error('Missile start does not match its frozen aircraft motion.');
  }
  if (surface.canyon) {
    if (!continuation || !view) throw new Error('Canyon missiles require aircraft motion and a chase view.');
    const plan = planCanyonMissile({ kind, side, surface, aircraftAt: time => motion.at(time), view,
      interceptTime: MISSILE_INTERCEPT_TIME, duration: FLYBY_DURATION, clearance: FLYBY_CLEARANCE });
    return { version: 1, kind, side, motion: motion.toData(), curve: { kind: 'canyon', plan: plan.toData() } };
  }
  const x = start.position.x + side * 100, z = start.position.z + 210;
  const launch = { x, y: surface.height(x, z) + 2, z };
  const intercept = kind !== 'flyby' ? { ...future } : { x: future.x + side * 24, y: future.y + 12, z: future.z };
  const control = { x: (launch.x + intercept.x) / 2, y: Math.max(launch.y + 55, intercept.y * 0.7),
    z: (launch.z + intercept.z) / 2 };
  return { version: 1, kind, side, motion: motion.toData(), curve: { kind: 'valley', launch, intercept, control } };
}

export class MissileFlight {
  age = 0;
  readonly kind: MissileKind;
  readonly side: number;
  readonly start: Pose;
  readonly launch: Readonly<Vec3>;
  readonly intercept: Readonly<Vec3>;
  private readonly control: Readonly<Vec3> | null;
  private readonly canyonPlan: CanyonMissilePlan | null;
  private readonly motion: AircraftMotion;
  private readonly data: MissilePlanData;

  constructor(data: MissilePlanData);
  constructor(kind: MissileKind, start: Pose, future: Vec3, side: number,
    surface?: Surface, continuation?: AircraftMotion, view?: MissileView);
  constructor(input: MissilePlanData | MissileKind, start?: Pose, future?: Vec3, side?: number,
    surface: Surface = valleySurface, continuation?: AircraftMotion, view?: MissileView) {
    if (typeof input === 'string') {
      if (!start || !future || side === undefined) throw new Error('Missing missile authoring inputs.');
      this.data = readMissilePlanData(authorPlan(input, start, future, side, surface, continuation, view));
    } else this.data = readMissilePlanData(input);
    this.kind = this.data.kind; this.side = this.data.side;
    this.start = structuredClone(this.data.motion.start);
    this.motion = AircraftMotion.fromData(this.data.motion);
    if (this.data.curve.kind === 'canyon') {
      this.canyonPlan = CanyonMissilePlan.fromData(this.data.curve.plan);
      this.launch = this.canyonPlan.launch; this.intercept = this.canyonPlan.intercept; this.control = null;
    } else {
      this.canyonPlan = null;
      this.launch = this.data.curve.launch; this.intercept = this.data.curve.intercept; this.control = this.data.curve.control;
    }
  }

  static fromData(data: unknown): MissileFlight { return new MissileFlight(readMissilePlanData(data)); }
  toData(): MissilePlanData { return readMissilePlanData(this.data); }

  get finalePhase(): FinalePhase | null {
    if (this.kind !== 'finale') return null;
    return this.age < MISSILE_INTERCEPT_TIME ? 'incoming' : this.age < FINALE_DURATION ? 'destroyed' : 'complete';
  }
  get hasImpacted(): boolean { return this.age >= MISSILE_INTERCEPT_TIME; }
  get finished(): boolean { return this.age >= (this.kind === 'finale' ? FINALE_DURATION : FLYBY_DURATION); }

  advance(dt: number): CombatCue | null {
    if (!Number.isFinite(dt) || dt < 0) throw new Error('Invalid missile time advance.');
    const before = this.age;
    this.age = Math.min(this.age + dt, this.kind === 'finale' ? FINALE_DURATION : FLYBY_DURATION);
    return before < MISSILE_INTERCEPT_TIME && this.age >= MISSILE_INTERCEPT_TIME
      ? this.kind === 'finale' ? 'destroyed' : this.kind === 'damage' ? 'damaged' : 'flyby' : null;
  }

  positionAt(age: number, aircraft?: Vec3): Vec3 {
    if (!Number.isFinite(age)) throw new Error('Invalid missile query time.');
    if (aircraft) readFlightVector(aircraft, 'missile aircraft');
    if (this.canyonPlan) return this.canyonPlan.positionAt(age);
    if (!this.control) throw new Error('Missing missile trajectory.');
    const t = Math.max(0, age) / MISSILE_INTERCEPT_TIME;
    const u = Math.min(t, 1), v = 1 - u;
    const position = { x: 0, y: 0, z: 0 };
    for (const axis of ['x', 'y', 'z'] as const) {
      position[axis] = v * v * this.launch[axis] + 2 * v * u * this.control[axis] + u * u * this.intercept[axis];
      if (t > 1) {
        position[axis] += 2 * (this.intercept[axis] - this.control[axis]) * (t - 1);
      }
    }
    if (this.kind === 'flyby' && aircraft && distance(position, aircraft) < FLYBY_CLEARANCE) {
      position.x = aircraft.x + this.side * FLYBY_CLEARANCE;
    }
    readFlightVector(position, 'missile position');
    return position;
  }

  aircraftPose(): Pose {
    const t = clamp(this.age, 0, MISSILE_INTERCEPT_TIME);
    return this.motion.at(t);
  }
}

export function finaleFlight(pose: Pose, side = 1): MissileFlight {
  return new MissileFlight('finale', pose, {
    x: pose.position.x + pose.velocity.x * MISSILE_INTERCEPT_TIME,
    y: pose.position.y + pose.velocity.y * MISSILE_INTERCEPT_TIME,
    z: pose.position.z + pose.velocity.z * MISSILE_INTERCEPT_TIME,
  }, side);
}
