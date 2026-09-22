import { snapshot, stampAt } from '../../shared/protocol/game.js';
import type { Snapshot } from '../../shared/protocol/game.js';
import type { HostSession, PlayerSlot } from '../game/multiplayer/session.js';

export interface SnapshotPublication {
  planRevision: number; eventSequence: number; coreEventId: number; lastInputs: [number, number];
  plans: ReadonlyMap<number, { id: string; digest: string }>;
  effects: Snapshot['effects'];
}

export function sessionSnapshot(session: HostSession, publication: SnapshotPublication): Snapshot {
  if (publication.coreEventId !== session.lastEventId) throw new Error('Publish all core events before taking a snapshot.');
  const state = session.snapshot();
  const encounters = state.encounters.filter(encounter => encounter.startAt <= state.time || publication.plans.has(encounter.sequence));
  const reference = (sequence: number) => {
    const value = publication.plans.get(sequence);
    if (!value) throw new Error('Snapshot requires every retained plan reference.');
    return value;
  };
  const player = (slot: PlayerSlot) => {
    const player = state.players[slot]!;
    return { slot, score: player.score, misses: player.misses, lastResolved: player.lastResolved,
      assistance: player.assistance, assisted: player.assisted, eliminated: player.completion !== null,
      bomb: player.bomb ? { sequence: player.bomb.sequence, releasedAt: stampAt(player.bomb.releasedAt),
        steps: player.bomb.steps, position: player.bomb.value.position, velocity: player.bomb.value.velocity } : null };
  };
  return snapshot.parse({ at: stampAt(state.time), status: state.status, winner: state.winner,
    planRevision: publication.planRevision, eventSequence: publication.eventSequence, lastInputs: publication.lastInputs,
    plans: encounters.map(encounter => reference(encounter.sequence)), effects: publication.effects,
    wrecks: encounters.filter(encounter => encounter.destroyed).map(encounter => reference(encounter.sequence).id),
    results: encounters.flatMap(encounter => encounter.attempts.flatMap(attempt => attempt.result ? [attempt.result] : [])),
    players: [player(0), player(1)] });
}
