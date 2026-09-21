import { mix } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import { MAX_TRACK_COMPONENT, MIN_TRACK_INTERVAL } from '../simulation/flight-track-data';
import { routePoint } from '../terrain/canyon-route';

export interface CanyonMissileData {
  readonly version: 1;
  readonly launch: Readonly<Vec3>;
  readonly intercept: Readonly<Vec3>;
  readonly along: number;
  readonly targetAlong: number;
  readonly lateral: number;
  readonly targetLateral: number;
  readonly forward: number;
  readonly power: 2 | 3 | 4;
  readonly arrival: number;
  readonly duration: number;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Canyon missile data object.');
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_TRACK_COMPONENT) {
    throw new Error('Invalid bounded Canyon missile data number.');
  }
  return value === 0 ? 0 : value;
}
function vector(value: unknown): Readonly<Vec3> {
  const v = record(value);
  return Object.freeze({ x: number(v.x), y: number(v.y), z: number(v.z) });
}

export function readCanyonMissileData(value: unknown): CanyonMissileData {
  const data = record(value);
  if (data.version !== 1) throw new Error('Unsupported Canyon missile data version.');
  const power = data.power;
  if (power !== 2 && power !== 3 && power !== 4) throw new Error('Invalid Canyon missile ascent power.');
  const arrival = number(data.arrival), duration = number(data.duration), forward = number(data.forward);
  if (arrival < MIN_TRACK_INTERVAL || duration - arrival < MIN_TRACK_INTERVAL || duration > 30 || forward < 0) {
    throw new Error('Invalid Canyon missile duration or forward motion.');
  }
  return Object.freeze({
    version: 1, launch: vector(data.launch), intercept: vector(data.intercept),
    along: number(data.along), targetAlong: number(data.targetAlong),
    lateral: number(data.lateral), targetLateral: number(data.targetLateral),
    forward, power, arrival, duration,
  });
}

const ease = (u: number): number => u ** 3 * (10 - 15 * u + 6 * u * u);

export class CanyonMissilePlan {
  private readonly data: CanyonMissileData;
  readonly launch: Readonly<Vec3>;
  readonly intercept: Readonly<Vec3>;

  constructor(data: CanyonMissileData) {
    this.data = readCanyonMissileData(data);
    this.launch = this.data.launch;
    this.intercept = this.data.intercept;
  }

  static fromData(data: unknown): CanyonMissilePlan { return new CanyonMissilePlan(readCanyonMissileData(data)); }
  toData(): CanyonMissileData { return readCanyonMissileData(this.data); }

  positionAt(age: number): Vec3 {
    if (!Number.isFinite(age)) throw new Error('Invalid Canyon missile query time.');
    const { arrival, duration, along, targetAlong, lateral: initialLateral, targetLateral, forward, power } = this.data;
    const u = Math.max(0, age) / arrival, progress = ease(Math.min(u, 1));
    const elapsed = Math.max(0, age - arrival), exit = Math.min(1, elapsed / (duration - arrival));
    const route = mix(along, targetAlong, progress) + forward * elapsed ** 3 / (3 * (duration - arrival) ** 2);
    const lateral = mix(initialLateral, targetLateral, progress) * (1 - ease(exit));
    const y = this.launch.y + (this.intercept.y - this.launch.y) * (0.25 * u + 0.75 * u ** power);
    if (![route, lateral, y].every(n => Number.isFinite(n) && Math.abs(n) <= MAX_TRACK_COMPONENT)) {
      throw new Error('Invalid Canyon missile query time or extent.');
    }
    return { ...routePoint(route, lateral), y };
  }
}
