import { decodeMessage, encodeMessage, ProtocolError } from '../../shared/protocol/codec.js';
import { compareStamps, manifest, payload, reference, secondsAt, snapshot, stampAt } from '../../shared/protocol/game.js';
import type { Snapshot } from '../../shared/protocol/game.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import { messageChannel } from '../../shared/protocol/messages.js';
import { launchFrom } from '../simulation/pose.js';
import { DeliveryBarrier } from './delivery-barrier.js';
import type { DeliveryDecision } from './delivery-barrier.js';
import { ReplicaPlans } from './replica-plans.js';
import type { CompletedTransfer } from './transfer.js';
import type { ClockAnchor } from './session-clock.js';

type Incoming = Extract<WireMessage, { type: 'plan-commit' | 'event' | 'snapshot' | 'checkpoint-commit' }>;
type Control = Exclude<Incoming, { type: 'snapshot' }>;
type Manifest = Extract<CompletedTransfer['payload'], { kind: 'checkpoint' }>['data']['manifest'];
export type ReplicaWait = Exclude<DeliveryDecision, { ok: true }>['reason'] | 'initial_state' | null;
export class ReplicaError extends Error {
  constructor(readonly code: 'capacity' | 'conflict' | 'regression' | 'event' | 'plan') { super(`Replica rejected: ${code}.`); }
}
const referencesEqual = (a: Snapshot['plans'], b: Snapshot['plans']) =>
  a.length === b.length && a.every(value => b.some(other => value.id === other.id && value.digest === other.digest));

/** Authoritative logical state only. Speculative effects never mutate these totals. */
export class GuestReplica {
  private gate: DeliveryBarrier;
  private readonly manifest: Manifest;
  private readonly controls: Control[] = [];
  private pendingSnapshot: Extract<Incoming, { type: 'snapshot' }> | null = null;
  private checkpoint: CompletedTransfer | undefined;
  private stateValue: Snapshot | null = null;
  private presentationValue: Snapshot | null = null;
  private readonly history: Snapshot[] = [];
  private anchor: ClockAnchor | null = null;
  private waiting: ReplicaWait = 'initial_state';
  constructor(private readonly sessionId: string, private readonly epoch: number, course: Manifest, readonly plans = new ReplicaPlans()) {
    this.gate = new DeliveryBarrier(sessionId, epoch);
    this.manifest = manifest.parse(course);
  }
  get state(): Snapshot | null { return this.stateValue ? structuredClone(this.stateValue) : null; }
  get presentationState(): Snapshot | null { return this.presentationValue ? structuredClone(this.presentationValue) : null; }
  presentationAt(time: number): Snapshot {
    const at = stampAt(time);
    const state = [...this.history].reverse().find(state => compareStamps(state.at, at) <= 0);
    if (!state) throw new ReplicaError('plan');
    return structuredClone(state);
  }
  get clockAnchor(): ClockAnchor | null { return this.anchor ? structuredClone(this.anchor) : null; }
  get waitReason(): ReplicaWait { return this.waiting; }
  get pendingCount(): number { return this.controls.length + Number(this.pendingSnapshot !== null); }
  get watermarks() { return this.gate.watermarks; }
  installVerified(value: CompletedTransfer): Extract<MessageBody, { type: 'transfer-ready' }> {
    if (value.payload.kind === 'checkpoint') {
      const owned = payload.parse(value.payload);
      if (owned.kind !== 'checkpoint' || owned.data.sessionId !== this.sessionId || owned.data.epoch !== this.epoch) {
        throw new ProtocolError('epoch');
      }
      if (JSON.stringify(owned.data.manifest) !== JSON.stringify(this.manifest)) throw new ProtocolError('compatibility');
      this.checkpoint = { reference: reference.parse(value.reference), payload: owned };
    } else {
      if (value.payload.kind === 'formation' && value.payload.data.terrain !== this.manifest.terrain) throw new ReplicaError('plan');
      this.plans.installVerified(value);
    }
    this.flush();
    return { type: 'transfer-ready', transfer: reference.parse(value.reference) };
  }
  receive(value: Incoming): void {
    const message = decodeMessage(encodeMessage(value), { sessionId: this.sessionId, epoch: this.epoch,
      peer: 'host', channel: messageChannel(value) });
    if (message.type === 'snapshot') {
      if (!this.pendingSnapshot || message.sequence > this.pendingSnapshot.sequence) this.pendingSnapshot = message;
    } else if (message.type === 'event' || message.type === 'plan-commit' || message.type === 'checkpoint-commit') {
      const previous = this.controls.find(control => control.sequence === message.sequence);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(message)) throw new ReplicaError('conflict');
        return;
      }
      if (this.controls.length >= 64) throw new ReplicaError('capacity');
      this.controls.push(message);
      this.controls.sort((a, b) => a.sequence - b.sequence);
    } else throw new ProtocolError('invalid_message');
    this.flush();
  }
  private flush(): void {
    this.waiting = this.stateValue ? null : 'initial_state';
    const checkpointIndex = this.controls.findIndex(message => message.type === 'checkpoint-commit' &&
      message.checkpoint.id === this.checkpoint?.reference.id);
    if (checkpointIndex >= 0) {
      const message = this.controls[checkpointIndex]!, nextGate = this.gate.copy();
      const decision = nextGate.consider(message, value => this.plans.has(value), this.checkpoint);
      if (decision.ok) {
        if (this.checkpoint?.payload.kind !== 'checkpoint') throw new ReplicaError('conflict');
        this.applySnapshot(this.checkpoint.payload.data.state, null);
        this.gate = nextGate; this.controls.splice(checkpointIndex, 1); this.checkpoint = undefined;
      }
    }
    while (this.controls.length) {
      const message = this.controls[0]!;
      // Result events need a complete starting state; plan commits and checkpoints do not.
      if (message.type === 'event' && !this.stateValue) { this.waiting = 'initial_state'; break; }
      const nextGate = this.gate.copy();
      const decision = nextGate.consider(message, value => this.plans.has(value), this.checkpoint);
      if (!decision.ok) {
        if (decision.reason === 'stale') { this.controls.shift(); continue; }
        this.waiting = decision.reason; break;
      }
      if (message.type === 'plan-commit') {
        const state = this.stateValue ? structuredClone(this.stateValue) : null;
        if (state) {
          const sequences = message.plans.map(ref => this.plans.formation(ref).sequence);
          if (state.players.some(player => player.bomb && !sequences.includes(player.bomb.sequence))) throw new ReplicaError('plan');
          state.plans = structuredClone(message.plans); state.planRevision = message.planRevision;
          state.results = state.results.filter(result => sequences.includes(result.sequence));
          state.wrecks = state.wrecks.filter(id => message.plans.some(ref => ref.id === id));
        }
        this.plans.commit(message.plans);
        this.stateValue = state;
      } else if (message.type === 'checkpoint-commit') {
        if (this.checkpoint?.payload.kind !== 'checkpoint') throw new ReplicaError('conflict');
        this.applySnapshot(this.checkpoint.payload.data.state, null);
        this.checkpoint = undefined;
      } else this.applyEvent(message);
      this.gate = nextGate;
      this.controls.shift();
    }
    if (this.pendingSnapshot) {
      const message = this.pendingSnapshot;
      const nextGate = this.gate.copy();
      const decision = nextGate.consider(message, value => this.plans.has(value));
      if (decision.ok) {
        this.applySnapshot(message.state, { epoch: this.epoch, at: message.state.at, monotonicMs: message.sampledAt,
          running: message.state.status === 'running' });
        this.gate = nextGate;
        this.pendingSnapshot = null;
        // An initial snapshot can unblock previously received reliable events.
        if (this.controls.length && this.waiting === 'initial_state') { this.flush(); return; }
      } else if (decision.reason === 'stale') this.pendingSnapshot = null;
      else this.waiting = decision.reason;
    }
    if (!this.controls.length && !this.pendingSnapshot) this.waiting = this.stateValue ? null : 'initial_state';
  }
  private applySnapshot(value: Snapshot, anchor: ClockAnchor | null): void {
    const next = snapshot.parse(value), old = this.stateValue;
    if (old) {
      if (compareStamps(next.at, old.at) < 0 || old.status === 'over' && next.status !== 'over') throw new ReplicaError('regression');
      for (const slot of [0, 1] as const) {
        const before = old.players[slot], after = next.players[slot];
        if (after.score < before.score || after.misses < before.misses || before.eliminated && !after.eliminated ||
          before.assisted && !after.assisted || (after.lastResolved ?? -1) < (before.lastResolved ?? -1) ||
          next.lastInputs[slot] < old.lastInputs[slot]) throw new ReplicaError('regression');
      }
      for (const result of old.results) {
        if (next.plans.some(ref => this.plans.formation(ref).sequence === result.sequence) &&
          !next.results.some(current => JSON.stringify(current) === JSON.stringify(result))) throw new ReplicaError('regression');
      }
      for (const id of old.wrecks) if (next.plans.some(ref => ref.id === id) && !next.wrecks.includes(id)) throw new ReplicaError('regression');
    }
    if (anchor && !referencesEqual(next.plans, this.plans.references())) throw new ReplicaError('plan');
    const sequences = next.plans.map(ref => this.plans.formation(ref).sequence);
    if (next.results.some(result => !sequences.includes(result.sequence)) ||
      next.players.some(player => player.bomb && !sequences.includes(player.bomb.sequence))) throw new ReplicaError('plan');
    for (const effect of next.effects) this.plans.combat(effect);
    if (!anchor) this.plans.commit(next.plans);
    this.plans.retainEffects(next.effects);
    this.stateValue = next; this.presentationValue = structuredClone(next);
    if (this.history.length && compareStamps(this.history.at(-1)!.at, next.at) === 0) this.history.pop();
    this.history.push(this.presentationValue);
    if (this.history.length > 32) this.history.shift();
    this.plans.pin(this.history.flatMap(state => [...state.plans, ...state.effects]));
    this.anchor = anchor ? structuredClone(anchor) : null;
  }
  private applyEvent(message: Extract<Incoming, { type: 'event' }>): void {
    const state = structuredClone(this.stateValue!);
    const event = message.event;
    const advance = (time: Snapshot['at']) => { if (compareStamps(time, state.at) > 0) state.at = structuredClone(time); };
    if (event.action === 'released') {
      const player = state.players[event.slot], plan = this.plans.formation(event.plan);
      if (plan.sequence !== event.sequence || player.eliminated || player.bomb ||
        event.sequence <= (player.lastResolved ?? -1)) throw new ReplicaError('event');
      const time = secondsAt(event.at), window = plan.releaseWindow(event.slot);
      if (compareStamps(event.at, stampAt(window.acquireAt)) < 0 || compareStamps(event.at, stampAt(window.cutoffAt)) > 0) {
        throw new ReplicaError('event');
      }
      const value = launchFrom(plan.pose(event.slot, time));
      player.bomb = { sequence: event.sequence, releasedAt: structuredClone(event.at), steps: 0,
        position: value.position, velocity: value.velocity };
      state.lastInputs[event.slot] = Math.max(state.lastInputs[event.slot], event.inputSequence);
      advance(event.at);
    } else if (event.action === 'resolved') {
      const result = event.result, player = state.players[result.slot];
      if (player.eliminated || result.sequence <= (player.lastResolved ?? -1) ||
        result.score !== player.score + result.points || result.misses !== player.misses + Number(result.points === 0) ||
        player.assisted && !result.assisted ||
        (result.impact ? player.bomb?.sequence !== result.sequence : player.bomb !== null)) throw new ReplicaError('event');
      const ref = state.plans.find(ref => this.plans.formation(ref).sequence === result.sequence);
      if (!ref) throw new ReplicaError('plan');
      player.score = result.score; player.misses = result.misses; player.assisted = result.assisted;
      player.lastResolved = result.sequence; player.eliminated = result.misses === 3; player.bomb = null;
      state.results.push(structuredClone(result)); advance(stampAt(result.time));
      if (result.points && !state.wrecks.includes(ref.id)) state.wrecks.push(ref.id);
      if (state.players.every(player => player.eliminated)) {
        state.status = 'over';
        state.winner = state.players[0].score === state.players[1].score ? 'draw' : state.players[0].score > state.players[1].score ? 0 : 1;
      }
    } else if (event.action === 'assistance') {
      const player = state.players[event.slot];
      if (player.eliminated || player.assisted && !event.assisted) throw new ReplicaError('event');
      player.assistance = event.enabled; player.assisted = event.assisted;
    } else if (event.action === 'combat') {
      const combat = this.plans.combat(event.effect);
      if (combat.slot !== event.slot || compareStamps(stampAt(combat.bornAt), event.at) !== 0) throw new ReplicaError('event');
      if (!state.effects.some(ref => ref.id === event.effect.id)) state.effects.push({ ...event.effect, bornAt: combat.bornAt });
      this.plans.retainEffects(state.effects);
    } else if (event.action === 'eliminated') {
      const combat = this.plans.combat(event.combat);
      if (!state.players[event.slot].eliminated || combat.slot !== event.slot || combat.sequence !== event.sequence ||
        combat.missile.kind !== 'finale' || compareStamps(stampAt(combat.bornAt), event.at) !== 0) throw new ReplicaError('event');
    } else {
      if (!state.players.every(player => player.eliminated) || state.winner !== event.winner) throw new ReplicaError('event');
      state.status = 'over'; advance(event.at);
    }
    state.eventSequence = message.eventSequence;
    this.stateValue = state;
  }
}
