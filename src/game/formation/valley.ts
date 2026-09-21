import { ATTACK_HEIGHT, CRUISE_HEIGHT, difficulty, FLOOR, STEP, targetSightDistance, TARGET_RADIUS } from '../../config/game';
import { contactAccuracy, predictImpact } from '../../simulation/ballistics';
import { ChaseAcquisitionError, ChaseTimeline } from '../../simulation/chase-timeline';
import type { AcquisitionWindow, ViewportEnvelope } from '../../simulation/chase-timeline';
import type { ChaseView } from '../../simulation/chase-camera';
import { joinMotion } from '../../simulation/curves';
import { flightControlHull } from '../../simulation/flight-track';
import { MIN_TRACK_INTERVAL } from '../../simulation/flight-track-data';
import type { FlightTrackData } from '../../simulation/flight-track-data';
import { clamp, distance } from '../../simulation/math';
import type { Vec3 } from '../../simulation/math';
import { launchFrom } from '../../simulation/pose';
import type { Pose } from '../../simulation/pose';
import { valleySurface } from '../../terrain/surface';
import { planEncounter, poseAt } from '../run';
import type { Encounter } from '../run';
import type { TargetKind } from '../targets';
import { FormationTrack } from './track';

export const MAX_FORMATION_CANDIDATES = 8;
export const FORMATION_KNOT_STEP = 0.1;
export const FORMATION_FUTURE = 5.5;
const INTERCEPT_ITERATIONS = 12;
const INTERCEPT_TOLERANCE = 0.005;

/** Exploratory inputs, not accepted product formation defaults. */
export interface ValleyCandidate {
  /** Requested minimum lag; any extra time must fit this explicit allowance. */
  readonly lag: number;
  readonly maxLagAdjustment: number;
  readonly phaseDelta: number;
  readonly maxLateralCorrection: number;
  readonly maxForwardCorrection: number;
}
export interface ValleyFormationInput {
  readonly encounterId: string;
  readonly count: number;
  readonly seed: number;
  readonly terrain: 'green-valley' | 'desert';
  readonly startAt: number;
  readonly previous: readonly [Pose, Pose];
  readonly previousViews: readonly [ChaseView | null, ChaseView | null];
  readonly candidates: readonly ValleyCandidate[];
  readonly viewport: ViewportEnvelope;
  readonly acquisitionMargin: number;
}
export interface ValleyAttempt {
  readonly encounterId: string;
  readonly slot: 0 | 1;
  /** All attempt times are shared-clock seconds; track knots are release-zero. */
  readonly releaseAt: number;
  readonly acquireAt: number;
  readonly cutoffAt: number;
  /** Local recovery completes here; both pilots keep moving until plan.handoffAt. */
  readonly endAt: number;
  readonly track: FormationTrack;
  readonly camera: ChaseTimeline;
  readonly acquisition: AcquisitionWindow;
}
export interface ValleyFormation {
  readonly encounterId: string;
  readonly target: Readonly<Vec3>;
  readonly targetKind: TargetKind;
  readonly radius: typeof TARGET_RADIUS;
  readonly terrain: ValleyFormationInput['terrain'];
  readonly startAt: number;
  readonly handoffAt: number;
  readonly coverageEndAt: number;
  readonly candidate: Readonly<ValleyCandidate>;
  readonly releaseLag: number;
  readonly attempts: readonly [ValleyAttempt, ValleyAttempt];
  readonly rejected: readonly CandidateFailure[];
}
export type FailureReason = 'intercept' | 'correction_bounds' | 'lag_bounds' | 'acquisition' | 'clearance'
  | 'forward_speed' | 'coverage' | 'release_window';
export interface CandidateFailure { readonly candidate: number; readonly reason: FailureReason; readonly detail: string }
export type FormationResult =
  | { readonly ok: true; readonly plan: ValleyFormation }
  | { readonly ok: false; readonly failures: readonly CandidateFailure[] };

class CandidateError extends Error {
  constructor(readonly reason: FailureReason, detail: string) { super(detail); }
}

export function formationPose(attempt: ValleyAttempt, sharedTime: number): Pose {
  return attempt.track.at(sharedTime - attempt.releaseAt);
}

function validate(input: ValleyFormationInput): void {
  const bounded = (n: number, max: number) => Number.isFinite(n) && Math.abs(n) <= max;
  if (!input.encounterId || input.encounterId.length > 128 ||
    !Number.isInteger(input.count) || input.count < 0 || input.count > 100_000 ||
    !Number.isSafeInteger(input.seed) || !bounded(input.startAt, 1e8) ||
    !['green-valley', 'desert'].includes(input.terrain) ||
    !input.candidates.length || input.candidates.length > MAX_FORMATION_CANDIDATES ||
    !bounded(input.viewport.minAspect, 4) || !bounded(input.viewport.maxAspect, 4) ||
    input.viewport.minAspect <= 0 || input.viewport.maxAspect < input.viewport.minAspect ||
    !bounded(input.acquisitionMargin, 0.5) || input.acquisitionMargin < STEP ||
    input.previous.length !== 2 || input.previousViews.length !== 2) {
    throw new Error('Invalid bounded valley formation inputs.');
  }
  for (const pose of input.previous) {
    if (![pose.position, pose.velocity, pose.acceleration].every(v =>
      [v.x, v.y, v.z].every(n => bounded(n, 1e8))) ||
      ![pose.bank, pose.pitch].every(n => bounded(n, Math.PI)) || pose.velocity.z <= 0) {
      throw new Error('Invalid previous formation Pose.');
    }
  }
  for (const view of input.previousViews) {
    if (view && (![view.position, view.target].every(v => [v.x, v.y, v.z].every(n => bounded(n, 1e8))) ||
      distance(view.position, view.target) === 0)) throw new Error('Invalid previous formation camera.');
  }
  for (const candidate of input.candidates) {
    if (!bounded(candidate.lag, 4) || candidate.lag <= 0 ||
      !bounded(candidate.maxLagAdjustment, 1) || candidate.maxLagAdjustment < 0 ||
      !bounded(candidate.phaseDelta, Math.PI) || Math.abs(candidate.phaseDelta) < 0.01 ||
      !bounded(candidate.maxLateralCorrection, 100) || candidate.maxLateralCorrection <= 0 ||
      !bounded(candidate.maxForwardCorrection, 100) || candidate.maxForwardCorrection <= 0) {
      throw new Error('Invalid exploratory formation candidate.');
    }
  }
}

function authoredPose(encounter: Encounter, count: number, start: number, offset: number,
  time: number): Pose {
  if (time === start) return structuredClone(encounter.start);
  const cruise = { ...encounter, visibleAt: null };
  const nominal = poseAt(cruise, time, count);
  nominal.position.x += offset;
  const end = poseAt(cruise, -5, count);
  end.position.x += offset;
  const duration = -5 - start;
  for (const axis of time < -5 ? ['x', 'y', 'z'] as const : []) {
    const motion = joinMotion({
      position: encounter.start.position[axis], velocity: encounter.start.velocity[axis],
      acceleration: encounter.start.acceleration[axis],
    }, { position: end.position[axis], velocity: end.velocity[axis], acceleration: end.acceleration[axis] },
    duration, time - start);
    nominal.position[axis] = motion.position;
    nominal.velocity[axis] = motion.velocity;
    nominal.acceleration[axis] = motion.acceleration;
  }
  if (encounter.visibleAt !== null && time >= encounter.visibleAt) {
    const entry = authoredPose(cruise, count, start, offset, encounter.visibleAt);
    const low = { position: FLOOR + ATTACK_HEIGHT, velocity: 0, acceleration: 0 };
    const vertical = time < 2.2
      ? joinMotion({ position: entry.position.y, velocity: entry.velocity.y, acceleration: entry.acceleration.y },
        low, difficulty(count).diveDuration, time - encounter.visibleAt)
      : joinMotion(low, { position: FLOOR + CRUISE_HEIGHT, velocity: 0, acceleration: 0 }, 3, time - 2.2);
    nominal.position.y = vertical.position;
    nominal.velocity.y = vertical.velocity;
    nominal.acceleration.y = vertical.acceleration;
  }
  const t = clamp((time - start) / duration, 0, 1), blend = t ** 3 * (10 - 15 * t + 6 * t * t);
  const bank = clamp(-nominal.acceleration.x / 32, -0.65, 0.65);
  const pitch = -Math.atan2(nominal.velocity.y, nominal.velocity.z);
  nominal.bank = bank + (encounter.start.bank - clamp(-encounter.start.acceleration.x / 32, -0.65, 0.65)) * (1 - blend);
  nominal.pitch = pitch + (encounter.start.pitch + Math.atan2(encounter.start.velocity.y, encounter.start.velocity.z)) * (1 - blend);
  return nominal;
}

function sample(encounter: Encounter, count: number, start: number, end: number, offset: number): FormationTrack {
  const times = new Set([start, end, -5, 0, 2.2, 5.2]);
  if (encounter.visibleAt !== null) {
    times.add(encounter.visibleAt);
    times.add(encounter.visibleAt + difficulty(count).diveDuration);
  }
  const anchors = [...times];
  for (let index = Math.ceil(start / FORMATION_KNOT_STEP); index * FORMATION_KNOT_STEP < end; index++) {
    const t = index * FORMATION_KNOT_STEP;
    if (!anchors.some(anchor => Math.abs(anchor - t) < 0.00001)) times.add(t);
  }
  const knots = [...times].filter(t => t >= start && t <= end).sort((a, b) => a - b)
    .map(time => ({ phase: time, time, pose: authoredPose(encounter, count, start, offset, time) }));
  if (knots.slice(1).some((knot, i) => knot.time - knots[i]!.time < MIN_TRACK_INTERVAL)) {
    throw new CandidateError('coverage', 'Distinct motion boundaries are below supported track time resolution.');
  }
  return new FormationTrack({ version: 1, knots });
}

/** Bezier hulls conservatively cover every quintic, not just sampled aircraft centers. */
function validateMotion(track: FormationTrack, speed: number): void {
  const knots = track.motion.knots;
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1]!, b = knots[i]!, dt = b.time - a.time;
    const hull = flightControlHull(a, b);
    const forward = hull.slice(1).map((p, j) => 5 * (p.z - hull[j]!.z) / dt);
    if (forward.some(v => v <= 0 || v > speed + 0.001)) {
      throw new CandidateError('forward_speed', 'Entry or continuation exceeds the native forward-speed envelope.');
    }
    const minX = Math.min(...hull.map(p => p.x)) - 14, maxX = Math.max(...hull.map(p => p.x)) + 14;
    const minZ = Math.min(...hull.map(p => p.z)) - 14, maxZ = Math.max(...hull.map(p => p.z)) + 14;
    const bottom = Math.min(...hull.map(p => p.y)) - 14;
    const cell = valleySurface.cell;
    if ((maxX - minX) * (maxZ - minZ) > 100_000) throw new CandidateError('clearance', 'Unbounded aircraft sweep.');
    for (let x = Math.floor(minX / cell) * cell; x <= Math.ceil(maxX / cell) * cell; x += cell) {
      for (let z = Math.floor(minZ / cell) * cell; z <= Math.ceil(maxZ / cell) * cell; z += cell) {
        if (valleySurface.vertex(x, z) >= bottom) throw new CandidateError('clearance', 'Aircraft sweep intersects canonical terrain.');
      }
    }
  }
}

function attempt(input: ValleyFormationInput, source: Encounter, releaseLag: number,
  slot: 0 | 1, offset: number): ValleyAttempt {
  const releaseAt = input.startAt + 8 + (slot ? releaseLag : 0);
  const start = input.startAt - releaseAt, endAt = releaseAt + 7;
  const coverageEnd = input.startAt + 8 + releaseLag + 7 + FORMATION_FUTURE - releaseAt;
  const deadline = -difficulty(input.count).diveDuration - 0.5;
  const acquisition: AcquisitionWindow = Object.freeze({
    target: Object.freeze({ ...source.target }), range: targetSightDistance(input.count),
    viewport: Object.freeze({ ...input.viewport }), earliest: start,
    deadline, margin: input.acquisitionMargin,
  });
  const cruise = sample({ ...source, visibleAt: null }, input.count, start, coverageEnd, offset);
  const cruiseCamera = new ChaseTimeline(t => cruise.at(t), valleySurface, start, coverageEnd, input.previousViews[slot]);
  let acquireAt: number;
  try { acquireAt = cruiseCamera.acquire(acquisition); }
  catch (error) {
    if (!(error instanceof ChaseAcquisitionError)) throw error;
    throw new CandidateError('acquisition', `Slot ${slot} cannot acquire before its dive deadline.`);
  }
  const diveAt = acquireAt;
  if (diveAt > deadline) throw new CandidateError('acquisition', 'Dive would violate the solo fairness deadline.');
  const track = sample({ ...source, visibleAt: diveAt }, input.count, start, coverageEnd, offset);
  validateMotion(track, Math.max(difficulty(input.count).speed, source.start.velocity.z));
  const camera = new ChaseTimeline(t => track.at(t), valleySurface, start, coverageEnd, input.previousViews[slot]);
  for (let i = 0; i <= Math.ceil(input.acquisitionMargin / STEP); i++) {
    const t = acquireAt + Math.min(input.acquisitionMargin, i * STEP);
    for (const aspect of [input.viewport.minAspect, input.viewport.maxAspect]) {
      if (!camera.verify(t, camera.at(t), aspect, acquisition).ok) {
        throw new CandidateError('acquisition', 'Actual diving camera loses the complete ring during acquisition margin.');
      }
    }
  }
  const cutoff = (source.target.z + 90 - source.origin) / difficulty(input.count).speed;
  if (cutoff <= 0 || cutoff >= 7) {
    throw new CandidateError('coverage', 'Attempt lacks cutoff/recovery/finale coverage.');
  }
  for (const t of [-0.06, -0.003, 0, 0.003, 0.06]) {
    const points = contactAccuracy(predictImpact(launchFrom(track.at(t)), valleySurface), source.target, valleySurface);
    if (points < (Math.abs(t) <= 0.003 ? 95 : 1)) {
      throw new CandidateError('release_window', `Slot ${slot} does not preserve native release-window probes.`);
    }
  }
  return Object.freeze({ encounterId: input.encounterId, slot, releaseAt, acquireAt: releaseAt + acquireAt,
    cutoffAt: releaseAt + cutoff, endAt, track, camera, acquisition });
}

/**
 * Host-only bounded authoring. It neither advances Runs nor chooses formation
 * product parameters. Failure is data; there is no offset/lockout fallback.
 */
export function planValleyFormation(input: ValleyFormationInput): FormationResult {
  validate(input);
  const lead = planEncounter(input.count, input.seed, input.previous[0], valleySurface);
  const target = Object.freeze({ ...lead.target });
  const failures: CandidateFailure[] = [];
  for (const [index, candidate] of input.candidates.entries()) {
    try {
      const follower: Encounter = { ...lead, start: structuredClone(input.previous[1]),
        phase: lead.phase + candidate.phaseDelta, visibleAt: -5 };
      let offset = 0, converged = false;
      for (let iteration = 0; iteration < INTERCEPT_ITERATIONS; iteration++) {
        const impact = predictImpact(launchFrom(authoredPose(follower, input.count, -8 - candidate.lag, offset, 0)), valleySurface);
        if (impact.kind === 'ground' && distance(impact, target) < INTERCEPT_TOLERANCE) { converged = true; break; }
        offset += target.x - impact.x;
        follower.origin += target.z - impact.z;
        if (Math.abs(offset) > candidate.maxLateralCorrection ||
          Math.abs(follower.origin - lead.origin) > candidate.maxForwardCorrection) {
          throw new CandidateError('correction_bounds', 'Follower intercept exceeds declared path correction bounds.');
        }
      }
      if (!converged) throw new CandidateError('intercept', 'Follower intercept exhausted its bounded solve.');
      const speed = difficulty(input.count).speed;
      // The native entry uses the mean boundary forward speeds. At the cap,
      // a new intercept slightly farther forward needs more time, not a speed
      // overshoot. Only the caller's explicit allowance permits that adjustment.
      const entryDuration = 2 * (follower.origin - 5 * speed - follower.start.position.z)
        / (speed + follower.start.velocity.z);
      const releaseLag = Math.max(candidate.lag, entryDuration - 3);
      if (releaseLag > candidate.lag + candidate.maxLagAdjustment) {
        throw new CandidateError('lag_bounds', 'Follower handoff requires more lag than the declared timing allowance.');
      }
      const attempts = Object.freeze([attempt(input, lead, releaseLag, 0, 0),
        attempt(input, follower, releaseLag, 1, offset)] as const);
      const handoffAt = input.startAt + 8 + releaseLag + 7;
      return { ok: true, plan: Object.freeze({ encounterId: input.encounterId, target, targetKind: lead.targetKind,
        radius: TARGET_RADIUS, terrain: input.terrain, startAt: input.startAt, handoffAt,
        coverageEndAt: handoffAt + FORMATION_FUTURE, candidate: Object.freeze({ ...candidate }), releaseLag,
        attempts, rejected: Object.freeze([...failures]) }) };
    } catch (error) {
      if (!(error instanceof CandidateError)) throw error;
      failures.push(Object.freeze({ candidate: index, reason: error.reason, detail: error.message }));
    }
  }
  return { ok: false, failures: Object.freeze(failures) };
}

/** The data payload retains native valley seconds; it is not speed-reparameterized. */
export function formationTrackData(attempt: ValleyAttempt): FlightTrackData { return attempt.track.toData(); }
