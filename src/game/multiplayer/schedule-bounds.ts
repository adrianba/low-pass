import { FLOOR, GRAVITY, STEP } from '../../config/game';
import { flightControlHull } from '../../simulation/flight-track';
import { BOMB_MOUNT } from '../../simulation/pose';
import { CANYON } from '../../terrain/river-canyon';
import type { FormationPlan } from '../formation/approved';
import { FINALE_DURATION } from '../missile';
import { MAX_BOMB_SECONDS, MAX_SESSION_PLANS } from './session';

// Current + lookahead leave two retained tails. Even a last-instant release
// must settle and finish its effects within those two subsequent encounters.
export const MIN_SCHEDULE_DURATION = (MAX_BOMB_SECONDS + FINALE_DURATION) / (MAX_SESSION_PLANS - 2);

export function latestBombSettlement(plan: FormationPlan, slot: 0 | 1): number {
  const attempt = plan.attempts[slot], knots = attempt.track.toData().knots;
  const minimumGround = plan.terrain === 'river-canyon' ? CANYON.bed : FLOOR;
  const mountRadius = Math.hypot(BOMB_MOUNT.x, BOMB_MOUNT.y, BOMB_MOUNT.z);
  let latest = -Infinity;
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1]!, b = knots[i]!;
    const first = Math.max(attempt.acquireAt, a.time + attempt.releaseAt);
    const last = Math.min(attempt.cutoffAt, b.time + attempt.releaseAt);
    if (first > last) continue;
    const hull = flightControlHull(a, b), duration = b.time - a.time;
    const height = Math.max(...hull.map(p => p.y)) + mountRadius;
    const velocity = Math.max(...hull.slice(1).map((p, j) => 5 * (p.y - hull[j]!.y) / duration));
    const fall = (velocity + Math.sqrt(velocity ** 2 + 2 * GRAVITY * Math.max(0, height - minimumGround))) / GRAVITY;
    const bounded = fall + 2 * STEP;
    if (!Number.isFinite(bounded) || bounded > MAX_BOMB_SECONDS) throw new Error('Plan exceeds supported bomb lifetime.');
    latest = Math.max(latest, last + bounded);
  }
  if (!Number.isFinite(latest)) throw new Error('Plan has no bounded release interval.');
  return latest;
}

export function assertScheduleBounds(plan: FormationPlan, previous?: FormationPlan): void {
  if (plan.handoffAt - plan.startAt < MIN_SCHEDULE_DURATION) throw new Error('Plan exceeds the bounded history budget.');
  for (const slot of [0, 1] as const) {
    const attempt = plan.attempts[slot], deadline = attempt.releaseAt + attempt.acquisition.deadline;
    if (!Number.isFinite(deadline) || deadline < attempt.acquireAt || deadline > attempt.releaseAt) {
      throw new Error('Plan has an invalid dive deadline.');
    }
    latestBombSettlement(plan, slot);
    if (previous) {
      if (latestBombSettlement(previous, slot) + STEP >= deadline) {
        throw new Error('Previous bomb can overlap the next dive deadline.');
      }
    }
  }
}
