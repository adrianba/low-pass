import type { PlayerSlot } from '../game/multiplayer/session.js';
import type { SharedWorldFrame } from '../rendering/shared-frame.js';

export interface MatchPlayerDisplay {
  readonly score: number;
  readonly misses: number;
  readonly assistance: boolean;
  readonly assisted: boolean;
  readonly eliminated: boolean;
  readonly result: { readonly points: number; readonly time: number } | null;
}

export interface MatchDisplay {
  readonly epoch: number;
  readonly frame: SharedWorldFrame;
  readonly localSlot: PlayerSlot;
  readonly players: readonly [MatchPlayerDisplay, MatchPlayerDisplay];
  readonly winner: PlayerSlot | 'draw' | null;
}

export function snapshotMatchDisplay(frame: SharedWorldFrame, localSlot: PlayerSlot,
  players: readonly [MatchPlayerDisplay, MatchPlayerDisplay], winner: MatchDisplay['winner'], epoch = 0): MatchDisplay {
  const player = (slot: PlayerSlot) => Object.freeze({ score: players[slot].score, misses: players[slot].misses,
    assistance: players[slot].assistance, assisted: players[slot].assisted, eliminated: players[slot].eliminated,
    result: players[slot].result ? Object.freeze({ ...players[slot].result }) : null });
  return Object.freeze({ epoch, frame, localSlot, players: Object.freeze([player(0), player(1)] as const), winner });
}
