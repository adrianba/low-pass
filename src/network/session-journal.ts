import { decodeMessage, encodeMessage } from '../../shared/protocol/codec.js';
import { combat, counter, reference, stampAt } from '../../shared/protocol/game.js';
import type { CombatData } from '../../shared/protocol/game.js';
import type { Role } from '../../shared/protocol/limits.js';
import { MAX_EFFECTS, MAX_PLANS } from '../../shared/protocol/limits.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import { FLYBY_DURATION } from '../game/combat-timing.js';
import { MAX_SESSION_EVENTS } from '../game/multiplayer/session.js';
import type { HostSession, PlayerSlot, SessionEvent } from '../game/multiplayer/session.js';
import { PlanPublication } from './plan-publication.js';
import { RELEASE_DECISIONS, ReleaseAuthority, releaseAcknowledgement } from './release-authority.js';
import type { ReleaseDecision } from './release-authority.js';
import { sessionSnapshot } from './session-snapshot.js';
import type { SendResult } from './transport.js';

type Reference = { id: string; digest: string };
type Command = Extract<WireMessage, { type: 'command' }>;
type Acknowledgement = Extract<MessageBody, { type: 'ack' }>;
type EventBody = Extract<MessageBody, { type: 'event' }>;
interface Accepted {
  coreId: number; slot: PlayerSlot; inputSequence: number; epoch: number; intent: string; plan: Reference | null;
}
interface Published extends Accepted { eventSequence: number }
interface Pending { source: SessionEvent; index: number }
interface Outcome {
  sequence: number; slot: PlayerSlot;
  effect: { reference: Reference; bornAt: number; kind: CombatData['missile']['kind']; ready: boolean } | null;
}

/** One host-owned journal survives transport replacement; sending commits its watermarks. */
export class SessionJournal {
  readonly authority: ReleaseAuthority;
  private readonly pending: Pending[] = [];
  private readonly acknowledgements: Acknowledgement[] = [];
  private readonly accepted = new Map<number, Accepted>();
  private readonly published: [Map<number, Published>, Map<number, Published>] = [new Map(), new Map()];
  private readonly outcomes = new Map<number, Outcome>();
  private collected = 0;
  private publishedCore = 0;
  private publishedEvent = 0;
  constructor(readonly session: HostSession, private readonly sessionId: string, epoch: number,
    now: () => number, readonly plans: PlanPublication) {
    if (session.lastEventId !== 0) throw new Error('Create the publication journal before gameplay events.');
    this.authority = new ReleaseAuthority(session, sessionId, epoch, now);
    this.authorizePlans();
  }
  get eventSequence(): number { return this.publishedEvent; }
  get coreEventId(): number { return this.publishedCore; }
  get pendingCount(): number { return this.pending.length + this.acknowledgements.length; }
  get canSnapshot(): boolean {
    return this.pendingCount === 0 && this.publishedCore === this.session.lastEventId;
  }
  authorizePlans(): void {
    for (const [sequence, ref] of this.plans.references) this.authority.registerPlan(sequence, ref);
  }
  receiveRelease(role: Role, value: Command, receivedAt?: number): ReleaseDecision {
    if (value.command.action !== 'release') throw new Error('Expected a release command.');
    return this.receiveInput(role, value, receivedAt);
  }
  receiveAssistance(role: Role, value: Command): ReleaseDecision {
    if (value.command.action !== 'assistance') throw new Error('Expected an assistance command.');
    return this.receiveInput(role, value);
  }
  private receiveInput(role: Role, value: Command, receivedAt?: number): ReleaseDecision {
    const message = decodeMessage(encodeMessage(value), { sessionId: this.sessionId, epoch: value.epoch, peer: role, channel: 'control' });
    if (message.type !== 'command' || message.command.action !== 'release' && message.command.action !== 'assistance') throw new Error('Expected a gameplay input.');
    if (this.acknowledgements.length >= 64) throw new Error('Release acknowledgement budget exhausted.');
    const intent = JSON.stringify(message.command);
    const published = this.published[message.slot].get(message.inputSequence);
    const remembered = published ?? [...this.accepted.values()].find(record =>
      record.slot === message.slot && record.inputSequence === message.inputSequence);
    if (message.epoch === this.authority.epoch && remembered?.epoch === message.epoch) {
      const decision: ReleaseDecision = remembered.intent === intent
        ? { accepted: true, coreEventId: remembered.coreId } : { accepted: false, reason: 'duplicate' };
      if (!decision.accepted || published) this.acknowledgements.push(
        releaseAcknowledgement(message.slot, message.inputSequence, decision, () => published!.eventSequence));
      return decision;
    }
    if (this.accepted.size >= MAX_PLANS * 2) throw new Error('Unpublished release budget exhausted.');
    const decision = this.authority.receive(role, message, receivedAt);
    if (decision.accepted) {
      if (this.accepted.has(decision.coreEventId)) throw new Error('Input publication identity conflict.');
      this.accepted.set(decision.coreEventId, { coreId: decision.coreEventId, slot: message.slot,
        inputSequence: message.inputSequence, epoch: message.epoch, intent,
        plan: message.command.action === 'release' ? structuredClone(message.command.plan) : null });
    } else this.acknowledgements.push(releaseAcknowledgement(message.slot, message.inputSequence, decision,
      () => { throw new Error('Rejected releases have no published event.'); }));
    return decision;
  }
  collect(): SessionEvent[] {
    const expected = this.session.lastEventId - this.collected;
    if (expected + this.pending.length > MAX_SESSION_EVENTS) throw new Error('Publication event budget exhausted.');
    const events = this.session.drainEvents();
    if (events.length !== expected || events.some((event, index) => event.eventId !== this.collected + index + 1)) {
      throw new Error('Only the publication journal may drain host events.');
    }
    this.pending.push(...events.map(source => ({ source: structuredClone(source), index: 0 })));
    this.collected = this.session.lastEventId;
    return events;
  }
  prepareOutcome(coreId: number, effect: { reference: Reference; data: unknown } | null): void {
    const source = this.pending.find(item => item.source.eventId === coreId)?.source;
    if (!source || source.type !== 'resolved' || this.outcomes.has(source.result.id)) throw new Error('Unknown or already prepared outcome.');
    const result = source.result;
    this.prune();
    if (this.outcomes.size >= MAX_PLANS * 2 + MAX_EFFECTS) throw new Error('Publication outcome budget exhausted.');
    let prepared: Outcome['effect'] = null;
    if (effect) {
      const data = combat.parse(effect.data), ref = reference.parse(effect.reference);
      const kind = result.points ? 'flyby' : result.misses === 3 ? 'finale' : 'damage';
      if (data.id !== result.id || data.slot !== result.slot || data.sequence !== result.sequence ||
        data.bornAt !== result.time || data.missile.kind !== kind ||
        data.damageLevel !== Math.min(2, result.misses) ||
        [...this.outcomes.values()].some(outcome => outcome.effect?.reference.id === ref.id)) {
        throw new Error('Combat publication does not match its authoritative outcome.');
      }
      prepared = { reference: ref, bornAt: data.bornAt, kind, ready: false };
    } else if (!result.points) throw new Error('Every miss requires its damage or finale plan.');
    this.outcomes.set(result.id, { sequence: result.sequence, slot: result.slot, effect: prepared });
  }
  acknowledgeEffect(value: Reference): void {
    const ref = reference.parse(value), effect = [...this.outcomes.values()].find(outcome => outcome.effect?.reference.id === ref.id)?.effect;
    if (!effect || effect.reference.digest !== ref.digest) throw new Error('Unexpected combat acknowledgement.');
    effect.ready = true;
  }
  private bodies(source: SessionEvent): EventBody['event'][] | null {
    if (source.type === 'released') {
      const accepted = this.accepted.get(source.eventId), plan = this.plans.references.get(source.sequence);
      if (!accepted?.plan || !plan || accepted.plan.id !== plan.id || accepted.plan.digest !== plan.digest) {
        throw new Error('Release publication lost its input or retained plan.');
      }
      return [{ action: 'released', slot: source.slot, sequence: source.sequence, at: stampAt(source.time),
        inputSequence: accepted.inputSequence, plan: accepted.plan }];
    }
    if (source.type === 'assistance') {
      return [{ action: 'assistance', slot: source.slot, enabled: source.enabled, assisted: source.assisted }];
    }
    if (source.type === 'resolved') {
      if (!this.plans.references.has(source.result.sequence)) throw new Error('Keep the result flight until its outcome is published.');
      const outcome = this.outcomes.get(source.result.id);
      if (!outcome || outcome.effect && !outcome.effect.ready) return null;
      return [{ action: 'resolved', result: source.result }, ...(outcome.effect ? [{
        action: 'combat' as const, slot: source.result.slot, effect: outcome.effect.reference, at: stampAt(outcome.effect.bornAt),
      }] : [])];
    }
    if (source.type === 'eliminated') {
      const completion = source.completion, effect = this.outcomes.get(completion.sequence * 2 + completion.slot + 1)?.effect;
      if (!effect?.ready || effect.kind !== 'finale') throw new Error('Elimination requires its published frozen finale.');
      return [{ action: 'eliminated', slot: completion.slot, sequence: completion.sequence,
        at: stampAt(completion.time), combat: effect.reference }];
    }
    return [{ action: 'ended', at: stampAt(source.time), winner: source.winner }];
  }
  flush(send: (body: MessageBody) => SendResult, limit = 16): {
    sent: number; blocked: 'outcome' | 'backpressure' | 'not_open' | 'budget' | null;
  } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('Invalid publication work budget.');
    let sent = 0;
    while (sent < limit) {
      const acknowledgement = this.acknowledgements[0];
      if (acknowledgement) {
        const result = send(structuredClone(acknowledgement));
        if (!result.ok) return { sent, blocked: result.reason };
        this.acknowledgements.shift(); sent++; continue;
      }
      const pending = this.pending[0];
      if (!pending) return { sent, blocked: null };
      const bodies = this.bodies(pending.source);
      if (!bodies) return { sent, blocked: 'outcome' };
      const eventSequence = counter.min(1).parse(this.publishedEvent + 1);
      const body: EventBody = { type: 'event', planRevision: this.plans.revision, eventSequence, event: bodies[pending.index]! };
      const result = send(structuredClone(body));
      if (!result.ok) return { sent, blocked: result.reason };
      this.publishedEvent = eventSequence; pending.index++; sent++;
      if (pending.source.type === 'released' || pending.source.type === 'assistance') {
        const accepted = this.accepted.get(pending.source.eventId)!;
        const cache = this.published[accepted.slot];
        cache.set(accepted.inputSequence, { ...accepted, eventSequence });
        if (cache.size > RELEASE_DECISIONS) cache.delete(cache.keys().next().value!);
        this.acknowledgements.push(releaseAcknowledgement(accepted.slot, accepted.inputSequence,
          { accepted: true, coreEventId: accepted.coreId }, () => eventSequence));
        this.accepted.delete(accepted.coreId);
      }
      if (pending.index === bodies.length) {
        this.publishedCore = pending.source.eventId; this.pending.shift();
      }
    }
    return { sent, blocked: this.pendingCount ? 'budget' : null };
  }
  snapshot(sampledAt: number): Extract<MessageBody, { type: 'snapshot' }> {
    if (!Number.isFinite(sampledAt) || Math.abs(sampledAt) > 1e12) throw new Error('Invalid snapshot sample time.');
    if (!this.canSnapshot) throw new Error('Publish complete event groups and acknowledgements before snapshots.');
    this.prune();
    const effects = [...this.outcomes.values()].flatMap(outcome => outcome.effect &&
      (outcome.effect.kind === 'finale' || this.session.time < outcome.effect.bornAt + FLYBY_DURATION)
      ? [{ ...outcome.effect.reference, bornAt: outcome.effect.bornAt }] : []);
    return { type: 'snapshot', sampledAt, state: sessionSnapshot(this.session, {
      plans: this.plans.references, planRevision: this.plans.revision, eventSequence: this.publishedEvent,
      coreEventId: this.publishedCore, lastInputs: this.authority.lastInputs, effects,
    }) };
  }
  private prune(): void {
    const retained = this.session.planSequences;
    for (const [id, outcome] of this.outcomes) if (!retained.includes(outcome.sequence) && outcome.effect?.kind !== 'finale' &&
      !this.pending.some(item => item.source.type === 'resolved' && item.source.result.id === id ||
        item.source.type === 'eliminated' && item.source.completion.sequence === outcome.sequence && item.source.completion.slot === outcome.slot)) {
      this.outcomes.delete(id);
    }
  }
}
