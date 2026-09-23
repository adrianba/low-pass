import { decodeMessage, encodeMessage } from '../../shared/protocol/codec.js';
import { counter, secondsAt } from '../../shared/protocol/game.js';
import type { SharedWorldFrame } from '../rendering/shared-frame.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import { messageChannel } from '../../shared/protocol/messages.js';
import { CombatTimeline } from '../game/multiplayer/combat-timeline.js';
import { spectatorSlot } from '../game/multiplayer/host-combat.js';
import { replicaWorldFrame } from '../rendering/replica-frame.js';
import type { PreparedConnection } from './lobby-connection.js';
import { releaseIntent } from './release-authority.js';
import { GuestReplica } from './replica.js';
import { TransferReceiver } from './transfer.js';
import type { SendResult } from './transport.js';

/** Receives authoritative state without running the course author or scoring locally. */
export class GuestGame {
  readonly replica: GuestReplica;
  readonly combat = new CombatTimeline();
  private readonly receiver: TransferReceiver;
  private readonly outgoing: MessageBody[] = [];
  private readonly verifiedWaiting: Array<Extract<MessageBody, { type: 'transfer-ready' }>> = [];
  private lastInput = 0;
  private lastReleaseInput: number | null = null;
  private releasedSequence = -1;
  private lastDecision: Extract<WireMessage, { type: 'ack' }>['decision'] | null = null;
  private closed = false;
  private resetPresentation = false;
  private displayed: { time: number; sequence: number; ready: boolean; reference: { id: string; digest: string } } | null = null;
  get lastInputSequence(): number { return this.lastInput; }
  get epoch(): number { return this.replica.epoch; }
  constructor(prepared: Pick<Extract<PreparedConnection, { role: 'guest' }>, 'formations' | 'course'>,
    readonly sessionId: string, epoch: number, now: () => number,
    private readonly send: (body: MessageBody) => SendResult) {
    this.replica = new GuestReplica(sessionId, epoch, prepared.course.manifest);
    this.receiver = new TransferReceiver(now, { maxTransfers: 4, maxBytes: 32 * 1024 * 1024, ttlMs: 30_000 });
    for (const formation of prepared.formations) this.replica.installVerified(formation);
  }
  advanceEpoch(nextEpoch: number): void {
    if (this.closed) throw new Error('Guest game is closed.');
    this.replica.advanceEpoch(nextEpoch);
    this.resetEpoch();
  }
  recoverEpoch(nextEpoch: number): void {
    if (this.closed) throw new Error('Guest game is closed.');
    this.replica.recoverEpoch(nextEpoch);
    this.resetEpoch();
  }
  private resetEpoch(): void {
    this.receiver.reset(); this.outgoing.length = 0; this.verifiedWaiting.length = 0;
    this.displayed = null; this.releasedSequence = -1; this.lastReleaseInput = null;
    this.lastDecision = null; this.resetPresentation = true;
  }
  async receive(value: WireMessage): Promise<void> {
    if (this.closed) throw new Error('Guest game is closed.');
    const message = decodeMessage(encodeMessage(value), { sessionId: this.sessionId, epoch: this.epoch,
      peer: 'host', channel: messageChannel(value) });
    if (message.type === 'transfer-offer') this.receiver.offer(message.transfer);
    else if (message.type === 'transfer-chunk') {
      const complete = await this.receiver.accept({ transferId: message.transferId, index: message.index, data: message.data });
      if (this.closed || !complete) return;
      const acknowledgement = this.replica.installVerified(complete);
      if (complete.payload.kind === 'checkpoint') this.queue(acknowledgement);
      else {
        if (this.verifiedWaiting.length >= 8) throw new Error('Guest verification dependency budget exhausted.');
        this.verifiedWaiting.push(acknowledgement);
      }
      for (let index = this.verifiedWaiting.length - 1; index >= 0; index--) {
        const pending = this.verifiedWaiting[index]!;
        if (this.replica.plans.has(pending.transfer)) {
          this.queue(pending); this.verifiedWaiting.splice(index, 1);
        }
      }
    } else if (message.type === 'plan-commit' || message.type === 'event' || message.type === 'snapshot' || message.type === 'checkpoint-commit') {
      this.replica.receive(message);
    } else if (message.type === 'ack') {
      if (message.slot === 1 && message.inputSequence > this.lastInput) throw new Error('Unknown local release acknowledgement.');
      if (message.slot === 1 && message.inputSequence === this.lastReleaseInput) {
        if (this.lastDecision && JSON.stringify(this.lastDecision) !== JSON.stringify(message.decision)) {
          throw new Error('Conflicting local release acknowledgement.');
        }
        if (!this.lastDecision && !message.decision.accepted) this.releasedSequence--;
        this.lastDecision = message.decision;
      }
    } else throw new Error('Lifecycle traffic belongs to the match controller.');
  }
  private queue(body: MessageBody) {
    if (this.outgoing.length >= 32) throw new Error('Guest game control budget exhausted.');
    this.outgoing.push(body);
  }
  requestPause(reason: Extract<MessageBody, { type: 'pause-state' }>['reason'] = 'manual'): void {
    this.queueCommand({ action: 'pause', reason });
  }
  requestAssistance(enabled: boolean): number {
    return this.queueCommand({ action: 'assistance', enabled });
  }
  private queueCommand(command: Extract<MessageBody, { type: 'command' }>['command']): number {
    if (this.closed) throw new Error('Guest game is closed.');
    const input = counter.min(1).parse(this.lastInput + 1);
    this.queue({ type: 'command', slot: 1, inputSequence: input, command });
    this.lastInput = input;
    return input;
  }
  pump(): SendResult {
    if (this.closed) return { ok: false, reason: 'not_open' };
    if (this.receiver.expire().length) throw new Error('Gameplay transfer expired.');
    for (let work = 0; this.outgoing.length && work < 16; work++) {
      const result = this.send(this.outgoing[0]!);
      if (!result.ok) return result;
      this.outgoing.shift();
    }
    return { ok: true };
  }
  frame(time: number, seed: number) {
    const state = this.replica.presentationAt(time);
    if (this.resetPresentation) { this.combat.reset(); this.resetPresentation = false; }
    const plans = state.plans.map(ref => ({ ref, flight: this.replica.plans.formation(ref) }));
    const at = (time: number) => {
      const plan = [...plans].reverse().find(({ flight }) => flight.startAt <= time && time <= flight.handoffAt);
      if (!plan) throw new Error('Missing guest presentation flight.');
      return plan;
    };
    const actors = state.players;
    this.combat.update(state.effects.map(effect => this.replica.plans.combatPlan(effect)), time, actors,
      (slot, time) => at(time).flight.pose(slot, time));
    const flightTime = state.status === 'over' ? secondsAt(state.at) : time;
    const current = at(flightTime);
    const frame = replicaWorldFrame(state, this.replica.plans, seed, spectatorSlot(1, this.combat), time, {
      poses: [this.combat.poseAt(0), this.combat.poseAt(1)],
      destroyed: [!this.combat.aliveAt(0), !this.combat.aliveAt(1)],
      views: [this.combat.finaleView(0) ?? current.flight.view(0, time), this.combat.finaleView(1) ?? current.flight.view(1, time)],
    });
    this.displayed = { time, sequence: current.flight.sequence,
      ready: !actors[1].eliminated && frame.ready && current.flight.sequence > this.releasedSequence,
      reference: current.ref };
    return frame;
  }
  release(frame?: SharedWorldFrame): boolean {
    const displayed = frame ? (() => {
      const flight = this.replica.plans.at(frame.time);
      const ref = this.replica.plans.references().find(ref => this.replica.plans.formation(ref).sequence === flight.sequence);
      return ref ? { time: frame.time, sequence: flight.sequence, reference: ref,
        ready: frame.ready && frame.viewedSlot === 1 && flight.sequence > this.releasedSequence } : null;
    })() : this.displayed;
    if (!displayed?.ready || this.closed) return false;
    this.lastReleaseInput = this.queueCommand(releaseIntent(displayed.sequence, displayed.reference, displayed.time));
    this.releasedSequence = displayed.sequence;
    this.lastDecision = null;
    displayed.ready = false;
    return true;
  }
  close(): void {
    this.closed = true; this.receiver.reset(); this.outgoing.length = 0; this.verifiedWaiting.length = 0;
    this.displayed = null; this.combat.reset();
  }
}
