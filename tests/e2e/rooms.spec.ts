import { test, expect } from '@playwright/test';
import { roomService } from '../helpers/room-service.js';

test('two isolated browsers use private rooms without sharing capabilities or changing local records', async ({ browser }) => {
  const fixture = await roomService(), { code, origin, warnings } = fixture;
  const host = await browser.newContext(), guest = await browser.newContext();
  try {
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
    const ice = await guestPage.evaluate(async capability => {
      const response = await fetch('/api/multiplayer/room/ice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capability}` }, body: '{}',
      });
      const config = await response.json();
      const peer = new RTCPeerConnection({ iceServers: config.iceServers });
      peer.close();
      return { status: response.status, refreshAfterMs: config.refreshAfterMs, username: config.iceServers[0].username };
    }, joined.body.capability);
    expect(ice.status).toBe(200); expect(ice.refreshAfterMs).toBeGreaterThan(0);
    expect(ice.username).toContain(joined.body.room.participantId);
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
    await fixture.close();
  }
});
