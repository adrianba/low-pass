import type { MessageBody } from '../../shared/protocol/messages.js';

export const CLOCK_LIMITS = Object.freeze({ samples: 16, pending: 8, sampleAgeMs: 5000, probeAgeMs: 2000,
  driftPpm: 1000, timestampErrorMs: 1, uncertaintyMs: 150 });
export class ClockError extends Error {
  constructor(readonly code: 'unsynchronized' | 'stale' | 'uncertain' | 'drift' | 'coverage' | 'invalid' | 'capacity') {
    super(`Multiplayer clock unavailable: ${code}.`);
  }
}
interface Sample { lower: number; upper: number; at: number }

/** Offset is an interval: asymmetric network delay cannot establish an exact clock. */
export class PeerClock {
  private readonly pending = new Map<number, number>();
  private readonly samples: Sample[] = [];
  private nextId = 0;
  private lastNow = -Infinity;
  private now(value: number): number {
    if (!Number.isFinite(value) || Math.abs(value) > 1e12 || value < this.lastNow) throw new ClockError('invalid');
    this.lastNow = value; return value;
  }
  probe(time: number): Extract<MessageBody, { type: 'ping' }> {
    const now = this.now(time);
    for (const [id, sentAt] of this.pending) if (now - sentAt > CLOCK_LIMITS.probeAgeMs) this.pending.delete(id);
    if (this.pending.size >= CLOCK_LIMITS.pending || this.nextId === Number.MAX_SAFE_INTEGER) throw new ClockError('capacity');
    const id = ++this.nextId; this.pending.set(id, now);
    return { type: 'ping', id, sentAt: now };
  }
  receive(pong: Extract<MessageBody, { type: 'pong' }>, time: number): { ok: true } | { ok: false; reason: 'unknown' | 'expired' } {
    const now = this.now(time), sentAt = this.pending.get(pong.id);
    if (sentAt === undefined) return { ok: false, reason: 'unknown' };
    if (sentAt !== pong.sentAt || !Number.isFinite(pong.receivedAt) || Math.abs(pong.receivedAt) > 1e12) throw new ClockError('invalid');
    this.pending.delete(pong.id);
    if (now - sentAt > CLOCK_LIMITS.probeAgeMs) return { ok: false, reason: 'expired' };
    const margin = CLOCK_LIMITS.timestampErrorMs + (now - sentAt) * CLOCK_LIMITS.driftPpm / 1e6;
    this.samples.push({ lower: pong.receivedAt - now - margin, upper: pong.receivedAt - sentAt + margin, at: now });
    if (this.samples.length > CLOCK_LIMITS.samples) this.samples.shift();
    return { ok: true };
  }
  estimate(time: number) {
    const now = this.now(time);
    const fresh = this.samples.filter(sample => now - sample.at <= CLOCK_LIMITS.sampleAgeMs).map(sample => {
      const margin = (now - sample.at) * CLOCK_LIMITS.driftPpm / 1e6;
      return { lower: sample.lower - margin, upper: sample.upper + margin };
    });
    if (!fresh.length) throw new ClockError(this.samples.length ? 'stale' : 'unsynchronized');
    // Prefer a narrow, recent interval; averaging queued packets biases the offset.
    const best = fresh.reduce((a, b) => b.upper - b.lower <= a.upper - a.lower ? b : a);
    if (Math.max(...fresh.map(sample => sample.lower)) > Math.min(...fresh.map(sample => sample.upper))) {
      throw new ClockError('drift');
    }
    const uncertaintyMs = (best.upper - best.lower) / 2;
    if (uncertaintyMs > CLOCK_LIMITS.uncertaintyMs) throw new ClockError('uncertain');
    return { remoteLower: now + best.lower, remoteUpper: now + best.upper,
      offsetMs: (best.lower + best.upper) / 2, uncertaintyMs };
  }
  reset(): void { this.pending.clear(); this.samples.length = 0; }
}
