import { performance } from 'node:perf_hooks';
import { RoomError } from './room-store.js';

interface Bucket { count: number; expires: number }
export class RoomLimits {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly clock: () => number = () => performance.now()) {}
  take(key: string, limit: number, periodMs = 60_000): void {
    const now = this.clock(), bucket = this.buckets.get(key);
    if (bucket && now < bucket.expires) {
      if (bucket.count >= limit) throw new RoomError('rate_limited', 429);
      bucket.count++; return;
    }
    this.sweep();
    if (this.buckets.size >= 2048) throw new RoomError('rate_limit_capacity', 503);
    this.buckets.set(key, { count: 1, expires: now + periodMs });
  }
  sweep(): void {
    const now = this.clock();
    for (const [key, value] of this.buckets) if (now >= value.expires) this.buckets.delete(key);
  }
  clear(): void { this.buckets.clear(); }
  get size(): number { return this.buckets.size; }
}
