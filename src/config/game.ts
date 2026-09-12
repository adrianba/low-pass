export const STEP = 1 / 120;
export const GRAVITY = 24;
export const FLOOR = 12;
export const ATTACK_HEIGHT = 58;
export const CRUISE_HEIGHT = 155;
export const TARGET_RADIUS = 28;
export const CELL = 16;
export const CHUNK = 256;
export const MAX_MISSES = 3;
export const MAX_SPEED = 350;
export const DIFFICULTY_STEPS = 12;
export const EDGE_EPSILON = 1e-7;
export type Quality = 'low' | 'medium' | 'high';
export const QUALITY = {
  low: { scale: 1.5, shadow: 512, trees: 5, distance: 1500 },
  medium: { scale: 1, shadow: 1024, trees: 10, distance: 1850 },
  high: { scale: 0.8, shadow: 2048, trees: 16, distance: 2150 },
} satisfies Record<Quality, { scale: number; shadow: number; trees: number; distance: number }>;

export function difficulty(encounters: number) {
  const step = Math.min(Math.max(0, encounters), DIFFICULTY_STEPS);
  const level = step / DIFFICULTY_STEPS;
  return {
    level: step + 1,
    speed: 76 + (MAX_SPEED - 76) * level,
    amplitude: 13 + 21 * level,
    frequency: 0.34 + 0.81 * level,
    diveDuration: 2.3 - 1.3 * level,
  };
}

export function targetSightDistance(encounters: number): number {
  const { speed, diveDuration } = difficulty(encounters);
  const fallTime = Math.sqrt(2 * ATTACK_HEIGHT / GRAVITY);
  return Math.max(1200, speed * (fallTime + diveDuration + 1) + 100);
}
