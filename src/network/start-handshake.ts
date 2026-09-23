import { decodeMessage, encodeMessage } from '../../shared/protocol/codec.js';
import { compareStamps, counter, identifier, stamp } from '../../shared/protocol/game.js';
import type { Stamp } from '../../shared/protocol/game.js';
import type { Role } from '../../shared/protocol/limits.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import type { SendResult } from './transport.js';
import { CLOCK_LIMITS } from './peer-clock.js';

export const START_LIMITS = Object.freeze({ countdownMs: 3000, confirmationMs: 500, overshootMs: 100, retryMs: 1000 });
type Offer = Extract<MessageBody, { type: 'start-offer' }>;
type Incoming = Extract<WireMessage, { type: 'loading-ready' | 'start-offer' | 'start-ready' | 'start-commit' | 'start-cancel' | 'barrier' }>;
interface Attempt { offer: Offer; sent: boolean; acknowledged: boolean; committed: boolean; invalidated: boolean }
export interface StartedSession { epoch: number; at: Stamp; hostStartsAt: number; requiresPause: boolean }

/** A handoff is not a launch: loading and the current readiness revision must be acknowledged. */
export class StartHandshake {
  private phaseValue: 'waiting' | 'offered' | 'countdown' | 'running' | 'closed' = 'waiting';
  private reasonValue: 'loading' | 'peer' | 'clock' | 'confirmation' | 'late' | null = 'loading';
  private local = { revision: 0, ready: false };
  private remote = { revision: 0, ready: false };
  private readonly outgoing: MessageBody[] = [];
  private active: Attempt | null = null;
  private attempt = 0;
  private retryAt = -Infinity;
  private lastWall = -Infinity;
  private started: StartedSession | null = null;
  private readonly at: Stamp;
  constructor(readonly role: Role, private readonly sessionId: string, readonly epoch: number, at: Stamp,
    private readonly now: () => number, private readonly hostTime: () => { lower: number; upper: number } | null,
    private readonly purpose: 'resume' | 'rematch' = 'resume') {
    identifier.parse(sessionId); counter.parse(epoch);
    if (role !== 'host' && role !== 'guest') throw new Error('Invalid startup role.');
    this.at = stamp.parse(at); this.readNow();
  }
  get phase() { return this.phaseValue; }
  get reason() { return this.reasonValue; }
  get pendingCount() { return this.outgoing.length; }
  get readiness() { return { local: this.local.ready, peer: this.remote.ready }; }
  peerUnavailable(): void {
    if (this.role !== 'host' || this.phaseValue === 'running' || this.phaseValue === 'closed') throw new Error('No active host readiness barrier.');
    this.remote.ready = false;
    if (this.active) this.cancel('peer');
  }
  get remainingMs(): number | null {
    if (!this.active || this.phaseValue !== 'countdown') return null;
    const now = this.readNow(), remote = this.role === 'guest' ? this.estimate() : null;
    if (this.role === 'guest' && !remote) return null;
    return Math.max(0, this.active.offer.startsAt - (remote ? (remote.lower + remote.upper) / 2 : now));
  }
  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now) || Math.abs(now) > 1e12 || now < this.lastWall) throw new Error('Invalid startup monotonic clock.');
    this.lastWall = now; return now;
  }
  private queue(body: MessageBody): void {
    if (this.outgoing.length >= 8) throw new Error('Startup control budget exhausted.');
    this.outgoing.push(body);
  }
  setReady(ready: boolean, revision: number): void {
    counter.parse(revision);
    if (typeof ready !== 'boolean' || revision < this.local.revision ||
      this.phaseValue === 'running' || this.phaseValue === 'closed') throw new Error('Invalid startup readiness update.');
    if (ready === this.local.ready && revision === this.local.revision) return;
    this.local = { ready, revision };
    if (this.role === 'guest') {
      this.remove('loading-ready'); this.queue({ type: 'loading-ready', revision, ready });
      if (this.active) {
        this.active.invalidated = true; this.phaseValue = 'waiting';
        this.reply(false);
      }
    } else if (this.active) this.cancel('loading');
    this.reasonValue = ready ? 'peer' : 'loading';
  }
  receive(value: Incoming): void {
    const message = decodeMessage(encodeMessage(value), { sessionId: this.sessionId, epoch: this.epoch,
      peer: this.role === 'host' ? 'guest' : 'host', channel: 'control' });
    if (this.phaseValue === 'closed' || this.phaseValue === 'running') throw new Error('Startup is no longer active.');
    const now = this.readNow();
    if (message.type === 'loading-ready' && this.role === 'host') {
      if (message.revision < this.remote.revision) return;
      this.remote = { revision: message.revision, ready: message.ready };
      if (this.active && (!message.ready || message.revision !== this.active.offer.revision)) this.cancel('peer');
      return;
    }
    if (message.type === 'start-offer' && this.role === 'guest') {
      const offer: Offer = { type: 'start-offer', attempt: message.attempt, revision: message.revision,
        startsAt: message.startsAt, nextEpoch: message.nextEpoch, at: message.at };
      if (offer.attempt < this.attempt) return;
      if (offer.attempt === this.attempt) {
        if (!this.active) return;
        if (JSON.stringify(offer) !== JSON.stringify(this.active.offer)) throw new Error('A startup offer cannot change.');
        if (this.active.acknowledged) return;
        this.reply(this.acceptable()); return;
      }
      if (this.active || compareStamps(offer.at, this.at) !== 0) throw new Error('Unexpected startup offer.');
      this.attempt = offer.attempt;
      this.active = { offer, sent: true, acknowledged: false, committed: false, invalidated: false };
      this.phaseValue = 'offered';
      this.reply(this.acceptable()); return;
    }
    if (message.type === 'start-ready' && this.role === 'host') {
      if (message.attempt < this.attempt || message.attempt === this.attempt && !this.active) return;
      const active = this.active;
      if (!active || message.attempt !== active.offer.attempt || !active.sent) throw new Error('Unsolicited startup acknowledgement.');
      if (!message.ready || message.revision !== active.offer.revision || !this.local.ready ||
        this.local.revision !== active.offer.revision || !this.remote.ready || this.remote.revision !== active.offer.revision) {
        this.cancel('peer'); return;
      }
      if (active.acknowledged) return;
      if (now >= active.offer.startsAt - START_LIMITS.confirmationMs) { this.cancel('late'); return; }
      active.acknowledged = true;
      this.queue({ type: 'start-commit', attempt: active.offer.attempt }); return;
    }
    if ((message.type === 'start-commit' || message.type === 'start-cancel') && this.role === 'guest') {
      if (message.attempt < this.attempt || message.attempt === this.attempt && !this.active) return;
      if (!this.active || message.attempt !== this.active.offer.attempt) throw new Error('Unknown startup decision.');
      if (message.type === 'start-cancel') {
        this.remove('start-ready'); this.active = null; this.phaseValue = 'waiting'; this.reasonValue = 'peer'; return;
      }
      if (!this.active.acknowledged) throw new Error('Startup was committed before readiness was sent.');
      this.active.committed = true;
      if (this.active.invalidated || !this.local.ready || this.local.revision !== this.active.offer.revision) {
        this.reply(false); return;
      }
      this.phaseValue = 'countdown'; this.reasonValue = null; return;
    }
    if (message.type === 'barrier' && this.role === 'guest') {
      const active = this.active;
      if (!active?.committed || message.reason !== this.purpose || message.nextEpoch !== active.offer.nextEpoch ||
        compareStamps(message.at, active.offer.at) !== 0) throw new Error('Start requires the acknowledged countdown barrier.');
      const remote = this.estimate();
      const requiresPause = active.invalidated || !this.local.ready || this.local.revision !== active.offer.revision ||
        !remote || remote.upper < active.offer.startsAt || remote.lower > active.offer.startsAt + START_LIMITS.confirmationMs;
      this.finish(requiresPause); return;
    }
    throw new Error('Unexpected startup message.');
  }
  private estimate(): { lower: number; upper: number } | null {
    const value = this.hostTime();
    return value && Number.isFinite(value.lower) && Number.isFinite(value.upper) && value.lower <= value.upper &&
      value.upper - value.lower <= 2 * CLOCK_LIMITS.uncertaintyMs ? value : null;
  }
  private acceptable(): boolean {
    const active = this.active;
    if (!active || active.invalidated || !this.local.ready || this.local.revision !== active.offer.revision) {
      this.reasonValue = 'loading'; return false;
    }
    const remote = this.estimate();
    if (!remote) {
      this.reasonValue = 'clock'; return false;
    }
    if (remote.upper >= active.offer.startsAt - START_LIMITS.confirmationMs) { this.reasonValue = 'late'; return false; }
    this.reasonValue = 'confirmation'; return true;
  }
  private reply(ready: boolean): void {
    if (!this.active) throw new Error('Missing startup offer.');
    this.remove('start-ready');
    if (!ready) this.active.invalidated = true;
    this.queue({ type: 'start-ready', attempt: this.active.offer.attempt, revision: this.local.revision, ready });
  }
  private remove(type: MessageBody['type']): void {
    for (let index = this.outgoing.length - 1; index >= 0; index--) if (this.outgoing[index]!.type === type) this.outgoing.splice(index, 1);
  }
  private cancel(reason: typeof this.reasonValue): void {
    const active = this.active;
    if (!active) return;
    this.remove('start-offer'); this.remove('start-commit'); this.remove('barrier');
    if (active.sent) this.queue({ type: 'start-cancel', attempt: active.offer.attempt });
    this.active = null; this.phaseValue = 'waiting'; this.reasonValue = reason;
    this.retryAt = this.readNow() + START_LIMITS.retryMs;
  }
  private tick(): void {
    const now = this.readNow();
    if (this.role !== 'host' || this.phaseValue === 'closed' || this.phaseValue === 'running') return;
    const active = this.active;
    if (active) {
      if (!active.committed && now >= active.offer.startsAt - START_LIMITS.confirmationMs ||
        now > active.offer.startsAt + START_LIMITS.overshootMs) { this.cancel('late'); return; }
      if (active.committed && now >= active.offer.startsAt && !this.outgoing.some(body => body.type === 'barrier')) {
        this.queue({ type: 'barrier', nextEpoch: active.offer.nextEpoch, reason: this.purpose, at: active.offer.at });
      }
    } else if (!this.outgoing.length && this.local.ready && this.remote.ready &&
      this.local.revision === this.remote.revision && now >= this.retryAt) {
      this.attempt = counter.min(1).parse(this.attempt + 1);
      const offer: Offer = { type: 'start-offer', attempt: this.attempt, revision: this.local.revision,
        nextEpoch: this.epoch + 1, at: structuredClone(this.at), startsAt: now + START_LIMITS.countdownMs };
      this.active = { offer, sent: false, acknowledged: false, committed: false, invalidated: false };
      this.phaseValue = 'offered'; this.reasonValue = 'confirmation'; this.queue(offer);
    }
  }
  pump(send: (body: MessageBody) => SendResult): SendResult {
    this.tick();
    for (let work = 0; this.outgoing.length && work < 8; work++) {
      let body = this.outgoing[0]!;
      if (body.type === 'start-ready' && body.ready && !this.acceptable()) {
        this.reply(false); body = this.outgoing[0]!;
      }
      const result = send(structuredClone(body));
      if (!result.ok) {
        if (body.type === 'barrier') this.cancel('late');
        return result;
      }
      this.outgoing.shift();
      if (body.type === 'start-offer') this.active!.sent = true;
      else if (body.type === 'start-ready' && body.ready) this.active!.acknowledged = true;
      else if (body.type === 'start-commit') {
        this.active!.committed = true; this.phaseValue = 'countdown'; this.reasonValue = null;
      } else if (body.type === 'barrier') this.finish(false);
    }
    return { ok: true };
  }
  private finish(requiresPause: boolean): void {
    const offer = this.active!.offer;
    this.started = { epoch: offer.nextEpoch, at: structuredClone(offer.at), hostStartsAt: offer.startsAt, requiresPause };
    this.phaseValue = 'running'; this.reasonValue = null; this.active = null; this.outgoing.length = 0;
  }
  takeStart(): StartedSession | null { const started = this.started; this.started = null; return started; }
  close(): void { this.phaseValue = 'closed'; this.active = null; this.started = null; this.outgoing.length = 0; }
}
