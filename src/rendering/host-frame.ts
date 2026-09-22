import type { FormationScheduler } from '../game/multiplayer/scheduler';
import type { PlayerSlot } from '../game/multiplayer/session';
import type { ChaseView } from '../simulation/chase-camera';
import { hash } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import type { Pose } from '../simulation/pose';
import { snapshotSharedFrame } from './shared-frame';
import type { SharedWorldFrame } from './shared-frame';
import type { WorldFrame } from './world-frame';

export interface SharedPresentation {
  readonly time?: number;
  readonly poses?: readonly [Pose, Pose];
  readonly destroyed?: readonly [boolean, boolean];
  readonly views?: readonly [ChaseView, ChaseView];
  readonly effectPositions?: readonly Vec3[];
  readonly prediction?: WorldFrame['prediction'];
}

export function hostWorldFrame(scheduler: FormationScheduler, viewedSlot: PlayerSlot,
  presentation: SharedPresentation = {}): SharedWorldFrame {
  const state = scheduler.session.snapshot(), current = scheduler.plan();
  const aircraft = (slot: PlayerSlot) => ({
    pose: presentation.poses?.[slot] ?? state.players[slot]!.pose,
    bomb: state.players[slot]!.bomb?.value ?? null,
    released: state.players[slot]!.bomb !== null ||
      state.encounters.find(e => e.sequence === scheduler.sequence)!.attempts[slot]!.releasedAt !== null,
    destroyed: presentation.destroyed?.[slot] ?? state.players[slot]!.completion !== null,
  });
  const encounters = state.encounters.filter(e => e.startAt <= state.time);
  return snapshotSharedFrame({
    time: presentation.time ?? state.time, terrain: state.terrain, viewedSlot,
    aircraft: [aircraft(0), aircraft(1)],
    views: presentation.views ?? [
      current.attempts[0].camera.at(state.time - current.attempts[0].releaseAt),
      current.attempts[1].camera.at(state.time - current.attempts[1].releaseAt),
    ],
    targets: encounters.map(e => ({ id: e.sequence + 1, position: e.target, kind: e.targetKind,
      heading: hash(e.sequence + 1, 7, scheduler.seed) * Math.PI * 2, destroyed: e.destroyed,
      sightDistance: Math.max(...scheduler.plan(e.sequence).attempts.map(a => a.acquisition.range)),
      canyon: state.terrain === 'river-canyon' })),
    impacts: encounters.flatMap(e => e.attempts.flatMap(a => a.result?.impact ? [{
      id: a.result.id, sequence: e.sequence, slot: a.result.slot, time: a.result.time, impact: a.result.impact,
    }] : [])),
    prediction: presentation.prediction ?? null,
    ready: scheduler.session.releaseState(viewedSlot, scheduler.sequence).ok,
    effectPositions: presentation.effectPositions ?? [],
  });
}
