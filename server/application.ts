import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { ServiceConfig } from './config.js';

function json(response: ServerResponse, status: number, value: object, head = false): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(head ? undefined : body);
}

export class ApplicationService {
  private closing: Promise<void> | null = null;
  readonly server = createServer({
    maxHeaderSize: 8192,
    headersTimeout: 5000,
    requestTimeout: 10_000,
    keepAliveTimeout: 5000,
    connectionsCheckingInterval: 1000,
  }, (request, response) => {
    const path = request.url?.split('?', 1)[0];
    const head = request.method === 'HEAD';
    const known = path === '/livez' || path === '/readyz' ||
      path === '/api/multiplayer/readyz' || path === '/api/multiplayer/capabilities';
    if (!known) {
      json(response, 404, { error: 'not_found' }, head);
    } else if (request.method !== 'GET' && !head) {
      response.setHeader('Allow', 'GET, HEAD');
      json(response, 405, { error: 'method_not_allowed' });
    } else if (this.closing) {
      json(response, 503, { error: 'shutting_down' }, head);
    } else if (path === '/livez') {
      json(response, 200, { status: 'ok' }, head);
    } else if (path === '/api/multiplayer/readyz' && this.config.multiplayer.status === 'unavailable') {
      json(response, 503, { error: 'multiplayer_unavailable', reason: this.config.multiplayer.reason }, head);
    } else if (path === '/readyz' || path === '/api/multiplayer/readyz') {
      json(response, 200, { status: 'ready', multiplayer: false }, head);
    } else {
      json(response, 200, { multiplayer: false, reason: this.config.multiplayer.reason }, head);
    }
  });

  constructor(private readonly config: ServiceConfig, private readonly warn: (message: string) => void) {
    this.server.maxRequestsPerSocket = 100;
    this.server.maxConnections = 128;
  }

  async listen(): Promise<number> {
    if (this.closing) throw new Error('Cannot start a closed application service.');
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { reject(error); };
      this.server.once('error', failed);
      this.server.listen(this.config.port, '127.0.0.1', () => {
        this.server.removeListener('error', failed);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing application listener address.');
    return address.port;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = new Promise<void>((resolve, reject) => {
      if (!this.server.listening) { resolve(); return; }
      const deadline = setTimeout(() => {
        this.warn('Application shutdown deadline reached; closing remaining HTTP connections.');
        this.server.closeAllConnections();
      }, this.config.shutdownTimeoutMs);
      this.server.close(error => {
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve();
      });
    });
    return this.closing;
  }
}
