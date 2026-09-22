import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerLink } from '../../src/network/peer-link.js';
import { versions } from './protocol-fixtures.js';
import type { RoomMembership } from '../../shared/protocol/rooms.js';

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
  vi.useFakeTimers(); Socket.instances = []; vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('location', { origin: 'https://game.example' });
});
afterEach(() => { for (const link of links.splice(0)) link.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup() {
  const link = new PeerLink({ member, compatibility: versions, aspect: 1.2, iceServers: [], relayOnly: false });
  links.push(link); return { link, socket: Socket.instances.at(-1)! };
}
describe('authenticated peer-link lifecycle', () => {
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
