import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, RecordStore } from '../../src/storage/records';

describe('local records', () => {
  it('keeps top 10 completed runs and survives reload', () => {
    let json: string | null = null;
    const storage = { getItem: () => json, setItem: (_: string, value: string) => { json = value; } };
    const warn = () => { throw new Error('Unexpected warning'); };
    const store = new RecordStore(() => storage, warn);
    for (let i = 0; i < 15; i++) store.complete({ id: String(i), score: i * 100, date: '2026-01-01T00:00:00Z', assisted: true });
    expect(store.scores).toHaveLength(10);
    expect(store.scores[0]!.score).toBe(1400);
    store.complete(store.scores[0]!);
    expect(store.scores).toHaveLength(10);
    store.update({ ...DEFAULT_SETTINGS, assist: false });
    const reload = new RecordStore(() => storage, warn);
    expect(reload.settings.assist).toBe(false);
    expect(reload.scores).toEqual(store.scores);
  });
  it.each(['invalid', '{}', '{"version":1,"scores":[],"settings":{"volume":99}}'])('warns on malformed storage: %s', raw => {
    const warnings: string[] = [];
    const store = new RecordStore(() => ({ getItem: () => raw, setItem: () => {} }), m => warnings.push(m));
    expect(store.settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toHaveLength(1);
  });
  it('warns on unavailable or quota-limited storage but retains session scores', () => {
    const warnings: string[] = [];
    const unavailable = new RecordStore(() => { throw new Error('Blocked'); }, m => warnings.push(m));
    expect(unavailable.scores).toEqual([]);
    const full = new RecordStore(() => ({ getItem: () => null, setItem: () => { throw new Error('Quota'); } }), m => warnings.push(m));
    full.complete({ id: 'a', score: 50, date: new Date().toISOString(), assisted: false });
    expect(full.scores).toHaveLength(1);
    expect(warnings).toHaveLength(2);
  });
});
