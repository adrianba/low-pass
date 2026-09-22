import { createServer, request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';

// Loopback-only fixture proxy, not a production proxy or source-IP policy.
export function connectivityProxy(targetPort) {
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error('Invalid test upstream port.');
  const sockets = new Set();
  const options = request => ({ hostname: '127.0.0.1', port: targetPort, path: request.url, method: request.method,
    headers: { ...request.headers, 'x-forwarded-for': '203.0.113.10' } });
  const server = createServer({ headersTimeout: 5000, requestTimeout: 10_000, maxHeaderSize: 8192 }, (request, response) => {
    const upstream = httpRequest(options(request), received => {
      response.writeHead(received.statusCode, received.headers); received.pipe(response);
      received.on('error', () => response.destroy());
    });
    upstream.setTimeout(10_000, () => upstream.destroy());
    upstream.on('error', () => {
      if (response.destroyed) return;
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end('Local diagnostic upstream unavailable.\n');
    });
    request.on('aborted', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.maxConnections = 64;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    const upstream = httpRequest(options(request));
    upstream.setTimeout(10_000, () => upstream.destroy());
    upstream.on('upgrade', (response, peer, receivedHead) => {
      peer.setTimeout(0);
      if (socket.destroyed) { peer.destroy(); return; }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
        .map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`);
      if (head.length) peer.write(head);
      if (receivedHead.length) socket.write(receivedHead);
      socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
      socket.once('close', () => peer.destroy()); peer.once('close', () => socket.destroy());
      socket.pipe(peer).pipe(socket);
    });
    upstream.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); });
    upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.end();
  });
  return { server, close: () => new Promise((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    server.close(error => error ? reject(error) : resolve());
  }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const upstream = Number(process.env.CONNECTIVITY_UPSTREAM_PORT), port = Number(process.env.CONNECTIVITY_PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid diagnostic port.');
  const proxy = connectivityProxy(upstream);
  proxy.server.on('error', () => { console.error('Local diagnostic listener failed.'); process.exitCode = 1; });
  proxy.server.listen(port, '127.0.0.1', () => console.info(`Local diagnostic: http://localhost:${port}/connectivity.html`));
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (closing) return;
    closing = true;
    void proxy.close().catch(() => { console.error('Local diagnostic shutdown failed.'); process.exitCode = 1; });
  });
}
