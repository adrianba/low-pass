import { compareStamps, counter, secondsAt, stamp } from '../../shared/protocol/game.js';
import { ClockError, PeerClock } from './peer-clock.js';
import type { ClockAnchor } from './session-clock.js';

export const REPLICA_CLOCK_LIMITS = Object.freeze({ freshnessMs: 500, futureSeconds: 0.5,
  presentationDelaySeconds: 0.05, correctionSeconds: 0.1, slewRate: 0.01 });

export class ReplicaClock {
  private anchor: ClockAnchor | null = null;
  private receivedAt = 0;
  private lastWall = -Infinity;
  private frameWall = 0;
  private displayed: number | null = null;
  private epochFloor = 0;
  private floorWait = 0;
  constructor(private readonly peer: PeerClock) {}
  private now(time: number): number {
    if (!Number.isFinite(time) || Math.abs(time) > 1e12 || time < this.lastWall) throw new ClockError('invalid');
    this.lastWall = time; return time;
  }
  observe(value: ClockAnchor, receivedAt: number): void {
    counter.parse(value.epoch); stamp.parse(value.at);
    if (!Number.isFinite(value.monotonicMs) || Math.abs(value.monotonicMs) > 1e12 || typeof value.running !== 'boolean') {
      throw new ClockError('invalid');
    }
    if (this.anchor && (value.epoch < this.anchor.epoch || value.epoch > this.anchor.epoch + 1 ||
      value.monotonicMs < this.anchor.monotonicMs ||
      compareStamps(value.at, this.anchor.at) < 0 ||
      value.running && !this.anchor.running && value.epoch === this.anchor.epoch)) throw new ClockError('drift', 'inconsistent host clock anchor');
    this.receivedAt = this.now(receivedAt);
    if (this.anchor?.epoch !== value.epoch) {
      this.epochFloor = this.anchor && !this.anchor.running ? secondsAt(this.anchor.at) : secondsAt(value.at);
      this.frameWall = receivedAt;
      this.floorWait = 0;
    }
    this.anchor = structuredClone(value);
  }
  frame(time: number, coverage: { startAt: number; endAt: number }): number {
    const now = this.now(time), anchor = this.anchor;
    if (!anchor) throw new ClockError('unsynchronized');
    if (![coverage.startAt, coverage.endAt].every(Number.isFinite) || coverage.startAt < 0 || coverage.endAt < coverage.startAt) {
      throw new ClockError('invalid');
    }
    let desired = secondsAt(anchor.at), floorWait = 0;
    if (anchor.running) {
      if (now - this.receivedAt > REPLICA_CLOCK_LIMITS.freshnessMs) throw new ClockError('stale');
      const estimate = this.peer.estimate(now);
      const delayed = desired + (estimate.remoteLower - anchor.monotonicMs) / 1000 -
        REPLICA_CLOCK_LIMITS.presentationDelaySeconds;
      floorWait = Math.max(0, this.epochFloor - delayed);
      desired = Math.max(this.epochFloor, delayed);
      if (desired > secondsAt(anchor.at) + REPLICA_CLOCK_LIMITS.futureSeconds) throw new ClockError('stale');
    }
    if (desired < coverage.startAt || desired > coverage.endAt) throw new ClockError('coverage');
    let next = desired;
    if (this.displayed !== null && anchor.running) {
      // Time spent waiting for the initial presentation delay is not flight time.
      const delta = Math.max(0, (now - this.frameWall) / 1000 - this.floorWait);
      const error = desired - (this.displayed + delta);
      if (Math.abs(error) > REPLICA_CLOCK_LIMITS.correctionSeconds) {
        throw new ClockError('drift', `required presentation correction ${Math.round(error * 1000)}ms`);
      }
      const correction = Math.min(delta * REPLICA_CLOCK_LIMITS.slewRate, Math.max(-delta * REPLICA_CLOCK_LIMITS.slewRate, error));
      next = Math.max(this.displayed, Math.min(desired, this.displayed + delta + correction));
    }
    if (this.displayed !== null && next < this.displayed) throw new ClockError('drift', 'presentation would rewind');
    if (next < coverage.startAt || next > coverage.endAt) throw new ClockError('coverage');
    this.displayed = next; this.frameWall = now; this.floorWait = floorWait;
    return next;
  }
}
