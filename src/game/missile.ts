import type { Pose } from './run';
import { clamp, distance, hash } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import { valleySurface } from '../terrain/surface';
import type { Surface } from '../terrain/surface';
import { projectRoute, routeMotion, routePoint } from '../terrain/canyon-route';

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
  private readonly arrival: Vec3 | null;
  private exitLift = 0;

  constructor(readonly kind: MissileKind, readonly start: Pose, future: Vec3, readonly side: number,
    private readonly surface: Surface = valleySurface, private readonly continuation?: (time: number) => Pose) {
    const route = surface.canyon ? projectRoute(start.position.x, start.position.z) : null;
    const launch = route ? routePoint(route.along + 210 * routeMotion(route.along).tz, side * 260)
      : { x: start.position.x + side * 100, z: start.position.z + 210 };
    const { x, z } = launch;
    this.launch = { x, y: surface.height(x, z) + (surface.canyon ? 8 : 2), z };
    this.intercept = kind !== 'flyby' ? { ...future } : { x: future.x + side * 24, y: future.y + 12, z: future.z };
    if (surface.canyon && kind === 'flyby') {
      const frame = routeMotion(projectRoute(future.x, future.z).along);
      this.intercept.x = future.x + frame.nx * side * 24;
      this.intercept.z = future.z + frame.nz * side * 24;
    }
    this.control = {
      x: (this.launch.x + this.intercept.x) / 2,
      y: Math.max(this.launch.y + 55, this.intercept.y * 0.7),
      z: (this.launch.z + this.intercept.z) / 2,
    };
    const forward = routeMotion(projectRoute(future.x, future.z).along);
    this.arrival = surface.canyon ? { x: this.intercept.x - forward.tx * 90, y: this.intercept.y,
      z: this.intercept.z - forward.tz * 90 } : null;
    if (surface.canyon) {
      for (let i = 1; i < 100; i++) {
        const u = i / 100, v = 1 - u;
        const p = this.positionAt(u * MISSILE_INTERCEPT_TIME);
        this.control.y += Math.max(0, (surface.height(p.x, p.z) + 5 - p.y) / (3 * v * v * u));
      }
      let lift = 0;
      for (let i = 1; i <= 100; i++) {
        const u = i / 100, p = this.positionAt(MISSILE_INTERCEPT_TIME + (FLYBY_DURATION - MISSILE_INTERCEPT_TIME) * u);
        const blend = u ** 3 * (10 - 15 * u + 6 * u * u);
        lift = Math.max(lift, (surface.height(p.x, p.z) + 8 - p.y) / blend);
      }
      this.exitLift = lift;
    }
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
    const u = this.arrival ? t : Math.min(t, 1), v = 1 - u;
    const position = { x: 0, y: 0, z: 0 };
    for (const axis of ['x', 'y', 'z'] as const) {
      position[axis] = this.arrival
        ? v ** 3 * this.launch[axis] + 3 * v * v * u * this.control[axis]
          + 3 * v * u * u * this.arrival[axis] + u ** 3 * this.intercept[axis]
        : v * v * this.launch[axis] + 2 * v * u * this.control[axis] + u * u * this.intercept[axis];
      if (!this.arrival && t > 1) {
        position[axis] += 2 * (this.intercept[axis] - this.control[axis]) * (t - 1);
      }
    }
    if (this.kind === 'flyby' && aircraft && distance(position, aircraft) < FLYBY_CLEARANCE) {
      if (this.surface.canyon) {
        const frame = routeMotion(projectRoute(aircraft.x, aircraft.z).along);
        position.x = aircraft.x + frame.nx * this.side * FLYBY_CLEARANCE;
        position.z = aircraft.z + frame.nz * this.side * FLYBY_CLEARANCE;
      } else position.x = aircraft.x + this.side * FLYBY_CLEARANCE;
    }
    if (this.surface.canyon && t > 1) {
      const u = clamp((age - MISSILE_INTERCEPT_TIME) / (FLYBY_DURATION - MISSILE_INTERCEPT_TIME), 0, 1);
      position.y += this.exitLift * u ** 3 * (10 - 15 * u + 6 * u * u);
    }
    return position;
  }

  aircraftPose(): Pose {
    const t = clamp(this.age, 0, MISSILE_INTERCEPT_TIME);
    if (this.continuation) return this.continuation(t);
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
