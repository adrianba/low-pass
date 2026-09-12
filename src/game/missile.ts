import type { Pose } from './run';
import { clamp, distance, hash } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import { terrainHeight } from '../terrain/heightfield';

export const MISSILE_INTERCEPT_TIME = 1.7;
export const FLYBY_DURATION = 2.8;
export const FINALE_DURATION = 5.5;
export const FLYBY_CLEARANCE = 18;
export type MissileKind = 'flyby' | 'damage' | 'finale';
export type CombatCue = 'missile' | 'flyby' | 'damaged' | 'destroyed';
export type FinalePhase = 'incoming' | 'destroyed' | 'complete';

export const shouldFlyby = (encounter: number, seed: number): boolean => encounter === 1 || hash(encounter, 113, seed) < 0.5;

export class MissileFlight {
  age = 0;
  readonly launch: Vec3;
  readonly intercept: Vec3;
  private readonly control: Vec3;

  constructor(readonly kind: MissileKind, readonly start: Pose, future: Vec3, readonly side: number) {
    const x = start.position.x + side * 100, z = start.position.z + 210;
    this.launch = { x, y: terrainHeight(x, z) + 2, z };
    this.intercept = kind !== 'flyby' ? { ...future } : { x: future.x + side * 24, y: future.y + 12, z: future.z };
    this.control = {
      x: (this.launch.x + this.intercept.x) / 2,
      y: Math.max(this.launch.y + 55, this.intercept.y * 0.7),
      z: (this.launch.z + this.intercept.z) / 2,
    };
  }

  get finalePhase(): FinalePhase | null {
    if (this.kind !== 'finale') return null;
    return this.age < MISSILE_INTERCEPT_TIME ? 'incoming' : this.age < FINALE_DURATION ? 'destroyed' : 'complete';
  }
  get hasImpacted(): boolean { return this.age >= MISSILE_INTERCEPT_TIME; }
  get finished(): boolean { return this.age >= (this.kind === 'finale' ? FINALE_DURATION : FLYBY_DURATION); }

  advance(dt: number): CombatCue | null {
    const before = this.age;
    this.age = Math.min(this.age + dt, this.kind === 'finale' ? FINALE_DURATION : FLYBY_DURATION);
    return before < MISSILE_INTERCEPT_TIME && this.age >= MISSILE_INTERCEPT_TIME
      ? this.kind === 'finale' ? 'destroyed' : this.kind === 'damage' ? 'damaged' : 'flyby' : null;
  }

  positionAt(age: number, aircraft?: Vec3): Vec3 {
    const t = Math.max(0, age) / MISSILE_INTERCEPT_TIME;
    const u = Math.min(t, 1);
    const position = { x: 0, y: 0, z: 0 };
    for (const axis of ['x', 'y', 'z'] as const) {
      position[axis] = (1 - u) ** 2 * this.launch[axis] + 2 * (1 - u) * u * this.control[axis] + u * u * this.intercept[axis];
      if (t > 1) position[axis] += 2 * (this.intercept[axis] - this.control[axis]) * (t - 1);
    }
    if (this.kind === 'flyby' && aircraft && distance(position, aircraft) < FLYBY_CLEARANCE) {
      position.x = aircraft.x + this.side * FLYBY_CLEARANCE;
    }
    return position;
  }

  aircraftPose(): Pose {
    const t = clamp(this.age, 0, MISSILE_INTERCEPT_TIME);
    return {
      ...this.start,
      position: {
        x: this.start.position.x + this.start.velocity.x * t,
        y: this.start.position.y + this.start.velocity.y * t,
        z: this.start.position.z + this.start.velocity.z * t,
      },
    };
  }
}

export function finaleFlight(pose: Pose, side = 1): MissileFlight {
  return new MissileFlight('finale', pose, {
    x: pose.position.x + pose.velocity.x * MISSILE_INTERCEPT_TIME,
    y: pose.position.y + pose.velocity.y * MISSILE_INTERCEPT_TIME,
    z: pose.position.z + pose.velocity.z * MISSILE_INTERCEPT_TIME,
  }, side);
}
