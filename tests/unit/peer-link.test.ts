import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerLink, SIGNAL_RECOVERY_MS } from '../../src/network/peer-link.js';
import type { OutgoingSignal, RtcOptions } from '../../src/network/rtc-peer.js';
import type { WireMessage } from '../../shared/protocol/messages.js';
import { versions } from './protocol-fixtures.js';
import type { RoomMembership } from '../../shared/protocol/rooms.js';

const peers = vi.hoisted(() => ({ values: [] as Array<{ close: ReturnType<typeof vi.fn>; sent: WireMessage[];
  signal: (message: OutgoingSignal) => void }> }));
vi.mock('../../src/network/rtc-peer.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/network/rtc-peer.js')>();
  return { ...original, RtcPeer: class {
    status: 'open' | 'closed' = 'open';
    readonly epoch: number;
    readonly sent: WireMessage[] = [];
    close = vi.fn(() => { this.status = 'closed'; });
    constructor(private readonly options: RtcOptions) {
      this.epoch = options.epoch;
      peers.values.push({ close: this.close, sent: this.sent, signal: options.signal });
    }
    start() {
      this.options.signal({ type: 'offer', generation: this.options.generation, sdp: 'v=0\r\n' });
      return Promise.resolve();
    }
    receiveSignal() { return Promise.resolve(); }
    send(message: WireMessage) { this.sent.push(message); return { ok: true as const }; }
    drain() { return []; }
  } };
});
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1; bufferedAmount = 0;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) { Socket.instances.push(this); }
  send(text: string) { this.sent.push(text); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const member: RoomMembership = { capability: 'a'.repeat(43), room: { roomId: 'r'.repeat(22), participantId: 'h'.repeat(22),
  role: 'host', state: 'admitted', guestId: 'g'.repeat(22), invitationExpiresInMs: 0, expiresInMs: 900000 } };
const links: PeerLink[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  Socket.instances = []; peers.values = [];
  vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('location', { origin: 'https://game.example' });
});
afterEach(() => { for (const link of links.splice(0)) link.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup() {
  const link = new PeerLink({ member, compatibility: versions, aspect: 1.2, iceServers: [], relayOnly: false });
  links.push(link); return { link, socket: Socket.instances.at(-1)! };
}
describe('authenticated peer-link lifecycle', () => {
  function connected() {
    const state = setup();
    state.socket.onopen?.();
    state.socket.receive({ type: 'authenticated', version: 1, room: member.room });
    state.socket.receive({ type: 'peer', connected: true, generation: 0 });
    expect(state.link.status).toBe('open');
    return state;
  }
  it('reauthenticates signaling without replacing a healthy peer or interrupting game traffic', async () => {
    const { link, socket } = connected(), peer = peers.values[0]!;
    socket.close();
    expect(link.signalingState).toBe('recovering');
    expect(link.status).toBe('open');
    expect(link.send({ type: 'ping', id: 1, sentAt: 0 }).ok).toBe(true);
    expect(peer.sent.at(-1)).toMatchObject({ type: 'ping' });
    peer.signal({ type: 'ice', generation: 1, candidate: null });
    await vi.advanceTimersByTimeAsync(500);
    const replacement = Socket.instances.at(-1)!;
    expect(replacement).not.toBe(socket);
    replacement.onopen?.();
    replacement.receive({ type: 'authenticated', version: 1, room: member.room });
    expect(replacement.sent).toHaveLength(1);
    replacement.receive({ type: 'peer', connected: true, generation: 1 });
    expect(JSON.parse(replacement.sent[1]!)).toEqual({ type: 'ice', generation: 1, candidate: null });
    expect(link.signalingState).toBe('available');
    expect(link.failure).toBeNull(); expect(peer.close).not.toHaveBeenCalled();
    expect(peers.values).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('waits for the other signaling socket without reconnecting its own healthy socket', () => {
    const { link, socket } = connected(), peer = peers.values[0]!;
    socket.receive({ type: 'peer', connected: false, generation: 1 });
    peer.signal({ type: 'ice', generation: 1, candidate: null });
    expect(link.signalingState).toBe('recovering');
    expect(Socket.instances).toHaveLength(1);
    expect(socket.readyState).toBe(Socket.OPEN);
    socket.receive({ type: 'peer', connected: true, generation: 1 });
    expect(link.signalingState).toBe('available');
    expect(peer.close).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not extend the 15-second deadline through failed reauthentication attempts', async () => {
    const { link, socket } = connected(), peer = peers.values[0]!;
    socket.close();
    await vi.advanceTimersByTimeAsync(SIGNAL_RECOVERY_MS - 1);
    expect(link.status).toBe('open');
    expect(Socket.instances.length).toBeGreaterThan(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(link.status).toBe('closed');
    expect(link.failure).toBe('signaling_recovery_expired');
    expect(peer.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('closes a healthy peer if recovered signaling cannot prove the same membership', async () => {
    const { link, socket } = connected(), peer = peers.values[0]!;
    socket.close(); await vi.advanceTimersByTimeAsync(500);
    const replacement = Socket.instances.at(-1)!;
    replacement.onopen?.();
    replacement.receive({ type: 'authenticated', version: 1, room: { ...member.room, participantId: 'x'.repeat(22) } });
    expect(link.failure).toBe('membership');
    expect(peer.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds queued signaling and cancels retries when the live page leaves', async () => {
    const { link, socket } = connected(), peer = peers.values[0]!;
    socket.close();
    for (let index = 0; index < 130; index++) peer.signal({ type: 'ice', generation: 1, candidate: null });
    expect(() => peer.signal({ type: 'ice', generation: 1, candidate: null })).toThrow('signaling_capacity');
    link.close(); await vi.advanceTimersByTimeAsync(20_000);
    expect(Socket.instances).toHaveLength(1);
    expect(peer.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('authenticates without URL credentials and waits for the other admitted member', () => {
    const { link, socket } = setup(); socket.onopen?.();
    expect(socket.url).toBe('wss://game.example/signal');
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'auth', version: 1, capability: member.capability });
    socket.receive({ type: 'authenticated', version: 1, room: member.room });
    socket.receive({ type: 'peer', connected: false, generation: 0 });
    expect(link.status).toBe('waiting'); expect(vi.getTimerCount()).toBe(0);
    link.close(); expect(socket.readyState).toBe(3); expect(socket.onmessage).toBeNull();
  });
  it('fails authentication timeouts, early signals and mismatched membership explicitly', async () => {
    const first = setup(); await vi.advanceTimersByTimeAsync(10_000);
    expect(first.link.failure).toBe('authentication_timeout');
    const early = setup(); early.socket.receive({ type: 'peer', connected: true, generation: 0 });
    expect(early.link.failure).toBe('unauthenticated_signal');
    const mismatch = setup();
    mismatch.socket.receive({ type: 'authenticated', version: 1, room: { ...member.room, guestId: 'x'.repeat(22) } });
    expect(mismatch.link.failure).toBe('membership');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds signal input and reports only a fixed code for malformed private data', () => {
    const { link, socket } = setup();
    socket.onmessage?.({ data: 'private-value'.repeat(2000) });
    expect(link.failure).toBe('invalid_signal'); expect(link.status).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });
});
