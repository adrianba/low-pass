import { RtcPeer } from '../../src/network/rtc-peer.js';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler.js';
import { formationData } from '../../src/network/formation-data.js';
import { createTransfer, TransferReceiver } from '../../src/network/transfer.js';
import { serverSignal } from '../../shared/protocol/signaling.js';
import { byteLength, encodePayload } from '../../shared/protocol/codec.js';
import type { WireMessage } from '../../shared/protocol/messages.js';
import type { Role } from '../../shared/protocol/limits.js';
import { versions } from '../unit/protocol-fixtures.js';
import { ClockError, PeerClock } from '../../src/network/peer-clock.js';
import { StartHandshake } from '../../src/network/start-handshake.js';
import type { StartedSession } from '../../src/network/start-handshake.js';

export interface Options { role: Role; roomId: string; capability: string; generation: number; epoch: number;
  mismatch?: boolean; relayOnly?: boolean; timeoutMs?: number; iceServers?: RTCIceServer[] }
export class RtcFixture {
  readonly errors: string[] = [];
  readonly messages: WireMessage[] = [];
  peer: RtcPeer | null = null;
  received: { digest: string; bytes: number } | null = null;
  backpressure = 0;
  peerPresent = false;
  readonly rttMs: number[] = [];
  transferReceiveMs: number | null = null;
  private receiveStarted = 0;
  private readonly socket: WebSocket;
  private readonly receiver = new TransferReceiver(() => performance.now(), { maxTransfers: 2, maxBytes: 32 * 1024 * 1024, ttlMs: 30_000 });
  private outgoing: WireMessage[] = [];
  private urgent: WireMessage[] = [];
  private sequence = 1;
  private probeId = 1;
  private closing = false;
  private busy = false;
  private startup: StartHandshake | null = null;
  private readonly startupClock = new PeerClock();
  private startupProbeAt = -Infinity;
  private started: StartedSession | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  readonly ready: Promise<void>;
  constructor(private readonly options: Options) {
    this.socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/signal');
    this.ready = new Promise<void>((resolve, reject) => {
      this.socket.onopen = () => {
        this.socket.send(JSON.stringify({ type: 'auth', version: 1, capability: options.capability }));
      };
      this.socket.onerror = () => { if (!this.closing) { this.errors.push('signal_error'); reject(new Error('Fixture signaling failed.')); } };
      this.socket.onclose = () => { if (!this.closing) { this.errors.push('signal_closed'); reject(new Error('Fixture signaling closed.')); } };
      this.socket.onmessage = event => {
        const message = serverSignal.parse(JSON.parse(event.data));
        if (message.type === 'authenticated') {
          if (message.room.role !== options.role || message.room.roomId !== options.roomId || message.room.state !== 'admitted') {
            reject(new Error('Fixture membership mismatch.')); return;
          }
          this.peer = new RtcPeer({ role: options.role, sessionId: options.roomId, epoch: options.epoch,
            generation: options.generation, aspect: 1.2, compatibility: options.mismatch ? { ...versions, build: 'b'.repeat(64) } : versions,
            iceServers: options.iceServers ?? [], relayOnly: options.relayOnly, timeoutMs: options.timeoutMs,
            signal: value => {
              if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Fixture signaling unavailable.');
              this.socket.send(JSON.stringify(value));
            } });
          resolve();
        } else if (message.type === 'peer') this.peerPresent = message.connected;
        else if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice') {
          if (!this.peer) { this.errors.push('early_signal'); return; }
          void this.peer.receiveSignal(message).catch(() => { if (!this.closing) this.errors.push('negotiation_failed'); });
        } else if (message.type === 'error') this.errors.push(message.code);
      };
    });
    this.timer = setInterval(() => { void this.pump(); }, 5);
  }
  private envelope() {
    return { version: 1 as const, sessionId: this.options.roomId, sender: this.options.role, epoch: this.peer?.epoch ?? this.options.epoch, sequence: 0 };
  }
  barrier() {
    if (!this.peer || this.options.role !== 'host' || this.urgent.length || this.outgoing.length) throw new Error('Fixture barrier requires a drained host.');
    const result = this.peer.send({ ...this.envelope(), sequence: this.sequence, type: 'barrier',
      nextEpoch: this.peer.epoch + 1, reason: 'resume', at: { tick: 0, fraction: 0 } });
    if (!result.ok) throw new Error(`Fixture barrier failed: ${result.reason}.`);
    this.sequence++;
  }
  startMatch() {
    if (!this.peer || this.peer.status !== 'open' || this.startup) throw new Error('Fixture startup requires a fresh open peer.');
    this.startup = new StartHandshake(this.options.role, this.options.roomId, this.peer.epoch,
      { tick: 0, fraction: 0 }, () => performance.now(), () => {
        try {
          const estimate = this.startupClock.estimate(performance.now());
          return { lower: estimate.remoteLower, upper: estimate.remoteUpper };
        } catch (error) {
          if (!(error instanceof ClockError)) throw error;
          return null;
        }
      });
    this.startup.setReady(true, 0);
  }
  startupReport() {
    let clock: string | { offsetMs: number; uncertaintyMs: number };
    try {
      const estimate = this.startupClock.estimate(performance.now());
      clock = { offsetMs: estimate.offsetMs, uncertaintyMs: estimate.uncertaintyMs };
    } catch (error) {
      if (!(error instanceof ClockError)) throw error;
      clock = error.code;
    }
    return { phase: this.startup?.phase ?? null, reason: this.startup?.reason ?? null, started: this.started, clock };
  }
  async plan() {
    const data = formationData(new FormationScheduler('river-canyon', 7).plan(), 0);
    const transfer = await createTransfer({ kind: 'formation', data }, data.encounterId);
    this.outgoing.push({ ...this.envelope(), type: 'transfer-offer', transfer: transfer.offer },
      ...transfer.chunks.map(chunk => ({ ...this.envelope(), type: 'transfer-chunk' as const, ...chunk })));
    return { digest: transfer.offer.digest, bytes: transfer.offer.bytes };
  }
  command() {
    if (this.urgent.length >= 62) throw new Error('Fixture priority queue capacity.');
    this.urgent.push({ ...this.envelope(), type: 'command', slot: this.options.role === 'host' ? 0 : 1, inputSequence: 1,
      command: { action: 'pause' } });
    this.probe();
  }
  probe() {
    if (this.urgent.length >= 64) throw new Error('Fixture priority queue capacity.');
    this.urgent.push({ ...this.envelope(), type: 'ping', id: this.probeId++, sentAt: 0 });
  }
  private async pump() {
    if (this.busy || this.closing || !this.peer) return;
    this.busy = true;
    try {
      for (let count = 0; (this.urgent.length || this.outgoing.length) && this.peer.status === 'open' && count < 32; count++) {
        const queue = this.urgent.length ? this.urgent : this.outgoing, message = queue[0]!;
        const result = this.peer.send({ ...message, sequence: this.sequence,
          ...(message.type === 'ping' ? { sentAt: performance.now() } : {}) });
        if (!result.ok) { if (result.reason === 'backpressure') this.backpressure++; break; }
        this.sequence++; queue.shift();
      }
      for (const event of this.peer.drain()) {
        if (event.type === 'failed') { this.errors.push(event.code); continue; }
        if (event.type === 'rejected') { this.errors.push(event.code); continue; }
        if (event.type !== 'message') continue;
        const message = event.message;
        if (message.type === 'transfer-offer') { this.receiver.offer(message.transfer); this.receiveStarted = performance.now(); }
        else if (message.type === 'transfer-chunk') {
          const completed = await this.receiver.accept({ transferId: message.transferId, index: message.index, data: message.data });
          if (completed) {
            if (completed.payload.kind !== 'formation') throw new Error('Wrong fixture transfer kind.');
            this.received = { digest: completed.reference.digest, bytes: byteLength(encodePayload(completed.payload)) };
            this.transferReceiveMs = performance.now() - this.receiveStarted;
          }
        } else {
          if (this.messages.length >= 128) this.messages.shift();
          this.messages.push(message);
          if (this.startup && (message.type === 'loading-ready' || message.type === 'start-offer' || message.type === 'start-ready' ||
            message.type === 'start-commit' || message.type === 'start-cancel' || message.type === 'barrier')) {
            this.startup.receive(message);
          } else if (message.type === 'ping') {
            if (this.urgent.length >= 64) throw new Error('Fixture priority queue capacity.');
            this.urgent.push({ ...this.envelope(), type: 'pong', id: message.id, sentAt: message.sentAt, receivedAt: event.receivedAt });
          } else if (message.type === 'pong') {
            if (this.rttMs.length >= 60) this.rttMs.shift();
            this.rttMs.push(performance.now() - message.sentAt);
            if (this.startup) this.startupClock.receive(message, performance.now());
          }
        }
      }
      if (this.startup && this.peer.status === 'open') {
        if (performance.now() - this.startupProbeAt >= 300) {
          this.startupProbeAt = performance.now();
          const probe = this.startupClock.probe(performance.now());
          if (this.peer.send({ ...this.envelope(), sequence: this.sequence, ...probe }).ok) this.sequence++;
          else this.startupClock.cancelProbe(probe.id);
        }
        this.startup.pump(body => {
          const result = this.peer!.send({ ...this.envelope(), sequence: this.sequence, ...body });
          if (result.ok) this.sequence++;
          return result;
        });
        this.started ??= this.startup.takeStart();
      }
    } catch { this.errors.push('fixture_transfer_failed'); }
    finally { this.busy = false; }
  }
  async close(): Promise<void> {
    this.closing = true; clearInterval(this.timer); this.startup?.close(); this.peer?.close(); this.receiver.reset(); this.outgoing = []; this.urgent = [];
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => { this.socket.addEventListener('close', () => resolve(), { once: true }); this.socket.close(); });
  }
}
declare global {
  interface Window { rtcFixture: RtcFixture; connectRtc: (options: Options) => Promise<void> }
}
window.connectRtc = async options => {
  if (window.rtcFixture) await window.rtcFixture.close();
  window.rtcFixture = new RtcFixture(options);
  await window.rtcFixture.ready;
};
