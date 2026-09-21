import { MAX_MISSES, STEP, TARGET_RADIUS } from '../../config/game';
import { isTerrainTheme } from '../../config/terrain';
import type { TerrainTheme } from '../../config/terrain';
import { advanceBomb, contactAccuracy } from '../../simulation/ballistics';
import type { Bomb } from '../../simulation/ballistics';
import { FlightTrack } from '../../simulation/flight-track';
import { launchFrom } from '../../simulation/pose';
import type { Pose } from '../../simulation/pose';
import { surfaceFor } from '../../terrain/surface';
import type { Contact } from '../../terrain/surface';
import { FINALE_DURATION } from '../missile';
import type { FormationPlan } from '../formation/approved';
import { FormationTrack } from '../formation/track';
import { TARGET_KINDS } from '../targets';

export type PlayerSlot = 0 | 1;
export const MAX_SESSION_PLANS = 4;
export const MAX_SESSION_EVENTS = 256;
export const MAX_BOMB_SECONDS = 20;
export const MAX_SESSION_ADVANCE = 60;
export type SessionStatus = 'running' | 'paused' | 'blocked' | 'over';
export type CommandRejection = Exclude<SessionStatus, 'running'> | Failure['code'] | 'eliminated'
  | 'stale_encounter' | 'unknown_encounter' | 'resolved' | 'already_released' | 'not_acquired' | 'cutoff' | 'active_bomb';
export type CommandResult = { ok: true } | { ok: false; reason: CommandRejection };
export interface AttemptResult {
  id: number; sequence: number; slot: PlayerSlot; time: number; points: number; impact: Contact | null;
}
export interface PlayerCompletion {
  slot: PlayerSlot; sequence: number; time: number; score: number; misses: number; assisted: boolean; pose: Pose;
}
type EventPayload =
  | { type: 'released'; slot: PlayerSlot; sequence: number; time: number }
  | { type: 'resolved'; result: AttemptResult }
  | { type: 'eliminated'; completion: PlayerCompletion }
  | { type: 'ended'; time: number; winner: PlayerSlot | 'draw' };
export type SessionEvent = EventPayload & { eventId: number };
interface ActiveBomb { sequence: number; releasedAt: number; steps: number; value: Bomb }
interface Player {
  score: number; misses: number; assistance: boolean; assisted: boolean;
  bomb: ActiveBomb | null; completion: PlayerCompletion | null;
}
interface Attempt {
  acquireAt: number; releaseAt: number; cutoffAt: number; resolveCutoffAt: number;
  track: FlightTrack | FormationTrack;
  releasedAt: number | null; result: AttemptResult | null; skipped: boolean;
}
interface Encounter {
  sequence: number; id: string; startAt: number; handoffAt: number; coverageEndAt: number;
  target: FormationPlan['target']; targetKind: FormationPlan['targetKind'];
  destroyed: boolean; attempts: [Attempt, Attempt];
}
interface Failure { code: 'coverage' | 'events_full' | 'bomb_lifetime' | 'unsettled_attempt'; message: string }
const slots = [0, 1] as const;
const player = (): Player => ({ score: 0, misses: 0, assistance: false, assisted: false, bomb: null, completion: null });
function validSlot(slot: PlayerSlot): void {
  if (slot !== 0 && slot !== 1) throw new Error('Invalid player slot.');
}
function samePose(a: Pose, b: Pose): boolean {
  return (['position', 'velocity', 'acceleration'] as const).every(key =>
    (['x', 'y', 'z'] as const).every(axis => a[key][axis] === b[key][axis]))
    && a.bank === b.bank && a.pitch === b.pitch;
}

export class HostSession {
  readonly terrain: TerrainTheme;
  private clock: number;
  private state: SessionStatus = 'running';
  private readonly players: [Player, Player] = [player(), player()];
  private readonly encounters = new Map<number, Encounter>();
  private lastSequence = -1;
  private readonly events: SessionEvent[] = [];
  private eventId = 0;
  private failure: Failure | null = null;
  private requiredCoverage = 0;

  constructor(first: FormationPlan) {
    if (!isTerrainTheme(first.terrain)) throw new Error('Invalid session terrain.');
    this.terrain = first.terrain;
    this.clock = first.startAt;
    this.installPlan(0, first);
  }

  get time(): number { return this.clock; }
  get status(): SessionStatus { return this.state; }
  get winner(): PlayerSlot | 'draw' | null {
    if (this.state !== 'over') return null;
    return this.players[0].score === this.players[1].score ? 'draw'
      : this.players[0].score > this.players[1].score ? 0 : 1;
  }

  installPlan(sequence: number, plan: FormationPlan): void {
    if (this.state === 'over') throw new Error('Cannot install a plan into an ended session.');
    if (!Number.isSafeInteger(sequence) || sequence !== this.lastSequence + 1 || sequence > 100_000 ||
      this.encounters.size >= MAX_SESSION_PLANS) throw new Error('Invalid session plan sequence or capacity.');
    const times = [plan.startAt, plan.handoffAt, plan.coverageEndAt];
    if (plan.terrain !== this.terrain || plan.radius !== TARGET_RADIUS || !plan.encounterId || plan.encounterId.length > 128 ||
      !times.every(t => Number.isFinite(t) && t >= 0 && t <= 1e8) || plan.startAt < this.clock ||
      plan.handoffAt <= plan.startAt || plan.coverageEndAt - plan.handoffAt < FINALE_DURATION - 1e-8 ||
      ![plan.target.x, plan.target.y, plan.target.z].every(n => Number.isFinite(n) && Math.abs(n) <= 1e9) ||
      !TARGET_KINDS.includes(plan.targetKind) || plan.attempts.length !== 2) {
      throw new Error('Invalid session plan metadata or coverage.');
    }
    const previous = this.encounters.get(this.lastSequence);
    if (previous && plan.startAt !== previous.handoffAt) throw new Error('Session plans must share an exact handoff.');
    const attempt = (slot: PlayerSlot): Attempt => {
      const input = plan.attempts[slot];
      if (input.slot !== slot || input.encounterId !== plan.encounterId ||
        ![input.acquireAt, input.releaseAt, input.cutoffAt, input.endAt].every(Number.isFinite) ||
        input.acquireAt < plan.startAt || input.acquireAt > input.releaseAt ||
        input.releaseAt >= input.cutoffAt || input.cutoffAt >= input.endAt || input.endAt > plan.handoffAt) {
        throw new Error('Invalid session attempt timing or identity.');
      }
      const track = this.terrain === 'river-canyon'
        ? FlightTrack.fromData(input.track.toData()) : FormationTrack.fromData(input.track.toData());
      const localStart = plan.startAt - input.releaseAt, localEnd = plan.coverageEndAt - input.releaseAt;
      if (localStart < track.startTime || localEnd > track.endTime) throw new Error('Incomplete session flight coverage.');
      if (previous && !samePose(track.at(localStart), previous.attempts[slot].track.at(plan.startAt - previous.attempts[slot].releaseAt))) {
        throw new Error('Session handoff changed full aircraft motion.');
      }
      let resolveCutoffAt = plan.startAt + (Math.floor((input.cutoffAt - plan.startAt) / STEP) + 1) * STEP;
      if (resolveCutoffAt <= input.cutoffAt) resolveCutoffAt += STEP;
      return { acquireAt: input.acquireAt, releaseAt: input.releaseAt, cutoffAt: input.cutoffAt, resolveCutoffAt,
        track, releasedAt: null, result: null, skipped: this.players[slot].completion !== null } satisfies Attempt;
    };
    this.encounters.set(sequence, { sequence, id: plan.encounterId, startAt: plan.startAt, handoffAt: plan.handoffAt,
      coverageEndAt: plan.coverageEndAt, target: { ...plan.target }, targetKind: plan.targetKind,
      destroyed: false, attempts: [attempt(0), attempt(1)] });
    this.lastSequence = sequence;
  }

  pose(slot: PlayerSlot): Pose {
    validSlot(slot);
    const completed = this.players[slot].completion;
    if (completed) return structuredClone(completed.pose);
    const encounter = [...this.encounters.values()].reverse().find(e => e.startAt <= this.clock);
    if (!encounter || this.clock > encounter.coverageEndAt) throw new Error('Missing session pose coverage.');
    return encounter.attempts[slot].track.at(this.clock - encounter.attempts[slot].releaseAt);
  }

  release(slot: PlayerSlot, sequence: number): CommandResult {
    validSlot(slot);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid release sequence.');
    if (this.state !== 'running') return { ok: false, reason: this.state };
    const p = this.players[slot], encounter = this.encounters.get(sequence);
    if (p.completion) return { ok: false, reason: 'eliminated' };
    if (!encounter) return { ok: false, reason: sequence <= this.lastSequence ? 'stale_encounter' : 'unknown_encounter' };
    const attempt = encounter.attempts[slot];
    if (attempt.result || attempt.skipped) return { ok: false, reason: 'resolved' };
    if (attempt.releasedAt !== null) return { ok: false, reason: 'already_released' };
    if (this.clock < attempt.acquireAt) return { ok: false, reason: 'not_acquired' };
    if (this.clock > attempt.cutoffAt) return { ok: false, reason: 'cutoff' };
    if (p.bomb) return { ok: false, reason: 'active_bomb' };
    this.reserveEvents(1);
    const value = launchFrom(attempt.track.at(this.clock - attempt.releaseAt));
    attempt.releasedAt = this.clock;
    p.bomb = { sequence, releasedAt: this.clock, steps: 0, value };
    this.emit({ type: 'released', slot, sequence, time: this.clock });
    return { ok: true };
  }

  setAssistance(slot: PlayerSlot, enabled: boolean): CommandResult {
    validSlot(slot);
    if (typeof enabled !== 'boolean') throw new Error('Invalid assistance setting.');
    if (this.players[slot].completion) return { ok: false, reason: 'eliminated' };
    this.players[slot].assistance = enabled;
    this.players[slot].assisted ||= enabled;
    return { ok: true };
  }

  pause(): void { if (this.state === 'running') this.state = 'paused'; }
  resume(): CommandResult {
    if (this.state === 'over') return { ok: false, reason: 'over' };
    if (this.failure) {
      const fixed = this.failure.code === 'coverage' && this.encounters.get(this.lastSequence)!.handoffAt >= this.requiredCoverage
        || this.failure.code === 'events_full' && this.events.length <= MAX_SESSION_EVENTS - 3;
      if (!fixed) return { ok: false, reason: this.failure.code };
      this.failure = null;
    }
    this.state = 'running';
    return { ok: true };
  }

  advanceTo(target: number): CommandResult {
    if (!Number.isFinite(target) || target < this.clock || target - this.clock > MAX_SESSION_ADVANCE) {
      throw new Error('Invalid bounded session clock advance.');
    }
    if (this.state !== 'running') return { ok: false, reason: this.state };
    if (target > this.encounters.get(this.lastSequence)!.handoffAt) {
      this.requiredCoverage = target;
      this.fail('coverage', 'Install the next shared plan before advancing beyond the handoff.');
    }
    this.processEvents();
    while (this.clock < target && this.state === 'running') {
      let next = target;
      for (const p of this.players) if (p.bomb) next = Math.min(next, p.bomb.releasedAt + (p.bomb.steps + 1) * STEP);
      for (const encounter of this.encounters.values()) for (const a of encounter.attempts) {
        if (!a.skipped && !a.result && a.releasedAt === null) next = Math.min(next, a.resolveCutoffAt);
      }
      if (next <= this.clock) throw new Error('Session event clock failed to advance.');
      this.clock = next;
      this.processEvents();
    }
    return { ok: true };
  }

  private processEvents(): void {
    for (const slot of slots) {
      const active = this.players[slot].bomb;
      if (active && active.releasedAt + (active.steps + 1) * STEP <= this.clock) {
        const next = structuredClone(active.value);
        const impact = advanceBomb(next, STEP, surfaceFor(this.terrain));
        if (impact) this.resolve(active.sequence, slot, impact);
        else if (active.steps + 1 >= MAX_BOMB_SECONDS / STEP) this.fail('bomb_lifetime', 'Active bomb exceeded supported lifetime.');
        else { active.value = next; active.steps++; }
      }
    }
    for (const encounter of this.encounters.values()) for (const slot of slots) {
      const a = encounter.attempts[slot];
      if (!a.skipped && !a.result && a.releasedAt === null && this.clock >= a.resolveCutoffAt) {
        if (this.players[slot].bomb) this.fail('unsettled_attempt', 'A later cutoff overlaps an unsettled player bomb.');
        this.resolve(encounter.sequence, slot, null);
      }
    }
  }

  private resolve(sequence: number, slot: PlayerSlot, impact: Contact | null): void {
    const encounter = this.encounters.get(sequence)!;
    const attempt = encounter.attempts[slot], p = this.players[slot];
    if (attempt.result || attempt.skipped || p.completion) throw new Error('Attempt was already finalized.');
    const points = impact?.kind === 'ground' ? contactAccuracy(impact, encounter.target, surfaceFor(this.terrain)) : 0;
    const eliminated = !points && p.misses + 1 === MAX_MISSES;
    const ended = eliminated && this.players[slot === 0 ? 1 : 0].completion !== null;
    this.reserveEvents(1 + Number(eliminated) + Number(ended));
    attempt.result = { id: sequence * 2 + slot + 1, sequence, slot, time: this.clock, points, impact };
    p.bomb = null;
    p.score += points;
    if (!points) p.misses++;
    encounter.destroyed ||= points > 0;
    this.emit({ type: 'resolved', result: attempt.result });
    if (eliminated) {
      p.completion = { slot, sequence, time: this.clock, score: p.score, misses: p.misses, assisted: p.assisted, pose: this.pose(slot) };
      for (const other of this.encounters.values()) if (!other.attempts[slot].result) other.attempts[slot].skipped = true;
      this.emit({ type: 'eliminated', completion: p.completion });
      if (ended) { this.state = 'over'; this.emit({ type: 'ended', time: this.clock, winner: this.winner! }); }
    }
  }

  retirePlan(sequence: number): void {
    const encounter = this.encounters.get(sequence);
    if (!encounter) throw new Error('Unknown retained encounter.');
    const settledAt = Math.max(encounter.handoffAt, ...encounter.attempts.map(a => a.result?.time ?? encounter.handoffAt));
    if (sequence === this.lastSequence || encounter.attempts.some(a => !a.result && !a.skipped) ||
      this.clock < settledAt + FINALE_DURATION) throw new Error('Encounter still owns motion, outcomes or effect tails.');
    this.encounters.delete(sequence);
  }

  drainEvents(): SessionEvent[] { return structuredClone(this.events.splice(0)); }
  snapshot() {
    return structuredClone({
      time: this.clock, status: this.state, terrain: this.terrain, winner: this.winner, failure: this.failure,
      players: slots.map(slot => {
        const p = this.players[slot];
        return { score: p.score, misses: p.misses, assistance: p.assistance,
          assisted: p.assisted, bomb: p.bomb, completion: p.completion, pose: this.pose(slot) };
      }),
      encounters: [...this.encounters.values()].map(e => ({
        sequence: e.sequence, id: e.id, target: e.target, targetKind: e.targetKind, destroyed: e.destroyed,
        startAt: e.startAt, handoffAt: e.handoffAt,
        attempts: e.attempts.map(a => ({ releasedAt: a.releasedAt, result: a.result, skipped: a.skipped })),
      })),
    });
  }

  private emit(event: EventPayload): void { this.events.push(structuredClone({ ...event, eventId: ++this.eventId })); }
  private reserveEvents(count: number): void {
    if (this.events.length + count > MAX_SESSION_EVENTS) this.fail('events_full', 'Drain session events before continuing.');
  }
  private fail(code: Failure['code'], message: string): never {
    this.failure = { code, message }; this.state = 'blocked';
    throw new Error(message);
  }
}
