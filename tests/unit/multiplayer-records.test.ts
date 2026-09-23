import { describe, expect, it, vi } from 'vitest';
import { MULTIPLAYER_STORAGE_KEY, MultiplayerRecordStore } from '../../src/storage/multiplayer-records.js';
import type { MultiplayerProgress, MultiplayerMatchIdentity } from '../../src/storage/multiplayer-records.js';
import { STORAGE_KEY } from '../../src/storage/records.js';
import { versions } from './protocol-fixtures.js';

const identity: MultiplayerMatchIdentity = { matchId: 'room:1', localSlot: 0, terrain: 'river-canyon',
  compatibility: versions, startedAt: '2026-09-22T00:00:00.000Z' };
function player(score = 0, misses = 0, assisted = false): MultiplayerProgress[0] {
  return { score, misses, assisted, eliminated: misses === 3 };
}
function fixture(raw?: string) {
  const values = new Map([[STORAGE_KEY, 'untouched solo data']]);
  if (raw !== undefined) values.set(MULTIPLAYER_STORAGE_KEY, raw);
  const warn = vi.fn(), setItem = vi.fn((key: string, value: string) => { values.set(key, value); });
  const getItem = vi.fn((key: string) => values.get(key) ?? null);
  const storage = { getItem, setItem };
  const store = new MultiplayerRecordStore(() => storage, warn, () => '2026-09-22T00:01:00.000Z');
  return { store, storage, values, warn, setItem, getItem };
}

describe('separate bounded multiplayer records', () => {
  it('saves each elimination immediately and independently, then updates a completed match idempotently', () => {
    const state = fixture();
    state.store.begin(identity);
    state.store.observe([player(80, 2, true), player(250, 1)]);
    expect(state.setItem).not.toHaveBeenCalled();
    state.store.observe([player(80, 3, true), player(250, 1)]);
    expect(state.setItem).toHaveBeenCalledOnce();
    expect(state.store.scores).toMatchObject([{ id: 'room:1:0', slot: 0, score: 80, assisted: true,
      matchStatus: 'active', opponent: { score: 250, completed: false } }]);
    state.store.observe([player(80, 3, true), player(250, 1)]);
    expect(state.setItem).toHaveBeenCalledOnce();
    state.store.observe([player(80, 3, true), player(280, 3)]);
    expect(state.store.current).toMatchObject({ status: 'complete', winner: 1, reason: null });
    expect(state.store.scores.map(score => [score.slot, score.score, score.matchStatus])).toEqual([[1, 280, 'complete'], [0, 80, 'complete']]);
    expect(state.store.scores[1]!.opponent).toMatchObject({ score: 280, completed: true });
    state.store.finish('left');
    state.store.observe([player(80, 3, true), player(280, 3)]);
    expect(state.setItem).toHaveBeenCalledTimes(2);
    expect(state.values.get(STORAGE_KEY)).toBe('untouched solo data');
    expect(state.getItem.mock.calls).toEqual([[MULTIPLAYER_STORAGE_KEY]]);
    expect(state.setItem.mock.calls.every(([key]) => key === MULTIPLAYER_STORAGE_KEY)).toBe(true);
    const copy = state.store.current!;
    copy.players[0].score = 999;
    expect(state.store.current!.players[0].score).toBe(80);
  });
  it('retains finalized scores but gives no leaderboard entry or win to a disconnected survivor', () => {
    const state = fixture();
    state.store.begin(identity);
    state.store.observe([player(100, 3), player(900, 2, true)]);
    state.store.finish('connection_lost');
    expect(state.store.scores).toHaveLength(1);
    expect(state.store.scores[0]).toMatchObject({ score: 100, matchStatus: 'incomplete',
      opponent: { score: 900, completed: false } });
    expect(state.store.current).toMatchObject({ status: 'incomplete', reason: 'connection_lost', winner: null });
    expect(state.store.current!.players[1].finalizedAt).toBeNull();
    expect(() => state.store.observe([player(100, 3), player(900, 3, true)])).toThrow('finalized match');
  });
  it('marks an interrupted live page incomplete on reload without losing either observed total', () => {
    const state = fixture();
    state.store.begin(identity);
    state.store.observe([player(100, 3), player(700, 2)]);
    const restored = fixture(state.values.get(MULTIPLAYER_STORAGE_KEY)!);
    expect(restored.warn).not.toHaveBeenCalled();
    expect(restored.store.matches[0]).toMatchObject({ status: 'incomplete', reason: 'interrupted', winner: null });
    expect(restored.store.scores[0]).toMatchObject({ score: 100, matchStatus: 'incomplete', opponent: { score: 700, completed: false } });
    expect(restored.setItem).toHaveBeenCalledOnce();
    expect(() => restored.store.begin(identity)).toThrow('already recorded');
  });
  it('records near-simultaneous equal totals as a draw and bounds both lists across rematches', () => {
    const state = fixture();
    for (let round = 0; round < 12; round++) {
      state.store.begin({ ...identity, matchId: `room:${round + 1}` });
      state.store.observe([player(round * 100, 3), player(round * 100, 3)]);
      expect(state.store.current?.winner).toBe('draw');
    }
    expect(state.store.scores).toHaveLength(10);
    expect(state.store.matches).toHaveLength(10);
    expect(new Set(state.store.scores.map(score => score.id)).size).toBe(10);
    expect(state.store.scores[0]!.score).toBe(1100);
    expect(state.store.scores.at(-1)!.score).toBe(700);
    expect(state.store.matches[0]!.matchId).toBe('room:12');
    expect(fixture(state.values.get(MULTIPLAYER_STORAGE_KEY)!).warn).not.toHaveBeenCalled();
  });
  it('rejects regressions, changed finalized scores and assistance repair', () => {
    const state = fixture();
    state.store.begin(identity);
    state.store.observe([player(100, 3, true), player(50, 1, true)]);
    const regressions: MultiplayerProgress[] = [
      [player(100, 2, true), player(50, 1, true)], [player(101, 3, true), player(50, 1, true)],
      [player(100, 3, true), player(49, 1, true)], [player(100, 3, true), player(50, 1)],
    ];
    for (const next of regressions) expect(() => state.store.observe(next)).toThrow('cannot regress');
    expect(() => state.store.begin({ ...identity, matchId: 'next' })).toThrow('Finish');
    expect(state.store.scores).toHaveLength(1);
  });
  it('preserves invalid saved bytes and reports validation failure rather than silently clearing them', () => {
    const valid = fixture();
    valid.store.begin(identity); valid.store.observe([player(100, 3), player(200, 3)]);
    const raw = valid.values.get(MULTIPLAYER_STORAGE_KEY)!;
    const badWinner = JSON.parse(raw); badWinner.matches[0].winner = 0;
    const duplicate = JSON.parse(raw); duplicate.scores.push(duplicate.scores[0]);
    const changedScore = JSON.parse(raw); changedScore.scores[0].score++;
    for (const invalid of ['{', ' '.repeat(65537), '{"version":2,"scores":[],"matches":[]}',
      JSON.stringify(badWinner), JSON.stringify(duplicate), JSON.stringify(changedScore)]) {
      const state = fixture(invalid);
      expect(state.warn).toHaveBeenCalledOnce();
      state.store.begin(identity); state.store.observe([player(100, 3), player()]);
      expect(state.store.scores).toHaveLength(1);
      expect(state.values.get(MULTIPLAYER_STORAGE_KEY)).toBe(invalid);
      expect(state.setItem).not.toHaveBeenCalled();
    }
  });
  it('keeps session records after denied reads or quota failure and warns only at the storage boundary', () => {
    const state = fixture();
    state.setItem.mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    state.store.begin(identity); state.store.observe([player(100, 3), player()]);
    state.store.observe([player(100, 3), player(200, 3)]);
    expect(state.store.scores).toHaveLength(2);
    expect(state.warn).toHaveBeenCalledOnce();
    expect(state.setItem).toHaveBeenCalledOnce();
    const warn = vi.fn();
    const denied = new MultiplayerRecordStore(() => { throw new DOMException('Denied', 'SecurityError'); }, warn);
    denied.begin(identity); denied.finish('left');
    expect(denied.matches[0]).toMatchObject({ status: 'incomplete', reason: 'left', winner: null });
    expect(denied.scores).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });
});
