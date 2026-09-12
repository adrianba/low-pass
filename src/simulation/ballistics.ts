import { EDGE_EPSILON, GRAVITY, STEP, TARGET_RADIUS } from '../config/game';
import { terrainImpact } from '../terrain/heightfield';
import type { Vec3 } from './math';

export interface Bomb { position: Vec3; velocity: Vec3; age: number }

export function advanceBomb(bomb: Bomb, dt = STEP): Vec3 | null {
  const old = bomb.position;
  const next = {
    x: old.x + bomb.velocity.x * dt,
    y: old.y + bomb.velocity.y * dt - 0.5 * GRAVITY * dt * dt,
    z: old.z + bomb.velocity.z * dt,
  };
  bomb.velocity.y -= GRAVITY * dt;
  bomb.age += dt;
  const impact = terrainImpact(old, next);
  bomb.position = impact ?? next;
  return impact;
}

export function predictImpact(launch: Bomb): Vec3 {
  const bomb = { position: { ...launch.position }, velocity: { ...launch.velocity }, age: 0 };
  for (let i = 0; i < 2400; i++) {
    const impact = advanceBomb(bomb);
    if (impact) return impact;
  }
  throw new Error('Bomb trajectory exceeded its supported flight duration.');
}

export function accuracy(impact: Vec3, target: Vec3, radius = TARGET_RADIUS): number {
  const d = Math.hypot(impact.x - target.x, impact.z - target.z);
  return d > radius + EDGE_EPSILON ? 0 : Math.max(1, Math.round(100 - 99 * Math.min(d, radius) / radius));
}
