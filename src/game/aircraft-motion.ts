import { joinMotion } from '../simulation/curves';
import { FlightTrack, joinPose } from '../simulation/flight-track';
import { MAX_TRACK_DURATION, MIN_TRACK_INTERVAL, readFlightPose, readFlightTrackData } from '../simulation/flight-track-data';
import type { FlightKnot, FlightTrackData } from '../simulation/flight-track-data';
import type { Pose } from '../simulation/pose';
import { FLYBY_DURATION, MISSILE_INTERCEPT_TIME } from './combat-timing';
import type { FormationPlan } from './formation/approved';
import { FormationTrack } from './formation/track';
import type { Encounter } from './run';

interface Entry {
  readonly start: FlightKnot['pose']; readonly startAt: number; readonly endAt: number;
}
export type AircraftMotionData =
  | { readonly version: 1; readonly kind: 'tangent'; readonly start: FlightKnot['pose'] }
  | { readonly version: 1; readonly kind: 'track'; readonly start: FlightKnot['pose'];
    readonly style: 'canyon' | 'formation'; readonly offset: number; readonly track: FlightTrackData; readonly entry: Entry | null };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid aircraft motion object.');
  return value as Record<string, unknown>;
}
function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_TRACK_DURATION) {
    throw new Error('Invalid aircraft motion time.');
  }
  return value === 0 ? 0 : value;
}
function readData(value: unknown): AircraftMotionData {
  const data = record(value);
  if (data.version !== 1) throw new Error('Unsupported aircraft motion version.');
  const start = readFlightPose(data.start);
  if (data.kind === 'tangent') return Object.freeze({ version: 1, kind: 'tangent', start });
  if (data.kind !== 'track' || (data.style !== 'canyon' && data.style !== 'formation')) {
    throw new Error('Invalid aircraft motion kind or attitude style.');
  }
  const track = readFlightTrackData(data.track), offset = time(data.offset);
  let entry: Entry | null = null;
  if (data.entry !== null) {
    const input = record(data.entry);
    entry = Object.freeze({ start: readFlightPose(input.start), startAt: time(input.startAt), endAt: time(input.endAt) });
    if (data.style !== 'canyon' || entry.endAt - entry.startAt < MIN_TRACK_INTERVAL || entry.endAt < track.knots[0]!.time ||
      entry.endAt > track.knots.at(-1)!.time) throw new Error('Invalid aircraft motion entry join.');
  }
  if (offset < (entry?.startAt ?? track.knots[0]!.time) || offset + FLYBY_DURATION > track.knots.at(-1)!.time) {
    throw new Error('Aircraft motion does not cover the complete combat continuation.');
  }
  return Object.freeze({ version: 1, kind: 'track', start, style: data.style, track, offset, entry });
}

export class AircraftMotion {
  private readonly data: AircraftMotionData;
  private readonly track: FlightTrack | FormationTrack | null;
  private readonly initial: Pose;
  private readonly entryEnd: Pose | null;

  constructor(data: AircraftMotionData) {
    this.data = readData(data);
    this.track = this.data.kind === 'track' ? this.data.style === 'canyon'
      ? FlightTrack.fromData(this.data.track) : FormationTrack.fromData(this.data.track) : null;
    this.entryEnd = this.data.kind === 'track' && this.data.entry ? this.track!.at(this.data.entry.endAt) : null;
    this.initial = this.sourceAt(0);
  }

  static fromData(data: unknown): AircraftMotion { return new AircraftMotion(readData(data)); }
  static tangent(start: Pose): AircraftMotion { return new AircraftMotion({ version: 1, kind: 'tangent', start }); }
  static fromFormation(plan: FormationPlan, slot: 0 | 1, sharedTime: number, start?: Pose): AircraftMotion {
    if ((slot !== 0 && slot !== 1) || !Number.isFinite(sharedTime) || sharedTime < plan.startAt || sharedTime > plan.handoffAt) {
      throw new Error('Invalid formation combat motion anchor.');
    }
    const attempt = plan.attempts[slot], offset = sharedTime - attempt.releaseAt;
    return new AircraftMotion({ version: 1, kind: 'track', start: start ?? attempt.track.at(offset),
      style: plan.terrain === 'river-canyon' ? 'canyon' : 'formation', offset, track: attempt.track.toData(), entry: null });
  }
  static fromSoloCanyon(start: Pose, encounter: Encounter): AircraftMotion {
    const flight = encounter.canyon;
    if (!flight) throw new Error('Missing solo Canyon continuation.');
    return new AircraftMotion({ version: 1, kind: 'track', start, style: 'canyon', offset: encounter.time,
      track: flight.track.toData(), entry: { start: encounter.start, startAt: flight.startTime, endAt: flight.entryEnd } });
  }

  toData(): AircraftMotionData { return readData(this.data); }

  at(age: number): Pose {
    if (!Number.isFinite(age) || age < 0 || age > FLYBY_DURATION) throw new Error('Invalid aircraft continuation age.');
    const next = this.sourceAt(age);
    if (this.data.kind === 'track') {
      const start = this.data.start;
      for (const axis of ['x', 'y', 'z'] as const) {
        const correction = joinMotion({
          position: start.position[axis] - this.initial.position[axis],
          velocity: start.velocity[axis] - this.initial.velocity[axis],
          acceleration: start.acceleration[axis] - this.initial.acceleration[axis],
        }, { position: 0, velocity: 0, acceleration: 0 }, MISSILE_INTERCEPT_TIME, age);
        next.position[axis] += correction.position;
        next.velocity[axis] += correction.velocity;
        next.acceleration[axis] += correction.acceleration;
      }
      next.bank = start.bank + (next.bank - start.bank) * Math.min(1, age / 0.1);
      next.pitch = start.pitch + (next.pitch - start.pitch) * Math.min(1, age / 0.1);
    }
    readFlightPose(next);
    return next;
  }

  private sourceAt(age: number): Pose {
    if (this.data.kind === 'tangent') {
      const next: Pose = structuredClone(this.data.start);
      for (const axis of ['x', 'y', 'z'] as const) next.position[axis] += next.velocity[axis] * age;
      return next;
    }
    const at = this.data.offset + age, entry = this.data.entry;
    if (entry && at < entry.endAt) return joinPose(entry.start, this.entryEnd!, entry.endAt - entry.startAt, at - entry.startAt);
    return this.track!.at(at);
  }
}
