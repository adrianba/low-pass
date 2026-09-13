import { hash } from '../simulation/math';

export const TARGET_KINDS = ['tank', 'radar', 'sam'] as const;
export type TargetKind = typeof TARGET_KINDS[number];

export function targetFromRoll(roll: number): TargetKind {
  if (!Number.isFinite(roll) || roll < 0 || roll > 1) throw new Error('Target roll must be between zero and one.');
  return TARGET_KINDS[Math.min(Math.floor(roll * TARGET_KINDS.length), TARGET_KINDS.length - 1)]!;
}

export function selectTargetKind(count: number, seed: number): TargetKind {
  return targetFromRoll(hash(count, 193, seed));
}
