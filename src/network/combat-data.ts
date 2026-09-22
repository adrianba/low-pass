import { combat, referencedCombat } from '../../shared/protocol/game.js';
import type { CombatData, ReferencedCombat } from '../../shared/protocol/game.js';
import { readCombatPlanData } from '../game/multiplayer/combat-plan.js';
import { AircraftMotion } from '../game/aircraft-motion.js';
import type { FormationData } from './replica-plans.js';

type Reference = ReferencedCombat['missile']['motion']['track'];
export interface ReferencedFormation { reference: Reference; data: FormationData }

/** Reuse verified numeric knots; never quantize them or repeat candidate selection. */
export function combatTransferData(value: unknown, plans: readonly ReferencedFormation[]): ReferencedCombat {
  const data = combat.parse(value), motion = data.missile.motion;
  if (motion.kind !== 'track' || motion.entry) throw new Error('Referenced combat requires paired flight motion.');
  const identify = (track: typeof motion.track): Reference => {
    const encoded = JSON.stringify(track);
    const plan = plans.find(plan => (plan.data.terrain === 'river-canyon' ? 'canyon' : 'formation') === motion.style &&
      JSON.stringify(plan.data.attempts[data.slot].track) === encoded);
    if (!plan) throw new Error('Combat requires its exact verified flight track.');
    return plan.reference;
  };
  return referencedCombat.parse({ ...data, missile: { ...data.missile, motion: {
    ...motion, kind: 'track-reference', track: identify(motion.track),
    next: motion.next ? { ...motion.next, track: identify(motion.next.track) } : motion.next,
  } } });
}

export function combatDependencies(value: CombatData | ReferencedCombat): Reference[] {
  const motion = value.missile.motion;
  return motion.kind === 'track-reference' ? [motion.track, ...(motion.next ? [motion.next.track] : [])] : [];
}

export function expandCombat(value: CombatData | ReferencedCombat, resolve: (reference: Reference) => FormationData): CombatData {
  const motion = value.missile.motion;
  if (motion.kind !== 'track-reference') return combat.parse(value);
  const track = (reference: Reference) => {
    const plan = resolve(reference);
    if ((plan.terrain === 'river-canyon' ? 'canyon' : 'formation') !== motion.style) throw new Error('Combat flight style mismatch.');
    return plan.attempts[value.slot].track;
  };
  const expanded = combat.parse({ ...value, missile: { ...value.missile, motion: {
    ...motion, kind: 'track', track: track(motion.track),
    next: motion.next ? { ...motion.next, track: track(motion.next.track) } : motion.next,
  } } });
  readCombatPlanData(expanded);
  AircraftMotion.fromData(expanded.missile.motion);
  return expanded;
}
