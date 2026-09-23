import { describe, expect, it } from 'vitest';
import { stampAt } from '../../shared/protocol/game.js';
import { PeerClock, CLOCK_LIMITS } from '../../src/network/peer-clock.js';
import { ReplicaClock } from '../../src/network/replica-clock.js';

function sample(clock: PeerClock, sentAt: number, outward: number, inward: number, offset = 500) {
  const ping = clock.probe(sentAt);
  expect(clock.receive({ type: 'pong', id: ping.id, sentAt: ping.sentAt, receivedAt: sentAt + outward + offset },
    sentAt + outward + inward)).toEqual({ ok: true });
}
describe('bounded peer-clock estimation', () => {
  it('does not turn queued pong processing into backwards clock drift after replacing every sample', () => {
    const peer = new PeerClock();
    sample(peer, 0, 0, 0);
    for (let index = 1; index <= CLOCK_LIMITS.samples + 1; index++) {
      const sentAt = index * 300, ping = peer.probe(sentAt);
      const receivedAt = sentAt + 10, processedAt = receivedAt + 240;
      expect(peer.receive({ type: 'pong', id: ping.id, sentAt, receivedAt: sentAt + 505 },
        processedAt, receivedAt)).toEqual({ ok: true });
      const estimate = peer.estimate(processedAt);
      expect(estimate.offsetMs).toBe(500);
      expect(estimate.uncertaintyMs).toBeLessThan(7);
      expect(estimate.remoteLower).toBeLessThan(processedAt + 500);
      expect(estimate.remoteUpper).toBeGreaterThan(processedAt + 500);
    }
  });
  it('validates receipt times without extending probe expiry for a queued reply', () => {
    const peer = new PeerClock(), ping = peer.probe(100);
    const pong = { type: 'pong' as const, id: ping.id, sentAt: ping.sentAt, receivedAt: 600 };
    for (const receivedAt of [NaN, 99, 201]) expect(() => peer.receive(pong, 200, receivedAt)).toThrow('invalid');
    expect(peer.receive(pong, 2101, 110)).toEqual({ ok: false, reason: 'expired' });
  });
  it('cancels unsent probes without exhausting pending capacity or accepting their stray replies', () => {
    const clock = new PeerClock(); sample(clock, 0, 0, 0);
    let last = clock.probe(1);
    clock.cancelProbe(last.id);
    for (let time = 2; time <= 100; time++) {
      last = clock.probe(time); clock.cancelProbe(last.id);
    }
    expect(() => clock.cancelProbe(last.id)).toThrow('invalid');
    expect(clock.receive({ type: 'pong', id: last.id, sentAt: last.sentAt, receivedAt: 9000 }, 101))
      .toEqual({ ok: false, reason: 'unknown' });
    expect(clock.estimate(102).offsetMs).toBe(500);
  });
  it('bounds asymmetric delays rather than claiming exact offset and accounts for drift since a sample', () => {
    const clock = new PeerClock();
    sample(clock, 1000, 10, 90);
    const first = clock.estimate(1100);
    expect(first.remoteLower).toBeCloseTo(1508.9, 8); expect(first.remoteUpper).toBeCloseTo(1611.1, 8);
    expect(first.offsetMs).toBe(460); expect(first.uncertaintyMs).toBeCloseTo(51.1, 8);
    sample(clock, 1200, 10, 10);
    const next = clock.estimate(2000);
    expect(next.remoteLower).toBeLessThan(2500); expect(next.remoteUpper).toBeGreaterThan(2500);
    expect(next.uncertaintyMs).toBeLessThan(12);
    expect(() => clock.estimate(7000)).toThrow('stale (peer timing sample 5780ms old)');
  });
  it('bounds probes and samples, rejects forged timing and exposes incompatible or uncertain clocks', () => {
    const clock = new PeerClock(), ping = clock.probe(0);
    expect(() => clock.receive({ type: 'pong', id: ping.id, sentAt: 1, receivedAt: 10 }, 10)).toThrow('invalid');
    expect(clock.receive({ type: 'pong', id: ping.id, sentAt: 0, receivedAt: 10 }, 2001)).toEqual({ ok: false, reason: 'expired' });
    expect(clock.receive({ type: 'pong', id: ping.id, sentAt: 0, receivedAt: 10 }, 2002)).toEqual({ ok: false, reason: 'unknown' });
    for (let index = 0; index < CLOCK_LIMITS.pending; index++) clock.probe(2010 + index);
    expect(() => clock.probe(2020)).toThrow('capacity');
    clock.reset();
    sample(clock, 3000, 400, 400);
    expect(() => clock.estimate(3800)).toThrow('uncertain');
    clock.reset();
    sample(clock, 4000, 5, 5);
    sample(clock, 4020, 5, 5, 1000);
    expect(() => clock.estimate(4030)).toThrow('drift');
    clock.reset();
    for (let index = 0; index < 40; index++) sample(clock, 5000 + index * 20, 5, 5);
    expect(clock.estimate(5800).offsetMs).toBe(500);
    expect(() => clock.estimate(5799)).toThrow('invalid');
  });
  it('keeps real remote time inside the estimated interval across asymmetric RTT and opposing clock drift', () => {
    for (const offset of [-4000, 5000]) for (const outward of [0, 20, 120]) for (const inward of [0, 20, 120]) {
      const clock = new PeerClock();
      for (let time = 0; time < 6000; time += 500) {
        const guest = (time: number) => -2000 + time * 0.9998;
        const host = (time: number) => offset + time * 1.0002;
        const ping = clock.probe(guest(time));
        clock.receive({ type: 'pong', id: ping.id, sentAt: ping.sentAt, receivedAt: host(time + outward) },
          guest(time + outward + inward));
        const estimated = clock.estimate(guest(time + outward + inward));
        expect(estimated.remoteLower).toBeLessThanOrEqual(host(time + outward + inward));
        expect(estimated.remoteUpper).toBeGreaterThanOrEqual(host(time + outward + inward));
      }
    }
  });
});

describe('bounded replica presentation clock', () => {
  it('does not treat waiting at the new epoch floor as backwards clock drift', () => {
    const peer = new PeerClock(); sample(peer, 0, 10, 140);
    const clock = new ReplicaClock(peer), coverage = { startAt: 0, endAt: 20 };
    clock.observe({ epoch: 1, at: stampAt(0), monotonicMs: 650, running: true }, 150);
    expect(clock.frame(150, coverage)).toBe(0);
    clock.observe({ epoch: 1, at: stampAt(0.12), monotonicMs: 770, running: true }, 270);
    expect(clock.frame(270, coverage)).toBe(0);
    clock.observe({ epoch: 1, at: stampAt(0.25), monotonicMs: 900, running: true }, 400);
    expect(clock.frame(400, coverage)).toBeGreaterThan(0);
    expect(clock.frame(410, coverage)).toBeLessThan(0.1);
  });
  it('smooths small changes without rewinding and freezes paused epochs instead of accumulating elapsed wall time', () => {
    const peer = new PeerClock(); sample(peer, 1000, 10, 10);
    const clock = new ReplicaClock(peer), coverage = { startAt: 0, endAt: 20 };
    clock.observe({ epoch: 1, at: stampAt(1), monotonicMs: 1500, running: true }, 1020);
    const first = clock.frame(1100, coverage);
    expect(first).toBeCloseTo(1.0389, 8);
    const next = clock.frame(1180, coverage);
    expect(next).toBeGreaterThan(first);
    expect(next - first).toBeGreaterThanOrEqual(0.08 * 0.99);
    expect(next - first).toBeLessThanOrEqual(0.08 * 1.01);
    clock.observe({ epoch: 1, at: stampAt(1.2), monotonicMs: 1700, running: false }, 1210);
    expect(clock.frame(30_000, coverage)).toBeCloseTo(1.2, 10);
    expect(() => clock.observe({ epoch: 1, at: stampAt(1.2), monotonicMs: 30_500, running: true }, 30_000)).toThrow('drift');
    sample(peer, 30_000, 10, 10);
    clock.observe({ epoch: 2, at: stampAt(1.2), monotonicMs: 30_500, running: true }, 30_020);
    expect(clock.frame(30_020, coverage)).toBeCloseTo(1.2, 10);
  });
  it('reports missing synchronization, stale snapshots, missing coverage and large corrections explicitly', () => {
    const peer = new PeerClock(), clock = new ReplicaClock(peer);
    expect(() => clock.frame(0, { startAt: 0, endAt: 2 })).toThrow('unsynchronized');
    sample(peer, 0, 10, 10);
    clock.observe({ epoch: 1, at: stampAt(1), monotonicMs: 500, running: true }, 20);
    expect(() => clock.frame(20, { startAt: 1.5, endAt: 2 })).toThrow('coverage');
    clock.frame(20, { startAt: 0, endAt: 2 });
    clock.observe({ epoch: 1, at: stampAt(1.6), monotonicMs: 600, running: true }, 120);
    expect(() => clock.frame(120, { startAt: 0, endAt: 2 })).toThrow('drift');
    expect(() => clock.frame(621, { startAt: 0, endAt: 2 })).toThrow('stale (snapshot receipt 501ms old)');
  });
  it('distinguishes delayed anchor extrapolation from a missing snapshot receipt', () => {
    const peer = new PeerClock(); sample(peer, 0, 0, 0);
    const clock = new ReplicaClock(peer);
    clock.observe({ epoch: 1, at: stampAt(1), monotonicMs: 500, running: true }, 600);
    expect(() => clock.frame(600, { startAt: 0, endAt: 20 })).toThrow('stale (snapshot extrapolation 548ms)');
  });
});
