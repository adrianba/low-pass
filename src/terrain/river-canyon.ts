import { FLOOR } from '../config/game';
import { hash, noise, smooth } from '../simulation/math';
import { projectRoute, routeMotion } from './canyon-route';

export const CANYON = {
  cell: 8, water: 0, bed: -10, shelfSpacing: 1600, shelfOrigin: 1400, shelfHalfLength: 220, shelfTaper: 420,
  bankTarget: 84, bankEdge: 36, corridor: 66, shelfWidth: 140, wallRise: 230,
} as const;

export const canyonCenter = (z: number): number => routeMotion(z).x;
export const canyonSlope = (z: number): number => routeMotion(z).slope;
export const canyonCurvature = (z: number): number => routeMotion(z).second;
export const shelfSide = (index: number): number => hash(index, 347, 29) < 0.5 ? -1 : 1;

const heights = new Map<string, number>();
const heightKeys: string[] = [];
let nextHeight = 0;

export function canyonVertex(x: number, z: number): number {
  const key = `${x},${z}`;
  const cached = heights.get(key);
  if (cached !== undefined) return cached;
  const projected = projectRoute(x, z);
  const offset = projected.lateral, width = Math.abs(offset);
  const shelf = Math.round((projected.along - CANYON.shelfOrigin) / CANYON.shelfSpacing);
  const reach = Math.abs(projected.along - CANYON.shelfOrigin - shelf * CANYON.shelfSpacing);
  const shelfBlend = (Math.sign(offset) === shelfSide(shelf) ? 1 : 0)
    * (1 - smooth((reach - CANYON.shelfHalfLength) / CANYON.shelfTaper));
  const wallStart = CANYON.corridor + (CANYON.shelfWidth - CANYON.corridor) * shelfBlend;
  const bank = CANYON.bed + (FLOOR - CANYON.bed) * smooth((width - 17) / (CANYON.bankEdge - 17));
  const wall = smooth((width - wallStart) / 105);
  const height = bank + wall * (CANYON.wallRise + noise(x / 90, z / 160, 97) * 55);
  if (heightKeys.length < 80_000) heightKeys.push(key);
  else {
    heights.delete(heightKeys[nextHeight]!);
    heightKeys[nextHeight] = key;
    nextHeight = (nextHeight + 1) % 80_000;
  }
  heights.set(key, height);
  return height;
}
