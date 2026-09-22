import { STEP } from '../config/game';
import type { Surface } from '../terrain/surface';
import { chaseView, targetInChaseView } from './chase-camera';
import type { ChaseView } from './chase-camera';
import { MAX_TRACK_COMPONENT } from './flight-track-data';
import { distance, mix } from './math';
import type { Vec3 } from './math';
import type { Pose } from './pose';

export const MAX_CHASE_SAMPLES = 32_768;
export const CHASE_VIEW_TOLERANCE = 0.001;
export class ChaseAcquisitionError extends Error {}
interface Sample {
  readonly time: number;
  readonly position: Readonly<Vec3>;
  readonly target: Readonly<Vec3>;
}
export function sampleChase(samples: readonly Sample[], time: number): ChaseView {
  if (samples.length < 2 || !Number.isFinite(time) || time < samples[0]!.time || time > samples.at(-1)!.time) {
    throw new Error('Chase time exceeds authored coverage.');
  }
  let lo = 0, hi = samples.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.time < time) lo = mid; else hi = mid;
  }
  const a = samples[lo]!, b = samples[hi]!, alpha = (time - a.time) / (b.time - a.time);
  const vector = (a: Vec3, b: Vec3): Vec3 => ({
    x: mix(a.x, b.x, alpha), y: mix(a.y, b.y, alpha), z: mix(a.z, b.z, alpha),
  });
  return { position: vector(a.position, b.position), target: vector(a.target, b.target) };
}
export interface ViewportEnvelope { readonly minAspect: number; readonly maxAspect: number }
export interface AcquisitionWindow {
  readonly target: Readonly<Vec3>;
  readonly range: number;
  readonly viewport: ViewportEnvelope;
  readonly earliest: number;
  readonly deadline: number;
  readonly margin: number;
}
export type ViewCheck =
  | { ok: true }
  | { ok: false; reason: 'viewport_changed' | 'camera_mismatch' | 'target_hidden' };

function finiteVector(value: Vec3): boolean {
  return [value.x, value.y, value.z].every(n => Number.isFinite(n) && Math.abs(n) <= MAX_TRACK_COMPONENT);
}
function viewportValid(value: ViewportEnvelope): boolean {
  return Number.isFinite(value.minAspect) && Number.isFinite(value.maxAspect) &&
    value.minAspect > 0 && value.maxAspect >= value.minAspect;
}
function copyView(value: ChaseView): ChaseView {
  return { position: { ...value.position }, target: { ...value.target } };
}

export class ChaseTimeline {
  readonly samples: readonly Sample[];

  constructor(poseAt: (time: number) => Pose, readonly surface: Surface,
    readonly startTime: number, readonly endTime: number, previous: ChaseView | null = null) {
    const count = Math.ceil((endTime - startTime) / STEP);
    if (![startTime, endTime].every(Number.isFinite) || count < 1 || count + 1 > MAX_CHASE_SAMPLES) {
      throw new Error('Invalid bounded chase timeline coverage.');
    }
    if (previous && (!finiteVector(previous.position) || !finiteVector(previous.target))) {
      throw new Error('Invalid initial chase view.');
    }
    const samples: Sample[] = [];
    let last: ChaseView | null = previous ? copyView(previous) : null;
    let lastTime = startTime;
    for (let index = 0; index <= count; index++) {
      const time = index === count ? endTime : Math.min(endTime, startTime + index * STEP);
      if (index && time <= lastTime) continue;
      const pose = poseAt(time);
      if (![pose.position, pose.velocity, pose.acceleration].every(finiteVector) ||
        ![pose.bank, pose.pitch].every(Number.isFinite)) throw new Error('Invalid authored chase motion.');
      const view = chaseView(pose, surface, last?.position ?? null, index ? time - lastTime : 0);
      if (index === 0 && previous) view.target = { ...previous.target };
      if (!finiteVector(view.position) || !finiteVector(view.target) || distance(view.position, view.target) === 0) {
        throw new Error('Invalid authored chase view.');
      }
      samples.push(Object.freeze({ time, position: Object.freeze({ ...view.position }), target: Object.freeze({ ...view.target }) }));
      last = view;
      lastTime = time;
    }
    if (samples.length < 2 || samples.at(-1)!.time !== endTime) throw new Error('Incomplete chase timeline coverage.');
    this.samples = Object.freeze(samples);
  }

  at(time: number): ChaseView {
    if (!Number.isFinite(time) || time < this.startTime || time > this.endTime) {
      throw new Error('Chase time exceeds authored coverage.');
    }
    return sampleChase(this.samples, time);
  }

  acquire(window: AcquisitionWindow): number {
    this.validateWindow(window);
    let visibleSince: number | null = null;
    const count = Math.ceil((window.deadline - window.earliest) / STEP);
    for (let index = 0; index <= count; index++) {
      const time = Math.min(window.deadline, window.earliest + index * STEP);
      const view = this.at(time);
      const visible = [window.viewport.minAspect, window.viewport.maxAspect].every(aspect =>
        targetInChaseView(window.target, view, this.surface, aspect, window.range));
      if (!visible) visibleSince = null;
      else if (visibleSince === null) visibleSince = time;
      if (visibleSince !== null && time - visibleSince >= window.margin) return visibleSince;
    }
    throw new ChaseAcquisitionError('Authored camera cannot acquire the complete target before the dive deadline.');
  }

  verify(time: number, actual: ChaseView, aspect: number, window: AcquisitionWindow): ViewCheck {
    this.validateWindow(window);
    if (!Number.isFinite(aspect) || aspect <= 0 || !finiteVector(actual.position) || !finiteVector(actual.target)) {
      throw new Error('Invalid actual chase view or viewport.');
    }
    const expected = this.at(time);
    if (aspect < window.viewport.minAspect || aspect > window.viewport.maxAspect) {
      return { ok: false, reason: 'viewport_changed' };
    }
    if (distance(actual.position, expected.position) > CHASE_VIEW_TOLERANCE ||
      distance(actual.target, expected.target) > CHASE_VIEW_TOLERANCE) {
      return { ok: false, reason: 'camera_mismatch' };
    }
    return targetInChaseView(window.target, actual, this.surface, aspect, window.range)
      ? { ok: true } : { ok: false, reason: 'target_hidden' };
  }

  private validateWindow(window: AcquisitionWindow): void {
    if (!finiteVector(window.target) || !Number.isFinite(window.range) || window.range <= 0 ||
      !viewportValid(window.viewport) || ![window.earliest, window.deadline, window.margin].every(Number.isFinite) ||
      window.earliest < this.startTime || window.deadline > this.endTime ||
      window.margin < STEP || window.deadline - window.earliest < window.margin) {
      throw new Error('Invalid authored acquisition window.');
    }
  }
}
