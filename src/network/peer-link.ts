import { roomMembership } from '../../shared/protocol/rooms.js';
import type { RoomMembership } from '../../shared/protocol/rooms.js';
import { serverSignal } from '../../shared/protocol/signaling.js';
import { byteLength } from '../../shared/protocol/codec.js';
import { MAX_WIRE_BYTES, PROTOCOL_VERSION } from '../../shared/protocol/limits.js';
import type { Compatibility } from '../../shared/protocol/game.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import { RtcPeer, RtcError } from './rtc-peer.js';
import type { SendResult, TransportEvent } from './transport.js';

export class PeerLinkError extends Error { constructor(readonly code: string) { super(`Private connection failed: ${code}.`); } }
export interface PeerLinkOptions {
  member: RoomMembership; compatibility: Compatibility; aspect: number;
  iceServers: RTCIceServer[]; relayOnly: boolean;
}
/** One admitted connection generation; higher-level recovery owns replacement. */
export class PeerLink {
  private readonly socket: WebSocket;
  private readonly options: PeerLinkOptions;
  private peer: RtcPeer | null = null;
  private authenticated = false;
  private disposed = false;
  private connecting = false;
  private sequence = 1;
  private epoch = 0;
  private failureValue: string | null = null;
  private readonly authTimer: ReturnType<typeof setTimeout>;
  constructor(options: PeerLinkOptions) {
    const member = roomMembership.safeParse(options.member);
    if (!member.success || member.data.room.state !== 'admitted') throw new PeerLinkError('membership');
    this.options = structuredClone(options);
    this.socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/signal');
    this.authTimer = setTimeout(() => this.fail('authentication_timeout'), 10_000);
    this.socket.onopen = () => {
      try { this.signal({ type: 'auth', version: PROTOCOL_VERSION, capability: this.options.member.capability }); }
      catch { this.fail('signaling'); }
    };
    this.socket.onerror = () => this.fail('signaling');
    this.socket.onclose = () => { if (!this.disposed) this.fail('signaling_closed'); };
    this.socket.onmessage = event => {
      if (this.disposed) return;
      try {
        if (typeof event.data !== 'string' || byteLength(event.data) > MAX_WIRE_BYTES) throw new PeerLinkError('invalid_signal');
        const parsed = serverSignal.safeParse(JSON.parse(event.data));
        if (!parsed.success) throw new PeerLinkError('invalid_signal');
        const message = parsed.data, room = this.options.member.room;
        if (message.type === 'authenticated' || message.type === 'room') {
          if (message.room.roomId !== room.roomId || message.room.participantId !== room.participantId ||
            message.room.role !== room.role || message.room.guestId !== room.guestId || message.room.state !== 'admitted') throw new PeerLinkError('membership');
          if (message.type === 'authenticated') {
            if (this.authenticated) throw new PeerLinkError('duplicate_authentication');
            this.authenticated = true; clearTimeout(this.authTimer);
          }
        } else if (!this.authenticated) throw new PeerLinkError('unauthenticated_signal');
        else if (message.type === 'peer') {
          if (!message.connected && this.peer) throw new PeerLinkError('peer_disconnected');
          if (message.connected && room.role === 'host' && !this.peer) {
            this.createPeer(message.generation + 1);
            void this.peer!.start().catch(() => this.fail('negotiation'));
          }
        } else if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice') {
          if (message.type === 'offer' && room.role === 'guest' && !this.peer) this.createPeer(message.generation);
          if (!this.peer) throw new PeerLinkError('early_signal');
          void this.peer.receiveSignal(message).catch(() => this.fail('negotiation'));
        } else if (message.type === 'closed') this.fail(message.reason);
        else this.fail(message.code);
      } catch (error) { this.fail(error instanceof PeerLinkError || error instanceof RtcError ? error.code : 'invalid_signal'); }
    };
  }
  private signal(value: unknown) {
    if (this.disposed || this.socket.readyState !== WebSocket.OPEN) throw new PeerLinkError('signaling');
    const text = JSON.stringify(value);
    if (byteLength(text) > MAX_WIRE_BYTES || this.socket.bufferedAmount + byteLength(text) > 64 * 1024) throw new PeerLinkError('signaling_capacity');
    this.socket.send(text);
  }
  private createPeer(generation: number) {
    this.connecting = true;
    this.epoch = generation - 1;
    this.peer = new RtcPeer({ role: this.options.member.room.role, sessionId: this.options.member.room.roomId,
      epoch: this.epoch, generation, compatibility: this.options.compatibility, aspect: this.options.aspect,
      iceServers: this.options.iceServers, relayOnly: this.options.relayOnly, signal: value => this.signal(value) });
  }
  get status(): 'signaling' | 'waiting' | 'connecting' | 'open' | 'closed' {
    if (this.disposed) return 'closed';
    if (this.peer?.status === 'open') return 'open';
    return this.connecting ? 'connecting' : this.authenticated ? 'waiting' : 'signaling';
  }
  get failure(): string | null { return this.failureValue; }
  send(body: MessageBody): SendResult {
    if (this.status !== 'open' || !this.peer) return { ok: false, reason: 'not_open' };
    const message: WireMessage = { version: PROTOCOL_VERSION, sessionId: this.options.member.room.roomId,
      epoch: this.epoch, sender: this.options.member.room.role, sequence: this.sequence, ...body };
    const result = this.peer.send(message);
    if (result.ok) this.sequence++;
    return result;
  }
  drain(): TransportEvent[] {
    const events = this.peer?.drain() ?? [];
    for (const event of events) {
      if (event.type === 'failed' || event.type === 'rejected') this.fail(event.code);
      else if (event.type === 'status' && event.status === 'closed' && !this.disposed) this.fail('connection_closed');
    }
    return events;
  }
  async diagnostics() { return { status: this.status, failure: this.failureValue, peer: await this.peer?.diagnostics() ?? null }; }
  private fail(code: string) { if (!this.disposed) { this.failureValue = code; this.close(); } }
  close() {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.authTimer); this.peer?.close();
    this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
    this.socket.close();
  }
}
