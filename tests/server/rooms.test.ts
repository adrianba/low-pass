import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { RoomStore, ROOM_LIMITS, hashSecret } from '../../server/room-store.js';
import { ClientAddresses } from '../../server/client-address.js';
import { RoomLimits } from '../../server/room-limits.js';
import { ApplicationService } from '../../server/application.js';
import { readServiceConfig } from '../../server/config.js';
import { invitationRequest, roomView } from '../../shared/protocol/rooms.js';
import { assetFixture } from './fixtures.js';

const accessCode = 'private-test-hosting-code-with-enough-entropy';
const trusted = ['127.0.0.1/32', '173.245.48.0/20'];
const source = '203.0.113.10';
let staticRoot: string, privateRoot: string, secretFile: string;
const services: ApplicationService[] = [];
beforeAll(async () => {
  staticRoot = await assetFixture(); privateRoot = await mkdtemp(join(tmpdir(), 'low-pass-room-test-'));
  secretFile = join(privateRoot, 'hosting-code');
  await writeFile(secretFile, accessCode + '\n', { mode: 0o600 });
});
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(services.splice(0).map(service => service.close())); });
afterAll(async () => { await rm(staticRoot, { recursive: true, force: true }); await rm(privateRoot, { recursive: true, force: true }); });
const env = () => ({ LOW_PASS_STATIC_ROOT: staticRoot, LOW_PASS_MULTIPLAYER_ENABLED: 'true',
  LOW_PASS_PUBLIC_ORIGIN: 'https://low-pass.example', LOW_PASS_TRUSTED_PROXY_CIDRS: trusted.join(','),
  LOW_PASS_HOSTING_CODE_FILE: secretFile });
function request(remote: string, forwarded?: string) {
  const socket = new Socket(); Object.defineProperty(socket, 'remoteAddress', { value: remote });
  const message = new IncomingMessage(socket);
  if (forwarded !== undefined) message.headers['x-forwarded-for'] = forwarded;
  return message;
}
async function start(settings: NodeJS.ProcessEnv = env()) {
  const warnings: string[] = [], service = new ApplicationService({ ...readServiceConfig(settings), port: 0 }, message => warnings.push(message));
  services.push(service);
  const origin = `http://127.0.0.1:${await service.listen()}`;
  const post = (path: string, data: unknown = {}, credential?: string, headers: Record<string, string> = {}) =>
    fetch(origin + '/api/multiplayer/' + path, { method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: 'https://low-pass.example', 'X-Forwarded-For': `${source},173.245.48.5`,
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...headers,
    }, body: JSON.stringify(data) });
  return { origin, post, service, warnings };
}
function host(store: RoomStore, address = source) {
  return store.create(store.authorize(accessCode, address).capability, address);
}
const code = (value: string) => invitationRequest.parse({ invitation: value }).invitation;

describe('explicit proxy trust', () => {
  it('uses the nearest untrusted client, not spoofed prefixes or CF-Connecting-IP', () => {
    const addresses = new ClientAddresses(trusted);
    const req = request('::ffff:7f00:1', `198.51.100.99,${source},173.245.48.5`);
    req.headers['cf-connecting-ip'] = '198.51.100.1';
    expect(addresses.read(req)).toBe(source);
    expect(addresses.read(request('127.0.0.1', `198.51.100.99,${source}`))).toBe(source);
    expect(addresses.read(request('127.0.0.1', '2001:0db8:0:0::1,173.245.48.5'))).toBe('2001:db8::1');
    for (const req of [request(source, '198.51.100.99'), request('127.0.0.1'),
      request('127.0.0.1', 'garbage'), request('127.0.0.1', Array(17).fill(source).join(',')),
      request('127.0.0.1', '173.245.48.5')]) expect(() => addresses.read(req)).toThrow();
    for (const ranges of [[], ['0.0.0.0/0'], ['::/0'], ['127.0.0.1'], ['::1/129']]) expect(() => new ClientAddresses(ranges)).toThrow();
  });
});

describe('bounded private room state', () => {
  it('requires a one-use source-bound host grant and admits exactly one guest with separate capabilities', () => {
    const store = new RoomStore(hashSecret(accessCode), () => 0);
    expect(() => store.authorize('wrong', source)).toThrow('invalid_hosting_code');
    const grant = store.authorize(accessCode, source);
    expect(() => store.create(grant.capability, 'other')).toThrow('invalid_capability');
    const room = store.create(grant.capability, source);
    expect(() => store.create(grant.capability, source)).toThrow('invalid_capability');
    const guest = store.join(code(room.invitation));
    expect(new Set([grant.capability, room.capability, guest.capability, room.invitation]).size).toBe(4);
    expect(() => store.join(code(room.invitation))).toThrow('room_full');
    expect(() => store.authenticate(guest.capability, true)).toThrow('admission_required');
    expect(() => store.admit(guest.capability, guest.room.participantId, true)).toThrow('host_required');
    expect(() => store.admit(room.capability, 'stale-id', true)).toThrow('stale_admission');
    expect(store.admit(room.capability, guest.room.participantId, true).state).toBe('admitted');
    expect(store.authenticate(guest.capability, true)).toMatchObject({ role: 'guest', admitted: true });
    expect(() => store.rotate(room.capability)).toThrow('room_full');
    store.leave(guest.capability);
    expect(() => store.status(room.capability)).toThrow('room_closed');
    expect(store.counts).toMatchObject({ rooms: 0, members: 0, invitations: 0 });
  });

  it('revokes pending admission and old invitations without allowing a replacement after admission', () => {
    const store = new RoomStore(hashSecret(accessCode), () => 0), first = host(store);
    const guest = store.join(code(first.invitation));
    store.admit(first.capability, guest.room.participantId, false);
    expect(() => store.status(guest.capability)).toThrow('admission_denied');
    expect(() => store.join(code(first.invitation))).toThrow('invalid_invitation');
    const replacement = store.rotate(first.capability);
    expect(replacement.invitation).not.toBe(first.invitation);
    const pending = store.join(code(replacement.invitation));
    store.rotate(first.capability);
    expect(() => store.status(pending.capability)).toThrow('invitation_revoked');
    store.close();
    expect(store.counts).toEqual({ rooms: 0, grants: 0, members: 0, invitations: 0, tombstones: 0 });
  });

  it('expires grants, pending admissions, invitations and abandoned rooms with bounded capacity', () => {
    let now = 0;
    const store = new RoomStore(hashSecret(accessCode), () => now), grant = store.authorize(accessCode, source);
    now = ROOM_LIMITS.grantMs; expect(() => store.create(grant.capability, source)).toThrow('invalid_capability');
    const first = host(store), guest = store.join(code(first.invitation));
    now += ROOM_LIMITS.pendingMs;
    expect(() => store.status(guest.capability)).toThrow('admission_expired');
    const invite = store.rotate(first.capability);
    now += ROOM_LIMITS.invitationMs;
    expect(() => store.join(code(invite.invitation))).toThrow('invitation_expired');
    now += ROOM_LIMITS.idleMs; store.sweep();
    expect(store.counts.rooms).toBe(0);
    for (let i = 0; i < ROOM_LIMITS.rooms; i++) host(store, `source-${i}`);
    expect(() => host(store, 'overflow')).toThrow('capacity');
    store.close();
    const grantStore = new RoomStore(hashSecret(accessCode), () => 0);
    for (let i = 0; i < ROOM_LIMITS.grants; i++) grantStore.authorize(accessCode, `source-${i}`);
    expect(() => grantStore.authorize(accessCode, 'overflow')).toThrow('capacity');
    grantStore.close();
  });

  it('caps rate-limit bookkeeping and recovers expired buckets', () => {
    let now = 0;
    const limits = new RoomLimits(() => now);
    limits.take('source', 1); expect(() => limits.take('source', 1)).toThrow('rate_limited');
    for (let i = 1; i < 2048; i++) limits.take(`source-${i}`, 1);
    expect(() => limits.take('overflow', 1)).toThrow('capacity');
    now = 60_000; limits.sweep(); expect(limits.size).toBe(0);
    limits.take('source', 1); limits.clear(); expect(limits.size).toBe(0);
  });
});

describe('real private room HTTP boundary', () => {
  it('authorizes, atomically reserves a guest, admits, and revokes both capabilities on leave', async () => {
    const { post, origin, service, warnings } = await start();
    expect(await (await fetch(origin + '/api/multiplayer/capabilities')).json()).toEqual({ multiplayer: false, reason: 'not_implemented', rooms: true, signaling: true });
    const authorization = await post('host-authorizations', { accessCode });
    expect(authorization.status).toBe(201);
    const grant = await authorization.json();
    const created = await post('rooms', {}, grant.capability);
    expect(created.status).toBe(201); expect(created.headers.get('cache-control')).toBe('no-store');
    const host = await created.json();
    expect(roomView.parse(host.room).role).toBe('host');
    const attempts = await Promise.all([post('join', { invitation: host.invitation.toLowerCase() }), post('join', { invitation: host.invitation })]);
    expect(attempts.map(r => r.status).sort()).toEqual([201, 409]);
    const guest = await attempts.find(r => r.status === 201)!.json();
    expect((await post('room/admission', { participantId: guest.room.participantId, admit: true }, guest.capability)).status).toBe(403);
    expect((await post('room/admission', { participantId: guest.room.participantId, admit: true }, host.capability)).status).toBe(200);
    expect(service.rooms!.store.authenticate(guest.capability, true).role).toBe('guest');
    expect((await post('room/invitation', {}, host.capability)).status).toBe(409);
    expect((await post('room/leave', {}, host.capability)).status).toBe(204);
    expect((await post('room/status', {}, guest.capability)).status).toBe(401);
    expect((await fetch(origin + '/')).status).toBe(200);
    expect(warnings).toEqual([]);
  });

  it('rejects spoofing, cross-origin access, query credentials, oversized bodies and invalid JSON', async () => {
    const { post, origin } = await start();
    expect((await post('host-authorizations', { accessCode }, undefined, { Origin: 'https://other.example' })).status).toBe(403);
    expect((await post('host-authorizations', { accessCode }, undefined, { 'X-Forwarded-For': '' })).status).toBe(403);
    expect((await post('host-authorizations?capability=not-a-real-token', { accessCode })).status).toBe(400);
    expect((await post('host-authorizations', { accessCode: 'x'.repeat(17 * 1024) })).status).toBe(413);
    expect((await post('host-authorizations', { accessCode }, undefined, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await fetch(origin + '/api/multiplayer/rooms')).status).toBe(405);
    expect((await fetch(origin + '/api/multiplayer/host-authorizations', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://low-pass.example', 'X-Forwarded-For': `${source},173.245.48.5` },
      body: '{' })).status).toBe(400);
    for (let i = 0; i < 5; i++) {
      expect((await post('host-authorizations', { accessCode: 'wrong' }, undefined,
        { 'X-Forwarded-For': `198.51.100.${i},${source},173.245.48.5` })).status).toBe(401);
    }
    const limited = await post('host-authorizations', { accessCode });
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
    const other = await post('host-authorizations', { accessCode }, undefined, { 'X-Forwarded-For': '203.0.113.11,173.245.48.5' });
    expect(other.status).toBe(201);
    const auth = await other.json();
    expect((await post('rooms', {}, auth.capability)).status).toBe(401);
  });

  it('keeps solo healthy with invalid optional configuration and an untrusted immediate proxy', async () => {
    for (const override of [{ LOW_PASS_PUBLIC_ORIGIN: 'https://secret.example/path' },
      { LOW_PASS_TRUSTED_PROXY_CIDRS: '0.0.0.0/0' }, { LOW_PASS_HOSTING_CODE_FILE: '/missing/private-file' }]) {
      const { origin } = await start({ ...env(), ...override });
      expect((await fetch(origin + '/')).status).toBe(200);
      expect((await fetch(origin + '/healthz')).status).toBe(200);
      expect((await fetch(origin + '/api/multiplayer/readyz')).status).toBe(503);
    }
    const { post } = await start({ ...env(), LOW_PASS_TRUSTED_PROXY_CIDRS: '10.0.0.0/8' });
    expect((await post('host-authorizations', { accessCode })).status).toBe(403);
    const publicSecret = join(staticRoot, 'public-secret');
    await writeFile(publicSecret, accessCode);
    expect(readServiceConfig({ ...env(), LOW_PASS_HOSTING_CODE_FILE: publicSecret }).multiplayer.status).toBe('unavailable');
    const blocked = await start({ ...env(), LOW_PASS_HOSTING_CODE_FILE: publicSecret });
    expect((await fetch(blocked.origin + '/public-secret')).status).toBe(404);
    expect((await fetch(blocked.origin + '/healthz')).status).toBe(200);
    await rm(publicSecret);
  });

  it('contains a room-maintenance failure without killing static serving', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { origin, post, service, warnings } = await start();
    vi.spyOn(service.rooms!.store, 'sweep').mockImplementationOnce(() => { throw new Error('Internal failure'); });
    vi.advanceTimersByTime(1000);
    expect(service.rooms!.available).toBe(false);
    expect(warnings).toEqual(['Multiplayer room maintenance failed; rooms disabled until restart.']);
    expect((await fetch(origin + '/healthz')).status).toBe(200);
    expect((await fetch(origin + '/api/multiplayer/readyz')).status).toBe(503);
    expect((await post('host-authorizations', { accessCode })).status).toBe(503);
  });
});
