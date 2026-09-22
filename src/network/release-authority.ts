import { decodeMessage, encodeMessage, ProtocolError } from '../../shared/protocol/codec.js';
import { counter, identifier, reference, secondsAt, sequence as planSequence, stampAt } from '../../shared/protocol/game.js';
import type { Stamp } from '../../shared/protocol/game.js';
import type { Role } from '../../shared/protocol/limits.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import type { HostSession, PlayerSlot } from '../game/multiplayer/session.js';

// Development allowance above observed ~0.58s preflight stalls, not a latency guarantee.
export const RELEASE_GRACE_SECONDS = 0.75;
export const RELEASE_DECISIONS = 64;
type Reference = { id: string; digest: string };
type CommandMessage = Extract<WireMessage, { type: 'command' }>;
type ReleaseIntent = Extract<CommandMessage['command'], { action: 'release' }>;
type Rejection = Extract<MessageBody, { type: 'ack' }>['decision'] & { accepted: false };
export type ReleaseDecision = { accepted: true; releaseEventId: number } | Rejection;
interface Remembered { intent: string; decision: ReleaseDecision }

/** Capture the actual displayed plan time, never a fresh arrival/input wall time. */
export function releaseIntent(sequence: number, plan: Reference, displayedAt: number): ReleaseIntent {
  return { action: 'release', sequence: planSequence.parse(sequence), plan: reference.parse(plan), displayedAt: stampAt(displayedAt) };
}

function boundaryTime(stamp: Stamp, bounds: { acquireAt: number; cutoffAt: number }): number {
  for (const time of [bounds.acquireAt, bounds.cutoffAt]) {
    const encoded = stampAt(time);
    if (stamp.tick === encoded.tick && stamp.fraction === encoded.fraction) return time;
  }
  return secondsAt(stamp);
}

/** Core-event IDs are mapped to wire event sequences by the publishing controller. */
export class ReleaseAuthority {
  private currentEpoch: number;
  private epochStart: number;
  private phase: 'running' | 'settling' | 'paused' = 'running';
  private pauseDeadline = Infinity;
  private lastWall = -Infinity;
  private readonly plans = new Map<number, Reference>();
  private readonly highest: [number, number] = [0, 0];
  private readonly decisions: [Map<number, Remembered>, Map<number, Remembered>] = [new Map(), new Map()];
  constructor(readonly session: HostSession, private readonly sessionId: string, epoch: number,
    private readonly now: () => number) {
    identifier.parse(sessionId); counter.parse(epoch);
    this.currentEpoch = epoch; this.epochStart = session.time;
    this.readNow();
  }
  get epoch(): number { return this.currentEpoch; }
  get lastInputs(): [number, number] { return [...this.highest]; }
  get rememberedDecisions(): number { return this.decisions[0].size + this.decisions[1].size; }
  private readNow(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < this.lastWall) throw new Error('Monotonic clock moved backwards.');
    this.lastWall = value; return value;
  }
  registerPlan(sequence: number, value: Reference): void {
    const retained = this.session.planSequences;
    if (!retained.includes(sequence)) throw new Error('Cannot authorize an uninstalled plan.');
    const owned = reference.parse(value), previous = this.plans.get(sequence);
    if (previous && (previous.id !== owned.id || previous.digest !== owned.digest)) throw new Error('Cannot replace an authorized plan.');
    for (const key of this.plans.keys()) if (!retained.includes(key)) this.plans.delete(key);
    this.plans.set(sequence, owned);
  }
  receive(peer: Role, value: CommandMessage): ReleaseDecision {
    const message = decodeMessage(encodeMessage(value), { sessionId: this.sessionId, epoch: value.epoch, peer, channel: 'control' });
    if (message.type !== 'command' || message.command.action !== 'release') throw new ProtocolError('invalid_message');
    const now = this.readNow();
    if (message.epoch !== this.currentEpoch) return { accepted: false, reason: 'epoch' };
    const slot = message.slot, input = message.inputSequence, intent = JSON.stringify(message.command);
    const remembered = this.decisions[slot].get(input);
    if (remembered) return remembered.intent === intent ? structuredClone(remembered.decision) : { accepted: false, reason: 'duplicate' };
    if (input <= this.highest[slot]) return { accepted: false, reason: 'duplicate' };
    let decision: ReleaseDecision;
    const plan = this.plans.get(message.command.sequence);
    if (this.phase === 'paused' || this.phase === 'settling' && now > this.pauseDeadline) {
      decision = { accepted: false, reason: 'paused' };
    } else if (!plan || !this.session.planSequences.includes(message.command.sequence) ||
      plan.id !== message.command.plan.id || plan.digest !== message.command.plan.digest) {
      decision = { accepted: false, reason: 'plan' };
    } else {
      const time = boundaryTime(message.command.displayedAt, this.session.releaseWindow(slot, message.command.sequence));
      if (time < this.epochStart) decision = { accepted: false, reason: 'epoch' };
      else {
        const releaseEventId = this.session.lastEventId + 1;
        const result = this.session.releaseAt(slot, message.command.sequence, time, this.phase === 'settling');
        if (result.ok) decision = { accepted: true, releaseEventId };
        else {
          const reason = result.reason;
          if (reason === 'coverage' || reason === 'events_full' || reason === 'bomb_lifetime' || reason === 'unsettled_attempt') {
            throw new Error('Unexpected release failure.');
          }
          decision = { accepted: false, reason };
        }
      }
    }
    this.highest[slot] = input;
    this.decisions[slot].set(input, { intent, decision });
    if (this.decisions[slot].size > RELEASE_DECISIONS) {
      this.decisions[slot].delete(this.decisions[slot].keys().next().value!);
    }
    return structuredClone(decision);
  }
  beginPause(): void {
    if (this.phase !== 'running' || this.session.status !== 'running') throw new Error('Pause requires a running authority.');
    this.pauseDeadline = this.readNow() + this.session.releaseGraceSeconds * 1000;
    this.session.pause(); this.phase = 'settling';
  }
  sealPause(): void {
    if (this.phase !== 'settling' || this.readNow() <= this.pauseDeadline) throw new Error('Pause input settlement is incomplete.');
    this.phase = 'paused';
  }
  resume(nextEpoch: number): void {
    counter.parse(nextEpoch);
    if (this.phase !== 'paused' || nextEpoch !== this.currentEpoch + 1) throw new Error('Resume requires a sealed new epoch.');
    const result = this.session.resume();
    if (!result.ok) throw new Error(`Cannot resume release authority: ${result.reason}.`);
    this.currentEpoch = nextEpoch; this.epochStart = this.session.time; this.phase = 'running';
    for (const decisions of this.decisions) decisions.clear();
  }
}

export function releaseAcknowledgement(slot: PlayerSlot, inputSequence: number, decision: ReleaseDecision,
  publishedSequence: (releaseEventId: number) => number): Extract<MessageBody, { type: 'ack' }> {
  const result = decision.accepted
    ? { accepted: true as const, eventSequence: counter.min(1).parse(publishedSequence(decision.releaseEventId)) } : decision;
  return { type: 'ack', slot, inputSequence: counter.min(1).parse(inputSequence), decision: result };
}
