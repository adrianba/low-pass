import { combat, counter, identifier, reference } from '../../shared/protocol/game.js';
import type { Snapshot } from '../../shared/protocol/game.js';
import { MAX_RECOVERY_REFERENCES, PROTOCOL_VERSION } from '../../shared/protocol/limits.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import { formationSampler, HostCombat, spectatorSlot } from '../game/multiplayer/host-combat.js';
import type { CombatViewProvider } from '../game/multiplayer/host-combat.js';
import type { PlayerSlot } from '../game/multiplayer/session.js';
import { CombatTimeline } from '../game/multiplayer/combat-timeline.js';
import { FINALE_DURATION } from '../game/combat-timing.js';
import { hostWorldFrame } from '../rendering/host-frame.js';
import { combatDependencies, combatTransferData } from './combat-data.js';
import { formationData } from './formation-data.js';
import { PlanPublication } from './plan-publication.js';
import type { PreparedHostCourse, OutgoingTransfer } from './prepared-course.js';
import { releaseIntent } from './release-authority.js';
import type { FormationData } from './replica-plans.js';
import { SessionJournal } from './session-journal.js';
import { createTransfer } from './transfer.js';
import type { SendResult } from './transport.js';
import type { AuthoredFlight, FormationAuthoring } from './formation-worker-client.js';

type Reference = { id: string; digest: string };
type Pending = { transfer: OutgoingTransfer; index: number; sent: boolean; acknowledged: boolean };
type Flight = Pending & { data: FormationData };
type Effect = Pending & { dependencies: Flight[] };
export const GAME_STREAM_LIMITS = Object.freeze({ work: 16, advanceSeconds: 0.1, snapshotMs: 50, stallMs: 400 });
export type HostGameWait = 'publication' | 'coverage' | 'backpressure' | 'not_open' | null;

/** Owns the host journal, verified lookahead and all gameplay publication. */
export class HostGame {
  readonly plans = new PlanPublication();
  readonly journal: SessionJournal;
  readonly combat: HostCombat;
  readonly timeline = new CombatTimeline();
  readonly scheduler: PreparedHostCourse['scheduler'];
  private readonly flights = new Map<number, Flight>();
  private readonly effects = new Map<string, Effect>();
  private commit: Extract<MessageBody, { type: 'plan-commit' }> | null;
  private checkpoint: Pending | null = null;
  private checkpointState: Snapshot | null = null;
  private checkpointCommitted = false;
  private initialized = false;
  private cachePending = false;
  private lastSnapshot = -Infinity;
  private lastWall = -Infinity;
  private busy = false;
  private closed = false;
  private localInput = 0;
  private wait: HostGameWait = null;
  private planning = false;
  private authored: AuthoredFlight | null = null;
  private planningError: Error | null = null;
  constructor(prepared: PreparedHostCourse, readonly sessionId: string, epoch: number,
    private readonly now: () => number, private readonly send: (body: MessageBody) => SendResult,
    view: CombatViewProvider, assistance: readonly [boolean, boolean],
    private readonly manifest: Extract<MessageBody, { type: 'course-manifest' }>['manifest'],
    private readonly author?: FormationAuthoring,
    private readonly sampledAt: (time: number) => number = () => this.now()) {
    identifier.parse(sessionId); counter.parse(epoch);
    this.scheduler = prepared.scheduler;
    if (this.scheduler.session.time !== 0 || this.scheduler.session.lastEventId !== 0) throw new Error('A host game requires its unused prepared course.');
    for (const slot of [0, 1] as const) this.scheduler.session.setAssistance(slot, assistance[slot]);
    for (const [sequence, transfer] of prepared.transfers.entries()) {
      const data = formationData(this.scheduler.plan(sequence), sequence);
      const ref = { id: transfer.offer.id, digest: transfer.offer.digest };
      this.flights.set(sequence, { transfer, data, index: transfer.chunks.length, sent: true, acknowledged: true });
      this.plans.stage(sequence, ref); this.plans.acknowledge(ref);
    }
    this.commit = this.plans.commit([0, 1]);
    this.journal = new SessionJournal(this.scheduler.session, sessionId, epoch, now, this.plans);
    this.combat = new HostCombat(this.scheduler, view);
    this.readNow();
    if (author) { this.scheduler.useExternalLookahead(); this.prefetch(); }
  }
  get waitReason(): HostGameWait { return this.wait; }
  get epoch(): number { return this.journal.authority.epoch; }
  get ready(): boolean { return this.initialized && !this.closed; }
  get counts() { return { flights: this.flights.size, effects: this.effects.size,
    retainedFlights: this.retainedFlights().length, pendingEvents: this.journal.pendingCount }; }
  advanceEpoch(nextEpoch: number, resume: boolean): void {
    if (this.closed || this.busy || !this.ready || !this.journal.canSnapshot || this.commit) {
      throw new Error('Publish and settle the current host epoch before replacing its checkpoint.');
    }
    if (resume) this.journal.authority.resume(nextEpoch);
    else this.journal.authority.advancePausedEpoch(nextEpoch);
    this.resetCheckpoint();
    for (const pending of [...this.flights.values(), ...this.effects.values()]) if (!pending.acknowledged) {
      pending.index = -1; pending.sent = false;
    }
  }
  recoverEpoch(nextEpoch: number, inventory: readonly Reference[]): void {
    this.checkInventory(inventory);
    this.beginRecoveryEpoch(nextEpoch);
    this.acceptRecoveryCache(inventory);
  }
  beginRecoveryEpoch(nextEpoch: number): void {
    if (this.closed || this.busy) throw new Error('Invalid host recovery boundary.');
    this.journal.authority.advancePausedEpoch(nextEpoch);
    this.resetCheckpoint(); this.cachePending = true;
    this.commit = { type: 'plan-commit', planRevision: this.plans.revision, plans: [...this.plans.references.values()] };
  }
  private checkInventory(inventory: readonly Reference[]): Map<string, string> {
    if (this.closed || this.busy || inventory.length > MAX_RECOVERY_REFERENCES) throw new Error('Invalid host recovery boundary.');
    const known = new Map(inventory.map(value => { const ref = reference.parse(value); return [ref.id, ref.digest]; }));
    if (known.size !== inventory.length) throw new Error('Duplicate recovery cache reference.');
    const retained = [...this.retainedFlights(), ...this.effects.values()];
    for (const value of retained) {
      const offer = value.transfer.offer, digest = known.get(offer.id);
      if (digest !== undefined && digest !== offer.digest) throw new Error('Recovery cache identity conflict.');
    }
    return known;
  }
  acceptRecoveryCache(inventory: readonly Reference[]): void {
    if (!this.cachePending) throw new Error('No pending recovery cache negotiation.');
    const known = this.checkInventory(inventory), retained = [...this.retainedFlights(), ...this.effects.values()];
    const needed = new Set([...this.effects.values()].filter(value => !known.has(value.transfer.offer.id))
      .flatMap(value => value.dependencies.map(flight => flight.transfer.offer.id)));
    for (const value of retained) {
      const offer = value.transfer.offer;
      const liveFlight = [...this.flights.values()].some(flight => flight.transfer.offer.id === offer.id);
      const acknowledged = known.get(offer.id) === offer.digest ||
        offer.kind === 'formation' && !liveFlight && !needed.has(offer.id);
      value.acknowledged = value.sent = acknowledged;
      value.index = acknowledged ? value.transfer.chunks.length : -1;
      if (acknowledged && offer.kind === 'combat') this.journal.acknowledgeEffect({ id: offer.id, digest: offer.digest });
      if (acknowledged && liveFlight) this.plans.acknowledge({ id: offer.id, digest: offer.digest });
    }
    this.cachePending = false;
  }
  private resetCheckpoint() {
    this.checkpoint = null; this.checkpointState = null; this.checkpointCommitted = false;
    this.initialized = false; this.lastSnapshot = -Infinity; this.wait = null;
  }
  private retainedFlights(): Flight[] {
    const values = new Map([...this.flights.values()].map(value => [value.transfer.offer.id, value]));
    for (const effect of this.effects.values()) for (const flight of effect.dependencies) values.set(flight.transfer.offer.id, flight);
    if (values.size > 10) throw new Error('Frozen effect flight retention budget exhausted.');
    return [...values.values()];
  }
  private readNow() {
    const time = this.now();
    if (!Number.isFinite(time) || time < this.lastWall) throw new Error('Invalid host game clock.');
    this.lastWall = time; return time;
  }
  receive(message: Extract<WireMessage, { type: 'command' | 'transfer-ready' }>, receivedAt?: number): void {
    if (this.closed || message.sessionId !== this.sessionId || message.epoch !== this.epoch || message.sender !== 'guest') {
      throw new Error('Unexpected host game message identity.');
    }
    if (message.type === 'command') {
      if (message.command.action !== 'release') throw new Error('Lifecycle commands belong to the match controller.');
      this.journal.receiveRelease('guest', message, receivedAt); return;
    }
    const ref = message.transfer;
    const flight = this.retainedFlights().find(value => value.transfer.offer.id === ref.id);
    const checkpoint = this.checkpoint?.transfer.offer.id === ref.id ? this.checkpoint : null;
    const pending = checkpoint ?? flight ?? this.effects.get(ref.id);
    if (!pending?.sent || pending.transfer.offer.digest !== ref.digest) throw new Error('Unexpected or premature game transfer acknowledgement.');
    if (pending.acknowledged) return;
    pending.acknowledged = true;
    if (flight) {
      if (this.flights.has(flight.data.sequence)) this.plans.acknowledge(ref);
    }
    else if (!checkpoint) this.journal.acknowledgeEffect(ref);
  }
  release(displayedAt: number, sequence = this.scheduler.sequence, receivedAt?: number) {
    if (!this.ready || this.busy) throw new Error('Host game is not ready for local input.');
    const ref = this.plans.references.get(sequence);
    if (!ref) throw new Error('Local release requires its published flight.');
    return this.journal.receiveRelease('host', { version: PROTOCOL_VERSION, sessionId: this.sessionId,
      epoch: this.epoch, sender: 'host', sequence: 0, type: 'command', slot: 0, inputSequence: ++this.localInput,
      command: releaseIntent(sequence, ref, displayedAt) }, receivedAt);
  }
  /** Returns a hold reason; the lifecycle owner must not discard elapsed time or catch up unseen flight. */
  async pump(target = this.scheduler.session.time): Promise<HostGameWait> {
    if (this.closed || this.busy) throw new Error('Host game pump requires exclusive live ownership.');
    if (this.cachePending) return this.wait = 'publication';
    const session = this.scheduler.session;
    if (!Number.isFinite(target) || target < session.time || target - session.time > GAME_STREAM_LIMITS.advanceSeconds + 1e-8) {
      throw new Error('Host game advance exceeds its per-frame work budget.');
    }
    this.busy = true;
    try {
      this.wait = null;
      this.installAuthored();
      await this.collect();
      this.prefetch();
      if (this.closed) return 'not_open';
      if (!this.checkpoint && !this.journal.canSnapshot) return this.wait = this.publish(false) ?? 'publication';
      if (!this.checkpoint) {
        const state = this.journal.snapshot(this.readNow()).state;
        const transfer = await createTransfer({ kind: 'checkpoint', data: { version: 1, sessionId: this.sessionId, epoch: this.epoch,
          snapshotSequence: 0, manifest: this.manifest, state } }, `state-${this.epoch}`);
        if (this.closed) return 'not_open';
        this.checkpoint = { transfer, index: -1, sent: false, acknowledged: false };
        this.checkpointState = state;
      }
      let result = this.publish(false);
      if (result || !this.initialized) return this.wait = result ?? 'publication';
      if (target > session.time && session.status === 'running') {
        const references = this.plans.references;
        const coverage = Math.max(...[...references.keys()].map(sequence => this.flights.get(sequence)!.data.handoffAt));
        // Crossing a handoff starts the next flight and authors one new lookahead.
        if (target >= coverage) return this.wait = 'coverage';
        if (!this.journal.canSnapshot && this.readNow() - this.lastSnapshot >= GAME_STREAM_LIMITS.stallMs) {
          return this.wait = 'publication';
        }
        this.scheduler.advanceTo(target, () => this.journal.canSnapshot);
        await this.stageFlights();
        await this.collect();
        if (this.closed) return 'not_open';
      }
      result = this.publish();
      return this.wait = result;
    } finally { this.busy = false; }
  }
  private async collect(): Promise<void> {
    const events = this.journal.collect();
    this.combat.consume(events);
    const sources = [...this.flights.values()].map(flight => ({
      reference: { id: flight.transfer.offer.id, digest: flight.transfer.offer.digest }, data: flight.data,
    }));
    for (const event of events) if (event.type === 'resolved') {
      const data = this.combat.at(this.scheduler.session.time).find(data => data.id === event.result.id);
      if (!data) { this.journal.prepareOutcome(event.eventId, null); continue; }
      const compact = combatTransferData(data, sources);
      const ready = combatDependencies(compact).every(ref =>
        [...this.flights.values()].some(flight => flight.acknowledged && flight.transfer.offer.id === ref.id));
      const transfer = await createTransfer({ kind: 'combat', data: ready ? compact : combat.parse(data) }, `combat-${data.id}`);
      if (this.closed) return;
      if (this.effects.size >= 8) throw new Error('Host combat transfer budget exhausted.');
      const dependencies = ready ? combatDependencies(compact).map(ref => {
        const flight = [...this.flights.values()].find(value =>
          value.transfer.offer.id === ref.id && value.transfer.offer.digest === ref.digest);
        if (!flight) throw new Error('Missing original combat transfer dependency.');
        return flight;
      }) : [];
      this.effects.set(transfer.offer.id, { transfer, dependencies, index: -1, sent: false, acknowledged: false });
      this.retainedFlights();
      this.journal.prepareOutcome(event.eventId, { reference: { id: transfer.offer.id, digest: transfer.offer.digest }, data });
    }
  }
  private async stageFlights(): Promise<void> {
    for (const sequence of this.scheduler.retainedSequences) if (!this.flights.has(sequence)) {
      const data = formationData(this.scheduler.plan(sequence), sequence);
      const transfer = await createTransfer({ kind: 'formation', data }, `flight-${sequence}`);
      if (this.closed) return;
      if (this.flights.size >= 6) throw new Error('Host flight transfer budget exhausted.');
      this.flights.set(sequence, { transfer, data, index: -1, sent: false, acknowledged: false });
      this.plans.stage(sequence, { id: transfer.offer.id, digest: transfer.offer.digest });
    }
  }
  private prefetch(): void {
    if (!this.author || this.planning || this.authored || this.closed) return;
    const request = this.scheduler.nextRequest();
    if (!request) return;
    this.planning = true;
    void this.author.author(request).then(result => {
      this.planning = false;
      if (!this.closed) this.authored = result;
    }, error => {
      this.planning = false;
      if (!this.closed) this.planningError = error instanceof Error ? error : new Error('Course authoring failed.');
    });
  }
  private installAuthored(): void {
    if (this.planningError) throw this.planningError;
    const next = this.authored;
    if (!next) return;
    const sequence = next.data.sequence;
    this.scheduler.installLookahead(sequence, next.plan);
    this.flights.set(sequence, { data: next.data, transfer: next.transfer, index: -1, sent: false, acknowledged: false });
    this.plans.stage(sequence, { id: next.transfer.offer.id, digest: next.transfer.offer.digest });
    this.authored = null;
  }
  private sendCommit(): HostGameWait {
    if (!this.commit) return null;
    const result = this.send(this.commit);
    if (!result.ok) return result.reason;
    this.commit = null; this.journal.authorizePlans();
    return null;
  }
  private publish(snapshotDue = true): HostGameWait {
    let held = this.sendCommit();
    if (held) return held;
    const publication = this.journal.flush(this.send, GAME_STREAM_LIMITS.work);
    if (publication.blocked === 'not_open') return publication.blocked;
    // Small outcome payloads precede large rolling flights on the paced reliable channel.
    for (let work = 0; work < GAME_STREAM_LIMITS.work; work++) {
      const pending = [...(this.checkpoint ? [this.checkpoint] : []), ...this.effects.values(), ...this.retainedFlights()].find(value => !value.sent);
      if (!pending) break;
      const body: MessageBody = pending.index < 0 ? { type: 'transfer-offer', transfer: pending.transfer.offer }
        : { type: 'transfer-chunk', ...pending.transfer.chunks[pending.index]! };
      const result = this.send(body);
      if (!result.ok) { held = result.reason; break; }
      if (++pending.index === pending.transfer.chunks.length) pending.sent = true;
    }
    if (!this.checkpoint) return held ?? 'publication';
    if (!this.checkpointCommitted) {
      if (!this.checkpoint!.acknowledged) return held ?? 'publication';
      const offer = this.checkpoint!.transfer.offer;
      const state = this.checkpointState!;
      const pending = [...this.flights.values(), ...this.effects.values()];
      if (this.retainedFlights().some(flight => !this.flights.has(flight.data.sequence) && !flight.acknowledged)) return held ?? 'publication';
      if ([...state.plans, ...state.effects].some(ref => !pending.some(value =>
        value.acknowledged && value.transfer.offer.id === ref.id && value.transfer.offer.digest === ref.digest))) return held ?? 'publication';
      const result = this.send({ type: 'checkpoint-commit', checkpoint: { id: offer.id, digest: offer.digest },
        planRevision: state.planRevision, eventSequence: state.eventSequence, snapshotSequence: 0 });
      if (!result.ok) return result.reason;
      this.checkpointCommitted = true;
    }
    if (this.journal.canSnapshot) {
      const retained = this.scheduler.retainedSequences.filter(sequence => this.plans.ready(sequence));
      if (JSON.stringify(retained) !== JSON.stringify([...this.plans.references.keys()])) {
        this.commit = this.plans.commit(retained);
        const blocked = this.sendCommit();
        if (blocked) return blocked;
      }
      const now = this.readNow();
      if (!this.initialized || snapshotDue && now - this.lastSnapshot >= GAME_STREAM_LIMITS.snapshotMs) {
        const result = this.send(this.journal.snapshot(this.sampledAt(this.scheduler.session.time)));
        if (!result.ok) return result.reason;
        this.initialized = true; this.lastSnapshot = now;
      }
      const active = new Set(this.journal.snapshot(now).state.effects.map(ref => ref.id));
      for (const [id, effect] of this.effects) if (effect.acknowledged && !active.has(id)) this.effects.delete(id);
      for (const sequence of this.flights.keys()) if (!this.scheduler.retainedSequences.includes(sequence)) this.flights.delete(sequence);
    }
    return null;
  }
  reference(sequence: number): Reference {
    const ref = this.plans.references.get(sequence);
    if (!ref) throw new Error('Flight is not published.');
    return ref;
  }
  player(slot: PlayerSlot) { return this.scheduler.session.snapshot().players[slot]!; }
  frame(time = this.scheduler.session.time) {
    const session = this.scheduler.session, state = session.snapshot(), plan = this.scheduler.plan();
    if (time !== session.time && (session.status !== 'over' || time < session.time || time > session.time + FINALE_DURATION)) {
      throw new Error('Invalid host presentation time.');
    }
    this.timeline.update(this.combat.at(time), time, [
      { misses: state.players[0]!.misses, eliminated: state.players[0]!.completion !== null },
      { misses: state.players[1]!.misses, eliminated: state.players[1]!.completion !== null },
    ], formationSampler(this.scheduler));
    return hostWorldFrame(this.scheduler, spectatorSlot(0, this.timeline), {
      time, poses: [this.timeline.poseAt(0), this.timeline.poseAt(1)],
      destroyed: [!this.timeline.aliveAt(0), !this.timeline.aliveAt(1)],
      views: [this.timeline.finaleView(0) ?? plan.attempts[0].camera.at(time - plan.attempts[0].releaseAt),
        this.timeline.finaleView(1) ?? plan.attempts[1].camera.at(time - plan.attempts[1].releaseAt)],
    });
  }
  close(): void {
    this.closed = true; this.scheduler.session.pause(); this.flights.clear(); this.effects.clear(); this.timeline.reset();
    this.author?.close(); this.authored = null;
  }
}
