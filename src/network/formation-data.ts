import { formation } from '../../shared/protocol/game.js';
import type { FormationPlan } from '../game/formation/approved';
import type { PlayerSlot } from '../game/multiplayer/session';

export function formationData(plan: FormationPlan, sequence: number) {
  const attempt = (slot: PlayerSlot) => {
    const a = plan.attempts[slot];
    return { slot, acquireAt: a.acquireAt, releaseAt: a.releaseAt, cutoffAt: a.cutoffAt, endAt: a.endAt,
      track: a.track.toData(), camera: a.camera.samples, acquisition: a.acquisition };
  };
  return formation.parse({ version: 1, sequence, encounterId: plan.encounterId,
    terrain: plan.terrain, target: plan.target, targetKind: plan.targetKind, radius: plan.radius,
    startAt: plan.startAt, handoffAt: plan.handoffAt, coverageEndAt: plan.coverageEndAt,
    attempts: [attempt(0), attempt(1)] });
}
