import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';
import { ApplicationService } from '../../server/application.js';
import { readServiceConfig } from '../../server/config.js';

const services: ApplicationService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

async function start(warn: (message: string) => void = message => { throw new Error(message); }) {
  const service = new ApplicationService({
    ...readServiceConfig({}), port: 0, shutdownTimeoutMs: 50,
  }, warn);
  services.push(service);
  const port = await service.listen();
  return { service, port, origin: `http://127.0.0.1:${port}` };
}

describe('optional application service', () => {
  it('exposes real runtime health without advertising multiplayer or room endpoints', async () => {
    const { service, origin } = await start();
    expect(service.server.address()).toMatchObject({ address: '127.0.0.1' });
    for (const [path, body] of [
      ['/livez', { status: 'ok' }],
      ['/readyz', { status: 'ready', multiplayer: false }],
      ['/api/multiplayer/capabilities', { multiplayer: false, reason: 'not_implemented' }],
    ] as const) {
      const response = await fetch(origin + path);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response.json()).toEqual(body);
    }
    for (const path of ['/api/multiplayer/rooms', '/signal', '/']) {
      const response = await fetch(origin + path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
  });

  it('handles HEAD and unsupported methods explicitly', async () => {
    const { origin } = await start();
    const head = await fetch(origin + '/readyz', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await head.text()).toBe('');
    const post = await fetch(origin + '/readyz', { method: 'POST', body: 'ignored' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect(await post.json()).toEqual({ error: 'method_not_allowed' });
  });

  it('surfaces binding failures and closes idempotently', async () => {
    const { service, port } = await start();
    const conflicting = new ApplicationService({ ...readServiceConfig({}), port }, () => {});
    await expect(conflicting.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await conflicting.close();
    expect(service.close()).toBe(service.close());
    await service.close();
    await expect(service.listen()).rejects.toThrow(/closed/);
  });

  it('bounds shutdown of an active HTTP request and reports the forced close', async () => {
    const warnings: string[] = [];
    const { service, port } = await start(message => warnings.push(message));
    service.server.removeAllListeners('request');
    const received = new Promise<void>(resolve => { service.server.once('request', () => resolve()); });
    const socket = connect(port, '127.0.0.1');
    const errors: Error[] = [];
    socket.on('error', error => errors.push(error));
    try {
      await once(socket, 'connect');
      socket.write('GET /held HTTP/1.1\r\nHost: localhost\r\n\r\n');
      await received;
      const closed = new Promise<void>(resolve => { socket.once('close', () => resolve()); });
      await service.close();
      await closed;
      for (const error of errors) expect(error).toMatchObject({ code: 'ECONNRESET' });
      expect(warnings).toEqual(['Application shutdown deadline reached; closing remaining HTTP connections.']);
    } finally { socket.destroy(); }
  });
});

describe('service configuration', () => {
  it('defaults to private disabled operation and accepts bounded overrides', () => {
    expect(readServiceConfig({})).toEqual({ port: 8081, shutdownTimeoutMs: 5000, multiplayerEnabled: false });
    expect(readServiceConfig({ LOW_PASS_SERVICE_PORT: '9081', LOW_PASS_SHUTDOWN_TIMEOUT_MS: '150',
      LOW_PASS_MULTIPLAYER_ENABLED: 'false' }))
      .toEqual({ port: 9081, shutdownTimeoutMs: 150, multiplayerEnabled: false });
  });

  it.each(['', '0', '-1', '65536', '1.5', 'Infinity', ' 8081', '8e3'])('rejects invalid port %j', port => {
    expect(() => readServiceConfig({ LOW_PASS_SERVICE_PORT: port })).toThrow(/LOW_PASS_SERVICE_PORT/);
  });

  it('rejects unsupported multiplayer activation and invalid deadlines without echoing input', () => {
    expect(() => readServiceConfig({ LOW_PASS_MULTIPLAYER_ENABLED: 'true' })).toThrow(/not implemented/);
    expect(() => readServiceConfig({ LOW_PASS_SHUTDOWN_TIMEOUT_MS: '30001' })).toThrow(/SHUTDOWN_TIMEOUT/);
    expect(() => readServiceConfig({ LOW_PASS_SERVICE_PORT: 'secret-value' })).toThrow(
      'LOW_PASS_SERVICE_PORT must be an integer from 1 to 65535.');
  });
});
