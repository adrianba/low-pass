import { FlightTrack } from '../../simulation/flight-track';
import type { FlightTrackData } from '../../simulation/flight-track-data';
import type { Pose } from '../../simulation/pose';

/**
 * Valley attitude is not FlightTrack's canyon-derived motionPose attitude.
 * Retain the authored attitude with bounded C1 Hermite interpolation while reusing the
 * immutable track format and quintic position/velocity/acceleration curves.
 * Both host and importer must evaluate formation tracks through this adapter.
 */
export class FormationTrack {
  readonly motion: FlightTrack;
  constructor(data: FlightTrackData) { this.motion = new FlightTrack(data); }
  static fromData(data: unknown): FormationTrack { return new FormationTrack(FlightTrack.fromData(data).toData()); }
  toData(): FlightTrackData { return this.motion.toData(); }
  get startTime(): number { return this.motion.startTime; }
  get endTime(): number { return this.motion.endTime; }

  at(time: number): Pose {
    this.motion.assertCoverage(time, time);
    const knots = this.motion.knots;
    let lo = 0, hi = knots.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (knots[mid]!.time < time) lo = mid; else hi = mid;
    }
    const a = knots[lo]!, b = knots[hi]!, duration = b.time - a.time;
    const t = (time - a.time) / duration;
    const pose = this.motion.at(time);
    for (const axis of ['bank', 'pitch'] as const) {
      const slope = (i: number): number => {
        if (i === 0 || i === knots.length - 1) return 0;
        const before = knots[i - 1]!, current = knots[i]!, after = knots[i + 1]!;
        const left = current.time - before.time, right = after.time - current.time;
        const a = (current.pose[axis] - before.pose[axis]) / left;
        const b = (after.pose[axis] - current.pose[axis]) / right;
        if (a * b <= 0) return 0;
        const w1 = 2 * right + left, w2 = right + 2 * left;
        return (w1 + w2) / (w1 / a + w2 / b);
      };
      pose[axis] = (2 * t ** 3 - 3 * t ** 2 + 1) * a.pose[axis]
        + (t ** 3 - 2 * t ** 2 + t) * duration * slope(lo)
        + (-2 * t ** 3 + 3 * t ** 2) * b.pose[axis]
        + (t ** 3 - t ** 2) * duration * slope(hi);
    }
    return pose;
  }
}
