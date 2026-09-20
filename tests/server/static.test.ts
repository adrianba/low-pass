import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { ApplicationService } from '../../server/application.js';
import { readServiceConfig } from '../../server/config.js';
import { assetFixture, model, script } from './fixtures.js';

let root: string;
let service: ApplicationService;
let port: number;
const warnings: string[] = [];
beforeAll(async () => {
  root = await assetFixture();
  await mkdir(join(root, 'api/multiplayer'), { recursive: true });
  await writeFile(join(root, 'api/multiplayer/rooms'), 'must not serve reserved files');
  service = new ApplicationService({ ...readServiceConfig({}), staticRoot: root, port: 0, shutdownTimeoutMs: 50 },
    message => warnings.push(message));
  port = await service.listen();
});
afterEach(() => { expect(warnings.splice(0)).toEqual([]); });
afterAll(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });

function get(path: string, headers: import('node:http').OutgoingHttpHeaders = {}, method = 'GET', chunks: string[] = []) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const received: Buffer[] = [];
      res.on('data', chunk => received.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(received) }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

describe('built-asset HTTP contract', () => {
  it('serves the index, health, HEAD and appropriate cache classes with security headers', async () => {
    for (const path of ['/', '/index.html']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.body.toString()).toContain('Low Pass fixture');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['content-type']).toContain('text/html');
    }
    const head = await get('/', {}, 'HEAD');
    expect(head.body.length).toBe(0);
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0);
    expect((await get('/healthz')).body.toString()).toBe('ok\n');
    const js = await get('/assets/index-12345678.js');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.headers['content-type']).toMatch(/javascript/);
    const binary = await get('/assets/model.glb');
    expect(binary.headers['content-type']).toBe('model/gltf-binary');
    expect(binary.headers['cache-control']).toBe('no-cache');
    expect(binary.body).toEqual(model);
    for (const path of ['/', '/api/multiplayer/rooms', '/.private', '/assets/missing.js']) {
      const res = await get(path);
      expect(res.headers['content-security-policy']).toContain("connect-src 'self'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('same-origin');
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('preserves validators and ranges, without compressing partial binary responses', async () => {
    const initial = await get('/assets/model.glb');
    expect(initial.headers.etag).toBeTypeOf('string');
    expect(initial.headers['last-modified']).toBeTypeOf('string');
    for (const headers of [
      { 'If-None-Match': String(initial.headers.etag) },
      { 'If-Modified-Since': String(initial.headers['last-modified']) },
    ]) {
      const res = await get('/assets/model.glb', headers);
      expect(res.status).toBe(304);
      expect(res.body.length).toBe(0);
      expect(res.headers['cache-control']).toBe('no-cache');
    }
    const range = await get('/assets/model.glb', { Range: 'bytes=2-9', 'Accept-Encoding': 'gzip' });
    expect(range.status).toBe(206);
    expect(range.body).toEqual(model.subarray(2, 10));
    expect(range.headers['content-range']).toBe('bytes 2-9/256');
    expect(range.headers['content-encoding']).toBeUndefined();
    const invalid = await get('/assets/model.glb', { Range: 'bytes=999-1000' });
    expect(invalid.status).toBe(416);
    expect(invalid.headers['content-range']).toBe('bytes */256');
    const stale = await get('/assets/model.glb', { Range: 'bytes=2-9', 'If-Range': '"stale"' });
    expect(stale.status).toBe(200);
    expect(stale.body).toEqual(model);
  });

  it.each(['gzip', 'deflate', 'br', 'identity', 'gzip;q=0, br;q=0, deflate;q=0'])('negotiates %s correctly', async encoding => {
    const res = await get('/assets/index-12345678.js', { 'Accept-Encoding': encoding });
    expect(res.status).toBe(200);
    expect(res.headers.vary).toContain('Accept-Encoding');
    const decompress = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync };
    const selected = res.headers['content-encoding'];
    if (encoding in decompress) expect(selected).toBe(encoding);
    else expect(selected).toBeUndefined();
    const bytes = selected === 'gzip' || selected === 'deflate' || selected === 'br'
      ? decompress[selected](res.body) : res.body;
    expect(bytes.toString()).toBe(script);
  });

  it.each(['/missing', '/index', '/assets/', '/.private', '/%2eprivate', '/node_modules/express/package.json',
    '/server/index.js', '/dist-server/index.js', '/src/main.ts', '/api/multiplayer/rooms', '/signal'])(
    'does not expose or fall back for %s', async path => {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body.toString())).toEqual({ error: 'not_found' });
    });

  it.each(['/%zz', '/%00', '/%2e%2e/private', '/assets/%2e%2e/%2e%2e/private', '/%5cprivate'])(
    'rejects malformed or traversal paths %s', async path => {
      const res = await get(path);
      expect(res.status).toBe(400);
      expect(res.body.toString()).not.toContain(root);
    });

  it.each(['/api/multiplayer/rooms', '/signal'])('bounds every content type and chunked body at %s', async path => {
    for (const type of ['application/json', 'text/plain', 'application/octet-stream', '']) {
      const headers = type ? { 'Content-Type': type } : {};
      const res = await get(path, headers, 'POST', ['x'.repeat(8192), 'x'.repeat(8193)]);
      expect(res.status).toBe(413);
    }
    expect((await get(path, {}, 'POST', ['x'.repeat(16 * 1024)])).status).toBe(404);
    expect((await get(path, { 'Content-Length': '17000' }, 'POST', ['x'.repeat(17000)])).status).toBe(413);
  });

  it('rejects symbolic links at startup and prevents later root escape', async () => {
    const fixture = await assetFixture();
    try {
      await symlink(root, join(fixture, 'escape'), 'junction');
      expect(() => new ApplicationService({ ...readServiceConfig({}), staticRoot: fixture }, () => {})).toThrow(/regular files/);
      await symlink(fixture, join(root, 'escape'), 'junction');
      expect((await get('/escape/index.html')).status).toBe(403);
    } finally {
      await rm(join(root, 'escape'), { force: true, recursive: true });
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('survives aborted static downloads and incomplete request bodies', async () => {
    for (const text of ['GET /assets/index-12345678.js HTTP/1.1\r\nHost: localhost\r\n\r\n',
      'POST /signal HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\npartial']) {
      const socket = connect(port, '127.0.0.1');
      await once(socket, 'connect');
      socket.write(text);
      socket.destroy();
      await once(socket, 'close');
    }
    expect((await get('/healthz')).status).toBe(200);
  });
});

it('bounds shutdown even with a socket upgraded on the actual application server', async () => {
  const messages: string[] = [];
  const upgraded = new ApplicationService({ ...readServiceConfig({}), staticRoot: root, port: 0, shutdownTimeoutMs: 50 },
    message => messages.push(message));
  upgraded.server.on('upgrade', (_request, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
  });
  const port = await upgraded.listen();
  const socket = connect(port, '127.0.0.1');
  try {
    await once(socket, 'connect');
    socket.write('GET /signal HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
    await once(socket, 'data');
    const closed = once(socket, 'close');
    await upgraded.close();
    await closed;
    expect(messages).toEqual(['Application shutdown deadline reached; closing remaining HTTP connections.']);
  } finally { socket.destroy(); await upgraded.close(); }
});
