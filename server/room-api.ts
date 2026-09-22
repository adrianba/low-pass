import type { Request, RequestHandler } from 'express';
import { admissionRequest, capability, emptyRequest, hostRequest, invitationRequest } from '../shared/protocol/rooms.js';
import type { RoomConfig } from './room-config.js';
import { ClientAddresses } from './client-address.js';
import { RoomError, RoomStore } from './room-store.js';
import { RoomLimits } from './room-limits.js';

const paths = new Set(['/api/multiplayer/host-authorizations', '/api/multiplayer/rooms', '/api/multiplayer/join',
  '/api/multiplayer/room/status', '/api/multiplayer/room/admission', '/api/multiplayer/room/invitation', '/api/multiplayer/room/leave']);

function bearer(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? '');
  if (!match || !capability.safeParse(match[1]).success) throw new RoomError('invalid_capability', 401);
  return match[1]!;
}
function body(request: Request): unknown {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new RoomError('json_required', 415);
  if (!Buffer.isBuffer(request.body)) throw new RoomError('invalid_json', 400);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body)); }
  catch { throw new RoomError('invalid_json', 400); }
}

export class RoomApi {
  readonly store: RoomStore;
  private readonly addresses: ClientAddresses;
  private readonly limits = new RoomLimits();
  private readonly sweep: ReturnType<typeof setInterval>;
  private failed = false;
  get available(): boolean { return !this.failed; }
  constructor(private readonly config: RoomConfig, warn: (message: string) => void) {
    this.store = new RoomStore(config.hostingDigest);
    this.addresses = new ClientAddresses(config.trustedProxyCidrs);
    this.sweep = setInterval(() => {
      try { this.store.sweep(); this.limits.sweep(); }
      catch {
        this.failed = true; clearInterval(this.sweep); this.store.close(); this.limits.clear();
        warn('Multiplayer room maintenance failed; rooms disabled until restart.');
      }
    }, 1000);
    this.sweep.unref();
  }
  readonly handle: RequestHandler = (request, response, next) => {
    if (!paths.has(request.path)) { next(); return; }
    try {
      if (this.failed) throw new RoomError('rooms_unavailable', 503);
      if (request.method !== 'POST') {
        response.set('Allow', 'POST'); throw new RoomError('method_not_allowed', 405);
      }
      this.limits.take('all', 4096);
      if (request.url.includes('?')) throw new RoomError('query_not_allowed', 400);
      if (request.headers.origin !== this.config.origin) throw new RoomError('origin_rejected', 403);
      let source: string;
      try { source = this.addresses.read(request); }
      catch { throw new RoomError('invalid_proxy_chain', 403); }
      this.limits.take(`source:${source}`, 240);
      const data = body(request);
      if (request.path === '/api/multiplayer/host-authorizations') {
        this.limits.take('host-global', 60); this.limits.take(`host:${source}`, 5);
        const parsed = hostRequest.safeParse(data);
        if (!parsed.success) throw new RoomError('invalid_request', 400);
        response.status(201).json(this.store.authorize(parsed.data.accessCode, source)); return;
      }
      if (request.path === '/api/multiplayer/join') {
        this.limits.take('join-global', 120); this.limits.take(`join:${source}`, 10);
        const parsed = invitationRequest.safeParse(data);
        if (!parsed.success) throw new RoomError('invalid_request', 400);
        response.status(201).json(this.store.join(parsed.data.invitation)); return;
      }
      const credential = bearer(request);
      if (request.path !== '/api/multiplayer/rooms') {
        const member = this.store.authenticate(credential);
        this.limits.take(`room:${member.roomId}`, 240);
        this.limits.take(`member:${member.participantId}`, 120);
      }
      if (request.path === '/api/multiplayer/room/admission') {
        const parsed = admissionRequest.safeParse(data);
        if (!parsed.success) throw new RoomError('invalid_request', 400);
        response.json({ room: this.store.admit(credential, parsed.data.participantId, parsed.data.admit) }); return;
      }
      if (!emptyRequest.safeParse(data).success) throw new RoomError('invalid_request', 400);
      if (request.path === '/api/multiplayer/rooms') {
        this.limits.take(`create:${source}`, 4, 10 * 60_000);
        response.status(201).json(this.store.create(credential, source));
      } else if (request.path === '/api/multiplayer/room/status') {
        response.json({ room: this.store.status(credential) });
      } else if (request.path === '/api/multiplayer/room/invitation') {
        response.json(this.store.rotate(credential));
      } else {
        this.store.leave(credential); response.status(204).end();
      }
    } catch (error) {
      if (!(error instanceof RoomError)) { next(error); return; }
      if (error.status === 429) response.set('Retry-After', '60');
      response.status(error.status).json({ error: error.code });
    }
  };
  close(): void { this.failed = true; clearInterval(this.sweep); this.store.close(); this.limits.clear(); }
}
