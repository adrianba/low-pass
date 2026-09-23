import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RtcPeer, RTC_LIMITS } from '../../src/network/rtc-peer.js';
import { decodeMessage, encodeMessage } from '../../shared/protocol/codec.js';
import { base, hello, release, snapshot, versions } from './protocol-fixtures.js';
import type { RtcOptions } from '../../src/network/rtc-peer.js';

class Channel {
  readyState = 'connecting'; bufferedAmount = 0; binaryType = ''; bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null; onbufferedamountlow: (() => void) | null = null;
  readonly sent: string[] = [];
  readonly protocol: string; readonly ordered: boolean; readonly negotiated: boolean;
  readonly maxRetransmits: number | null; readonly maxPacketLifeTime: number | null;
  constructor(readonly label: string, options: RTCDataChannelInit) {
    this.protocol = options.protocol ?? ''; this.ordered = options.ordered ?? true; this.negotiated = options.negotiated ?? false;
    this.maxRetransmits = options.maxRetransmits ?? null; this.maxPacketLifeTime = options.maxPacketLifeTime ?? null;
  }
  send(data: string) { this.sent.push(data); }
  open() { this.readyState = 'open'; this.onopen?.(); }
  receive(data: unknown) { this.onmessage?.({ data }); }
  close() { this.readyState = 'closed'; this.onclose?.(); }
}
class Connection {
  static instances: Connection[] = [];
  channels: Channel[] = [];
  sctp = { maxMessageSize: 65536 }; connectionState = 'new'; iceConnectionState = 'new';
  localDescription: RTCLocalSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: { candidate: { toJSON: () => RTCIceCandidateInit } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null; onicecandidateerror: ((event: { errorCode: number }) => void) | null = null;
  ondatachannel: ((event: { channel: Channel }) => void) | null = null;
  remoteCandidates: Array<RTCIceCandidateInit | undefined> = [];
  constructor(readonly config: RTCConfiguration) { Connection.instances.push(this); }
  createDataChannel(label: string, options: RTCDataChannelInit) { const c = new Channel(label, options); this.channels.push(c); return c; }
  async createOffer() { return { type: 'offer' as const, sdp: 'test-only-offer' }; }
  async createAnswer() { return { type: 'answer' as const, sdp: 'test-only-answer' }; }
  async setLocalDescription(value: RTCLocalSessionDescriptionInit) { this.localDescription = value; }
  async setRemoteDescription(value: RTCSessionDescriptionInit) { this.remoteDescription = value; }
  async addIceCandidate(value?: RTCIceCandidateInit) { this.remoteCandidates.push(value); }
  close() { this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
  async getStats() {
    return new Map<string, Record<string, unknown>>([
      ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
      ['pair', { localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.025 }],
      ['local', { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls', address: 'private-test-address', usernameFragment: 'private-ufrag' }],
      ['remote', { candidateType: 'host', address: 'private-remote-address', port: 1234 }],
    ]);
  }
}
const peers: RtcPeer[] = [];
beforeEach(() => { vi.stubGlobal('RTCPeerConnection', Connection); vi.useFakeTimers(); Connection.instances = []; });
afterEach(() => { for (const peer of peers.splice(0)) peer.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup(patch: Partial<RtcOptions> = {}) {
  const signal = vi.fn();
  const peer = new RtcPeer({ role: 'host', sessionId: base.sessionId, epoch: 0, generation: 1,
    compatibility: versions, aspect: 1.2, iceServers: [], signal, ...patch });
  peers.push(peer);
  const pc = Connection.instances.at(-1)!;
  const ready = () => {
    if (peer.role === 'guest') {
      pc.channels = [new Channel('control', { protocol: 'low-pass.v1', ordered: true }),
        new Channel('state', { protocol: 'low-pass.v1', ordered: false, maxRetransmits: 0 })];
      for (const channel of pc.channels) pc.ondatachannel!({ channel });
    }
    for (const channel of pc.channels) channel.open();
    pc.channels[0]!.receive(encodeMessage({ ...hello(), epoch: patch.epoch ?? 0, sender: peer.role === 'host' ? 'guest' : 'host', sequence: 0 }));
    expect(peer.status).toBe('open'); peer.drain();
  };
  return { peer, pc, signal, ready };
}

describe('bounded native peer adapter', () => {
  it('preserves validated release receipts ahead of a recoverable connection failure', () => {
    const state = setup({ clock: () => 123 }); state.ready();
    const command = release('guest');
    state.pc.channels[0]!.receive(encodeMessage(command));
    state.pc.close();
    expect(state.peer.drain()).toEqual([
      { type: 'message', channel: 'control', receivedAt: 123, message: command },
      { type: 'failed', code: 'connection' }, { type: 'status', status: 'closed', epoch: 0 },
    ]);
  });
  it('adopts a recovered authority epoch only through a host barrier on a fresh link', () => {
    const state = setup({ role: 'guest' }); state.ready();
    state.pc.channels[1]!.receive(encodeMessage({ ...base, epoch: 1, type: 'snapshot', state: snapshot(), sampledAt: 0 }));
    const barrier = { ...base, type: 'barrier' as const, reason: 'recovery' as const, nextEpoch: 9, at: { tick: 10, fraction: 0 } };
    state.pc.channels[0]!.receive(encodeMessage(barrier));
    expect(state.peer.epoch).toBe(9);
    expect(state.peer.drain().filter(event => event.type === 'message').map(event => event.message.type)).toEqual(['barrier']);
    state.pc.channels[1]!.receive(encodeMessage({ ...base, epoch: 9, type: 'snapshot', state: snapshot(), sampledAt: 0 }));
    expect(state.peer.drain()).toHaveLength(1);
    expect(() => encodeMessage({ ...barrier, epoch: 9, nextEpoch: 10 })).toThrow();
  });
  it('uses reliable control/unreliable state and gates data behind a matching peer hello', () => {
    const { peer, pc, ready } = setup();
    expect(peer.send(release('host'))).toEqual({ ok: false, reason: 'not_open' });
    expect(pc.channels.map(c => [c.label, c.ordered, c.maxRetransmits])).toEqual([['control', true, null], ['state', false, 0]]);
    ready();
    expect(peer.send(release('host'))).toEqual({ ok: true });
    expect(pc.channels[0]!.sent.map(text => JSON.parse(text).type)).toEqual(['hello', 'command']);
    expect(() => peer.send(release('guest'))).toThrow('role');
    expect(pc.channels[0]!.bufferedAmountLowThreshold).toBe(RTC_LIMITS.lowBytes);
  });

  it('holds state that overtakes the control-channel hello and rejects incompatible/binary traffic', () => {
    const { peer, pc } = setup();
    pc.channels[1]!.open();
    pc.channels[1]!.receive(encodeMessage({ ...base, sender: 'guest', type: 'ping', id: 1, sentAt: 0 }));
    expect(peer.drain()).toEqual([]);
    pc.channels[0]!.open();
    pc.channels[0]!.receive(encodeMessage({ ...hello(), sequence: 0, sender: 'guest' }));
    expect(peer.status).toBe('open'); expect(peer.drain().filter(event => event.type === 'message')).toHaveLength(2);
    pc.channels[1]!.receive(new ArrayBuffer(1));
    expect(peer.failure).toBe('invalid_message'); expect(peer.status).toBe('closed');
    const mismatch = setup();
    mismatch.pc.channels[0]!.open();
    mismatch.pc.channels[0]!.receive(encodeMessage({ ...hello(), sequence: 0, sender: 'guest',
      compatibility: { ...versions, build: 'b'.repeat(64) } }));
    expect(mismatch.peer.failure).toBe('compatibility');
  });

  it('reserves control buffer space above the bulk watermark and enforces inbox capacity', () => {
    const { peer, pc, ready } = setup(); ready();
    pc.channels[0]!.bufferedAmount = RTC_LIMITS.bulkBytes;
    expect(peer.send({ ...base, type: 'transfer-chunk', transferId: 'chunk', index: 0, data: 'AAAA' }))
      .toEqual({ ok: false, reason: 'backpressure' });
    expect(peer.send(release('host'))).toEqual({ ok: true });
    pc.channels[0]!.bufferedAmount = RTC_LIMITS.bufferedBytes;
    expect(peer.send(release('host'))).toEqual({ ok: false, reason: 'backpressure' });
    for (let i = 0; i <= RTC_LIMITS.inbox; i++) pc.channels[0]!.receive(encodeMessage(release('guest')));
    expect(peer.status).toBe('closed'); expect(peer.failure).toBe('capacity');
    expect(peer.drain()).toMatchObject([{ type: 'failed', code: 'capacity' }, { type: 'status', status: 'closed' }]);
  });

  it('paces bulk bytes without blocking commands or probes and wakes a stalled producer', () => {
    const writable = vi.fn(), state = setup({ writable }); state.ready();
    const chunk = { ...base, type: 'transfer-chunk' as const, transferId: 'chunk', index: 0, data: 'AAAA'.repeat(2700) };
    expect(state.peer.send(chunk)).toEqual({ ok: true });
    expect(state.peer.send(chunk)).toEqual({ ok: false, reason: 'backpressure' });
    expect(state.peer.send(release('host'))).toEqual({ ok: true });
    expect(state.peer.send({ ...base, type: 'ping', id: 1, sentAt: 0 })).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(writable).toHaveBeenCalledTimes(1);
    expect(state.peer.send(chunk)).toEqual({ ok: true });
    expect(state.peer.send(chunk)).toEqual({ ok: false, reason: 'backpressure' });
    state.peer.close(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not spend paced credit when the native buffer rejects a send', () => {
    const state = setup(); state.ready();
    const chunk = { ...base, type: 'transfer-chunk' as const, transferId: 'chunk', index: 0, data: 'AAAA'.repeat(2700) };
    vi.spyOn(state.pc.channels[0]!, 'send').mockImplementationOnce(() => { throw new DOMException('Full', 'OperationError'); });
    expect(state.peer.send(chunk)).toEqual({ ok: false, reason: 'backpressure' });
    expect(state.peer.send(chunk)).toEqual({ ok: true });
    expect(state.peer.send(chunk)).toEqual({ ok: false, reason: 'backpressure' });
  });

  it('buffers ICE before remote SDP, enforces generation/role, and emits the answer before local candidates', async () => {
    const { peer, pc, signal } = setup({ role: 'guest' });
    const candidate = { candidate: 'candidate:fixture', sdpMid: '0', sdpMLineIndex: 0 };
    await peer.receiveSignal({ type: 'ice', from: 'host', generation: 1, candidate });
    expect(pc.remoteCandidates).toEqual([]);
    pc.onicecandidate!({ candidate: { toJSON: () => candidate } });
    expect(signal).not.toHaveBeenCalled();
    await peer.receiveSignal({ type: 'offer', from: 'host', generation: 1, sdp: 'fixture-offer' });
    expect(pc.remoteCandidates).toEqual([candidate]);
    expect(signal.mock.calls.map(call => call[0].type)).toEqual(['answer', 'ice']);
    await expect(peer.receiveSignal({ type: 'ice', from: 'host', generation: 2, candidate })).rejects.toThrow('signaling');
    await expect(peer.receiveSignal({ type: 'answer', from: 'guest', generation: 1, sdp: 'bad-role' })).rejects.toThrow('signaling');
  });

  it('bounds candidate queues and initial negotiation time, closes channels, and surfaces callback failures', async () => {
    const { peer } = setup({ role: 'guest' });
    for (let i = 0; i < RTC_LIMITS.candidates; i++) await peer.receiveSignal({ type: 'ice', from: 'host', generation: 1, candidate: null });
    await expect(peer.receiveSignal({ type: 'ice', from: 'host', generation: 1, candidate: null })).rejects.toThrow('capacity');
    const stalled = setup({ timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(stalled.peer.failure).toBe('timeout'); expect(stalled.pc.channels.every(c => c.readyState === 'closed')).toBe(true);
    const broken = setup({ signal: () => { throw new Error('Do not expose private signaling contents.'); } });
    await expect(broken.peer.start()).rejects.toThrow('signaling');
    expect(broken.peer.failure).toBe('signaling');
    expect(broken.peer.drain()).toMatchObject([{ type: 'failed', code: 'signaling' }, { type: 'status', status: 'closed' }]);
  });

  it('requires both exact channel modes and enough SCTP message capacity', () => {
    const guest = setup({ role: 'guest' });
    guest.pc.ondatachannel!({ channel: new Channel('state', { protocol: 'low-pass.v1', ordered: true }) });
    expect(guest.peer.failure).toBe('channel');
    const small = setup(); small.pc.sctp.maxMessageSize = 1024;
    for (const channel of small.pc.channels) channel.open();
    small.pc.channels[0]!.receive(encodeMessage({ ...hello(), sender: 'guest', sequence: 0 }));
    expect(small.peer.failure).toBe('capacity');
  });

  it('redacts candidate addresses, URLs and usernames while retaining useful route/RTT diagnostics', async () => {
    const { peer, pc } = setup({ relayOnly: true });
    expect(pc.config.iceTransportPolicy).toBe('relay');
    pc.onicecandidateerror!({ errorCode: 701 });
    const diagnostic = await peer.diagnostics();
    expect(diagnostic).toEqual({ status: 'disconnected', failure: null, candidateFailures: 1, candidateErrorCodes: [701], gathered: [],
      link: { connection: 'new', ice: 'new', control: 'connecting', state: 'connecting', sentHello: false, receivedHello: false,
        epoch: 0, pendingEpochMessages: 0, discardedEpochMessages: 0 },
      selected: { local: 'relay', remote: 'host', protocol: 'udp', relayProtocol: 'tls', rttMs: 25 } });
    expect(JSON.stringify(diagnostic)).not.toContain('private-');
    peer.close();
    expect(pc.onicecandidate).toBeNull(); expect(pc.channels.every(c => c.onmessage === null)).toBe(true);
    expect((await peer.diagnostics()).selected).toBeNull();
  });

  it('handles native send pressure without destroying the connection and disposes failed constructors', () => {
    const { peer, pc, ready } = setup(); ready();
    vi.spyOn(pc.channels[0]!, 'send').mockImplementationOnce(() => { throw new DOMException('Full native buffer', 'OperationError'); });
    expect(peer.send(release('host'))).toEqual({ ok: false, reason: 'backpressure' });
    expect(peer.status).toBe('open'); expect(peer.send(release('host'))).toEqual({ ok: true });
    vi.spyOn(Connection.prototype, 'createDataChannel').mockImplementationOnce(() => { throw new Error('Native channel failure'); });
    expect(() => setup()).toThrow('channel');
    expect(Connection.instances.at(-1)!.connectionState).toBe('closed');
  });

  it('does not resume a closed peer when asynchronous offer creation finishes', async () => {
    const state = setup();
    let finish!: (value: RTCSessionDescriptionInit) => void;
    vi.spyOn(state.pc, 'createOffer').mockImplementation(() => new Promise(resolve => {
      finish = value => resolve({ type: 'offer', sdp: value.sdp! });
    }));
    const local = vi.spyOn(state.pc, 'setLocalDescription');
    const starting = state.peer.start();
    state.peer.close(); finish({ type: 'offer', sdp: 'late-offer' });
    await expect(starting).rejects.toThrow('connection');
    expect(local).not.toHaveBeenCalled(); expect(state.signal).not.toHaveBeenCalled();
  });

  it('advances game epochs only after a successfully sent host barrier, independently of ICE generation', () => {
    const state = setup({ epoch: 7, generation: 2 }); state.ready();
    const barrier = { ...base, epoch: 7, type: 'barrier' as const, nextEpoch: 8, reason: 'resume' as const,
      at: { tick: 0, fraction: 0 } };
    state.pc.channels[0]!.bufferedAmount = RTC_LIMITS.bufferedBytes;
    expect(state.peer.send(barrier)).toEqual({ ok: false, reason: 'backpressure' });
    expect(state.peer.epoch).toBe(7);
    state.pc.channels[0]!.bufferedAmount = 0;
    expect(state.peer.send(barrier).ok).toBe(true); expect(state.peer.epoch).toBe(8);
    expect(() => state.peer.send({ ...release('host'), epoch: 7 })).toThrow('epoch');
    expect(state.peer.send({ ...release('host'), epoch: 8 }).ok).toBe(true);
    expect(state.peer.status).toBe('open'); expect(state.signal).not.toHaveBeenCalled();
  });

  it('coalesces overtaking next-epoch state until the host barrier and drops old traffic without closing', async () => {
    const state = setup({ role: 'guest' }); state.ready();
    const frame = { ...base, type: 'snapshot' as const, epoch: 1, sequence: 3, sampledAt: 0, state: snapshot() };
    state.pc.channels[1]!.receive(encodeMessage(frame));
    state.pc.channels[1]!.receive(encodeMessage({ ...frame, sequence: 4 }));
    state.pc.channels[1]!.receive(encodeMessage({ ...base, epoch: 1, sequence: 5, type: 'ping', id: 1, sentAt: 0 }));
    expect(state.peer.drain()).toEqual([]); expect(state.peer.epoch).toBe(0);
    expect((await state.peer.diagnostics()).link.pendingEpochMessages).toBe(2);
    state.pc.channels[0]!.receive(encodeMessage({ ...base, sequence: 2, type: 'barrier', nextEpoch: 1,
      reason: 'resume', at: { tick: 0, fraction: 0 } }));
    expect(state.peer.epoch).toBe(1);
    const messages = state.peer.drain().filter(event => event.type === 'message');
    expect(messages.map(event => event.message.sequence)).toEqual([2, 4, 5]);
    state.pc.channels[1]!.receive(encodeMessage({ ...frame, epoch: 0 }));
    state.pc.channels[0]!.receive(encodeMessage(release('host')));
    expect(state.peer.drain()).toEqual([]); expect(state.peer.status).toBe('open');
    expect((await state.peer.diagnostics()).link).toMatchObject({ pendingEpochMessages: 0, discardedEpochMessages: 2 });
    state.pc.channels[0]!.receive(encodeMessage({ ...release('host'), epoch: 2 }));
    expect(state.peer.failure).toBe('epoch');
  });

  it('rejects skipped epochs and unauthorized guest advances while preserving strict application decoding', () => {
    expect(() => decodeMessage(encodeMessage({ ...base, epoch: 1, type: 'ping', id: 1, sentAt: 0 }),
      { sessionId: base.sessionId, epoch: 0, peer: 'host', channel: 'state' })).toThrow('epoch');
    const host = setup(); host.ready();
    host.pc.channels[1]!.receive(encodeMessage({ ...base, sender: 'guest', epoch: 1, type: 'ping', id: 1, sentAt: 0 }));
    expect(host.peer.failure).toBe('epoch');
    const guest = setup({ role: 'guest' }); guest.ready();
    guest.pc.channels[1]!.receive(encodeMessage({ ...base, epoch: 2, type: 'ping', id: 1, sentAt: 0 }));
    expect(guest.peer.failure).toBe('epoch');
  });
});
