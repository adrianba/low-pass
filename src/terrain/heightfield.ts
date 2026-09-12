import { CELL, FLOOR } from '../config/game';
import { mix, noise, smooth } from '../simulation/math';
import type { Vec3 } from '../simulation/math';

export const valleyCenter = (z: number): number => 120 * Math.sin(z / 1500) + 80 * Math.sin(z / 3800);
export const valleySlope = (z: number): number => 120 / 1500 * Math.cos(z / 1500) + 80 / 3800 * Math.cos(z / 3800);
export const valleyCurvature = (z: number): number => -120 / 1500 ** 2 * Math.sin(z / 1500) - 80 / 3800 ** 2 * Math.sin(z / 3800);

export function vertexHeight(x: number, z: number): number {
  const valley = smooth((Math.abs(x - valleyCenter(z)) - 170) / 550);
  const broad = noise(x / 410, z / 410, 43);
  const detail = noise(x / 85, z / 85, 17);
  const ridge = 1 - Math.abs(noise(x / 230, z / 290, 9) * 2 - 1);
  return FLOOR + valley * (22 + broad * 110 + ridge * ridge * 55 + detail * 12);
}

export function terrainHeight(x: number, z: number): number {
  const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
  const u = x / CELL - gx, v = z / CELL - gz;
  const a = vertexHeight(gx * CELL, gz * CELL);
  const b = vertexHeight((gx + 1) * CELL, gz * CELL);
  const c = vertexHeight(gx * CELL, (gz + 1) * CELL);
  const d = vertexHeight((gx + 1) * CELL, (gz + 1) * CELL);
  return u + v <= 1 ? a + u * (b - a) + v * (c - a)
    : d + (1 - u) * (c - d) + (1 - v) * (b - d);
}

// Split at every grid edge and diagonal: height is affine inside each triangle.
export function terrainImpact(a: Vec3, b: Vec3): Vec3 | null {
  const cuts = [0, 1];
  const crossings = (from: number, to: number, spacing: number) => {
    if (from === to) return;
    const lo = Math.floor(Math.min(from, to) / spacing) + 1;
    const hi = Math.floor(Math.max(from, to) / spacing);
    for (let i = lo; i <= hi; i++) {
      const t = (i * spacing - from) / (to - from);
      if (t > 0 && t < 1) cuts.push(t);
    }
  };
  crossings(a.x, b.x, CELL);
  crossings(a.z, b.z, CELL);
  crossings(a.x + a.z, b.x + b.z, CELL);
  cuts.sort((x, y) => x - y);
  const point = (t: number) => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), z: mix(a.z, b.z, t) });
  let previous = point(0);
  let gap = previous.y - terrainHeight(previous.x, previous.z);
  if (gap <= 0) return { ...previous, y: terrainHeight(previous.x, previous.z) };
  for (let i = 1; i < cuts.length; i++) {
    const next = point(cuts[i]!);
    const nextGap = next.y - terrainHeight(next.x, next.z);
    if (nextGap <= 0) {
      const t = gap / (gap - nextGap);
      return { x: mix(previous.x, next.x, t), y: mix(previous.y, next.y, t), z: mix(previous.z, next.z, t) };
    }
    previous = next;
    gap = nextGap;
  }
  return null;
}
