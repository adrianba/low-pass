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
interface NextTrack {
  readonly age: number; readonly from: number; readonly offset: number; readonly track: FlightTrackData;
}
export type AircraftMotionData =
  | { readonly version: 1; readonly kind: 'tangent'; readonly start: FlightKnot['pose'] }
  | { readonly version: 1; readonly kind: 'track'; readonly start: FlightKnot['pose'];
    readonly style: 'canyon' | 'formation'; readonly offset: number; readonly track: FlightTrackData;
    readonly entry: Entry | null; readonly next?: NextTrack | null };

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
export function readAircraftMotionData(value: unknown): AircraftMotionData {
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
  let next: NextTrack | null = null;
  if (data.next !== undefined && data.next !== null) {
    const input = record(data.next);
    next = Object.freeze({ age: time(input.age), from: time(input.from), offset: time(input.offset), track: readFlightTrackData(input.track) });
    if (entry || next.age < 0 || next.age > FLYBY_DURATION || Math.abs(offset + next.age - next.from) > 1e-7 ||
      next.from < track.knots[0]!.time || next.from > track.knots.at(-1)!.time ||
      next.offset < next.track.knots[0]!.time || next.offset + FLYBY_DURATION - next.age > next.track.knots.at(-1)!.time) {
      throw new Error('Invalid aircraft motion handoff coverage.');
    }
  }
  if (offset < (entry?.startAt ?? track.knots[0]!.time) ||
    (next?.from ?? offset + FLYBY_DURATION) > track.knots.at(-1)!.time) {
    throw new Error('Aircraft motion does not cover the complete combat continuation.');
  }
  return Object.freeze({ version: 1, kind: 'track', start, style: data.style, track, offset, entry, next });
}

export class AircraftMotion {
  private readonly data: AircraftMotionData;
  private readonly track: FlightTrack | FormationTrack | null;
  private readonly initial: Pose;
  private readonly entryEnd: Pose | null;
  private readonly nextTrack: FlightTrack | FormationTrack | null;

  constructor(data: AircraftMotionData) {
    this.data = readAircraftMotionData(data);
    this.track = this.data.kind === 'track' ? this.data.style === 'canyon'
      ? FlightTrack.fromData(this.data.track) : FormationTrack.fromData(this.data.track) : null;
    this.entryEnd = this.data.kind === 'track' && this.data.entry ? this.track!.at(this.data.entry.endAt) : null;
    this.nextTrack = this.data.kind === 'track' && this.data.next ? this.data.style === 'canyon'
      ? FlightTrack.fromData(this.data.next.track) : FormationTrack.fromData(this.data.next.track) : null;
    if (this.data.kind === 'track' && this.data.next) {
      const before = this.track!.at(this.data.next.from), after = this.nextTrack!.at(this.data.next.offset);
      if ((['position', 'velocity', 'acceleration'] as const).some(key =>
        (['x', 'y', 'z'] as const).some(axis => before[key][axis] !== after[key][axis])) ||
        before.bank !== after.bank || before.pitch !== after.pitch) throw new Error('Discontinuous aircraft motion handoff.');
    }
    this.initial = this.sourceAt(0);
  }

  static fromData(data: unknown): AircraftMotion { return new AircraftMotion(readAircraftMotionData(data)); }
  static tangent(start: Pose): AircraftMotion { return new AircraftMotion({ version: 1, kind: 'tangent', start }); }
  static fromFormation(plan: FormationPlan, slot: 0 | 1, sharedTime: number, start?: Pose, nextPlan?: FormationPlan): AircraftMotion {
    if ((slot !== 0 && slot !== 1) || !Number.isFinite(sharedTime) || sharedTime < plan.startAt || sharedTime > plan.handoffAt) {
      throw new Error('Invalid formation combat motion anchor.');
    }
    const attempt = plan.attempts[slot], offset = sharedTime - attempt.releaseAt;
    if (nextPlan && (nextPlan.terrain !== plan.terrain || nextPlan.startAt !== plan.handoffAt)) {
      throw new Error('Incompatible aircraft motion handoff plan.');
    }
    const next = nextPlan && sharedTime + FLYBY_DURATION > plan.handoffAt ? {
      age: nextPlan.startAt - sharedTime, from: nextPlan.startAt - attempt.releaseAt,
      offset: nextPlan.startAt - nextPlan.attempts[slot].releaseAt, track: nextPlan.attempts[slot].track.toData(),
    } : null;
    return new AircraftMotion({ version: 1, kind: 'track', start: start ?? attempt.track.at(offset),
      style: plan.terrain === 'river-canyon' ? 'canyon' : 'formation', offset, track: attempt.track.toData(), entry: null, next });
  }
  static fromSoloCanyon(start: Pose, encounter: Encounter): AircraftMotion {
    const flight = encounter.canyon;
    if (!flight) throw new Error('Missing solo Canyon continuation.');
    return new AircraftMotion({ version: 1, kind: 'track', start, style: 'canyon', offset: encounter.time,
      track: flight.track.toData(), entry: { start: encounter.start, startAt: flight.startTime, endAt: flight.entryEnd } });
  }

  toData(): AircraftMotionData { return readAircraftMotionData(this.data); }

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
    if (this.data.next && age >= this.data.next.age) return this.nextTrack!.at(this.data.next.offset + age - this.data.next.age);
    const at = this.data.offset + age, entry = this.data.entry;
    if (entry && at < entry.endAt) return joinPose(entry.start, this.entryEnd!, entry.endAt - entry.startAt, at - entry.startAt);
    return this.track!.at(at);
  }
}
