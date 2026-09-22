import { createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { KeyObject } from 'node:crypto';
import { iceConfiguration } from '../shared/protocol/ice.js';
import type { IceConfiguration } from '../shared/protocol/ice.js';
import { hashSecret, RoomError, ROOM_LIMITS } from './room-store.js';
import type { RoomStore } from './room-store.js';
import type { TurnConfig } from './turn-config.js';

export const TURN_LIMITS = Object.freeze({ lifetimeMs: 600_000, minimumMs: 60_000, skewMs: 30_000 });
interface Cached {
  servers: IceConfiguration['iceServers']; expiresAtMs: number; refreshAt: number;
}

export class TurnCredentials {
  private key: KeyObject | null;
  private readonly cache = new Map<string, Cached>();
  private readonly unsubscribe: () => void;
  private anchor: { wall: number; monotonic: number } | null = null;
  private lastMonotonic = -Infinity;
  constructor(private readonly config: TurnConfig, private readonly store: RoomStore,
    private readonly warn: (message: string) => void,
    private readonly clock: () => { wall: number; monotonic: number } = () => ({ wall: Date.now(), monotonic: performance.now() })) {
    this.key = config.key;
    this.unsubscribe = store.subscribe(() => {
      for (const digest of this.cache.keys()) if (!store.hasDigest(digest)) this.cache.delete(digest);
    });
  }
  get available(): boolean { return this.key !== null; }
  get size(): number { return this.cache.size; }
  issue(credential: string): IceConfiguration {
    if (!this.key) throw new RoomError('turn_unavailable', 503);
    const now = this.clock();
    const digest = hashSecret(credential), member = this.store.authenticateDigest(digest, true);
    const room = this.store.peekDigest(digest)!;
    const anchor = this.anchor ?? now;
    if (!Number.isSafeInteger(now.wall) || now.wall < 0 || !Number.isFinite(now.monotonic) ||
      now.monotonic < this.lastMonotonic || Math.abs((now.wall - anchor.wall) - (now.monotonic - anchor.monotonic)) > TURN_LIMITS.skewMs) {
      this.warn('TURN credential clock is unreliable; issuance disabled until restart.');
      this.close(); throw new RoomError('turn_clock_error', 503);
    }
    this.anchor = anchor; this.lastMonotonic = now.monotonic;
    let cached = this.cache.get(digest);
    if (!cached || now.monotonic >= cached.refreshAt || now.wall >= cached.expiresAtMs - 1000) {
      const lifetime = Math.min(TURN_LIMITS.lifetimeMs, Math.floor(room.expiresInMs / 1000) * 1000);
      if (lifetime < TURN_LIMITS.minimumMs) throw new RoomError('room_expiring', 409);
      if (!cached && this.cache.size >= ROOM_LIMITS.rooms * 2) throw new RoomError('capacity', 503);
      const expires = Math.floor((now.wall + lifetime) / 1000);
      const username = `${expires}:${member.roomId}:${member.participantId}`;
      const password = createHmac('sha1', this.key).update(username).digest('base64');
      const stun = this.config.urls.filter(url => url.startsWith('stun:'));
      cached = { expiresAtMs: expires * 1000, refreshAt: now.monotonic + lifetime / 2,
        servers: [
          ...(stun.length ? [{ urls: stun }] : []),
          { urls: this.config.urls.filter(url => !url.startsWith('stun:')), username,
            credential: password, credentialType: 'password' },
        ] };
      this.cache.set(digest, cached);
    }
    return iceConfiguration.parse({ iceServers: cached.servers, serverTimeMs: now.wall,
      expiresAtMs: cached.expiresAtMs,
      refreshAfterMs: Math.max(1, Math.floor(Math.min(cached.refreshAt - now.monotonic, cached.expiresAtMs - now.wall - 1))) });
  }
  close(): void { this.key = null; this.cache.clear(); this.unsubscribe(); }
}
