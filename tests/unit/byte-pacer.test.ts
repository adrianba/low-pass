import { describe, expect, it } from 'vitest';
import { BytePacer } from '../../src/network/byte-pacer.js';

describe('bounded byte pacing', () => {
  it('paces exact wire bytes and keeps failed send attempts from consuming credit', () => {
    const pacer = new BytePacer(1000, 1000);
    expect(pacer.delay(800, 0)).toBe(0);
    expect(pacer.delay(800, 0)).toBe(0);
    pacer.sent(800, 0);
    expect(pacer.delay(500, 0)).toBe(300);
    expect(pacer.delay(500, 299)).toBe(1);
    expect(() => pacer.sent(500, 299)).toThrow('budget');
    pacer.sent(500, 300);
    expect(pacer.delay(1000, 300)).toBe(1000);
  });
  it('never releases a catch-up burst after a long pause', () => {
    const pacer = new BytePacer(1000, 1000);
    pacer.sent(1000, 0); pacer.sent(1000, 60_000);
    expect(pacer.delay(1000, 60_000)).toBe(1000);
  });
  it('rejects invalid budgets, oversize sends and backward or invalid clocks', () => {
    expect(() => new BytePacer(0, 100)).toThrow();
    expect(() => new BytePacer(1000, 65537)).toThrow();
    const pacer = new BytePacer(1000, 1000);
    for (const bytes of [0, 1001, 1.5, NaN]) expect(() => pacer.delay(bytes, 0)).toThrow();
    pacer.sent(10, 10);
    for (const time of [9, Infinity, NaN]) expect(() => pacer.delay(1, time)).toThrow();
  });
});
