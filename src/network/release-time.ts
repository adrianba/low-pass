import { secondsAt, stampAt } from '../../shared/protocol/game.js';
import type { Stamp } from '../../shared/protocol/game.js';

export function releaseTime(stamp: Stamp, bounds: { acquireAt: number; cutoffAt: number }): number {
  for (const time of [bounds.acquireAt, bounds.cutoffAt]) {
    const encoded = stampAt(time);
    if (stamp.tick === encoded.tick && stamp.fraction === encoded.fraction) return time;
  }
  return secondsAt(stamp);
}
