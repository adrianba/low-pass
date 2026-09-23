import { describe, expect, it } from 'vitest';
import { MultiplayerRecordStore } from '../../src/storage/multiplayer-records.js';
import type { IncompleteReason } from '../../src/storage/multiplayer-records.js';
import { multiplayerOutcome } from '../../src/ui/multiplayer-results.js';
import { versions } from './protocol-fixtures.js';

function store() {
  const value = new MultiplayerRecordStore(() => ({ getItem: () => null, setItem: () => {} }), () => {});
  value.begin({ matchId: 'match:1', terrain: 'green-valley', localSlot: 0, compatibility: versions,
    startedAt: '2026-09-22T00:00:00Z' });
  return value;
}
const player = (score: number, eliminated = true) => ({ score, misses: eliminated ? 3 : 1, assisted: false, eliminated });
describe('multiplayer terminal result labels', () => {
  it.each([[100, 50, 'PLAYER 1 WINS'], [50, 100, 'PLAYER 2 WINS'], [100, 100, 'MATCH DRAW']] as const)(
    'uses the final totals %i / %i, not death order', (host, guest, title) => {
      const records = store();
      records.observe([player(host), player(guest)]);
      expect(multiplayerOutcome(records.current!)).toMatchObject({ title });
    });
  it.each<IncompleteReason>(['left', 'connection_lost', 'error', 'interrupted'])('does not award an unfinished high score after %s', reason => {
    const records = store();
    records.observe([player(0), player(999, false)]);
    records.finish(reason);
    const outcome = multiplayerOutcome(records.current!);
    expect(outcome.title).toBe('MATCH INCOMPLETE');
    expect(outcome.description).toContain('No winner.');
    expect(outcome.description).not.toContain('undefined');
    expect(records.scores).toHaveLength(1);
  });
  it('does not call an active flight complete or silently invent missing terminal data', () => {
    const records = store();
    expect(multiplayerOutcome(records.current!).title).toBe('MATCH IN PROGRESS');
    records.finish('left');
    expect(() => multiplayerOutcome({ ...records.current!, reason: null })).toThrow('require a reason');
    expect(() => multiplayerOutcome({ ...records.current!, status: 'complete', winner: null })).toThrow('winner or draw');
  });
});
