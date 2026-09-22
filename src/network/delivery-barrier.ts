import { decodeMessage, encodeMessage, ProtocolError } from '../../shared/protocol/codec.js';
import type { WireMessage } from '../../shared/protocol/messages.js';
import { messageChannel } from '../../shared/protocol/messages.js';
import type { CompletedTransfer } from './transfer.js';

export type DeliveryDecision = { ok: true } | { ok: false; reason: 'stale' | 'missing_plan' | 'missing_event' | 'checkpoint' };
type OrderedMessage = Extract<WireMessage, { type: 'plan-commit' | 'event' | 'snapshot' | 'checkpoint-commit' }>;
type HasReference = (reference: { id: string; digest: string }) => boolean;

/** Ordering only: applying outcomes, simulation state and input finality belongs to the replica. */
export class DeliveryBarrier {
  private revision = -1;
  private event = 0;
  private snapshot = -1;
  constructor(private readonly sessionId: string, private readonly epoch: number) {}
  get watermarks() { return { planRevision: this.revision, eventSequence: this.event, snapshotSequence: this.snapshot }; }
  copy(): DeliveryBarrier {
    const copy = new DeliveryBarrier(this.sessionId, this.epoch);
    copy.revision = this.revision; copy.event = this.event; copy.snapshot = this.snapshot;
    return copy;
  }

  consider(value: OrderedMessage, has: HasReference, checkpoint?: CompletedTransfer): DeliveryDecision {
    const message = decodeMessage(encodeMessage(value), { sessionId: this.sessionId, epoch: this.epoch,
      peer: 'host', channel: messageChannel(value) });
    if (message.type === 'plan-commit') {
      if (message.planRevision <= this.revision) return { ok: false, reason: 'stale' };
      if (message.planRevision !== this.revision + 1 || !message.plans.every(has)) return { ok: false, reason: 'missing_plan' };
      this.revision = message.planRevision;
    } else if (message.type === 'event') {
      if (message.eventSequence <= this.event) return { ok: false, reason: 'stale' };
      if (message.eventSequence !== this.event + 1) return { ok: false, reason: 'missing_event' };
      if (message.planRevision > this.revision) return { ok: false, reason: 'missing_plan' };
      const event = message.event;
      const reference = event.action === 'released' ? event.plan : event.action === 'combat' ? event.effect :
        event.action === 'eliminated' ? event.combat : null;
      if (reference && !has(reference)) return { ok: false, reason: 'missing_plan' };
      this.event = message.eventSequence;
    } else if (message.type === 'snapshot') {
      const state = message.state;
      if (message.sequence <= this.snapshot || state.planRevision < this.revision || state.eventSequence < this.event) return { ok: false, reason: 'stale' };
      if (state.planRevision > this.revision || ![...state.plans, ...state.effects].every(has)) return { ok: false, reason: 'missing_plan' };
      if (state.eventSequence > this.event) return { ok: false, reason: 'missing_event' };
      this.snapshot = message.sequence;
    } else if (message.type === 'checkpoint-commit') {
      if (!checkpoint || checkpoint.reference.id !== message.checkpoint.id || checkpoint.reference.digest !== message.checkpoint.digest ||
        checkpoint.payload.kind !== 'checkpoint') return { ok: false, reason: 'checkpoint' };
      const data = checkpoint.payload.data, state = data.state;
      if (data.sessionId !== this.sessionId) throw new ProtocolError('session');
      if (data.epoch !== this.epoch) throw new ProtocolError('epoch');
      if (message.planRevision !== state.planRevision || message.eventSequence !== state.eventSequence ||
        message.snapshotSequence !== data.snapshotSequence) throw new ProtocolError('invalid_message');
      if (state.planRevision < this.revision || state.eventSequence < this.event || data.snapshotSequence < this.snapshot) return { ok: false, reason: 'stale' };
      if (state.planRevision === this.revision && state.eventSequence === this.event && data.snapshotSequence === this.snapshot) {
        return { ok: false, reason: 'stale' };
      }
      if (![...state.plans, ...state.effects].every(has)) return { ok: false, reason: 'missing_plan' };
      this.revision = state.planRevision; this.event = state.eventSequence; this.snapshot = data.snapshotSequence;
    } else throw new ProtocolError('invalid_message');
    return { ok: true };
  }
}
