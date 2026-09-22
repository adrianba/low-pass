import type { Vec3 } from './math';
import type { Pose } from './pose';

import { MAX_TRACK_KNOTS, MAX_TRACK_DURATION, MIN_TRACK_INTERVAL, MAX_TRACK_COMPONENT } from '../../shared/protocol/limits.js';
export { MAX_TRACK_KNOTS, MAX_TRACK_DURATION, MIN_TRACK_INTERVAL, MAX_TRACK_COMPONENT };

export interface FlightKnot {
  readonly phase: number;
  readonly time: number;
  readonly pose: {
    readonly position: Readonly<Vec3>;
    readonly velocity: Readonly<Vec3>;
    readonly acceleration: Readonly<Vec3>;
    readonly bank: number;
    readonly pitch: number;
  };
}
export interface FlightTrackData { readonly version: 1; readonly knots: readonly FlightKnot[] }

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid flight track ${field}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function number(value: unknown, field: string, maximum = MAX_TRACK_COMPONENT): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > maximum) {
    throw new Error(`Invalid flight track ${field}: expected a bounded finite number.`);
  }
  return value === 0 ? 0 : value; // JSON canonicalizes -0; both authored and imported tracks must agree.
}

export function readFlightVector(value: unknown, field: string): Readonly<Vec3> {
  const object = record(value, field);
  return Object.freeze({
    x: number(object.x, `${field}.x`), y: number(object.y, `${field}.y`), z: number(object.z, `${field}.z`),
  });
}

export function readFlightPose(value: unknown): FlightKnot['pose'] {
  const object = record(value, 'pose');
  return Object.freeze({
    position: readFlightVector(object.position, 'position'),
    velocity: readFlightVector(object.velocity, 'velocity'),
    acceleration: readFlightVector(object.acceleration, 'acceleration'),
    bank: number(object.bank, 'bank', Math.PI),
    pitch: number(object.pitch, 'pitch', Math.PI),
  } satisfies Pose);
}

export function readFlightTrackData(value: unknown): FlightTrackData {
  const object = record(value, 'data');
  if (object.version !== 1) throw new Error('Unsupported flight track version.');
  if (!Array.isArray(object.knots) || object.knots.length < 2 || object.knots.length > MAX_TRACK_KNOTS) {
    throw new Error('Invalid flight track knot count.');
  }
  const knots = object.knots.map((value: unknown): FlightKnot => {
    const knot = record(value, 'knot');
    return Object.freeze({
      phase: number(knot.phase, 'phase', MAX_TRACK_DURATION),
      time: number(knot.time, 'time', MAX_TRACK_DURATION), pose: readFlightPose(knot.pose),
    });
  });
  for (let index = 1; index < knots.length; index++) {
    const a = knots[index - 1]!, b = knots[index]!;
    if (b.phase <= a.phase || b.time - a.time < MIN_TRACK_INTERVAL) {
      throw new Error('Flight track phases and times must increase with nondegenerate intervals.');
    }
  }
  if (!knots.some(knot => knot.phase === 0 && knot.time === 0)) {
    throw new Error('Flight track is missing its release anchor.');
  }
  if (knots.at(-1)!.time - knots[0]!.time > MAX_TRACK_DURATION) {
    throw new Error('Flight track duration exceeds supported coverage.');
  }
  return Object.freeze({ version: 1, knots: Object.freeze(knots) });
}
