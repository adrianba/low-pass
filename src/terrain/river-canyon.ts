import { FLOOR } from '../config/game';
import { hash, noise, smooth } from '../simulation/math';

export const CANYON = {
  cell: 8, water: 0, bed: -10, shelfSpacing: 1600, shelfOrigin: 800, shelfHalfLength: 220, shelfTaper: 420,
  bankTarget: 80, bankEdge: 36, corridor: 66, shelfWidth: 128, wallRise: 230,
} as const;

export const canyonCenter = (z: number): number => 65 * Math.sin(z / 950) + 35 * Math.sin(z / 2200);
export const canyonSlope = (z: number): number => 65 / 950 * Math.cos(z / 950) + 35 / 2200 * Math.cos(z / 2200);
export const canyonCurvature = (z: number): number => -65 / 950 ** 2 * Math.sin(z / 950) - 35 / 2200 ** 2 * Math.sin(z / 2200);
export const shelfSide = (index: number): number => hash(index, 347, 29) < 0.5 ? -1 : 1;

export function canyonVertex(x: number, z: number): number {
  const offset = x - canyonCenter(z), width = Math.abs(offset);
  const shelf = Math.round((z - CANYON.shelfOrigin) / CANYON.shelfSpacing);
  const reach = Math.abs(z - CANYON.shelfOrigin - shelf * CANYON.shelfSpacing);
  const shelfBlend = (Math.sign(offset) === shelfSide(shelf) ? 1 : 0)
    * (1 - smooth((reach - CANYON.shelfHalfLength) / CANYON.shelfTaper));
  const wallStart = CANYON.corridor + (CANYON.shelfWidth - CANYON.corridor) * shelfBlend;
  const bank = CANYON.bed + (FLOOR - CANYON.bed) * smooth((width - 17) / (CANYON.bankEdge - 17));
  const wall = smooth((width - wallStart) / 105);
  return bank + wall * (CANYON.wallRise + noise(x / 90, z / 160, 97) * 55);
}
