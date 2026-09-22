import type { ChaseView } from '../../simulation/chase-camera';
import type { Pose } from '../../simulation/pose';
import type { FormationPlan } from '../formation/approved';
import { FINALE_DURATION, FLYBY_DURATION } from '../combat-timing';
import type { MissileView } from '../canyon-missile';
import { authorCombatPlan } from './combat-plan';
import type { CombatPlanData } from './combat-plan';
import { MAX_COMBAT_VIEWS } from './combat-timeline';
import type { CombatTimeline, CombatPoseSampler } from './combat-timeline';
import type { FormationScheduler } from './scheduler';
import type { PlayerSlot, SessionEvent } from './session';

export type CombatViewProvider = (slot: PlayerSlot, view: ChaseView, range: number) => MissileView;

export function formationAt(plans: readonly FormationPlan[], time: number): FormationPlan {
  const plan = [...plans].reverse().find(p => p.startAt <= time && time <= p.handoffAt);
  if (!plan) throw new Error('Missing retained flight history.');
  return plan;
}

export function formationSampler(scheduler: FormationScheduler): CombatPoseSampler {
  const plans = scheduler.retainedSequences.map(sequence => scheduler.plan(sequence));
  return (slot, time): Pose => {
    const attempt = formationAt(plans, time).attempts[slot];
    return attempt.track.at(time - attempt.releaseAt);
  };
}

export class HostCombat {
  private readonly plans = new Map<number, CombatPlanData>();
  private readonly lastResolved: [number, number] = [-1, -1];
  constructor(private readonly scheduler: FormationScheduler, private readonly view: CombatViewProvider) {}

  consume(events: readonly SessionEvent[]): void {
    const plans = this.scheduler.retainedSequences.map(sequence => this.scheduler.plan(sequence));
    for (const event of events) {
      if (event.type !== 'resolved') continue;
      if (event.result.sequence <= this.lastResolved[event.result.slot]) throw new Error('Combat outcome was already authored.');
      const result = event.result, current = formationAt(plans, result.time), attempt = current.attempts[result.slot];
      const next = plans.find(p => p.startAt === current.handoffAt);
      const view = this.view(result.slot, attempt.camera.at(result.time - attempt.releaseAt), attempt.acquisition.range + 400);
      const combat = authorCombatPlan(result, current, this.scheduler.seed, view, undefined, next);
      if (combat) this.plans.set(combat.id, combat);
      this.lastResolved[result.slot] = result.sequence;
    }
    this.prune(this.scheduler.session.time);
  }
  at(time: number): readonly CombatPlanData[] {
    if (!Number.isFinite(time) || time < 0 || time > 1e8) throw new Error('Invalid combat presentation time.');
    this.prune(time);
    return [...this.plans.values()];
  }
  private prune(time: number): void {
    for (const [id, plan] of this.plans) {
      if (plan.missile.kind !== 'finale' && time >= plan.bornAt + FLYBY_DURATION) this.plans.delete(id);
    }
    if (this.plans.size > MAX_COMBAT_VIEWS) throw new Error('Combat history exceeds its bounded view budget.');
  }
}

export function spectatorSlot(preferred: PlayerSlot, timeline: CombatTimeline): PlayerSlot {
  if (timeline.aliveAt(preferred)) return preferred;
  const other = preferred === 0 ? 1 : 0;
  if (timeline.aliveAt(other)) return other;
  return timeline.finaleBornAt(0) > timeline.finaleBornAt(1) ? 0 : 1;
}

export function endingTime(scheduler: FormationScheduler): number | null {
  if (scheduler.session.status !== 'over') return null;
  return scheduler.session.time + FINALE_DURATION;
}
