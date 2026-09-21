import { difficulty, FLOOR, STEP, TARGET_RADIUS } from '../../config/game';
import { advanceBomb, contactAccuracy, predictImpact } from '../../simulation/ballistics';
import { projectChase } from '../../simulation/chase-camera';
import type { ChaseView } from '../../simulation/chase-camera';
import { ChaseAcquisitionError, ChaseTimeline } from '../../simulation/chase-timeline';
import type { AcquisitionWindow, ViewportEnvelope } from '../../simulation/chase-timeline';
import { FlightTrack, flightControlHull, motionPose } from '../../simulation/flight-track';
import type { FlightKnot } from '../../simulation/flight-track-data';
import { MIN_TRACK_INTERVAL } from '../../simulation/flight-track-data';
import { distance } from '../../simulation/math';
import type { Vec3 } from '../../simulation/math';
import { launchFrom } from '../../simulation/pose';
import type { Pose } from '../../simulation/pose';
import { canyonSurface } from '../../terrain/surface';
import { canyonCandidate, canyonShelves } from '../canyon-flight';
import type { CanyonCandidate } from '../canyon-flight';
import type { Encounter } from '../run';
import type { TargetKind } from '../targets';

export const MAX_CANYON_PAIR_CANDIDATES = 8;
export const MAX_CANYON_PAIR_DURATION = 90;
export const CANYON_PAIR_FUTURE = 5.5;
export const MAX_CLEARANCE_NODES = 32_768;

export interface CanyonPairCandidate {
  readonly lag: number;
  readonly phaseDelta: number;
  /** Additional shared entry time after reconciling the two native starts. */
  readonly entryPadding: number;
  /** Maximum extension of either native entry; never an implicit speed change. */
  readonly maxEntryExtension: number;
}
export interface DepartureEnvelope {
  readonly before: number;
  readonly after: number;
  /** Normalized inset for the projected aircraft bounds and departing bomb. */
  readonly screenMargin: number;
}
export interface CanyonFormationInput {
  readonly encounterId: string;
  readonly count: number;
  readonly seed: number;
  readonly startAt: number;
  readonly previous: readonly [Pose, Pose];
  readonly previousViews: readonly [ChaseView | null, ChaseView | null];
  readonly candidates: readonly CanyonPairCandidate[];
  readonly viewport: ViewportEnvelope;
  readonly acquisitionMargin: number;
  readonly departure: DepartureEnvelope;
}
export interface CanyonAttempt {
  readonly encounterId: string;
  readonly slot: 0 | 1;
  /** Shared-clock timestamps; the track and camera use local release-zero time. */
  readonly releaseAt: number;
  readonly acquireAt: number;
  readonly diveAt: number;
  readonly cutoffAt: number;
  readonly endAt: number;
  readonly entryEndAt: number;
  readonly entryExtension: number;
  readonly track: FlightTrack;
  readonly camera: ChaseTimeline;
  readonly acquisition: AcquisitionWindow;
}
export type CanyonPairFailureReason = 'native_candidate' | 'entry_timing' | 'attitude'
  | 'speed' | 'clearance' | 'coverage' | 'shelf' | 'acquisition' | 'release_window' | 'departure';
export interface CanyonPairFailure {
  readonly shelfIndex: number;
  readonly candidate: number;
  readonly reason: CanyonPairFailureReason;
  readonly detail: string;
}
export interface CanyonFormation {
  readonly encounterId: string;
  readonly terrain: 'river-canyon';
  readonly target: Readonly<Vec3>;
  readonly targetKind: TargetKind;
  readonly radius: typeof TARGET_RADIUS;
  readonly shelfIndex: number;
  readonly side: number;
  readonly startAt: number;
  readonly handoffAt: number;
  readonly coverageEndAt: number;
  readonly releaseLag: number;
  readonly candidate: Readonly<CanyonPairCandidate>;
  readonly departure: Readonly<DepartureEnvelope>;
  readonly attempts: readonly [CanyonAttempt, CanyonAttempt];
  readonly rejected: readonly CanyonPairFailure[];
  readonly work: Readonly<{ nativeCandidates: number; pairedCandidates: number; clearanceNodes: number }>;
}
export type CanyonFormationResult =
  | { readonly ok: true; readonly plan: CanyonFormation }
  | { readonly ok: false; readonly failures: readonly CanyonPairFailure[];
    readonly work: CanyonFormation['work'] };

class PairError extends Error {
  constructor(readonly reason: CanyonPairFailureReason, detail: string) { super(detail); }
}

export class CanyonChaseTimeline extends ChaseTimeline {
  constructor(track: FlightTrack, previous: ChaseView | null) {
    super(t => track.at(t), canyonSurface, track.startTime, track.endTime, previous);
    if (previous) {
      if (distance(this.samples[0]!.position, previous.position) > 0) {
        throw new PairError('acquisition', 'Incoming camera would require a terrain-clearance correction.');
      }
    }
  }
}

export function canyonFormationPose(attempt: CanyonAttempt, sharedTime: number): Pose {
  const local = sharedTime - attempt.releaseAt;
  attempt.track.assertCoverage(local, local);
  return attempt.track.at(local);
}

function validate(input: CanyonFormationInput): void {
  const bounded = (n: number, maximum: number) => Number.isFinite(n) && Math.abs(n) <= maximum;
  if (!input.encounterId || input.encounterId.length > 128 ||
    !Number.isSafeInteger(input.count) || input.count < 0 || input.count > 100_000 ||
    !Number.isSafeInteger(input.seed) || !bounded(input.startAt, 1e8) ||
    input.previous.length !== 2 || input.previousViews.length !== 2 ||
    input.candidates.length < 1 || input.candidates.length > MAX_CANYON_PAIR_CANDIDATES ||
    !bounded(input.viewport.minAspect, 4) || input.viewport.minAspect <= 0 ||
    !bounded(input.viewport.maxAspect, 4) || input.viewport.maxAspect < input.viewport.minAspect ||
    !bounded(input.acquisitionMargin, 0.5) || input.acquisitionMargin < STEP ||
    !bounded(input.departure.before, 0.5) || input.departure.before < STEP ||
    !bounded(input.departure.after, 0.5) || input.departure.after < STEP ||
    !bounded(input.departure.screenMargin, 0.2) || input.departure.screenMargin < 0) {
    throw new Error('Invalid bounded canyon formation inputs.');
  }
  for (const pose of input.previous) {
    if (![pose.position, pose.velocity, pose.acceleration].every(v => [v.x, v.y, v.z].every(n => bounded(n, 1e8))) ||
      ![pose.bank, pose.pitch].every(n => bounded(n, Math.PI)) || pose.velocity.z <= 0) {
      throw new Error('Invalid previous canyon Pose.');
    }
  }
  for (const view of input.previousViews) {
    if (view && (![view.position, view.target].every(v => [v.x, v.y, v.z].every(n => bounded(n, 1e8))) ||
      distance(view.position, view.target) === 0)) throw new Error('Invalid previous canyon camera.');
  }
  for (const candidate of input.candidates) {
    if (!bounded(candidate.lag, 4) || candidate.lag <= 0 ||
      !bounded(candidate.phaseDelta, Math.PI) || Math.abs(candidate.phaseDelta) < 0.01 ||
      !bounded(candidate.entryPadding, 3) || candidate.entryPadding < 0 ||
      !bounded(candidate.maxEntryExtension, 6) || candidate.maxEntryExtension < candidate.entryPadding) {
      throw new Error('Invalid exploratory canyon pair candidate.');
    }
  }
}

function phaseAt(track: FlightTrack, time: number): number {
  track.assertCoverage(time, time);
  const index = track.knots.findIndex(knot => knot.time >= time);
  if (index === 0) return track.knots[0]!.phase;
  const a = track.knots[index - 1]!, b = track.knots[index]!;
  return a.phase + (b.phase - a.phase) * (time - a.time) / (b.time - a.time);
}

function joinedTrack(encounter: Encounter, localStart: number, localEnd: number): FlightTrack {
  const flight = encounter.canyon!;
  if (localStart >= flight.entryEnd || flight.entryEnd >= flight.acquireAt || localEnd > flight.track.endTime ||
    localEnd - localStart > MAX_CANYON_PAIR_DURATION) {
    throw new PairError('coverage', 'Entry, acquisition or future continuation lacks native track coverage.');
  }
  const derived = motionPose({ ...encounter.start.position }, { ...encounter.start.velocity }, { ...encounter.start.acceleration });
  if (Math.abs(derived.bank - encounter.start.bank) > 1e-9 || Math.abs(derived.pitch - encounter.start.pitch) > 1e-9) {
    throw new PairError('attitude', 'Incoming attitude is incompatible with acceleration-derived Canyon motion.');
  }
  const entryPhase = phaseAt(flight.track, flight.entryEnd);
  const knots: FlightKnot[] = [
    { time: localStart, phase: entryPhase - (flight.entryEnd - localStart), pose: encounter.start },
    { time: flight.entryEnd, phase: entryPhase, pose: flight.track.at(flight.entryEnd) },
    ...flight.track.knots.filter(knot => knot.time > flight.entryEnd && knot.time < localEnd),
    { time: localEnd, phase: phaseAt(flight.track, localEnd), pose: flight.track.at(localEnd) },
  ];
  if (knots.slice(1).some((knot, i) => knot.time - knots[i]!.time < MIN_TRACK_INTERVAL)) {
    throw new PairError('coverage', 'Motion boundaries are below supported track resolution.');
  }
  return new FlightTrack({ version: 1, knots });
}

function advancesThroughGorge(track: FlightTrack): boolean {
  const positive = (points: number[], depth: number): boolean => {
    if (points.every(value => value > 0)) return true;
    if (depth === 8 || points[0]! <= 0 || points.at(-1)! <= 0) return false;
    const left = [points[0]!], right = [points.at(-1)!];
    let row = points;
    while (row.length > 1) {
      row = row.slice(1).map((value, i) => (value + row[i]!) / 2);
      left.push(row[0]!); right.unshift(row.at(-1)!);
    }
    return positive(left, depth + 1) && positive(right, depth + 1);
  };
  return track.knots.slice(1).every((b, i) => {
    const a = track.knots[i]!, hull = flightControlHull(a, b);
    return positive(hull.slice(1).map((point, j) => 5 * (point.z - hull[j]!.z) / (b.time - a.time)), 0);
  });
}

/** Canonical triangle heights are bounded by their vertices; subdivided Bezier
 * hulls cover the entire moving conservative 28-unit aircraft box, including
 * joins and all future continuation rather than just sampled endpoints. */
function proveClearance(track: FlightTrack, work: { clearanceNodes: number }): void {
  let nodes = 0;
  const safe = (points: Vec3[], depth: number): boolean => {
    work.clearanceNodes++;
    if (++nodes > MAX_CLEARANCE_NODES) throw new PairError('clearance', 'Exceeded bounded clearance proof work.');
    const xs = points.map(p => p.x), zs = points.map(p => p.z);
    const minX = Math.min(...xs) - 14, maxX = Math.max(...xs) + 14;
    const minZ = Math.min(...zs) - 14, maxZ = Math.max(...zs) + 14;
    const bottom = Math.min(...points.map(p => p.y)) - 14;
    let clear = false;
    if (maxX - minX <= 64 && maxZ - minZ <= 64) {
      clear = true;
      const cell = canyonSurface.cell;
      for (let x = Math.floor(minX / cell) * cell; x <= Math.ceil(maxX / cell) * cell && clear; x += cell) {
        for (let z = Math.floor(minZ / cell) * cell; z <= Math.ceil(maxZ / cell) * cell; z += cell) {
          if (canyonSurface.vertex(x, z) >= bottom) { clear = false; break; }
        }
      }
    }
    if (clear) return true;
    if (depth === 10) return false;
    const left = [points[0]!], right = [points.at(-1)!];
    let row = points;
    while (row.length > 1) {
      row = row.slice(1).map((p, i) => ({
        x: (p.x + row[i]!.x) / 2, y: (p.y + row[i]!.y) / 2, z: (p.z + row[i]!.z) / 2,
      }));
      left.push(row[0]!); right.unshift(row.at(-1)!);
    }
    return safe(left, depth + 1) && safe(right, depth + 1);
  };
  for (let i = 1; i < track.knots.length; i++) {
    if (!safe(flightControlHull(track.knots[i - 1]!, track.knots[i]!), 0)) {
      throw new PairError('clearance', `Conservative aircraft sweep is not terrain-safe at ${track.knots[i - 1]!.time}.`);
    }
  }
}

function validateShelf(target: Vec3): void {
  const cell = canyonSurface.cell;
  for (let x = Math.floor((target.x - TARGET_RADIUS) / cell) * cell; x <= Math.ceil((target.x + TARGET_RADIUS) / cell) * cell; x += cell) {
    for (let z = Math.floor((target.z - TARGET_RADIUS) / cell) * cell; z <= Math.ceil((target.z + TARGET_RADIUS) / cell) * cell; z += cell) {
      if (Math.abs(canyonSurface.vertex(x, z) - FLOOR) > 1e-9) {
        throw new PairError('shelf', 'Full scoring ring does not fit flat dry canonical shelf triangles.');
      }
    }
  }
}

function makeAttempt(input: CanyonFormationInput, encounter: Encounter, slot: 0 | 1, releaseAt: number,
  coverageEndAt: number, work: { clearanceNodes: number }): CanyonAttempt {
  const flight = encounter.canyon!, start = input.startAt - releaseAt, end = coverageEndAt - releaseAt;
  const track = joinedTrack(encounter, start, end);
  if (!track.respectsSpeed(difficulty(input.count).speed) || !advancesThroughGorge(track)) {
    throw new PairError('speed', `Slot ${slot} fails whole-quintic 3D speed or forward-motion bounds after entry reconciliation.`);
  }
  proveClearance(track, work);
  const camera = new CanyonChaseTimeline(track, input.previousViews[slot]);
  const acquisition: AcquisitionWindow = Object.freeze({
    target: Object.freeze({ ...encounter.target }), range: flight.sightDistance,
    viewport: Object.freeze({ ...input.viewport }), earliest: start, deadline: flight.diveAt,
    margin: input.acquisitionMargin,
  });
  let acquireAt: number;
  try { acquireAt = camera.acquire(acquisition); }
  catch (error) {
    if (!(error instanceof ChaseAcquisitionError)) throw error;
    throw new PairError('acquisition', `Slot ${slot} cannot acquire the complete ring before its native dive deadline.`);
  }
  for (const t of [-0.04, -0.0025, 0, 0.0025, 0.04]) {
    const score = contactAccuracy(predictImpact(launchFrom(track.at(t)), canyonSurface), encounter.target, canyonSurface);
    if (score < (t === 0 ? 100 : Math.abs(t) <= 0.0025 ? 95 : 1)) {
      throw new PairError('release_window', `Slot ${slot} fails native release-window probes.`);
    }
  }
  return Object.freeze({
    encounterId: input.encounterId, slot, releaseAt, acquireAt: releaseAt + acquireAt,
    diveAt: releaseAt + flight.diveAt, cutoffAt: releaseAt + flight.cutoffAt, endAt: releaseAt + flight.endAt,
    entryEndAt: releaseAt + flight.entryEnd, entryExtension: flight.startTime - start,
    track, camera, acquisition,
  });
}

function departureVisible(input: CanyonFormationInput, attempts: readonly [CanyonAttempt, CanyonAttempt]): void {
  const lead = attempts[0], follower = attempts[1], envelope = input.departure;
  const pointVisible = (point: Vec3, view: ChaseView): boolean =>
    [input.viewport.minAspect, input.viewport.maxAspect].every(aspect => {
      const screen = projectChase(point, view, aspect), margin = envelope.screenMargin;
      return screen !== null && screen.x >= margin && screen.x <= 1 - margin &&
        screen.y >= margin && screen.y <= 1 - margin && !canyonSurface.ground(view.position, point);
    });
  const bomb = launchFrom(lead.track.at(0));
  const ticks = Math.ceil((envelope.before + envelope.after) / STEP);
  const times = new Set([0, -envelope.before, envelope.after]);
  for (let i = 0; i <= ticks; i++) times.add(Math.min(envelope.after, -envelope.before + i * STEP));
  for (const time of [...times].sort((a, b) => a - b)) {
    const shared = lead.releaseAt + time, pose = canyonFormationPose(lead, shared);
    const view = follower.camera.at(shared - follower.releaseAt);
    for (const x of [-14, 14]) for (const y of [-14, 14]) for (const z of [-14, 14]) {
      if (!pointVisible({ x: pose.position.x + x, y: pose.position.y + y, z: pose.position.z + z }, view)) {
        throw new PairError('departure', 'Follower cannot see the complete lead-aircraft bounds near release.');
      }
    }
    if (time < 0) continue;
    while (bomb.age + STEP <= time + 1e-10) {
      if (advanceBomb(bomb, STEP, canyonSurface)) throw new PairError('departure', 'Lead bomb contacts terrain during departure observation.');
    }
    // Cover both endpoints used to interpolate the canonical fixed-step bomb.
    const next = { position: { ...bomb.position }, velocity: { ...bomb.velocity }, age: bomb.age };
    if (advanceBomb(next, STEP, canyonSurface) || !pointVisible(bomb.position, view) || !pointVisible(next.position, view)) {
      throw new PairError('departure', 'Follower cannot see the departing lead bomb.');
    }
  }
}

/** Host-authored same-shelf pairs. Candidate order and all timing allowances
 * are caller-controlled; an exhausted search never returns a shifted solo Run. */
export function planCanyonFormation(input: CanyonFormationInput): CanyonFormationResult {
  validate(input);
  const work = { nativeCandidates: 0, pairedCandidates: 0, clearanceNodes: 0 };
  const failures: CanyonPairFailure[] = [];
  for (const shelfIndex of canyonShelves(input.count, input.previous[0])) {
    work.nativeCandidates++;
    const lead = canyonCandidate(input.count, input.seed, input.previous[0], shelfIndex);
    const followers = new Map<number, CanyonCandidate>();
    for (const [index, candidate] of input.candidates.entries()) {
      work.pairedCandidates++;
      try {
        if (!lead.ok) throw new PairError('native_candidate', `Lead: ${lead.reason}`);
        let follower = followers.get(candidate.phaseDelta);
        if (!follower) {
          work.nativeCandidates++;
          follower = canyonCandidate(input.count, input.seed, input.previous[1], shelfIndex, candidate.phaseDelta);
          followers.set(candidate.phaseDelta, follower);
        }
        if (!follower.ok) throw new PairError('native_candidate', `Follower: ${follower.reason}`);
        const a = lead.encounter, b = follower.encounter;
        if (distance(a.target, b.target) !== 0 || a.targetKind !== b.targetKind) {
          throw new PairError('shelf', 'Native candidates disagree on shared target identity.');
        }
        validateShelf(a.target);
        const releaseDelay = Math.max(-a.canyon!.startTime, -b.canyon!.startTime - candidate.lag) + candidate.entryPadding;
        const releaseAt = input.startAt + releaseDelay;
        const followerRelease = releaseAt + candidate.lag;
        const extensions = [releaseDelay + a.canyon!.startTime, releaseDelay + candidate.lag + b.canyon!.startTime];
        if (extensions.some(extension => extension > candidate.maxEntryExtension + 1e-9)) {
          throw new PairError('entry_timing', 'Shared start requires more entry time than the declared allowance.');
        }
        const handoffAt = Math.max(releaseAt + a.canyon!.endAt, followerRelease + b.canyon!.endAt);
        const coverageEndAt = handoffAt + CANYON_PAIR_FUTURE;
        const attempts = Object.freeze([makeAttempt(input, a, 0, releaseAt, coverageEndAt, work),
          makeAttempt(input, b, 1, followerRelease, coverageEndAt, work)] as const);
        departureVisible(input, attempts);
        return { ok: true, plan: Object.freeze({
          encounterId: input.encounterId, terrain: 'river-canyon', target: Object.freeze({ ...a.target }),
          targetKind: a.targetKind, radius: TARGET_RADIUS, shelfIndex, side: a.canyon!.side,
          startAt: input.startAt, handoffAt, coverageEndAt, releaseLag: candidate.lag,
          candidate: Object.freeze({ ...candidate }), departure: Object.freeze({ ...input.departure }),
          attempts, rejected: Object.freeze([...failures]), work: Object.freeze({ ...work }),
        }) };
      } catch (error) {
        if (!(error instanceof PairError)) throw error;
        failures.push(Object.freeze({ shelfIndex, candidate: index, reason: error.reason, detail: error.message }));
      }
    }
  }
  return { ok: false, failures: Object.freeze(failures), work: Object.freeze({ ...work }) };
}
