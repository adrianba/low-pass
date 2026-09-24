import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSecretKey, webcrypto } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationService } from '../../server/application.js';
import { readServiceConfig } from '../../server/config.js';
import { hashSecret, RoomStore, ROOM_LIMITS } from '../../server/room-store.js';
import { TURN_LIMITS, TurnCredentials } from '../../server/turn-credentials.js';
import { iceConfiguration, iceUrl } from '../../shared/protocol/ice.js';
import { assetFixture } from './fixtures.js';

const accessCode = 'dummy-hosting-code-for-turn-tests-only';
const secret = 'dummy-shared-coturn-secret-for-local-tests-only';
const urls = ['stun:relay.example:3478', 'turn:relay.example:3478?transport=udp', 'turns:relay.example:5349?transport=tcp'];
const origin = 'https://turn-api.example';
let staticRoot: string, privateRoot: string, hostingFile: string, turnFile: string;
const services: ApplicationService[] = [];
beforeAll(async () => {
  staticRoot = await assetFixture(); privateRoot = await mkdtemp(join(tmpdir(), 'low-pass-turn-test-'));
  hostingFile = join(privateRoot, 'hosting-code'); turnFile = join(privateRoot, 'relay-key');
  await writeFile(hostingFile, accessCode + '\n', { mode: 0o600 });
  await writeFile(turnFile, secret + '\r\n', { mode: 0o600 });
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(services.splice(0).map(service => service.close())); });
afterAll(async () => { await rm(staticRoot, { recursive: true, force: true }); await rm(privateRoot, { recursive: true, force: true }); });
const env = () => ({ LOW_PASS_STATIC_ROOT: staticRoot, LOW_PASS_MULTIPLAYER_ENABLED: 'true',
  LOW_PASS_PUBLIC_ORIGIN: origin, LOW_PASS_TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
  LOW_PASS_HOSTING_CODE_FILE: hostingFile, LOW_PASS_TURN_URLS: urls.join(','), LOW_PASS_TURN_SECRET_FILE: turnFile });
function members(store: RoomStore) {
  const host = store.create(store.authorize(accessCode, 'source').capability, 'source');
  const guest = store.join(host.invitation.replace('-', ''));
  return { host, guest, admit: () => store.admit(host.capability, guest.room.participantId, true) };
}
function issuer() {
  let monotonic = 0, wall = 1_800_000_000_000;
  const store = new RoomStore(hashSecret(accessCode), () => monotonic), room = members(store), warnings: string[] = [];
  const service = new TurnCredentials({ urls, key: createSecretKey(Buffer.from(secret)) }, store,
    message => warnings.push(message), () => ({ wall, monotonic }));
  return { store, service, ...room, warnings, advance: (ms: number, wallMs = ms) => { monotonic += ms; wall += wallMs; } };
}
async function start(settings = env()) {
  const warnings: string[] = [];
  const service = new ApplicationService({ ...readServiceConfig(settings), port: 0 }, message => warnings.push(message));
  services.push(service);
  const url = `http://127.0.0.1:${await service.listen()}`;
  const request = (credential?: string, body = '{}', requestOrigin = origin) => fetch(url + '/api/multiplayer/room/ice', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin, 'X-Forwarded-For': '203.0.113.10',
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body,
  });
  return { service, url, request, warnings };
}

describe('private coturn REST credential issuance', () => {
  it('signs expiring per-member credentials with the coturn HMAC-SHA1 format, never the permanent secret', async () => {
    const state = issuer();
    expect(() => state.service.issue(state.host.capability)).toThrow('admission_required');
    expect(() => state.service.issue(state.guest.capability)).toThrow('admission_required');
    state.admit();
    const host = state.service.issue(state.host.capability), guest = state.service.issue(state.guest.capability);
    const relay = host.iceServers.find(server => 'credential' in server)!;
    expect(relay).toMatchObject({ username: `1800000600:${state.host.room.roomId}:${state.host.room.participantId}` });
    if (!('credential' in relay)) throw new Error('Missing relay credentials.');
    const key = await webcrypto.subtle.importKey('raw', Buffer.from(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const signature = await webcrypto.subtle.sign('HMAC', key, Buffer.from(relay.username));
    expect(relay.credential).toBe(Buffer.from(signature).toString('base64'));
    expect(host.refreshAfterMs).toBe(300_000); expect(host.expiresAtMs - host.serverTimeMs).toBe(600_000);
    expect(host.iceServers).not.toEqual(guest.iceServers);
    expect(JSON.stringify(host)).not.toContain(secret);
    expect(JSON.stringify(host)).not.toContain(state.host.capability);
    relay.credential = 'mutated';
    expect(state.service.issue(state.host.capability).iceServers).not.toEqual(host.iceServers);
    state.service.close(); state.store.close();
  });

  it('caches requests before refresh, refreshes for long matches, and stops after room revocation', () => {
    const state = issuer(); state.admit();
    const first = state.service.issue(state.host.capability);
    state.advance(299_999);
    const cached = state.service.issue(state.host.capability);
    expect(cached.iceServers).toEqual(first.iceServers); expect(cached.refreshAfterMs).toBe(1);
    state.advance(1);
    const refreshed = state.service.issue(state.host.capability);
    expect(refreshed.iceServers).not.toEqual(first.iceServers);
    expect(refreshed.expiresAtMs).toBe(first.expiresAtMs + 300_000);
    state.store.leave(state.guest.capability);
    expect(state.service.size).toBe(0);
    expect(() => state.service.issue(state.host.capability)).toThrow('room_closed');
    state.service.close(); state.store.close();
  });

  it('bounds refreshes to the room lifetime and contains large wall-clock jumps', () => {
    const state = issuer(); state.admit();
    for (let t = 0; t < ROOM_LIMITS.lifetimeMs - 300_000; t += 300_000) {
      state.service.issue(state.host.capability); state.advance(300_000);
    }
    const last = state.service.issue(state.host.capability);
    expect(last.expiresAtMs - last.serverTimeMs).toBe(300_000);
    state.advance(250_000);
    expect(() => state.service.issue(state.host.capability)).toThrow('room_expiring');
    state.service.close(); state.store.close();
    for (const jump of [-TURN_LIMITS.skewMs - 1, TURN_LIMITS.skewMs + 1]) {
      const skewed = issuer(); skewed.admit(); skewed.service.issue(skewed.host.capability);
      skewed.advance(1, 1 + jump);
      expect(() => skewed.service.issue(skewed.host.capability)).toThrow('turn_clock_error');
      expect(skewed.service.available).toBe(false); expect(skewed.service.size).toBe(0);
      expect(skewed.warnings).toEqual(['TURN credential clock is unreliable; issuance paused while waiting for a stable clock.']);
      expect(() => skewed.service.issue(skewed.host.capability)).toThrow('turn_clock_error');
      skewed.service.close(); skewed.store.close();
    }
  });

  it.each([-3_600_000, 3_600_000])('automatically recovers a stable %sms wall correction without extending leases or reusing cached credentials', jump => {
    const state = issuer(); state.admit();
    const before = state.service.issue(state.host.capability);
    state.service.issue(state.guest.capability);
    state.advance(1, 1 + jump);
    expect(state.service.checkClock()).toBe(false);
    expect(state.service.size).toBe(0);
    for (let second = 1; second < 30; second++) {
      state.advance(1000);
      expect(state.service.checkClock()).toBe(false);
    }
    expect(state.service.available).toBe(false);
    state.advance(1000);
    expect(state.service.checkClock()).toBe(true);
    expect(state.service.available).toBe(true);
    expect(state.store.peekDigest(hashSecret(state.host.capability))!.expiresInMs).toBe(ROOM_LIMITS.idleMs - 30_001);
    const after = state.service.issue(state.host.capability);
    expect(after.iceServers).not.toEqual(before.iceServers);
    expect(after.serverTimeMs - before.serverTimeMs).toBe(jump + 30_001);
    expect(after.expiresAtMs - after.serverTimeMs).toBeLessThanOrEqual(TURN_LIMITS.lifetimeMs);
    expect(state.warnings).toHaveLength(2);
    expect(state.warnings[1]).toContain('issuance resumed');
    state.service.close(); state.advance(1000);
    expect(state.service.checkClock()).toBe(false);
    expect(() => state.service.issue(state.host.capability)).toThrow('turn_unavailable');
    state.store.close();
  });

  it('requires continuously sampled stability, restarting the window on another jump or a sampling gap', () => {
    const state = issuer(); state.admit(); state.service.issue(state.host.capability);
    state.advance(1, 60_001); state.service.checkClock();
    state.advance(TURN_LIMITS.recoveryMs);
    expect(state.service.checkClock()).toBe(false);
    for (let second = 0; second < 29; second++) { state.advance(1000); expect(state.service.checkClock()).toBe(false); }
    state.advance(1000, 3000);
    expect(state.service.checkClock()).toBe(false);
    for (let second = 0; second < 29; second++) { state.advance(1000); expect(state.service.checkClock()).toBe(false); }
    state.advance(1000);
    expect(state.service.checkClock()).toBe(true);
    expect(state.warnings).toHaveLength(2);
    state.service.close(); state.store.close();
  });

  it('does not issue through invalid clocks or revive revoked rooms during recovery', () => {
    const state = issuer(); state.admit(); state.service.issue(state.host.capability);
    for (const wall of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
      expect(state.service.checkClock({ wall, monotonic: 0 })).toBe(false);
    }
    for (const monotonic of [NaN, Infinity, -1]) {
      expect(state.service.checkClock({ wall: 1_800_000_000_000, monotonic })).toBe(false);
    }
    state.store.leave(state.guest.capability);
    expect(state.service.checkClock()).toBe(false);
    for (let second = 0; second < 30; second++) { state.advance(1000); state.service.checkClock(); }
    expect(state.service.available).toBe(true);
    expect(() => state.service.issue(state.host.capability)).toThrow('room_closed');
    state.service.close(); state.store.close();
  });

  it('reports temporary clock recovery through HTTP without taking down rooms or static health', async () => {
    const { service, request, url } = await start(), room = members(service.rooms!.store);
    room.admit();
    service.rooms!.turn!.checkClock({ wall: NaN, monotonic: 0 });
    const response = await request(room.host.capability);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(await response.json()).toEqual({ error: 'turn_clock_error' });
    expect((await fetch(url + '/healthz')).status).toBe(200);
    expect((await fetch(url + '/api/multiplayer/readyz')).status).toBe(503);
    expect(service.rooms!.available).toBe(true);
  });

  it('observes and recovers the clock through room maintenance without waiting for player requests', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const warnings: string[] = [];
    const service = new ApplicationService({ ...readServiceConfig(env()), port: 0 }, message => warnings.push(message));
    const turn = service.rooms!.turn!, check = turn.checkClock.bind(turn);
    let monotonic = 0, wall = 1_800_000_000_000;
    const observe = vi.spyOn(turn, 'checkClock').mockImplementation(() => check({ wall, monotonic }));
    try {
      const url = `http://127.0.0.1:${await service.listen()}`;
      await vi.advanceTimersByTimeAsync(1000);
      wall += 60_000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(turn.available).toBe(false);
      expect((await fetch(url + '/api/multiplayer/readyz')).status).toBe(503);
      for (let second = 0; second < 30; second++) {
        wall += 1000; monotonic += 1000;
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(turn.available).toBe(true);
      expect(service.rooms!.available).toBe(true);
      expect((await fetch(url + '/api/multiplayer/readyz')).status).toBe(200);
      expect(observe).toHaveBeenCalledTimes(32);
      expect(warnings).toHaveLength(2);
      await service.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(observe).toHaveBeenCalledTimes(32);
      expect(turn.available).toBe(false);
    } finally { await service.close(); vi.useRealTimers(); }
  });

  it('requires explicit supported hosts, ports and transports, without URL credentials or arbitrary schemes', () => {
    for (const url of [...urls, 'turn:[2001:db8::1]:3478?transport=tcp']) expect(iceUrl.safeParse(url).success).toBe(true);
    for (const url of ['https://relay.example', 'turn:user:password@relay.example:3478?transport=udp',
      'turn:relay.example', 'turn:relay.example:3478', 'turns:relay.example:5349?transport=udp',
      'stun:relay.example:3478?transport=tcp', 'turn:relay.example:0?transport=tcp',
      'turn:relay.example:65536?transport=udp', 'turn:[bad::ip]:3478?transport=udp',
      'turn:127.1:3478?transport=udp', 'turn:bad..example:3478?transport=udp']) {
      expect(iceUrl.safeParse(url).success, url).toBe(false);
    }
    for (const override of [{ LOW_PASS_TURN_URLS: 'stun:relay.example:3478' }, { LOW_PASS_TURN_URLS: urls[1] + ',' + urls[1] },
      { LOW_PASS_TURN_SECRET_FILE: '/missing/private-relay-key' }]) {
      expect(readServiceConfig({ ...env(), ...override }).multiplayer.status).toBe('unavailable');
    }
    expect(readServiceConfig(env()).multiplayer.status).toBe('rooms');
  });

  it('protects the real HTTP endpoint with admission, Origin, strict bodies, bounded quotas and no-store', async () => {
    const { service, request, url, warnings } = await start(), room = members(service.rooms!.store);
    expect((await request()).status).toBe(401);
    expect((await request(room.host.capability)).status).toBe(403);
    room.admit();
    expect((await request(room.host.capability, '{}', 'https://other.example')).status).toBe(403);
    expect((await request(room.host.capability, '{"lifetime":999999}')).status).toBe(400);
    for (let i = 0; i < 4; i++) {
      const response = await request(room.host.capability);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(iceConfiguration.safeParse(await response.json()).success).toBe(true);
    }
    expect((await request(room.host.capability)).status).toBe(429);
    expect((await request(room.guest.capability)).status).toBe(200);
    expect(await (await fetch(url + '/api/multiplayer/capabilities')).json()).toMatchObject({ multiplayer: false, turn: true });
    service.rooms!.store.leave(room.host.capability);
    expect((await request(room.guest.capability)).status).toBe(401);
    expect(warnings).toEqual([]);
  });

  it('excludes a declared relay secret from static serving, degrades configuration failures, and reports stopped issuance', async () => {
    const publicFile = join(staticRoot, 'wrong-relay-secret');
    await writeFile(publicFile, secret);
    const invalid = await start({ ...env(), LOW_PASS_TURN_SECRET_FILE: publicFile });
    expect((await fetch(invalid.url + '/wrong-relay-secret')).status).toBe(404);
    expect((await fetch(invalid.url + '/healthz')).status).toBe(200);
    expect((await fetch(invalid.url + '/api/multiplayer/readyz')).status).toBe(503);
    await rm(publicFile);
    const active = await start();
    active.service.rooms!.turn!.close();
    expect((await fetch(active.url + '/healthz')).status).toBe(200);
    expect((await fetch(active.url + '/api/multiplayer/readyz')).status).toBe(503);
    expect(await (await fetch(active.url + '/api/multiplayer/capabilities')).json()).toMatchObject({ reason: 'service_error', turn: false });
  });
});
