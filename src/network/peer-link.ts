import { roomMembership } from '../../shared/protocol/rooms.js';
import type { RoomMembership } from '../../shared/protocol/rooms.js';
import { clientSignal, serverSignal } from '../../shared/protocol/signaling.js';
import type { ClientSignal } from '../../shared/protocol/signaling.js';
import { byteLength } from '../../shared/protocol/codec.js';
import { MAX_WIRE_BYTES, PROTOCOL_VERSION } from '../../shared/protocol/limits.js';
import type { Compatibility } from '../../shared/protocol/game.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import { RtcPeer, RtcError, RTC_LIMITS } from './rtc-peer.js';
import type { SendResult, TransportEvent } from './transport.js';

export class PeerLinkError extends Error { constructor(readonly code: string) { super(`Private connection failed: ${code}.`); } }
export const SIGNAL_RECOVERY_MS = 15_000;
export interface PeerLinkOptions {
  member: RoomMembership; compatibility: Compatibility; aspect: number;
  iceServers: RTCIceServer[]; relayOnly: boolean;
  epoch?: number;
}
/** One admitted connection generation; higher-level recovery owns replacement. */
export class PeerLink {
  private socket: WebSocket | null = null;
  private readonly options: PeerLinkOptions;
  private peer: RtcPeer | null = null;
  private authenticated = false;
  private peerPresent = false;
  private disposed = false;
  private connecting = false;
  private sequence = 1;
  private failureValue: string | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryUntil = Infinity;
  private retryDelay = 500;
  private readonly pendingSignals: ClientSignal[] = [];
  private pendingBytes = 0;
  private finalEvents: TransportEvent[] = [];
  constructor(options: PeerLinkOptions) {
    const member = roomMembership.safeParse(options.member);
    if (!member.success || member.data.room.state !== 'admitted') throw new PeerLinkError('membership');
    this.options = structuredClone(options);
    this.openSocket();
  }
  private expired(): boolean {
    if (!this.disposed && performance.now() >= this.recoveryUntil) this.fail('signaling_recovery_expired');
    return this.disposed;
  }
  private openSocket(): void {
    if (this.expired()) return;
    const socket = this.socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/signal');
    this.authTimer = setTimeout(() => this.socketUnavailable('authentication_timeout'), 10_000);
    socket.onopen = () => {
      if (this.socket !== socket || this.expired()) return;
      try { this.signal({ type: 'auth', version: PROTOCOL_VERSION, capability: this.options.member.capability }); }
      catch { this.socketUnavailable('signaling'); }
    };
    socket.onerror = () => { if (this.socket === socket) this.socketUnavailable('signaling'); };
    socket.onclose = () => { if (this.socket === socket) this.socketUnavailable('signaling_closed'); };
    socket.onmessage = event => {
      if (this.socket !== socket || this.expired()) return;
      try {
        if (typeof event.data !== 'string' || byteLength(event.data) > MAX_WIRE_BYTES) throw new PeerLinkError('invalid_signal');
        const parsed = serverSignal.safeParse(JSON.parse(event.data));
        if (!parsed.success) throw new PeerLinkError('invalid_signal');
        const message = parsed.data, room = this.options.member.room;
        if (message.type === 'error') {
          if (message.code === 'already_connected' && this.recoveryUntil !== Infinity) this.socketUnavailable(message.code);
          else if (message.code === 'peer_unavailable' && this.peer?.status === 'open') {
            this.peerPresent = false; this.beginSignalingRecovery();
          } else this.fail(message.code);
          return;
        }
        if (message.type === 'closed') {
          if (message.reason === 'service_stopped' && this.peer?.status === 'open') this.socketUnavailable('service_stopped');
          else this.fail(message.reason);
          return;
        }
        if (message.type === 'authenticated' || message.type === 'room') {
          if (message.room.roomId !== room.roomId || message.room.participantId !== room.participantId ||
            message.room.role !== room.role || message.room.guestId !== room.guestId || message.room.state !== 'admitted') throw new PeerLinkError('membership');
          if (message.type === 'authenticated') {
            if (this.authenticated) throw new PeerLinkError('duplicate_authentication');
            this.authenticated = true;
            if (this.authTimer !== null) clearTimeout(this.authTimer);
            this.authTimer = null;
          }
        } else if (!this.authenticated) throw new PeerLinkError('unauthenticated_signal');
        else if (message.type === 'peer') {
          this.peerPresent = message.connected;
          if (!message.connected && this.peer) {
            if (this.peer.status !== 'open') throw new PeerLinkError('peer_disconnected');
            this.beginSignalingRecovery();
          }
          if (message.connected && room.role === 'host' && !this.peer) {
            this.createPeer(message.generation + 1);
            void this.peer!.start().catch(() => this.fail('negotiation'));
          }
          if (message.connected && this.authenticated) this.signalingRestored();
        } else if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice') {
          if (message.type === 'offer' && room.role === 'guest' && !this.peer) this.createPeer(message.generation);
          if (!this.peer) throw new PeerLinkError('early_signal');
          void this.peer.receiveSignal(message).catch(() => this.fail('negotiation'));
        }
      } catch (error) { this.fail(error instanceof PeerLinkError || error instanceof RtcError ? error.code : 'invalid_signal'); }
    };
  }
  private signal(value: unknown): void {
    if (this.expired()) throw new PeerLinkError('signaling');
    const message = clientSignal.parse(value), text = JSON.stringify(message), bytes = byteLength(text);
    if (bytes > MAX_WIRE_BYTES) throw new PeerLinkError('signaling_capacity');
    if (this.socket?.readyState !== WebSocket.OPEN || message.type !== 'auth' && (!this.authenticated || !this.peerPresent)) {
      this.queueSignal(message, bytes); return;
    }
    if (this.socket.bufferedAmount + bytes > 64 * 1024) throw new PeerLinkError('signaling_capacity');
    try { this.socket.send(text); }
    catch {
      this.queueSignal(message, bytes);
      this.socketUnavailable('signaling');
    }
  }
  private queueSignal(message: ClientSignal, bytes: number): void {
    if (message.type === 'auth' || this.peer?.status !== 'open') throw new PeerLinkError('signaling');
    if (this.pendingSignals.length >= RTC_LIMITS.queuedSignals || this.pendingBytes + bytes > 64 * 1024) throw new PeerLinkError('signaling_capacity');
    this.pendingSignals.push(message); this.pendingBytes += bytes;
    this.beginSignalingRecovery();
  }
  private detachSocket(): void {
    if (this.authTimer !== null) clearTimeout(this.authTimer);
    this.authTimer = null; this.authenticated = false; this.peerPresent = false;
    const socket = this.socket; this.socket = null;
    if (socket) { socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; socket.close(); }
  }
  private socketUnavailable(code: string): void {
    if (this.disposed) return;
    if (this.peer?.status !== 'open') { this.fail(code); return; }
    this.detachSocket();
    this.beginSignalingRecovery();
    if (this.disposed || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.openSocket(); }, this.retryDelay);
    this.retryDelay = Math.min(4000, this.retryDelay * 2);
  }
  private beginSignalingRecovery(): void {
    if (this.expired() || this.recoveryUntil !== Infinity) return;
    this.recoveryUntil = performance.now() + SIGNAL_RECOVERY_MS;
    this.recoveryTimer = setTimeout(() => this.expired(), SIGNAL_RECOVERY_MS);
  }
  private signalingRestored(): void {
    if (this.expired()) return;
    const pending = this.pendingSignals.splice(0); this.pendingBytes = 0;
    for (const signal of pending) this.signal(signal);
    if (this.socket?.readyState !== WebSocket.OPEN || !this.authenticated || !this.peerPresent) return;
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null; this.recoveryUntil = Infinity; this.retryDelay = 500;
  }
  private createPeer(generation: number) {
    this.connecting = true;
    this.peer = new RtcPeer({ role: this.options.member.room.role, sessionId: this.options.member.room.roomId,
      epoch: this.options.epoch ?? generation - 1, generation, compatibility: this.options.compatibility, aspect: this.options.aspect,
      iceServers: this.options.iceServers, relayOnly: this.options.relayOnly, signal: value => this.signal(value) });
  }
  get status(): 'signaling' | 'waiting' | 'connecting' | 'open' | 'closed' {
    if (this.disposed) return 'closed';
    if (this.peer?.status === 'open') return 'open';
    return this.connecting ? 'connecting' : this.authenticated ? 'waiting' : 'signaling';
  }
  get failure(): string | null { return this.failureValue; }
  get signalingState(): 'available' | 'recovering' | 'connecting' | 'closed' {
    return this.disposed ? 'closed' : this.recoveryUntil !== Infinity ? 'recovering' : this.authenticated ? 'available' : 'connecting';
  }
  get epoch(): number { return this.peer?.epoch ?? this.options.epoch ?? 0; }
  get sessionId(): string { return this.options.member.room.roomId; }
  send(body: MessageBody): SendResult {
    if (this.expired() || this.status !== 'open' || !this.peer) return { ok: false, reason: 'not_open' };
    const message: WireMessage = { version: PROTOCOL_VERSION, sessionId: this.options.member.room.roomId,
      epoch: this.epoch, sender: this.options.member.room.role, sequence: this.sequence, ...body };
    const result = this.peer.send(message);
    if (result.ok) this.sequence++;
    return result;
  }
  drain(): TransportEvent[] {
    this.expired();
    const events = [...this.finalEvents.splice(0), ...this.peer?.drain() ?? []];
    for (const event of events) {
      if (event.type === 'failed' || event.type === 'rejected') this.fail(event.code);
      else if (event.type === 'status' && event.status === 'closed' && !this.disposed) this.fail('connection_closed');
    }
    return events;
  }
  async diagnostics() { return { status: this.status, failure: this.failureValue, peer: await this.peer?.diagnostics() ?? null }; }
  private fail(code: string) {
    if (this.disposed) return;
    this.failureValue = code;
    this.finalEvents = this.peer?.drain() ?? [];
    this.close();
  }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
    this.retryTimer = this.recoveryTimer = null;
    this.detachSocket(); this.peer?.close();
    this.pendingSignals.length = 0; this.pendingBytes = 0;
  }
}
