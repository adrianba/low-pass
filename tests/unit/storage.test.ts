import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, RecordStore, validSettings, STORAGE_KEY } from '../../src/storage/records';

describe('local records', () => {
  it('does not rewrite existing bytes on load or repeated completion', () => {
    const score = { id: 'retained', score: 100, date: '2026-01-01T00:00:00Z', assisted: false };
    const raw = JSON.stringify({ version: 1, scores: [score], settings: DEFAULT_SETTINGS }, null, 2);
    const writes: string[] = [];
    const store = new RecordStore(() => ({
      getItem: () => raw, setItem: (_key, value) => { writes.push(value); },
    }), () => { throw new Error('Unexpected warning'); });
    expect(store.scores).toEqual([score]);
    store.complete(score);
    expect(writes).toEqual([]);
  });
  it.each(['green-valley', 'desert', 'river-canyon'] as const)('remembers %s without changing completed scores', terrain => {
    let json: string | null = null;
    const storage = { getItem: () => json, setItem: (key: string, value: string) => {
      expect(key).toBe(STORAGE_KEY); json = value;
    } };
    const store = new RecordStore(() => storage, () => { throw new Error('Unexpected warning'); });
    store.complete({ id: 'saved', score: 350, date: '2026-01-01T00:00:00Z', assisted: false });
    store.update({ ...DEFAULT_SETTINGS, terrain });
    const restored = new RecordStore(() => storage, () => { throw new Error('Unexpected warning'); });
    expect(restored.settings.terrain).toBe(terrain);
    expect(restored.scores).toEqual(store.scores);
  });
  it.each([undefined, 'unknown', null, 42])('preserves v1 records when normalizing terrain %s', terrain => {
    const scores = [{ id: 'legacy', score: 400, date: '2026-01-01T00:00:00Z', assisted: true }];
    let json = JSON.stringify({ version: 1, scores, settings: {
      quality: 'high', assist: false, muted: true, volume: 0.3, terrain,
    } });
    const initial = json;
    const warnings: string[] = [];
    const store = new RecordStore(() => ({
      getItem: () => json, setItem: (_key, value) => { json = value; },
    }), message => warnings.push(message));
    expect(store.settings).toEqual({ quality: 'high', assist: false, muted: true, volume: 0.3, terrain: 'green-valley' });
    expect(store.scores).toEqual(scores);
    expect(warnings).toHaveLength(terrain === undefined ? 0 : 1);
    expect(json).toBe(initial);
    store.update({ ...store.settings, terrain: 'desert' });
    expect(JSON.parse(json).scores).toEqual(scores);
    expect(JSON.parse(json).settings.terrain).toBe('desert');
  });
  it('rejects invalid new settings rather than silently defaulting', () => {
    expect(validSettings({ ...DEFAULT_SETTINGS, terrain: 'ocean' })).toBe(false);
    expect(validSettings({ ...DEFAULT_SETTINGS, terrain: undefined })).toBe(false);
  });
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
