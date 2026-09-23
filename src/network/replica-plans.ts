import { combat, formation, payload, reference } from '../../shared/protocol/game.js';
import type { CombatData, Payload } from '../../shared/protocol/game.js';
import { MAX_PLANS, MAX_EFFECTS, MAX_TRANSFER_BYTES } from '../../shared/protocol/limits.js';
import { byteLength } from '../../shared/protocol/codec.js';
import { FormationTrack } from '../game/formation/track.js';
import type { PlayerSlot } from '../game/multiplayer/session.js';
import { FlightTrack } from '../simulation/flight-track.js';
import { sampleChase } from '../simulation/chase-timeline.js';
import type { CompletedTransfer } from './transfer.js';
import { combatDependencies, expandCombat } from './combat-data.js';
import { readCombatPlanData } from '../game/multiplayer/combat-plan.js';
import type { CombatPlanData } from '../game/multiplayer/combat-plan.js';

type Reference = CompletedTransfer['reference'];
export type FormationData = Extract<Payload, { kind: 'formation' }>['data'];

export class FormationPlayback {
  private readonly data: FormationData;
  private readonly tracks: readonly [FlightTrack | FormationTrack, FlightTrack | FormationTrack];
  constructor(value: FormationData) {
    this.data = formation.parse(value);
    const track = (slot: PlayerSlot) => this.data.terrain === 'river-canyon'
      ? FlightTrack.fromData(this.data.attempts[slot].track) : FormationTrack.fromData(this.data.attempts[slot].track);
    this.tracks = [track(0), track(1)];
  }
  get sequence(): number { return this.data.sequence; }
  get terrain() { return this.data.terrain; }
  get startAt(): number { return this.data.startAt; }
  get handoffAt(): number { return this.data.handoffAt; }
  get coverageEndAt(): number { return this.data.coverageEndAt; }
  get target() { return { ...this.data.target }; }
  get targetKind() { return this.data.targetKind; }
  get sightDistance(): number { return Math.max(...this.data.attempts.map(attempt => attempt.acquisition.range)); }
  releaseWindow(slot: PlayerSlot) {
    const attempt = this.data.attempts[slot];
    return { acquireAt: attempt.acquireAt, cutoffAt: attempt.cutoffAt };
  }
  toData(): FormationData { return structuredClone(this.data); }
  pose(slot: PlayerSlot, time: number) {
    this.assertTime(slot, time);
    return this.tracks[slot].at(time - this.data.attempts[slot].releaseAt);
  }
  view(slot: PlayerSlot, time: number) {
    this.assertTime(slot, time);
    const attempt = this.data.attempts[slot];
    return sampleChase(attempt.camera, time - attempt.releaseAt);
  }
  private assertTime(slot: PlayerSlot, time: number) {
    if ((slot !== 0 && slot !== 1) || !Number.isFinite(time) || time < this.startAt || time > this.coverageEndAt) {
      throw new Error('Replica flight exceeds committed coverage.');
    }
  }
}

interface Stored {
  reference: Reference; payload: Payload; bytes: number; playback: FormationPlayback | null;
  combat: CombatData | null; combatPlan: CombatPlanData | null;
}
/** Only hash-verified CompletedTransfers enter here; no candidate selection runs. */
export class ReplicaPlans {
  private readonly values = new Map<string, Stored>();
  private committed: Reference[] = [];
  private effects: Reference[] = [];
  private pinned = new Set<string>();
  private retired = new Set<string>();
  get count(): number { return this.values.size; }
  inventory(): Reference[] {
    return [...this.values.values()].filter(value => this.has(value.reference)).map(value => ({ ...value.reference }));
  }
  has(value: Reference): boolean {
    const stored = this.values.get(value.id);
    return stored?.reference.digest === value.digest && (stored.playback !== null || stored.combat !== null);
  }
  installVerified(value: CompletedTransfer): void {
    const ref = reference.parse(value.reference), previous = this.values.get(ref.id);
    if (previous) {
      if (previous.reference.digest !== ref.digest) throw new Error('Replica payload identity conflict.');
      return;
    }
    const owned = payload.parse(value.payload);
    if (owned.kind === 'checkpoint') throw new Error('Checkpoints belong to the state receiver, not the plan cache.');
    const bytes = byteLength(JSON.stringify(owned));
    const sameKind = [...this.values.values()].filter(value => value.payload.kind === owned.kind).length;
    if (sameKind >= (owned.kind === 'formation' ? MAX_PLANS : MAX_EFFECTS) + 2 ||
      bytes + [...this.values.values()].reduce((sum, value) => sum + value.bytes, 0) > 2 * MAX_TRANSFER_BYTES) {
      throw new Error('Replica verified-plan budget exhausted.');
    }
    const playback = owned.kind === 'formation' ? new FormationPlayback(owned.data) : null;
    const resolved = owned.kind === 'combat' && owned.data.missile.motion.kind !== 'track-reference' ? combat.parse(owned.data) : null;
    if (owned.kind === 'combat' && resolved) owned.data = resolved;
    this.values.set(ref.id, { reference: ref, payload: owned, playback, bytes, combat: resolved, combatPlan: null });
    this.resolveCombat();
  }
  private resolveCombat(): void {
    for (const stored of this.values.values()) {
      if (stored.payload.kind !== 'combat' || stored.combat ||
        combatDependencies(stored.payload.data).some(ref => !this.has(ref))) continue;
      const resolved = expandCombat(stored.payload.data, ref => this.formation(ref).toData());
      const bytes = byteLength(JSON.stringify(resolved));
      if (bytes + [...this.values.values()].reduce((sum, value) => sum + value.bytes, 0) > 2 * MAX_TRANSFER_BYTES) {
        throw new Error('Replica expanded combat budget exhausted.');
      }
      stored.combat = resolved; stored.bytes += bytes;
    }
  }
  formation(value: Reference): FormationPlayback {
    const stored = this.values.get(value.id);
    if (!stored || stored.reference.digest !== value.digest || !stored.playback) throw new Error('Missing verified formation.');
    return stored.playback;
  }
  combat(value: Reference): CombatData {
    const stored = this.values.get(value.id);
    if (!stored || stored.reference.digest !== value.digest || !stored.combat) throw new Error('Missing verified combat plan.');
    return structuredClone(stored.combat);
  }
  combatPlan(value: Reference): CombatPlanData {
    const stored = this.values.get(value.id);
    if (!stored || stored.reference.digest !== value.digest || !stored.combat) throw new Error('Missing verified combat plan.');
    return stored.combatPlan ??= readCombatPlanData(stored.combat);
  }
  commit(values: readonly Reference[]): void {
    if (!values.length || values.length > MAX_PLANS || new Set(values.map(value => value.id)).size !== values.length) {
      throw new Error('Invalid committed replica plans.');
    }
    const plans = values.map(value => this.formation(value)).sort((a, b) => a.sequence - b.sequence);
    for (let index = 1; index < plans.length; index++) {
      const previous = plans[index - 1]!, current = plans[index]!;
      if (current.sequence !== previous.sequence + 1 || current.startAt !== previous.handoffAt || current.terrain !== previous.terrain) {
        throw new Error('Discontinuous committed replica course.');
      }
    }
    for (const old of this.committed) if (!values.some(value => value.id === old.id)) this.retired.add(old.id);
    this.committed = structuredClone([...values].sort((a, b) => this.formation(a).sequence - this.formation(b).sequence));
    for (const value of values) this.retired.delete(value.id);
    this.prune();
  }
  retainEffects(values: readonly Reference[]): void {
    if (values.length > MAX_EFFECTS) throw new Error('Replica active effect budget exhausted.');
    for (const value of values) this.combat(value);
    for (const old of this.effects) if (!values.some(value => value.id === old.id)) this.retired.add(old.id);
    this.effects = structuredClone([...values]);
    for (const value of values) this.retired.delete(value.id);
    this.prune();
  }
  pin(values: readonly Reference[]): void {
    if (values.some(value => !this.has(value))) throw new Error('Cannot pin missing replica presentation data.');
    this.pinned = new Set(values.map(value => value.id)); this.prune();
  }
  private prune(): void {
    for (const id of this.retired) if (!this.pinned.has(id)) { this.values.delete(id); this.retired.delete(id); }
  }
  at(time: number): FormationPlayback {
    const plan = this.committed.map(value => this.formation(value)).reverse().find(plan => time >= plan.startAt && time <= plan.handoffAt);
    if (!plan) throw new Error('Missing committed replica flight coverage.');
    return plan;
  }
  references(): Reference[] { return structuredClone(this.committed); }
}
