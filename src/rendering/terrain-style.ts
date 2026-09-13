import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { TerrainTheme } from '../config/terrain';
import { noise } from '../simulation/math';

export const TERRAIN_PALETTES = {
  'green-valley': {
    sky: new Color3(0.49, 0.65, 0.74), sun: new Color3(1, 0.92, 0.78),
    fill: new Color3(0.69, 0.8, 1), ground: new Color3(0.21, 0.25, 0.16),
    rock: new Color3(0.36, 0.37, 0.32), dust: new Color3(0.5, 0.43, 0.31),
    reflectionGround: [64, 75, 43], reflectionSky: [142, 181, 217],
  },
  desert: {
    sky: new Color3(0.72, 0.76, 0.75), sun: new Color3(1, 0.94, 0.83),
    fill: new Color3(0.80, 0.86, 1), ground: new Color3(0.46, 0.34, 0.20),
    rock: new Color3(0.56, 0.40, 0.25), dust: new Color3(0.70, 0.53, 0.32),
    reflectionGround: [140, 105, 65], reflectionSky: [177, 200, 218],
  },
} satisfies Record<TerrainTheme, {
  sky: Color3; sun: Color3; fill: Color3; ground: Color3; rock: Color3; dust: Color3;
  reflectionGround: [number, number, number]; reflectionSky: [number, number, number];
}>;

export function terrainTint(theme: TerrainTheme, x: number, z: number): number[] {
  const variation = noise(x / 160, z / 160, 77);
  return theme === 'green-valley'
    ? [0.35 + variation * 0.24, 0.48 + variation * 0.26, 0.24 + variation * 0.18, 1]
    : [0.92 + variation * 0.08, 0.92 + variation * 0.08, 0.92 + variation * 0.08, 1];
}

export function terrainProp(theme: TerrainTheme, index: number): 'tree' | 'rock' | null {
  if (theme === 'desert') return index % 8 === 0 ? 'rock' : null;
  return index % 4 ? 'tree' : 'rock';
}
