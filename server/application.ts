import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import express from 'express';
import type { ServiceConfig } from './config.js';
import { compress, httpErrors, securityHeaders, staticFiles, validateStaticRoot } from './static.js';
import { RoomApi } from './room-api.js';

export class ApplicationService {
  private closing: Promise<void> | null = null;
  private readonly sockets = new Set<Socket>();
  readonly rooms: RoomApi | null;
  readonly server = createServer({
    maxHeaderSize: 8192,
    headersTimeout: 5000,
    requestTimeout: 10_000,
    keepAliveTimeout: 5000,
    connectionsCheckingInterval: 1000,
  });

  constructor(private readonly config: ServiceConfig, private readonly warn: (message: string) => void) {
    const root = validateStaticRoot(config.staticRoot);
    this.rooms = config.multiplayer.status === 'rooms' ? new RoomApi(config.multiplayer.config, warn) : null;
    const app = express();
    app.disable('x-powered-by');
    app.set('case sensitive routing', true);
    app.set('strict routing', true);
    app.use(securityHeaders, compress);
    app.use((_request, response, next) => {
      if (this.closing) { response.status(503).json({ error: 'shutting_down' }); return; }
      next();
    });
    const bodyLimit = express.raw({ type: () => true, limit: 16 * 1024, inflate: false });
    app.use((request, response, next) => {
      let path: string;
      try { path = decodeURIComponent(request.path); }
      catch { response.status(400).json({ error: 'invalid_path' }); return; }
      if (path === '/api' || path.startsWith('/api/') || path === '/signal' || path.startsWith('/signal/')) {
        bodyLimit(request, response, next);
      } else next();
    });
    if (this.rooms) app.use(this.rooms.handle);
    app.use((request, response, next) => {
      const path = decodeURIComponent(request.path);
      const known = ['/healthz', '/livez', '/readyz', '/api/multiplayer/readyz', '/api/multiplayer/capabilities'].includes(path);
      if (!known) {
        if (path === '/api' || path.startsWith('/api/') || path === '/signal' || path.startsWith('/signal/')) {
          response.status(404).json({ error: 'not_found' });
        } else next();
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.set('Allow', 'GET, HEAD').status(405).json({ error: 'method_not_allowed' });
      } else if (path === '/healthz') {
        response.type('text/plain').send('ok\n');
      } else if (path === '/livez') {
        response.json({ status: 'ok' });
      } else if (path === '/api/multiplayer/readyz' && (config.multiplayer.status === 'unavailable' || this.rooms?.available === false)) {
        response.status(503).json({ error: 'multiplayer_unavailable',
          reason: this.rooms?.available === false ? 'service_error' : config.multiplayer.reason });
      } else if (path === '/readyz' || path === '/api/multiplayer/readyz') {
        response.json({ status: 'ready', multiplayer: false, ...(this.rooms ? { rooms: this.rooms.available } : {}) });
      } else response.json({ multiplayer: false, reason: this.rooms?.available === false ? 'service_error' : config.multiplayer.reason,
        ...(this.rooms ? { rooms: this.rooms.available } : {}) });
    });
    app.use(...staticFiles(root, config.privateFiles));
    app.use(httpErrors(warn));
    this.server.on('request', app);
    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.maxRequestsPerSocket = 100;
    this.server.maxConnections = 128;
  }

  async listen(): Promise<number> {
    if (this.closing) throw new Error('Cannot start a closed application service.');
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { reject(error); };
      this.server.once('error', failed);
      this.server.listen(this.config.port, this.config.host, () => {
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
    this.rooms?.close();
    this.closing = new Promise<void>((resolve, reject) => {
      if (!this.server.listening) { resolve(); return; }
      const deadline = setTimeout(() => {
        this.warn('Application shutdown deadline reached; closing remaining HTTP connections.');
        this.server.closeAllConnections();
        for (const socket of this.sockets) socket.destroy();
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
