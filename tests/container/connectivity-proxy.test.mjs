import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { connectivityProxy } from '../../scripts/connectivity-proxy.mjs';

test('local diagnostic proxy forwards HTTP and actual WebSocket bytes, then closes both sides', async t => {
  const upstream = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ forwarded: request.headers['x-forwarded-for'], origin: request.headers.origin }));
  });
  const wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (request, socket, head) => {
    assert.equal(request.headers['x-forwarded-for'], '203.0.113.10');
    wss.handleUpgrade(request, socket, head, peer => peer.on('message', data => peer.send(data.toString())));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = connectivityProxy(upstream.address().port);
  proxy.server.listen(0, '127.0.0.1'); await once(proxy.server, 'listening');
  t.after(async () => {
    if (proxy.server.listening) await proxy.close();
    for (const peer of wss.clients) peer.terminate();
    wss.close();
    await new Promise(resolve => upstream.close(resolve));
  });
  const url = `http://127.0.0.1:${proxy.server.address().port}`;
  assert.deepEqual(await (await globalThis.fetch(url + '/api/multiplayer/readyz', {
    headers: { Origin: 'http://localhost:8080', 'X-Forwarded-For': 'untrusted-prefix' },
  })).json(), { forwarded: '203.0.113.10', origin: 'http://localhost:8080' });
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/signal', { origin: 'http://localhost:8080' });
  ws.on('error', () => {});
  await once(ws, 'open');
  const delivered = once(ws, 'message'); ws.send('local-only-fixture');
  assert.equal((await delivered)[0].toString(), 'local-only-fixture');
  const closed = once(ws, 'close'); await proxy.close(); await closed;
  assert.equal(ws.readyState, WebSocket.CLOSED);
});
