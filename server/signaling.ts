import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { clientSignal, serverSignal } from '../shared/protocol/signaling.js';
import type { ServerSignal } from '../shared/protocol/signaling.js';
import { MAX_WIRE_BYTES, PROTOCOL_VERSION } from '../shared/protocol/limits.js';
import { hashSecret, RoomError } from './room-store.js';
import type { Membership, RoomNotice } from './room-store.js';
import type { RoomApi } from './room-api.js';

export const SIGNAL_LIMITS = Object.freeze({
  connections: 48, pending: 16, bufferedBytes: 64 * 1024, candidates: 128,
  authMs: 5000, heartbeatMs: 5000, recoveryMs: 15_000, closeMs: 1000,
});
type ErrorCode = Extract<ServerSignal, { type: 'error' }>['code'];
interface Peer {
  ws: WebSocket; source: string; member: Membership | null; digest: string | null;
  authUntil: number; alive: boolean; closeUntil: number | null;
}
interface Negotiation { generation: number; state: 'idle' | 'offered' | 'answered'; hostIce: number; guestIce: number }

export class SignalingService {
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_WIRE_BYTES });
  private readonly peers = new Set<Peer>();
  private readonly members = new Map<string, Peer>();
  private readonly leases = new Map<string, { roomId: string; until: number }>();
  private readonly negotiations = new Map<string, Negotiation>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private stopped = false;
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPing: number;
  private lastTime = -Infinity;
  constructor(private readonly server: Server, private readonly rooms: RoomApi, private readonly warn: (message: string) => void,
    private readonly clock: () => number = () => performance.now()) {
    this.lastPing = this.now();
    server.on('upgrade', this.upgrade);
    this.unsubscribe = rooms.store.subscribe(notice => this.notice(notice));
    this.wss.on('error', () => { this.warn('Signaling service failed; signaling disabled until restart.'); this.close(); });
    this.timer = setInterval(() => {
      try { this.tick(); }
      catch { this.warn('Signaling maintenance failed; signaling disabled until restart.'); this.close(); }
    }, 1000);
    this.timer.unref();
  }
  get available(): boolean { return !this.stopped && this.rooms.available; }
  get counts() { return { sockets: this.peers.size, authenticated: this.members.size, leases: this.leases.size, negotiations: this.negotiations.size }; }
  private now(): number {
    const time = this.clock();
    if (!Number.isFinite(time) || time < this.lastTime) throw new Error('Signaling clock must be monotonic.');
    this.lastTime = time; return time;
  }
  private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let source: string;
    try {
      if (request.url !== '/signal' || request.method !== 'GET') throw new RoomError('invalid_upgrade', 400);
      if (!this.available) throw new RoomError('unavailable', 503);
      if (this.peers.size >= SIGNAL_LIMITS.connections ||
        [...this.peers].filter(p => !p.member).length >= SIGNAL_LIMITS.pending) throw new RoomError('capacity', 503);
      source = this.rooms.signalingSource(request);
    } catch (error) {
      if (!(error instanceof RoomError)) {
        this.warn('Signaling upgrade failed; signaling disabled until restart.'); this.close();
      }
      const deadline = setTimeout(() => socket.destroy(), SIGNAL_LIMITS.closeMs);
      deadline.unref(); socket.once('close', () => clearTimeout(deadline));
      socket.end(`HTTP/1.1 ${error instanceof RoomError ? error.status : 503} Rejected\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`,
        () => socket.destroy());
      return;
    }
    this.wss.handleUpgrade(request, socket, head, ws => {
      const peer: Peer = { ws, source, member: null, digest: null, authUntil: this.now() + SIGNAL_LIMITS.authMs, alive: true, closeUntil: null };
      this.peers.add(peer);
      ws.on('pong', () => { peer.alive = true; });
      ws.on('message', (data, binary) => this.message(peer, data, binary));
      ws.once('close', () => this.cleanup(peer));
      ws.on('error', () => { this.warn('Signaling connection failed.'); ws.terminate(); });
    });
  };
  private send(peer: Peer, value: ServerSignal): boolean {
    if (peer.ws.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify(serverSignal.parse(value));
    if (Buffer.byteLength(text) > MAX_WIRE_BYTES || peer.ws.bufferedAmount + Buffer.byteLength(text) > SIGNAL_LIMITS.bufferedBytes) {
      this.end(peer, 1009, 'backpressure'); return false;
    }
    peer.ws.send(text, error => {
      if (error) { this.warn('Signaling write failed.'); peer.ws.terminate(); }
    });
    return true;
  }
  private end(peer: Peer, code: number, reason: string): void {
    if (peer.closeUntil !== null) return;
    peer.closeUntil = this.now() + SIGNAL_LIMITS.closeMs;
    peer.ws.close(code, reason);
  }
  private reject(peer: Peer, code: ErrorCode, close = true): void {
    this.send(peer, { type: 'error', code });
    if (close) this.end(peer, 1008, code);
  }
  private message(peer: Peer, data: RawData, binary: boolean): void {
    if (!this.available || peer.closeUntil !== null || peer.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.expireLeases();
      this.rooms.signalingMessage(peer.source, peer.member ?? undefined);
      if (binary) { this.reject(peer, 'invalid_message'); return; }
      if (Buffer.byteLength(data.toString()) > MAX_WIRE_BYTES - 128) { this.reject(peer, 'invalid_message'); return; }
      let value: unknown;
      try { value = JSON.parse(data.toString()); } catch { this.reject(peer, 'invalid_message'); return; }
      const parsed = clientSignal.safeParse(value);
      if (!parsed.success) { this.reject(peer, 'invalid_message'); return; }
      const message = parsed.data;
      if (!peer.member) {
        if (this.now() >= peer.authUntil) { this.reject(peer, 'auth_timeout'); return; }
        if (message.type !== 'auth') { this.reject(peer, 'unauthorized'); return; }
        const digest = hashSecret(message.capability), member = this.rooms.store.authenticateDigest(digest);
        if (this.members.has(digest)) { this.reject(peer, 'already_connected'); return; }
        peer.member = member; peer.digest = digest;
        this.members.set(digest, peer); this.leases.delete(digest);
        if (!this.negotiations.has(member.roomId)) this.negotiations.set(member.roomId, { generation: 0, state: 'idle', hostIce: 0, guestIce: 0 });
        this.send(peer, { type: 'authenticated', version: PROTOCOL_VERSION, room: this.rooms.store.statusDigest(digest) });
        this.presence(member.roomId); return;
      }
      if (message.type === 'auth' || !peer.digest || this.members.get(peer.digest) !== peer) { this.reject(peer, 'unauthorized'); return; }
      const member = this.rooms.store.authenticateDigest(peer.digest);
      if (!member.admitted) { this.reject(peer, 'not_admitted', false); return; }
      const other = [...this.members.values()].find(p => p !== peer && p.member?.roomId === member.roomId && p.closeUntil === null);
      if (!other) { this.reject(peer, 'peer_unavailable', false); return; }
      const negotiation = this.negotiations.get(member.roomId)!;
      if (message.type === 'offer') {
        if (member.role !== 'host') { this.reject(peer, 'role'); return; }
        if (message.generation !== negotiation.generation + 1 || negotiation.state === 'offered') {
          this.reject(peer, 'generation', false); return;
        }
        negotiation.generation = message.generation; negotiation.state = 'offered'; negotiation.hostIce = negotiation.guestIce = 0;
        if (!this.send(other, { ...message, from: 'host' })) {
          negotiation.state = 'idle'; this.reject(peer, 'peer_unavailable', false);
        }
      } else if (message.type === 'answer') {
        if (member.role !== 'guest') { this.reject(peer, 'role'); return; }
        if (message.generation !== negotiation.generation || negotiation.state !== 'offered') { this.reject(peer, 'generation', false); return; }
        negotiation.state = 'answered';
        if (!this.send(other, { ...message, from: 'guest' })) {
          negotiation.state = 'idle'; this.reject(peer, 'peer_unavailable', false);
        }
      } else {
        if (message.generation !== negotiation.generation || negotiation.state === 'idle') { this.reject(peer, 'generation', false); return; }
        const key = member.role === 'host' ? 'hostIce' : 'guestIce';
        if (++negotiation[key] > SIGNAL_LIMITS.candidates) { this.reject(peer, 'capacity'); return; }
        if (!this.send(other, { ...message, from: member.role })) this.reject(peer, 'peer_unavailable', false);
      }
    } catch (error) {
      if (!(error instanceof RoomError)) {
        this.warn('Signaling message handling failed.'); this.reject(peer, 'invalid_message'); return;
      }
      this.reject(peer, error.status === 429 ? 'rate_limited' : error.status === 503 ? 'capacity' : 'unauthorized');
    }
  }
  private presence(roomId: string): void {
    const peers = [...this.members.values()].filter(p => p.member?.roomId === roomId && p.closeUntil === null);
    const generation = this.negotiations.get(roomId)?.generation ?? 0;
    for (const peer of peers) this.send(peer, { type: 'peer', connected: peers.length === 2, generation });
  }
  private notice(notice: RoomNotice): void {
    for (const [digest, lease] of this.leases) {
      if (lease.roomId === notice.roomId && !this.rooms.store.hasDigest(digest)) this.leases.delete(digest);
    }
    if (notice.kind === 'closed') {
      this.negotiations.delete(notice.roomId);
      for (const [digest, lease] of this.leases) if (lease.roomId === notice.roomId) this.leases.delete(digest);
    }
    for (const peer of this.peers) if (peer.member?.roomId === notice.roomId && peer.digest) {
      const view = this.rooms.store.peekDigest(peer.digest);
      if (notice.kind === 'closed' || !view) {
        const reason = notice.reason === 'recovery_expired' ? 'recovery_expired' : 'room_closed';
        this.send(peer, { type: 'closed', reason }); this.end(peer, 1000, reason);
      } else this.send(peer, { type: 'room', room: view });
    }
  }
  private cleanup(peer: Peer): void {
    this.peers.delete(peer);
    if (this.stopped && this.peers.size === 0 && this.shutdownTimer) clearTimeout(this.shutdownTimer);
    if (!peer.digest || this.members.get(peer.digest) !== peer || !peer.member) return;
    this.members.delete(peer.digest);
    if (!this.stopped && this.rooms.store.hasDigest(peer.digest)) {
      this.leases.set(peer.digest, { roomId: peer.member.roomId, until: this.now() + SIGNAL_LIMITS.recoveryMs });
      const negotiation = this.negotiations.get(peer.member.roomId);
      if (negotiation?.state === 'offered') negotiation.state = 'idle';
    }
    this.presence(peer.member.roomId);
  }
  private expireLeases(): void {
    const now = this.now();
    for (const [digest, lease] of this.leases) if (now >= lease.until) {
      this.leases.delete(digest);
      if (this.rooms.store.hasDigest(digest)) {
        try { this.rooms.store.leaveDigest(digest, 'recovery_expired'); }
        catch (error) {
          if (!(error instanceof RoomError) || error.status !== 401 || this.rooms.store.hasDigest(digest)) throw error;
        }
      }
    }
  }
  tick(): void {
    if (this.stopped) return;
    if (!this.rooms.available) { this.close(); return; }
    const now = this.now();
    this.expireLeases();
    for (const peer of this.peers) {
      if (peer.closeUntil !== null) { if (now >= peer.closeUntil) peer.ws.terminate(); continue; }
      if (peer.ws.readyState !== WebSocket.OPEN) { this.end(peer, 1000, 'connection_closed'); continue; }
      if (!peer.member && now >= peer.authUntil) { this.reject(peer, 'auth_timeout'); continue; }
      if (peer.member && now - this.lastPing >= SIGNAL_LIMITS.heartbeatMs) {
        if (!peer.alive) { this.reject(peer, 'heartbeat_timeout'); continue; }
        if (peer.digest) {
          try { this.rooms.store.authenticateDigest(peer.digest); }
          catch (error) {
            if (!(error instanceof RoomError) || error.status !== 401 || this.rooms.store.hasDigest(peer.digest)) throw error;
            continue;
          }
        }
        peer.alive = false; peer.ws.ping();
      }
    }
    if (now - this.lastPing >= SIGNAL_LIMITS.heartbeatMs) this.lastPing = now;
  }
  close(): void {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer); this.unsubscribe();
    this.server.removeListener('upgrade', this.upgrade); this.leases.clear(); this.negotiations.clear();
    for (const peer of this.peers) {
      this.send(peer, { type: 'closed', reason: 'service_stopped' });
      this.end(peer, 1001, 'service_stopped');
    }
    this.shutdownTimer = setTimeout(() => { for (const peer of this.peers) peer.ws.terminate(); }, SIGNAL_LIMITS.closeMs);
    this.shutdownTimer.unref();
    this.wss.close();
  }
}
