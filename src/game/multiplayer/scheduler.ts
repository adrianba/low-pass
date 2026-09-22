import type { TerrainTheme } from '../../config/terrain';
import { isTerrainTheme } from '../../config/terrain';
import type { FormationPlan, FormationRequest } from '../formation/approved';
import { planFormation } from '../formation/approved';
import { initialFormationPoses } from '../formation/initial';
import { assertScheduleBounds, MIN_SCHEDULE_DURATION } from './schedule-bounds';
import { HostSession, MAX_SESSION_ADVANCE } from './session';
import type { CommandResult, SessionOptions } from './session';

export type FormationAuthor = (request: FormationRequest) => ReturnType<typeof planFormation>;
export const MAX_SCHEDULE_WORK = Math.ceil(MAX_SESSION_ADVANCE / MIN_SCHEDULE_DURATION) + 1;

export class FormationScheduler {
  readonly session: HostSession;
  private readonly plans = new Map<number, FormationPlan>();
  private current = 0;
  private highest = 0;
  private error: string | null = null;

  constructor(readonly terrain: TerrainTheme, readonly seed: number, private readonly author: FormationAuthor = planFormation,
    options: SessionOptions = {}) {
    if (!isTerrainTheme(terrain) || !Number.isSafeInteger(seed)) throw new Error('Invalid shared course configuration.');
    const first = this.authorPlan(0);
    assertScheduleBounds(first, undefined, options.releaseGraceSeconds);
    this.session = new HostSession(first, options);
    this.plans.set(0, first);
    this.lookAhead();
  }

  get sequence(): number { return this.current; }
  get failure(): string | null { return this.error; }
  get retainedSequences(): number[] { return [...this.plans.keys()]; }

  plan(sequence = this.current): FormationPlan {
    const plan = this.plans.get(sequence);
    if (!plan) throw new Error('Unknown scheduled encounter.');
    return plan;
  }

  advanceTo(target: number): CommandResult {
    if (this.error) return { ok: false, reason: 'blocked' };
    if (!Number.isFinite(target) || target < this.session.time || target - this.session.time > MAX_SESSION_ADVANCE) {
      throw new Error('Invalid bounded schedule advance.');
    }
    if (this.session.status !== 'running') return { ok: false, reason: this.session.status };
    if (target === this.session.time) return this.session.advanceTo(target);
    let work = 0;
    while (this.session.time < target) {
      const end = Math.min(target, this.plan().handoffAt);
      const result = this.session.advanceTo(end);
      if (!result.ok || this.session.status !== 'running') return result;
      this.retire();
      if (this.session.time === this.plan().handoffAt) {
        this.current++;
        if (++work > MAX_SCHEDULE_WORK) this.fail('Schedule advance exceeded its planning work bound.');
        this.lookAhead();
      }
    }
    return { ok: true };
  }

  private retire(): void {
    for (const sequence of this.session.retireReadyPlans()) this.plans.delete(sequence);
  }

  private lookAhead(): void {
    if (this.highest > this.current) return;
    const sequence = this.highest + 1, previous = this.plan(this.highest);
    const wasRunning = this.session.status === 'running';
    this.error = `Encounter ${sequence} lookahead is incomplete.`;
    this.session.pause();
    const plan = this.authorPlan(sequence, previous);
    assertScheduleBounds(plan, previous, this.session.releaseGraceSeconds);
    this.session.installPlan(sequence, plan);
    this.plans.set(sequence, plan);
    this.highest = sequence;
    this.error = null;
    if (wasRunning) this.session.resume();
  }

  private authorPlan(sequence: number, previous?: FormationPlan): FormationPlan {
    const startAt = previous?.handoffAt ?? 0;
    const result = this.author({
      encounterId: `formation-${sequence}`, count: sequence, seed: this.seed, terrain: this.terrain, startAt,
      previous: previous ? [
        previous.attempts[0].track.at(startAt - previous.attempts[0].releaseAt),
        previous.attempts[1].track.at(startAt - previous.attempts[1].releaseAt),
      ] : initialFormationPoses(this.terrain),
      previousViews: previous ? [
        previous.attempts[0].camera.at(startAt - previous.attempts[0].releaseAt),
        previous.attempts[1].camera.at(startAt - previous.attempts[1].releaseAt),
      ] : [null, null],
    });
    if (!result.ok) this.fail(`Could not author encounter ${sequence}: ${JSON.stringify(result.failures)}`);
    return result.plan;
  }

  private fail(message: string): never {
    this.error = message;
    this.session?.pause();
    throw new Error(message);
  }
}
