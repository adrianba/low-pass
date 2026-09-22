import { counter, secondsAt, stampAt } from '../../shared/protocol/game.js';
import type { Stamp } from '../../shared/protocol/game.js';

export interface ClockAnchor { epoch: number; at: Stamp; monotonicMs: number; running: boolean }

/** Host clock anchors are separate from the last actually displayed frame time. */
export class SessionClock {
  private epoch: number;
  private at: number;
  private wall: number;
  private lastWall: number;
  private running = false;
  constructor(private readonly now: () => number, startAt = 0, epoch = 0) {
    this.epoch = counter.parse(epoch);
    this.at = secondsAt(stampAt(startAt));
    this.wall = this.lastWall = now();
    if (!Number.isFinite(this.wall)) throw new Error('Invalid monotonic clock.');
  }
  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now) || now < this.lastWall) throw new Error('Monotonic clock moved backwards.');
    this.lastWall = now;
    return now;
  }
  sample(): ClockAnchor {
    const now = this.readNow();
    return { epoch: this.epoch, at: stampAt(this.at + (this.running ? (now - this.wall) / 1000 : 0)),
      monotonicMs: now, running: this.running };
  }
  pause(): ClockAnchor {
    const sample = this.sample();
    this.at = secondsAt(sample.at); this.wall = sample.monotonicMs; this.running = false;
    return { ...sample, running: false };
  }
  start(epoch: number, startedAt?: number): ClockAnchor {
    counter.parse(epoch);
    if (this.running || epoch !== this.epoch + 1) throw new Error('Clock start requires a new paused epoch.');
    const now = this.readNow(), wall = startedAt ?? now;
    if (!Number.isFinite(wall) || wall < this.wall || wall > now) throw new Error('Invalid acknowledged clock start.');
    this.wall = wall; this.epoch = epoch; this.running = true;
    return this.sample();
  }
}
