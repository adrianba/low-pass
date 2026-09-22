import { createServer, request as httpRequest } from 'node:http';
import { createSecretKey } from 'node:crypto';
import { resolve } from 'node:path';
import { ApplicationService } from '../../server/application.js';
import { readServiceConfig } from '../../server/config.js';
import { hashSecret } from '../../server/room-store.js';

export async function roomService() {
  const code = 'browser-only-dummy-hosting-code-for-private-room-tests';
  let targetPort = 0;
  const proxy = createServer((request, response) => {
    if (request.url === '/room-fixture' || request.url === '/rtc-fixture') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<title>Private room fixture</title><link rel="icon" href="data:,">' +
        (request.url === '/rtc-fixture' ? '<script src="/rtc-fixture.js"></script>' : '')); return;
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
      config: { origin, hostingDigest: hashSecret(code), trustedProxyCidrs: ['127.0.0.1/32'],
        turn: { urls: ['turn:127.0.0.1:9?transport=udp'],
          key: createSecretKey(Buffer.from('dummy-coturn-key-for-browser-fixture-only')) } } } },
  message => warnings.push(message));
  proxy.on('upgrade', (request, socket, head) => {
    request.headers['x-forwarded-for'] = '203.0.113.10';
    service.server.emit('upgrade', request, socket, head);
  });
  targetPort = await service.listen();
  return { origin, code, service, warnings, close: async () => {
    await service.close();
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  } };
}
