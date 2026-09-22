import { assertCompatible, byteLength, decodeMessage, decodeTransportMessage, encodeMessage, ProtocolError } from '../../shared/protocol/codec.js';
import { compatibility, counter, identifier } from '../../shared/protocol/game.js';
import type { Compatibility } from '../../shared/protocol/game.js';
import { MAX_WIRE_BYTES, PROTOCOL_VERSION } from '../../shared/protocol/limits.js';
import type { Channel, Role } from '../../shared/protocol/limits.js';
import { messageChannel } from '../../shared/protocol/messages.js';
import type { WireMessage } from '../../shared/protocol/messages.js';
import { clientSignal, serverSignal } from '../../shared/protocol/signaling.js';
import type { ClientSignal, ServerSignal } from '../../shared/protocol/signaling.js';
import type { PeerTransport, SendResult, TransportEvent, TransportFailure, TransportStatus } from './transport.js';
import { BytePacer } from './byte-pacer.js';

export type OutgoingSignal = Exclude<ClientSignal, { type: 'auth' }>;
export type PeerSignal = Extract<ServerSignal, { type: 'offer' | 'answer' | 'ice' }>;
export type RtcFailure = TransportFailure;
export class RtcError extends Error {
  constructor(readonly code: RtcFailure) { super(`Peer connection failed: ${code}.`); }
}
export const RTC_LIMITS = Object.freeze({ bufferedBytes: 64 * 1024, bulkBytes: 32 * 1024, lowBytes: 16 * 1024,
  bulkBytesPerSecond: 160 * 1024, bulkBurstBytes: MAX_WIRE_BYTES, inbox: 128, candidates: 128, queuedSignals: 130 });
export interface RtcOptions {
  role: Role; sessionId: string; epoch: number; generation: number; compatibility: Compatibility; aspect: number;
  iceServers: RTCIceServer[]; signal: (message: OutgoingSignal) => void;
  relayOnly?: boolean; timeoutMs?: number; clock?: () => number; writable?: () => void;
}
interface CandidateSummary { local: string | null; remote: string | null; protocol: string | null; relayProtocol: string | null; rttMs: number | null }
function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}
function category(value: unknown, allowed: string[]): string | null { return typeof value === 'string' && allowed.includes(value) ? value : null; }

/** One authenticated negotiation generation; host barriers advance game epochs without renegotiation. */
export class RtcPeer implements PeerTransport {
  readonly role: Role;
  private readonly pc: RTCPeerConnection;
  private readonly options: RtcOptions;
  private readonly channels: Partial<Record<Channel, RTCDataChannel>> = {};
  private readonly bulkPacer = new BytePacer(RTC_LIMITS.bulkBytesPerSecond, RTC_LIMITS.bulkBurstBytes);
  private pacingTimer: ReturnType<typeof setTimeout> | null = null;
  private state: TransportStatus = 'disconnected';
  private failureValue: RtcFailure | ProtocolError['code'] | null = null;
  private disposed = false;
  private started = false;
  private sentDescription = false;
  private remoteDescription = false;
  private sentHello = false;
  private receivedHello = false;
  private localCandidates: OutgoingSignal[] = [];
  private remoteCandidates: Array<RTCIceCandidateInit | null> = [];
  private localCount = 0;
  private remoteCount = 0;
  private candidateFailures = 0;
  private readonly candidateErrorCodes = new Set<number>();
  private readonly gatheredTypes = new Set<string>();
  private stoppedAt: ReturnType<RtcPeer['linkState']> | null = null;
  private queued = 0;
  private work: Promise<void> = Promise.resolve();
  private inbox: TransportEvent[] = [];
  private pending: TransportEvent[] = [];
  private currentEpoch: number;
  private readonly futureState = new Map<'snapshot' | 'ping' | 'pong', Extract<TransportEvent, { type: 'message' }>>();
  private discardedEpochMessages = 0;
  private readonly timeout: ReturnType<typeof setTimeout>;
  constructor(options: RtcOptions) {
    identifier.parse(options.sessionId); counter.parse(options.epoch); compatibility.parse(options.compatibility);
    if (!['host', 'guest'].includes(options.role) || !Number.isInteger(options.generation) || options.generation < 1 ||
      options.generation > 1_000_000 || !Number.isFinite(options.aspect) || options.aspect < 0.75 || options.aspect > 2 ||
      !Number.isInteger(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) < 1000 ||
      (options.timeoutMs ?? 30_000) > 30_000) throw new RtcError('negotiation');
    this.options = { ...options, compatibility: { ...options.compatibility }, iceServers: structuredClone(options.iceServers) };
    this.currentEpoch = options.epoch;
    this.role = options.role;
    try { this.pc = new RTCPeerConnection({ iceServers: this.options.iceServers, iceTransportPolicy: options.relayOnly ? 'relay' : 'all' }); }
    catch { throw new RtcError('negotiation'); }
    this.timeout = setTimeout(() => this.fail('timeout'), options.timeoutMs ?? 30_000);
    this.pc.onicecandidate = event => {
      if (this.disposed || !event.candidate) return;
      if (++this.localCount > RTC_LIMITS.candidates) { this.fail('capacity'); return; }
      const kind = category(event.candidate.type, ['host', 'srflx', 'prflx', 'relay']);
      if (kind) this.gatheredTypes.add(kind);
      const value = event.candidate.toJSON();
      const message: OutgoingSignal = { type: 'ice', generation: this.options.generation,
        candidate: { candidate: value.candidate ?? '', sdpMid: value.sdpMid ?? null,
          sdpMLineIndex: value.sdpMLineIndex ?? null, usernameFragment: value.usernameFragment ?? null } };
      if (this.sentDescription) this.signal(message);
      else this.localCandidates.push(message);
    };
    this.pc.onicecandidateerror = event => {
      this.candidateFailures = Math.min(1024, this.candidateFailures + 1);
      if (this.candidateErrorCodes.size < 16 && Number.isInteger(event.errorCode) && event.errorCode >= 0 && event.errorCode <= 65535) {
        this.candidateErrorCodes.add(event.errorCode);
      }
    };
    this.pc.onconnectionstatechange = () => {
      if (!this.disposed && ['failed', 'disconnected', 'closed'].includes(this.pc.connectionState)) this.fail('connection');
    };
    this.pc.ondatachannel = event => {
      if (this.role !== 'guest') { event.channel.close(); this.fail('channel'); return; }
      this.attach(event.channel);
    };
    if (this.role === 'host') {
      try {
        this.attach(this.pc.createDataChannel('control', { ordered: true, protocol: 'low-pass.v1' }));
        this.attach(this.pc.createDataChannel('state', { ordered: false, maxRetransmits: 0, protocol: 'low-pass.v1' }));
      } catch { this.dispose(); throw new RtcError('channel'); }
    }
  }
  get status(): TransportStatus { return this.state; }
  get epoch(): number { return this.currentEpoch; }
  get failure(): RtcFailure | ProtocolError['code'] | null { return this.failureValue; }
  now(): number { return this.options.clock?.() ?? performance.now(); }
  bufferedAmount(channel: Channel): number { return this.channels[channel]?.bufferedAmount ?? 0; }
  private signal(value: OutgoingSignal): boolean {
    if (this.disposed) return false;
    try {
      const message = clientSignal.parse(value);
      if (byteLength(JSON.stringify(message)) > MAX_WIRE_BYTES - 128 || message.type === 'auth') throw new RtcError('signaling');
      this.options.signal(message);
      return true;
    } catch { this.fail('signaling'); return false; }
  }
  async start(): Promise<void> {
    if (this.disposed || this.started || this.role !== 'host') throw new RtcError('negotiation');
    this.started = true;
    try {
      const offer = await this.pc.createOffer();
      if (this.disposed) throw new RtcError('connection');
      await this.pc.setLocalDescription(offer);
      if (this.disposed) throw new RtcError('connection');
      if (!this.signal({ type: 'offer', generation: this.options.generation, sdp: this.pc.localDescription!.sdp })) throw new RtcError('signaling');
      this.flushLocal();
    } catch (error) { this.operationFailed(error, 'negotiation'); }
  }
  receiveSignal(value: PeerSignal): Promise<void> {
    if (this.disposed) return Promise.reject(new RtcError('connection'));
    const parsed = serverSignal.safeParse(value);
    if (!parsed.success || !['offer', 'answer', 'ice'].includes(parsed.data.type) ||
      value.generation !== this.options.generation || value.from === this.role ||
      byteLength(JSON.stringify(value)) > MAX_WIRE_BYTES) return Promise.reject(new RtcError('signaling'));
    if (++this.queued > RTC_LIMITS.queuedSignals) { this.queued--; this.fail('capacity'); return Promise.reject(new RtcError('capacity')); }
    const owned = structuredClone(value);
    const result = this.work.then(async () => {
      if (this.disposed) throw new RtcError('connection');
      try { await this.applySignal(owned); }
      catch (error) { this.operationFailed(error, owned.type === 'ice' ? 'candidate' : 'negotiation'); }
    }).finally(() => { this.queued--; });
    this.work = result.catch(() => { /* Failure is returned to the caller; keep the bounded queue drainable. */ });
    return result;
  }
  private operationFailed(error: unknown, fallback: RtcFailure): never {
    const code = error instanceof RtcError ? error.code : this.disposed ? 'connection' : fallback;
    this.fail(code); throw new RtcError(code);
  }
  private async applySignal(value: PeerSignal): Promise<void> {
    if (value.type === 'ice') {
      if (++this.remoteCount > RTC_LIMITS.candidates) throw new RtcError('capacity');
      if (this.remoteDescription) await this.pc.addIceCandidate(value.candidate ?? undefined);
      else this.remoteCandidates.push(value.candidate);
      return;
    }
    if (this.remoteDescription || (value.type === 'offer' ? this.role !== 'guest' : this.role !== 'host' || !this.started)) {
      throw new RtcError('negotiation');
    }
    await this.pc.setRemoteDescription({ type: value.type, sdp: value.sdp });
    if (this.disposed) throw new RtcError('connection');
    this.remoteDescription = true;
    for (const candidate of this.remoteCandidates.splice(0)) {
      if (this.disposed) throw new RtcError('connection');
      await this.pc.addIceCandidate(candidate ?? undefined);
    }
    if (value.type === 'offer' && !this.disposed) {
      const answer = await this.pc.createAnswer();
      if (this.disposed) throw new RtcError('connection');
      await this.pc.setLocalDescription(answer);
      if (this.disposed) throw new RtcError('connection');
      if (!this.signal({ type: 'answer', generation: this.options.generation, sdp: this.pc.localDescription!.sdp })) throw new RtcError('signaling');
      this.flushLocal();
    }
  }
  private flushLocal(): void {
    this.sentDescription = true;
    for (const message of this.localCandidates.splice(0)) if (!this.signal(message)) throw new RtcError('signaling');
  }
  private attach(channel: RTCDataChannel): void {
    const label = channel.label;
    if (this.disposed || (label !== 'control' && label !== 'state') || this.channels[label] ||
      channel.protocol !== 'low-pass.v1' || channel.negotiated || channel.maxPacketLifeTime !== null ||
      (label === 'control' ? !channel.ordered || channel.maxRetransmits !== null : channel.ordered || channel.maxRetransmits !== 0)) {
      channel.close(); this.fail('channel'); return;
    }
    this.channels[label] = channel; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = RTC_LIMITS.lowBytes;
    channel.onopen = () => this.opened();
    channel.onmessage = event => this.receive(label, event.data);
    channel.onbufferedamountlow = () => { if (!this.disposed) this.options.writable?.(); };
    channel.onerror = () => this.fail('channel');
    channel.onclose = () => { if (!this.disposed) this.fail('channel'); };
    if (channel.readyState === 'open') this.opened();
  }
  private opened(): void {
    if (this.disposed) return;
    if (this.channels.control?.readyState === 'open' && !this.sentHello) {
      this.sentHello = true;
      const hello: WireMessage = { type: 'hello', version: PROTOCOL_VERSION, sessionId: this.options.sessionId,
        epoch: this.options.epoch, sender: this.role, sequence: 0, compatibility: this.options.compatibility, viewport: { aspect: this.options.aspect } };
      try { this.channels.control.send(encodeMessage(hello)); } catch { this.fail('channel'); return; }
    }
    if (!this.receivedHello || this.channels.control?.readyState !== 'open' || this.channels.state?.readyState !== 'open' || this.state === 'open') return;
    const maximum = this.pc.sctp?.maxMessageSize;
    if (maximum !== undefined && maximum !== 0 && maximum < MAX_WIRE_BYTES) { this.fail('capacity'); return; }
    clearTimeout(this.timeout); this.state = 'open';
    this.enqueue({ type: 'status', status: 'open', epoch: this.currentEpoch });
    for (const event of this.pending.splice(0)) this.enqueue(event);
  }
  private receive(channel: Channel, data: unknown): void {
    if (this.disposed) return;
    try {
      if (typeof data !== 'string') throw new ProtocolError('invalid_message');
      const message = decodeTransportMessage(data, { channel, sessionId: this.options.sessionId, epoch: this.currentEpoch,
        peer: this.role === 'host' ? 'guest' : 'host' });
      if (message.epoch < this.currentEpoch) {
        this.discardedEpochMessages = Math.min(Number.MAX_SAFE_INTEGER, this.discardedEpochMessages + 1);
        return;
      }
      const event: Extract<TransportEvent, { type: 'message' }> = { type: 'message', channel, message, receivedAt: this.now() };
      if (message.epoch > this.currentEpoch) {
        if (message.type !== 'snapshot' && message.type !== 'ping' && message.type !== 'pong') throw new ProtocolError('epoch');
        const previous = this.futureState.get(message.type);
        if (!previous || previous.message.sequence < message.sequence) this.futureState.set(message.type, event);
        return;
      }
      if (message.type === 'hello') {
        if (this.receivedHello || message.sequence !== 0) throw new ProtocolError('invalid_message');
        assertCompatible(this.options.compatibility, message.compatibility); this.receivedHello = true;
      } else if (channel === 'control' && !this.receivedHello) throw new ProtocolError('compatibility');
      this.received(event);
      if (message.type === 'barrier' && !this.disposed) {
        this.currentEpoch = message.nextEpoch;
        const waiting = [...this.futureState.values()].sort((a, b) => a.message.sequence - b.message.sequence);
        this.futureState.clear();
        for (const queued of waiting) this.received(queued);
      }
      this.opened();
    } catch (error) {
      if (!(error instanceof ProtocolError)) { this.fail('channel'); return; }
      const code = error.code;
      this.failureValue = code; this.dispose();
      this.inbox = [{ type: 'rejected', channel, code }, { type: 'status', status: 'closed', epoch: this.currentEpoch }];
    }
  }
  private received(event: TransportEvent): void {
    if (this.disposed) return;
    if (this.state === 'open') this.enqueue(event);
    else if (this.pending.length < RTC_LIMITS.inbox - 1) this.pending.push(event);
    else this.fail('capacity');
  }
  private enqueue(event: TransportEvent): void {
    if (this.inbox.length >= RTC_LIMITS.inbox) { this.fail('capacity'); return; }
    this.inbox.push(event);
  }
  send(message: WireMessage): SendResult {
    if (this.state !== 'open') return { ok: false, reason: 'not_open' };
    if (message.sender !== this.role || message.type === 'hello') throw new ProtocolError('role');
    const text = encodeMessage(message), label = messageChannel(message);
    decodeMessage(text, { channel: label, sessionId: this.options.sessionId, epoch: this.currentEpoch, peer: this.role });
    const channel = this.channels[label]!;
    if (channel.readyState !== 'open') { this.fail('channel'); return { ok: false, reason: 'not_open' }; }
    const limit = message.type === 'transfer-chunk' ? RTC_LIMITS.bulkBytes : RTC_LIMITS.bufferedBytes;
    const bytes = byteLength(text), now = this.now();
    if (channel.bufferedAmount + bytes > limit) return { ok: false, reason: 'backpressure' };
    if (message.type === 'transfer-chunk') {
      const delay = this.bulkPacer.delay(bytes, now);
      if (delay > 0) {
        if (this.options.writable && this.pacingTimer === null) this.pacingTimer = setTimeout(() => {
          this.pacingTimer = null;
          if (!this.disposed) this.options.writable?.();
        }, delay);
        return { ok: false, reason: 'backpressure' };
      }
    }
    try { channel.send(text); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'OperationError') return { ok: false, reason: 'backpressure' };
      this.fail('channel'); return { ok: false, reason: 'not_open' };
    }
    if (message.type === 'transfer-chunk') this.bulkPacer.sent(bytes, now);
    if (message.type === 'barrier') this.currentEpoch = message.nextEpoch;
    return { ok: true };
  }
  drain(): TransportEvent[] { const events = this.inbox; this.inbox = []; return events; }
  private fail(code: RtcFailure): void {
    if (this.disposed) return;
    this.failureValue = code; this.dispose();
    this.inbox = [{ type: 'failed', code }, { type: 'status', status: 'closed', epoch: this.currentEpoch }];
  }
  private dispose(): void {
    this.stoppedAt ??= this.linkState();
    this.disposed = true; this.state = 'closed'; clearTimeout(this.timeout);
    if (this.pacingTimer !== null) { clearTimeout(this.pacingTimer); this.pacingTimer = null; }
    this.pending = []; this.futureState.clear(); this.localCandidates = []; this.remoteCandidates = [];
    this.pc.ondatachannel = this.pc.onicecandidate = this.pc.onconnectionstatechange = null;
    this.pc.onicecandidateerror = null;
    for (const channel of Object.values(this.channels)) {
      channel.onopen = channel.onmessage = channel.onerror = channel.onclose = channel.onbufferedamountlow = null; channel.close();
    }
    this.pc.close();
  }
  close(): void {
    if (this.disposed) return;
    this.dispose(); this.inbox = [{ type: 'status', status: 'closed', epoch: this.currentEpoch }];
  }
  private linkState() {
    return { connection: this.pc.connectionState, ice: this.pc.iceConnectionState,
      control: this.channels.control?.readyState ?? 'missing', state: this.channels.state?.readyState ?? 'missing',
      sentHello: this.sentHello, receivedHello: this.receivedHello, epoch: this.currentEpoch,
      pendingEpochMessages: this.futureState.size, discardedEpochMessages: this.discardedEpochMessages };
  }
  async diagnostics(): Promise<{ status: TransportStatus; failure: RtcPeer['failure']; candidateFailures: number;
    candidateErrorCodes: number[]; gathered: string[]; link: ReturnType<RtcPeer['linkState']>; selected: CandidateSummary | null }> {
    let selected: CandidateSummary | null = null;
    if (!this.disposed) {
      let report: RTCStatsReport;
      try { report = await this.pc.getStats(); }
      catch { if (!this.disposed) throw new RtcError('diagnostics');
        return { status: this.state, failure: this.failureValue, candidateFailures: this.candidateFailures,
          candidateErrorCodes: [...this.candidateErrorCodes], gathered: [...this.gatheredTypes],
          link: this.stoppedAt ?? this.linkState(), selected }; }
      report.forEach((raw: unknown) => {
        const transport = object(raw);
        if (transport?.type !== 'transport' || typeof transport.selectedCandidatePairId !== 'string') return;
        const pair = object(report.get(transport.selectedCandidatePairId));
        if (!pair) return;
        const local = typeof pair.localCandidateId === 'string' ? object(report.get(pair.localCandidateId)) : null;
        const remote = typeof pair.remoteCandidateId === 'string' ? object(report.get(pair.remoteCandidateId)) : null;
        const types = ['host', 'srflx', 'prflx', 'relay'];
        selected = { local: category(local?.candidateType, types), remote: category(remote?.candidateType, types),
          protocol: category(local?.protocol, ['udp', 'tcp']), relayProtocol: category(local?.relayProtocol, ['udp', 'tcp', 'tls']),
          rttMs: typeof pair.currentRoundTripTime === 'number' && Number.isFinite(pair.currentRoundTripTime) && pair.currentRoundTripTime >= 0
            ? pair.currentRoundTripTime * 1000 : null };
      });
    }
    return { status: this.state, failure: this.failureValue, candidateFailures: this.candidateFailures,
      candidateErrorCodes: [...this.candidateErrorCodes], gathered: [...this.gatheredTypes],
      link: this.stoppedAt ?? this.linkState(), selected };
  }
}
