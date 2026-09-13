import type { Pose } from '../game/run';
import type { Surface } from '../terrain/surface';
import { mix } from './math';
import type { Vec3 } from './math';
import { distance } from './math';
import { TARGET_RADIUS } from '../config/game';

export interface ChaseView { position: Vec3; target: Vec3 }
export const CHASE_FOV = 0.92;

export function chaseView(pose: Pose, surface: Surface, previous: Vec3 | null, dt: number): ChaseView {
  const p = pose.position;
  const desired = { x: mix(surface.center(p.z), p.x, 0.7), y: p.y + 16, z: p.z - 40 };
  desired.y = Math.max(desired.y, surface.height(desired.x, desired.z) + 16);
  const alpha = 1 - Math.exp(-dt * 6);
  const position = previous ? {
    x: mix(previous.x, desired.x, alpha), y: mix(previous.y, desired.y, alpha), z: mix(previous.z, desired.z, alpha),
  } : desired;
  if (surface.canyon) position.y = Math.max(position.y, surface.height(position.x, position.z) + 16);
  return { position, target: { x: mix(surface.center(p.z + 95), p.x, 0.45), y: p.y - 9, z: p.z + 95 } };
}

export function projectChase(point: Vec3, view: ChaseView, aspect: number): { x: number; y: number } | null {
  const normalize = (v: Vec3): Vec3 => {
    const length = Math.hypot(v.x, v.y, v.z);
    return { x: v.x / length, y: v.y / length, z: v.z / length };
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
  const from = view.position;
  const forward = normalize({ x: view.target.x - from.x, y: view.target.y - from.y, z: view.target.z - from.z });
  const right = normalize(cross({ x: 0, y: 1, z: 0 }, forward)), up = cross(forward, right);
  const delta = { x: point.x - from.x, y: point.y - from.y, z: point.z - from.z };
  const depth = dot(delta, forward);
  if (depth < 0.5 || depth > 3500) return null;
  const scale = depth * Math.tan(CHASE_FOV / 2);
  return { x: 0.5 + dot(delta, right) / (2 * scale * aspect), y: 0.5 - dot(delta, up) / (2 * scale) };
}

export function targetInChaseView(target: Vec3, view: ChaseView, surface: Surface, aspect: number, range: number): boolean {
  if (distance(view.position, target) > range) return false;
  const center = projectChase(target, view, aspect);
  if (!center || center.x < 0.05 || center.x > 0.95 || center.y < 0.1 || center.y > 0.94) return false;
  for (const [dx, dz] of [[0, 0], [-TARGET_RADIUS, 0], [TARGET_RADIUS, 0], [0, -TARGET_RADIUS], [0, TARGET_RADIUS]]) {
    const point = { x: target.x + dx!, y: target.y + 0.5, z: target.z + dz! };
    const screen = projectChase(point, view, aspect);
    if (!screen || screen.x < 0 || screen.x > 1 || screen.y < 0 || screen.y > 1
      || surface.ground(view.position, point)) return false;
  }
  return true;
}
