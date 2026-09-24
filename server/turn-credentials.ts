import { createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { KeyObject } from 'node:crypto';
import { iceConfiguration } from '../shared/protocol/ice.js';
import type { IceConfiguration } from '../shared/protocol/ice.js';
import { hashSecret, RoomError, ROOM_LIMITS } from './room-store.js';
import type { RoomStore } from './room-store.js';
import type { TurnConfig } from './turn-config.js';

export const TURN_LIMITS = Object.freeze({ lifetimeMs: 600_000, minimumMs: 60_000, skewMs: 30_000,
  recoveryMs: 30_000, recoveryToleranceMs: 1000, recoverySampleGapMs: 5000 });
interface ClockSample { wall: number; monotonic: number }
interface Cached {
  servers: IceConfiguration['iceServers']; expiresAtMs: number; refreshAt: number;
}

export class TurnCredentials {
  private key: KeyObject | null;
  private readonly cache = new Map<string, Cached>();
  private readonly unsubscribe: () => void;
  private anchor: ClockSample | null = null;
  private recovering = false;
  private stableSince: ClockSample | null = null;
  private lastMonotonic = -Infinity;
  constructor(private readonly config: TurnConfig, private readonly store: RoomStore,
    private readonly warn: (message: string) => void,
    private readonly clock: () => { wall: number; monotonic: number } = () => ({ wall: Date.now(), monotonic: performance.now() })) {
    this.key = config.key;
    this.unsubscribe = store.subscribe(() => {
      for (const digest of this.cache.keys()) if (!store.hasDigest(digest)) this.cache.delete(digest);
    });
  }
  get available(): boolean { return this.key !== null && !this.recovering; }
  get size(): number { return this.cache.size; }
  checkClock(now: ClockSample = this.clock()): boolean {
    if (!this.key) return false;
    const valid = Number.isSafeInteger(now.wall) && now.wall >= 0 &&
      Number.isSafeInteger(now.wall + TURN_LIMITS.lifetimeMs) && Number.isFinite(now.monotonic) &&
      now.monotonic >= 0 && now.monotonic >= this.lastMonotonic;
    const difference = (sample: ClockSample) => Math.abs((now.wall - sample.wall) - (now.monotonic - sample.monotonic));
    const previous = this.lastMonotonic;
    if (valid) this.lastMonotonic = now.monotonic;
    if (!valid || !this.recovering && this.anchor && difference(this.anchor) > TURN_LIMITS.skewMs) {
      if (!this.recovering) this.warn('TURN credential clock is unreliable; issuance paused while waiting for a stable clock.');
      this.recovering = true; this.cache.clear(); this.stableSince = valid ? { ...now } : null;
      return false;
    }
    if (this.recovering) {
      if (!this.stableSince || now.monotonic - previous > TURN_LIMITS.recoverySampleGapMs ||
        difference(this.stableSince) > TURN_LIMITS.recoveryToleranceMs) this.stableSince = { ...now };
      if (now.monotonic - this.stableSince.monotonic < TURN_LIMITS.recoveryMs) return false;
      this.anchor = { ...now }; this.stableSince = null; this.recovering = false;
      this.warn('TURN credential clock stabilized; issuance resumed with fresh credentials.');
    }
    this.anchor ??= { ...now };
    return true;
  }
  issue(credential: string): IceConfiguration {
    if (!this.key) throw new RoomError('turn_unavailable', 503);
    const now = this.clock();
    const digest = hashSecret(credential), member = this.store.authenticateDigest(digest, true);
    const room = this.store.peekDigest(digest)!;
    if (!this.checkClock(now)) throw new RoomError('turn_clock_error', 503);
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
