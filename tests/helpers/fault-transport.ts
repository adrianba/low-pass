import { byteLength, decodeMessage, encodeMessage, ProtocolError } from '../../shared/protocol/codec.js';
import type { Channel, Role } from '../../shared/protocol/limits.js';
import { MAX_WIRE_BYTES } from '../../shared/protocol/limits.js';
import type { WireMessage } from '../../shared/protocol/messages.js';
import { messageChannel } from '../../shared/protocol/messages.js';
import type { PeerTransport, SendResult, TransportEvent, TransportStatus } from '../../src/network/transport.js';

export interface Faults { latencyMs: number; jitterMs: number; loss: number; duplicate: number; retryMs: number }
export interface ClockSkew { offsetMs: number; driftPpm: number }
export interface HarnessOptions {
  seed: number; sessionId: string; epoch: number; maxPackets: number; maxBufferedBytes: number; maxInbox: number;
  clocks?: Partial<Record<Role, ClockSkew>>;
}
interface Packet {
  id: number; from: Role; channel: Channel; text: string; bytes: number; due: number;
  outcome?: 'lost' | 'single' | 'duplicate';
}
const other = (role: Role): Role => role === 'host' ? 'guest' : 'host';
const clearLink = (): Faults => ({ latencyMs: 0, jitterMs: 0, loss: 0, duplicate: 0, retryMs: 100 });
export class HarnessError extends Error {}

export class FaultNetwork {
  private clock = 0;
  private randomState: number;
  private nextId = 0;
  private readonly packets: Packet[] = [];
  private faults: Record<Channel, Faults> = { control: clearLink(), state: clearLink() };
  private partitioned = false;
  readonly peers: Readonly<Record<Role, FaultEndpoint>>;
  readonly options: Readonly<HarnessOptions>;
  readonly stats = { lost: 0, retried: 0, delivered: 0, duplicated: 0 };
  constructor(options: HarnessOptions) {
    if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff ||
      !Number.isSafeInteger(options.epoch) || options.epoch < 0 ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.sessionId) ||
      !Number.isInteger(options.maxPackets) || options.maxPackets < 1 || options.maxPackets > 4096 ||
      !Number.isInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1 || options.maxBufferedBytes > 4 * 1024 * 1024 ||
      !Number.isInteger(options.maxInbox) || options.maxInbox < 2 || options.maxInbox > 4096) throw new HarnessError('Invalid harness bounds.');
    for (const clock of Object.values(options.clocks ?? {})) {
      if (!Number.isFinite(clock.offsetMs) || Math.abs(clock.offsetMs) > 1e9 ||
        !Number.isFinite(clock.driftPpm) || Math.abs(clock.driftPpm) > 100_000) throw new HarnessError('Invalid fake clock.');
    }
    this.options = structuredClone(options); this.randomState = options.seed;
    this.peers = Object.freeze({ host: new FaultEndpoint(this, 'host', options.epoch), guest: new FaultEndpoint(this, 'guest', options.epoch) });
  }
  get time(): number { return this.clock; }
  get pendingPackets(): number { return this.packets.length; }
  queued(role: Role, channel?: Channel): number {
    return this.packets.filter(p => p.from === role && (!channel || p.channel === channel)).reduce((sum, p) => sum + p.bytes, 0);
  }
  private random(): number {
    let n = this.randomState = (this.randomState + 0x6d2b79f5) >>> 0;
    n = Math.imul(n ^ n >>> 15, n | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  }
  setFaults(channel: Channel, patch: Partial<Faults>): void {
    const value = { ...this.faults[channel], ...patch };
    if (![value.latencyMs, value.jitterMs, value.loss, value.duplicate, value.retryMs].every(Number.isFinite) ||
      value.latencyMs < 0 || value.latencyMs > 60_000 || value.jitterMs < 0 || value.jitterMs > 60_000 ||
      value.loss < 0 || value.loss > 1 || value.duplicate < 0 || value.duplicate > 1 ||
      value.retryMs < 1 || value.retryMs > 60_000) throw new HarnessError('Invalid fault profile.');
    this.faults[channel] = value;
  }
  partition(value: boolean): void { this.partitioned = value; }
  enqueue(from: Role, channel: Channel, text: string): SendResult {
    if (this.peers[from].status !== 'open' || this.peers[other(from)].status !== 'open') return { ok: false, reason: 'not_open' };
    const bytes = byteLength(text);
    if (bytes > MAX_WIRE_BYTES * 2) throw new HarnessError('Raw injection exceeds its bounded test budget.');
    if (this.packets.length >= this.options.maxPackets || this.queued(from) + bytes > this.options.maxBufferedBytes) {
      return { ok: false, reason: 'backpressure' };
    }
    const faults = this.faults[channel];
    const delay = Math.max(0, faults.latencyMs + (this.random() * 2 - 1) * faults.jitterMs);
    this.packets.push({ id: this.nextId++, from, channel, text, bytes, due: this.clock + delay });
    return { ok: true };
  }
  advanceTo(time: number): void {
    if (!Number.isFinite(time) || time < this.clock || time - this.clock > 60_000 || time > 1e12) throw new HarnessError('Invalid fake time advance.');
    let work = 0;
    while (true) {
      // Reliable control has per-sender head-of-line blocking; state is unordered.
      const controls = new Set<Role>();
      let packet: Packet | undefined;
      for (const candidate of this.packets) {
        if (candidate.channel === 'control') {
          if (controls.has(candidate.from)) continue;
          controls.add(candidate.from);
        }
        if (!packet || candidate.due < packet.due || (candidate.due === packet.due && candidate.id < packet.id)) packet = candidate;
      }
      if (!packet || packet.due > time) break;
      if (++work > 100_000) throw new HarnessError('Fake transport work budget exceeded.');
      const destination = this.peers[other(packet.from)], faults = this.faults[packet.channel];
      packet.outcome ??= this.partitioned || this.random() < faults.loss ? 'lost' :
        this.random() < faults.duplicate ? 'duplicate' : 'single';
      if (packet.outcome !== 'lost' && !destination.hasRoom(packet.outcome === 'duplicate' ? 2 : 1)) {
        throw new HarnessError('Drain the bounded transport inbox before advancing.');
      }
      this.clock = Math.max(this.clock, packet.due);
      if (packet.outcome === 'lost') {
        this.stats.lost++;
        if (packet.channel === 'control') {
          packet.due = this.clock + faults.retryMs; this.stats.retried++; delete packet.outcome;
          continue;
        }
      } else {
        destination.receive(packet.channel, packet.text); this.stats.delivered++;
        // Explicit application replay, not a claim that SCTP delivers duplicate frames.
        if (packet.outcome === 'duplicate') {
          destination.receive(packet.channel, packet.text); this.stats.duplicated++;
        }
      }
      this.packets.splice(this.packets.indexOf(packet), 1);
    }
    this.clock = time;
  }
  disconnect(): void {
    this.packets.length = 0;
    for (const endpoint of Object.values(this.peers)) if (endpoint.status !== 'closed') endpoint.transition('disconnected');
  }
  reconnect(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch <= Math.max(this.peers.host.epoch, this.peers.guest.epoch)) throw new HarnessError('Reconnect requires a new epoch.');
    if (Object.values(this.peers).some(p => p.status === 'closed')) throw new HarnessError('Closed transports cannot reopen.');
    this.packets.length = 0;
    for (const endpoint of Object.values(this.peers)) endpoint.transition('open', epoch);
  }
  close(): void {
    this.packets.length = 0;
    for (const endpoint of Object.values(this.peers)) endpoint.transition('closed');
  }
}

class FaultEndpoint implements PeerTransport {
  private inbox: TransportEvent[] = [];
  private state: TransportStatus = 'open';
  constructor(private readonly network: FaultNetwork, readonly role: Role, public epoch: number) {}
  get status(): TransportStatus { return this.state; }
  now(): number {
    const skew = this.network.options.clocks?.[this.role];
    return this.network.time * (1 + (skew?.driftPpm ?? 0) / 1e6) + (skew?.offsetMs ?? 0);
  }
  bufferedAmount(channel: Channel): number { return this.network.queued(this.role, channel); }
  send(message: WireMessage): SendResult {
    if (this.status !== 'open') return { ok: false, reason: 'not_open' };
    if (message.sender !== this.role) throw new ProtocolError('role');
    const text = encodeMessage(message), channel = messageChannel(message);
    decodeMessage(text, { sessionId: this.network.options.sessionId, epoch: this.epoch, peer: this.role, channel });
    return this.network.enqueue(this.role, channel, text);
  }
  hasRoom(count: number): boolean { return this.inbox.length + count <= this.network.options.maxInbox; }
  receive(channel: Channel, text: string): void {
    try {
      const message = decodeMessage(text, { sessionId: this.network.options.sessionId, epoch: this.epoch, peer: other(this.role), channel });
      this.inbox.push({ type: 'message', channel, message, receivedAt: this.now() });
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.inbox.push({ type: 'rejected', channel, code: error.code });
    }
  }
  drain(): TransportEvent[] { const events = this.inbox; this.inbox = []; return events; }
  transition(status: TransportStatus, epoch = this.epoch): void {
    this.state = status; this.epoch = epoch;
    this.inbox = [{ type: 'status', status, epoch }];
  }
  close(): void { this.network.close(); }
}
