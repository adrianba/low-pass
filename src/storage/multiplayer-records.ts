import { z } from 'zod';
import { compatibility, identifier, result, slot, terrain } from '../../shared/protocol/game.js';
import type { StoragePort } from './records.js';

export const MULTIPLAYER_STORAGE_KEY = 'low-pass.multiplayer-records.v1';
export const MULTIPLAYER_RECORD_LIMIT = 10;
const date = z.iso.datetime();
const reason = z.enum(['left', 'connection_lost', 'error', 'interrupted']);
const identity = z.strictObject({
  matchId: identifier.max(100), localSlot: slot, terrain, compatibility, startedAt: date,
});
const fields = { score: result.shape.score, misses: z.number().int().min(0).max(3),
  assisted: z.boolean(), eliminated: z.boolean() };
const progressPlayer = z.strictObject(fields).refine(value => value.eliminated === (value.misses === 3));
const progress = z.tuple([progressPlayer, progressPlayer]);
const savedPlayer = z.strictObject({ ...fields, finalizedAt: date.nullable() })
  .refine(value => value.eliminated === (value.misses === 3) && value.eliminated === (value.finalizedAt !== null));
function winner(players: readonly [{ score: number }, { score: number }]): 0 | 1 | 'draw' {
  return players[0].score === players[1].score ? 'draw' : players[0].score > players[1].score ? 0 : 1;
}
const summary = identity.extend({
  status: z.enum(['active', 'complete', 'incomplete']), endedAt: date.nullable(), reason: reason.nullable(),
  players: z.tuple([savedPlayer, savedPlayer]), winner: z.union([slot, z.literal('draw')]).nullable(),
}).refine(value => (value.status === 'complete') === value.players.every(player => player.eliminated) &&
  (value.status === 'active') === (value.endedAt === null) &&
  (value.status === 'incomplete') === (value.reason !== null) &&
  value.winner === (value.status === 'complete' ? winner(value.players) : null));
const completed = identity.extend({
  id: identifier, slot, score: result.shape.score, date, assisted: z.boolean(),
  opponent: z.strictObject({ score: result.shape.score, assisted: z.boolean(), completed: z.boolean() }),
  matchStatus: z.enum(['active', 'complete', 'incomplete']),
}).refine(value => value.id === `${value.matchId}:${value.slot}` &&
  (value.matchStatus === 'complete') === value.opponent.completed);
const saved = z.strictObject({
  version: z.literal(1), scores: z.array(completed).max(MULTIPLAYER_RECORD_LIMIT),
  matches: z.array(summary).max(MULTIPLAYER_RECORD_LIMIT),
}).refine(value => new Set(value.scores.map(score => score.id)).size === value.scores.length &&
  new Set(value.matches.map(match => match.matchId)).size === value.matches.length &&
  value.scores.every(score => {
    const match = value.matches.find(match => match.matchId === score.matchId);
    if (!match) return true;
    const player = match.players[score.slot], opponent = match.players[score.slot === 0 ? 1 : 0];
    return player.eliminated && player.score === score.score && player.assisted === score.assisted &&
      player.finalizedAt === score.date && score.matchStatus === match.status &&
      score.terrain === match.terrain && score.localSlot === match.localSlot &&
      score.startedAt === match.startedAt && JSON.stringify(score.compatibility) === JSON.stringify(match.compatibility) &&
      opponent.score === score.opponent.score && opponent.assisted === score.opponent.assisted &&
      opponent.eliminated === score.opponent.completed;
  }));
export type MultiplayerMatchIdentity = z.infer<typeof identity>;
export type MultiplayerProgress = z.infer<typeof progress>;
export type MultiplayerSummary = z.infer<typeof summary>;
export type MultiplayerScore = z.infer<typeof completed>;
export type IncompleteReason = z.infer<typeof reason>;

/** Local observations only: no room capabilities, solo settings or speculative outcomes. */
export class MultiplayerRecordStore {
  private records: z.infer<typeof saved> = { version: 1, scores: [], matches: [] };
  private storage: StoragePort | null = null;
  private currentValue: MultiplayerSummary | null = null;
  constructor(getStorage: () => StoragePort, private readonly warn: (message: string) => void,
    private readonly now: () => string = () => new Date().toISOString()) {
    try {
      this.storage = getStorage();
      const raw = this.storage.getItem(MULTIPLAYER_STORAGE_KEY);
      if (raw !== null) {
        if (raw.length > 64 * 1024) throw new Error('Multiplayer records exceed their size bound.');
        this.records = saved.parse(JSON.parse(raw));
        const interrupted = this.records.matches.some(match => match.status === 'active') ||
          this.records.scores.some(score => score.matchStatus === 'active');
        if (interrupted) {
          const endedAt = date.parse(this.now());
          this.records.matches = this.records.matches.map(match => match.status === 'active'
            ? { ...match, status: 'incomplete', endedAt, reason: 'interrupted' } : match);
          this.records.scores = this.records.scores.map(score => score.matchStatus === 'active'
            ? { ...score, matchStatus: 'incomplete' } : score);
          this.save();
        }
      }
    } catch {
      this.storage = null;
      this.warn('Multiplayer records unavailable. Existing saved data was not replaced; changes will last only this session.');
    }
  }
  get current(): MultiplayerSummary | null { return structuredClone(this.currentValue); }
  get active(): boolean { return this.currentValue?.status === 'active'; }
  get scores(): readonly MultiplayerScore[] { return structuredClone(this.records.scores); }
  get matches(): readonly MultiplayerSummary[] { return structuredClone(this.records.matches); }
  begin(value: MultiplayerMatchIdentity): void {
    const metadata = identity.parse(value);
    if (this.currentValue?.status === 'active') throw new Error('Finish the current match before recording another.');
    if (this.records.matches.some(match => match.matchId === metadata.matchId) ||
      this.records.scores.some(score => score.matchId === metadata.matchId)) throw new Error('This private match is already recorded.');
    const player = () => ({ score: 0, misses: 0, assisted: false, eliminated: false, finalizedAt: null });
    this.currentValue = { ...metadata, status: 'active', endedAt: null, reason: null,
      players: [player(), player()], winner: null };
  }
  observe(value: readonly [MultiplayerProgress[0], MultiplayerProgress[1]]): void {
    const next = progress.parse(value), previous = this.currentValue;
    if (!previous) throw new Error('No private match is being recorded.');
    if (next.every((player, slot) => {
      const old = previous.players[slot]!;
      return player.score === old.score && player.misses === old.misses &&
        player.assisted === old.assisted && player.eliminated === old.eliminated;
    })) return;
    if (previous.status !== 'active') throw new Error('A finalized match cannot change.');
    if (next.some((player, slot) => {
      const old = previous.players[slot]!;
      return player.score < old.score || player.misses < old.misses || old.assisted && !player.assisted ||
        old.eliminated && (player.score !== old.score || player.assisted !== old.assisted);
    })) throw new Error('Private player totals cannot regress or change after completion.');
    const at = date.parse(this.now());
    const player = (slot: 0 | 1) => ({ ...next[slot],
      finalizedAt: previous.players[slot].finalizedAt ?? (next[slot].eliminated ? at : null) });
    const players: MultiplayerSummary['players'] = [player(0), player(1)];
    const complete = players.every(player => player.eliminated);
    this.currentValue = summary.parse({ ...previous, players, status: complete ? 'complete' : 'active',
      winner: complete ? winner(players) : null, endedAt: complete ? at : null });
    if (players.some(player => player.eliminated)) this.publish();
  }
  finish(value: IncompleteReason): void {
    const why = reason.parse(value), current = this.currentValue;
    if (!current || current.status !== 'active') return;
    this.currentValue = summary.parse({ ...current, status: 'incomplete', reason: why, endedAt: date.parse(this.now()) });
    this.publish();
  }
  private publish() {
    const match = this.currentValue!;
    const scores = new Map(this.records.scores.map(score => [score.id, score]));
    for (const slot of [0, 1] as const) {
      const player = match.players[slot], opponent = match.players[slot === 0 ? 1 : 0];
      if (!player.finalizedAt) continue;
      const score = completed.parse({ ...identity.parse({
        matchId: match.matchId, localSlot: match.localSlot, terrain: match.terrain,
        compatibility: match.compatibility, startedAt: match.startedAt,
      }), id: `${match.matchId}:${slot}`, slot, score: player.score, date: player.finalizedAt,
      assisted: player.assisted, matchStatus: match.status,
      opponent: { score: opponent.score, assisted: opponent.assisted, completed: opponent.eliminated } });
      scores.set(score.id, score);
    }
    this.records.scores = [...scores.values()].sort((a, b) => b.score - a.score ||
      a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).slice(0, MULTIPLAYER_RECORD_LIMIT);
    this.records.matches = [structuredClone(match), ...this.records.matches.filter(old => old.matchId !== match.matchId)]
      .slice(0, MULTIPLAYER_RECORD_LIMIT);
    this.save();
  }
  private save() {
    if (!this.storage) return;
    try { this.storage.setItem(MULTIPLAYER_STORAGE_KEY, JSON.stringify(this.records)); }
    catch {
      this.storage = null;
      this.warn('Could not save multiplayer records. Changes will last only this session; solo records are unchanged.');
    }
  }
}
