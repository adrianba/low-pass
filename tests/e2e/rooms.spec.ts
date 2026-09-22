import { test, expect } from '@playwright/test';
import { createServer, request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { ApplicationService } from '../../server/application.js';
import { readServiceConfig } from '../../server/config.js';
import { hashSecret } from '../../server/room-store.js';

test('two isolated browsers use private rooms without sharing capabilities or changing local records', async ({ browser }) => {
  const code = 'browser-only-dummy-hosting-code-for-private-room-tests';
  let targetPort = 0;
  const proxy = createServer((request, response) => {
    if (request.url === '/room-fixture') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<title>Private room fixture</title><link rel="icon" href="data:,">'); return;
    }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: targetPort, path: request.url, method: request.method,
      headers: { ...request.headers, 'x-forwarded-for': '203.0.113.10' } }, received => {
      response.writeHead(received.statusCode!, received.headers); received.pipe(response);
    });
    upstream.on('error', error => { response.destroy(error); });
    request.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy address.');
  const origin = `http://127.0.0.1:${address.port}`, warnings: string[] = [];
  const service = new ApplicationService({ ...readServiceConfig({}), staticRoot: resolve('dist'), port: 0,
    multiplayer: { status: 'rooms', reason: 'not_implemented',
      config: { origin, hostingDigest: hashSecret(code), trustedProxyCidrs: ['127.0.0.1/32'] } } },
  message => warnings.push(message));
  proxy.on('upgrade', (request, socket, head) => {
    request.headers['x-forwarded-for'] = '203.0.113.10';
    service.server.emit('upgrade', request, socket, head);
  });
  const host = await browser.newContext(), guest = await browser.newContext();
  try {
    targetPort = await service.listen();
    const hostPage = await host.newPage(), guestPage = await guest.newPage();
    const errors: string[] = [];
    for (const page of [hostPage, guestPage]) page.on('pageerror', error => errors.push(error.message));
    await Promise.all([hostPage.goto(origin + '/room-fixture'), guestPage.goto(origin + '/room-fixture')]);
    const created = await hostPage.evaluate(async accessCode => {
      localStorage.setItem('low-pass.records.v1', 'host-existing-records');
      const grant = await (await fetch('/api/multiplayer/host-authorizations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessCode }),
      })).json();
      const response = await fetch('/api/multiplayer/rooms', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.capability}` }, body: '{}' });
      return { status: response.status, body: await response.json() };
    }, code);
    expect(created.status).toBe(201);
    const joined = await guestPage.evaluate(async invitation => {
      localStorage.setItem('low-pass.records.v1', 'guest-existing-records');
      const response = await fetch('/api/multiplayer/join', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invitation }) });
      return { status: response.status, body: await response.json() };
    }, created.body.invitation);
    expect(joined.status).toBe(201);
    expect(joined.body.capability).not.toBe(created.body.capability);
    expect(joined.body.room).toMatchObject({ role: 'guest', state: 'pending' });
    const admitted = await hostPage.evaluate(async ({ credential, id }) => {
      const response = await fetch('/api/multiplayer/room/admission', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
        body: JSON.stringify({ participantId: id, admit: true }) });
      return { status: response.status, body: await response.json() };
    }, { credential: created.body.capability, id: joined.body.room.participantId });
    expect(admitted.status).toBe(200); expect(admitted.body.room.state).toBe('admitted');
    const hostSocket = await hostPage.evaluateHandle(credential => new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/signal');
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', version: 1, capability: credential }));
      socket.onerror = () => reject(new Error('Host signaling failed.'));
      socket.onmessage = event => { if (JSON.parse(event.data).type === 'authenticated') resolve(socket); };
    }), created.body.capability);
    const guestSocket = await guestPage.evaluateHandle(credential => new Promise<{ socket: WebSocket; offer: Promise<unknown> }>((resolve, reject) => {
      const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/signal');
      let offered!: (value: unknown) => void;
      const offer = new Promise<unknown>(resolve => { offered = resolve; });
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', version: 1, capability: credential }));
      socket.onerror = () => reject(new Error('Guest signaling failed.'));
      socket.onmessage = event => {
        const value = JSON.parse(event.data);
        if (value.type === 'authenticated') resolve({ socket, offer });
        if (value.type === 'offer') offered(value);
      };
    }), joined.body.capability);
    const delivered = guestSocket.evaluate(connection => connection.offer);
    await hostSocket.evaluate(socket => socket.send(JSON.stringify({ type: 'offer', generation: 1, sdp: 'v=0\r\n' })));
    expect(await delivered).toEqual({ type: 'offer', generation: 1, sdp: 'v=0\r\n', from: 'host' });
    expect(await hostPage.evaluate(() => ({ ...localStorage }))).toEqual({ 'low-pass.records.v1': 'host-existing-records' });
    expect(await guestPage.evaluate(() => ({ ...localStorage }))).toEqual({ 'low-pass.records.v1': 'guest-existing-records' });
    expect(errors).toEqual([]); expect(warnings).toEqual([]);
  } finally {
    await Promise.all([host.close(), guest.close()]);
    await service.close();
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  }
});
