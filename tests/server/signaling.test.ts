import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { ApplicationService } from '../../server/application.js';
import { readServiceConfig } from '../../server/config.js';
import { hashSecret } from '../../server/room-store.js';
import { SignalingService, SIGNAL_LIMITS } from '../../server/signaling.js';
import { serverSignal } from '../../shared/protocol/signaling.js';
import type { ServerSignal } from '../../shared/protocol/signaling.js';
import { assetFixture } from './fixtures.js';

const secret = 'signaling-only-dummy-host-code-for-tests';
const origin = 'https://signal-test.example';
let staticRoot: string;
const resources: Array<{ app: ApplicationService; signal: SignalingService; clients: WebSocket[] }> = [];
beforeAll(async () => { staticRoot = await assetFixture(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { app, signal, clients } of resources.splice(0)) {
    for (const client of clients) client.terminate();
    signal.close(); await app.close();
  }
});
afterAll(async () => { await rm(staticRoot, { recursive: true, force: true }); });

async function setup() {
  let time = 0;
  const warnings: string[] = [];
  const app = new ApplicationService({ ...readServiceConfig({}), staticRoot, port: 0, shutdownTimeoutMs: 50,
    multiplayer: { status: 'rooms', reason: 'not_implemented',
      config: { origin, hostingDigest: hashSecret(secret), trustedProxyCidrs: ['127.0.0.1/32'] } } }, message => warnings.push(message));
  app.signaling!.close();
  const signal = new SignalingService(app.server, app.rooms!, message => warnings.push(message), () => time);
  const clients: WebSocket[] = [];
  resources.push({ app, signal, clients });
  const url = `ws://127.0.0.1:${await app.listen()}/signal`, store = app.rooms!.store;
  const host = store.create(store.authorize(secret, 'host').capability, 'host');
  const guest = store.join(host.invitation.replace('-', ''));
  async function connect(credential?: string) {
    const ws = new WebSocket(url, { origin, headers: { 'X-Forwarded-For': '203.0.113.10' } });
    clients.push(ws);
    const messages: ServerSignal[] = [];
    const waiters = new Set<() => void>();
    ws.on('message', raw => { messages.push(serverSignal.parse(JSON.parse(raw.toString()))); for (const notify of waiters) notify(); });
    ws.on('error', () => { /* Expected malformed/closed-socket cases are asserted by their close or HTTP status. */ });
    await once(ws, 'open');
    const next = (type: ServerSignal['type']): Promise<ServerSignal> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Missing ${type} signal.`)); }, 2000);
      const check = () => {
        const index = messages.findIndex(m => m.type === type);
        if (index >= 0) { clearTimeout(timer); waiters.delete(check); resolve(messages.splice(index, 1)[0]!); }
      };
      waiters.add(check); check();
    });
    if (credential) {
      ws.send(JSON.stringify({ type: 'auth', version: 1, capability: credential }));
      expect(await next('authenticated')).toMatchObject({ type: 'authenticated' });
    }
    return { ws, next, messages, send: (value: unknown) => ws.send(JSON.stringify(value)) };
  }
  return { app, signal, store, host, guest, url, clients, connect, warnings, tick: (now: number) => { time = now; signal.tick(); } };
}

describe('authenticated room-scoped WebSocket signaling', () => {
  it('requires Origin/proxy validation before upgrade and forbids credential query strings', async () => {
    const state = await setup();
    for (const [suffix, headers, status] of [
      ['', { Origin: 'https://other.example', 'X-Forwarded-For': '203.0.113.10' }, 403],
      ['', { Origin: origin }, 403],
      ['?capability=not-a-real-token', { Origin: origin, 'X-Forwarded-For': '203.0.113.10' }, 400],
    ] as const) {
      const client = new WebSocket(state.url + suffix, { headers });
      state.clients.push(client); client.on('error', () => {});
      const response = await new Promise<number>(resolve => {
        client.once('unexpected-response', (request, response) => { resolve(response.statusCode!); response.resume(); request.destroy(); });
      });
      expect(response).toBe(status);
    }
    expect(state.signal.counts.authenticated).toBe(0);
  });

  it('binds roles, requires admission, and serializes offers, answers and candidate generations', async () => {
    const state = await setup(), host = await state.connect(state.host.capability), guest = await state.connect(state.guest.capability);
    host.send({ type: 'offer', generation: 1, sdp: 'v=0\r\n' });
    expect(await host.next('error')).toEqual({ type: 'error', code: 'not_admitted' });
    state.store.admit(state.host.capability, state.guest.room.participantId, true);
    expect(await guest.next('room')).toMatchObject({ room: { state: 'admitted', role: 'guest' } });
    host.send({ type: 'offer', generation: 1, sdp: 'v=0\r\n' });
    expect(await guest.next('offer')).toEqual({ type: 'offer', from: 'host', generation: 1, sdp: 'v=0\r\n' });
    host.send({ type: 'offer', generation: 2, sdp: 'v=0\r\n' });
    expect(await host.next('error')).toMatchObject({ code: 'generation' });
    guest.send({ type: 'answer', generation: 1, sdp: 'v=0\r\n' });
    expect(await host.next('answer')).toMatchObject({ from: 'guest', generation: 1 });
    guest.send({ type: 'ice', generation: 0, candidate: null });
    expect(await guest.next('error')).toMatchObject({ code: 'invalid_message' });
    expect(state.warnings).toEqual([]);
  });

  it('rejects role spoofing, duplicate connections and pre-auth traffic', async () => {
    const state = await setup(), host = await state.connect(state.host.capability);
    const duplicate = await state.connect();
    duplicate.send({ type: 'auth', version: 1, capability: state.host.capability });
    expect(await duplicate.next('error')).toMatchObject({ code: 'already_connected' });
    const anonymous = await state.connect();
    anonymous.send({ type: 'offer', generation: 1, sdp: 'v=0\r\n' });
    expect(await anonymous.next('error')).toMatchObject({ code: 'unauthorized' });
    const guest = await state.connect(state.guest.capability);
    state.store.admit(state.host.capability, state.guest.room.participantId, true);
    guest.send({ type: 'offer', generation: 1, sdp: 'v=0\r\n' });
    expect(await guest.next('error')).toMatchObject({ code: 'role' });
    host.send({ type: 'offer', generation: 1, sdp: 'v=0\r\n', to: 'other-room' });
    expect(await host.next('error')).toMatchObject({ code: 'invalid_message' });
  });

  it('preserves a 15-second same-member recovery lease and invalidates stale negotiations on reconnection', async () => {
    const state = await setup(), host = await state.connect(state.host.capability);
    const guest = await state.connect(state.guest.capability);
    state.store.admit(state.host.capability, state.guest.room.participantId, true);
    host.send({ type: 'offer', generation: 1, sdp: 'v=0\r\n' });
    await guest.next('offer');
    guest.ws.close(); await once(guest.ws, 'close');
    await vi.waitFor(() => expect(state.signal.counts.leases).toBe(1));
    state.tick(14_999);
    const returned = await state.connect(state.guest.capability);
    expect(state.signal.counts.leases).toBe(0);
    host.send({ type: 'offer', generation: 2, sdp: 'v=0\r\n' });
    expect(await returned.next('offer')).toMatchObject({ generation: 2 });
    returned.send({ type: 'ice', generation: 1, candidate: null });
    expect(await returned.next('error')).toMatchObject({ code: 'generation' });
    returned.send({ type: 'answer', generation: 2, sdp: 'v=0\r\n' });
    expect(await host.next('answer')).toMatchObject({ generation: 2 });
    returned.ws.close(); await once(returned.ws, 'close');
    await vi.waitFor(() => expect(state.signal.counts.leases).toBe(1));
    state.tick(14_999 + SIGNAL_LIMITS.recoveryMs);
    expect(await host.next('closed')).toEqual({ type: 'closed', reason: 'recovery_expired' });
    expect(state.store.counts.rooms).toBe(0);
    expect(() => state.store.authenticate(state.guest.capability)).toThrow();
  });

  it('bounds unauthenticated lifetimes and candidate traffic, including explicit backpressure', async () => {
    const state = await setup(), anonymous = await state.connect();
    state.tick(SIGNAL_LIMITS.authMs);
    expect(await anonymous.next('error')).toMatchObject({ code: 'auth_timeout' });
    const host = await state.connect(state.host.capability), guest = await state.connect(state.guest.capability);
    state.store.admit(state.host.capability, state.guest.room.participantId, true);
    host.send({ type: 'offer', generation: 1, sdp: 'v=0\r\n' }); await guest.next('offer');
    for (let i = 0; i < SIGNAL_LIMITS.candidates + 1; i++) host.send({ type: 'ice', generation: 1, candidate: null });
    expect(await host.next('error')).toMatchObject({ code: 'capacity' });
    const other = await setup(), h = await other.connect(other.host.capability), g = await other.connect(other.guest.capability);
    other.store.admit(other.host.capability, other.guest.room.participantId, true);
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(SIGNAL_LIMITS.bufferedBytes);
    const closed = once(g.ws, 'close');
    h.send({ type: 'offer', generation: 1, sdp: 'v=0\r\n' });
    const [code, reason] = await closed;
    expect(code).toBe(1009); expect(reason.toString()).toBe('backpressure');
  });

  it('closes revoked members and shuts down upgraded sockets without logging bearer credentials', async () => {
    const state = await setup(), host = await state.connect(state.host.capability), guest = await state.connect(state.guest.capability);
    state.store.admit(state.host.capability, state.guest.room.participantId, false);
    expect(await guest.next('closed')).toMatchObject({ reason: 'room_closed' });
    state.signal.close();
    expect(await host.next('closed')).toMatchObject({ reason: 'service_stopped' });
    await state.app.close();
    expect(JSON.stringify(state.warnings)).not.toContain(state.host.capability);
    expect(JSON.stringify(state.warnings)).not.toContain(state.guest.capability);
  });

  it('bounds frame size and detects a peer that stops answering heartbeats', async () => {
    const state = await setup(), huge = await state.connect();
    const oversized = once(huge.ws, 'close');
    huge.ws.send('x'.repeat(16 * 1024 + 1));
    expect((await oversized)[0]).toBe(1009);
    const host = await state.connect(state.host.capability);
    vi.spyOn(host.ws, 'pong').mockImplementation(() => {});
    const ping = once(host.ws, 'ping');
    state.tick(SIGNAL_LIMITS.heartbeatMs); await ping;
    state.tick(SIGNAL_LIMITS.heartbeatMs * 2);
    expect(await host.next('error')).toMatchObject({ code: 'heartbeat_timeout' });
    expect(state.warnings).toEqual(['Signaling connection failed.']);
  });

  it('isolates rooms and rejects malformed, binary and revoked authentication messages', async () => {
    const state = await setup();
    const otherHost = state.store.create(state.store.authorize(secret, 'other').capability, 'other');
    const otherGuest = state.store.join(otherHost.invitation.replace('-', ''));
    state.store.admit(otherHost.capability, otherGuest.room.participantId, true);
    state.store.admit(state.host.capability, state.guest.room.participantId, true);
    const host = await state.connect(state.host.capability), guest = await state.connect(state.guest.capability);
    const unrelated = await state.connect(otherGuest.capability);
    host.send({ type: 'offer', generation: 1, sdp: 'private-offer' });
    expect(await guest.next('offer')).toMatchObject({ sdp: 'private-offer' });
    unrelated.send({ type: 'ice', generation: 1, candidate: null });
    expect(await unrelated.next('error')).toMatchObject({ code: 'peer_unavailable' });
    expect(unrelated.messages.some(message => message.type === 'offer')).toBe(false);
    for (const payload of ['{bad-json', Buffer.from('{}')]) {
      const invalid = await state.connect(); invalid.ws.send(payload);
      expect(await invalid.next('error')).toMatchObject({ code: 'invalid_message' });
    }
    state.store.leave(otherHost.capability);
    const revoked = await state.connect();
    revoked.send({ type: 'auth', version: 1, capability: otherGuest.capability });
    expect(await revoked.next('error')).toMatchObject({ code: 'unauthorized' });
  });

  it('caps pending sockets and clears denied-member recovery leases immediately', async () => {
    const state = await setup(), guest = await state.connect(state.guest.capability);
    guest.ws.close(); await once(guest.ws, 'close');
    await vi.waitFor(() => expect(state.signal.counts.leases).toBe(1));
    state.store.admit(state.host.capability, state.guest.room.participantId, false);
    expect(state.signal.counts.leases).toBe(0);
    for (let i = 0; i < SIGNAL_LIMITS.pending; i++) await state.connect();
    const excess = new WebSocket(state.url, { origin, headers: { 'X-Forwarded-For': '203.0.113.10' } });
    state.clients.push(excess); excess.on('error', () => {});
    expect(await new Promise<number>(resolve => excess.once('unexpected-response', (request, response) => {
      resolve(response.statusCode!); response.resume(); request.destroy();
    }))).toBe(503);
    expect(state.signal.counts.sockets).toBe(SIGNAL_LIMITS.pending);
  });

  it('treats room expiry during heartbeat refresh as normal closure, not a global service failure', async () => {
    const state = await setup(), host = await state.connect(state.host.capability);
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 8 * 60 * 60_000 + 1);
    state.tick(SIGNAL_LIMITS.heartbeatMs);
    expect(await host.next('closed')).toMatchObject({ reason: 'room_closed' });
    expect(state.signal.available).toBe(true);
    expect(state.signal.counts.negotiations).toBe(0);
    expect(state.warnings).toEqual([]);
  });
});
