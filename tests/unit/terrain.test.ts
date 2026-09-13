import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { createDesertMaterial, SAND_PERIOD } from '../../src/rendering/desert-material';
import { terrainTint, terrainProp } from '../../src/rendering/terrain-style';
import { noise } from '../../src/simulation/math';
import { isTerrainTheme } from '../../src/config/terrain';

describe('terrain themes', () => {
  it('accepts only the two known terrain IDs', () => {
    expect(isTerrainTheme('green-valley')).toBe(true);
    expect(isTerrainTheme('desert')).toBe(true);
    for (const value of [null, undefined, 'ocean', 1, {}]) expect(isTerrainTheme(value)).toBe(false);
  });
  it('preserves valley colors and props exactly and removes desert vegetation', () => {
    const v = noise(10 / 160, 20 / 160, 77);
    expect(terrainTint('green-valley', 10, 20)).toEqual([0.35 + v * 0.24, 0.48 + v * 0.26, 0.24 + v * 0.18, 1]);
    const desert = terrainTint('desert', 10, 20);
    expect(desert[0]).toBe(desert[1]);
    for (let i = 0; i < 100; i++) {
      expect(terrainProp('green-valley', i)).toBe(i % 4 ? 'tree' : 'rock');
      expect(terrainProp('desert', i)).toBe(i % 8 ? null : 'rock');
    }
  });
  it('creates one original sand material without textures and bounds origin phase', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const sand = createDesertMaterial(scene);
      expect(sand.material.getActiveTextures()).toHaveLength(0);
      expect(scene.materials).toHaveLength(1);
      expect(sand.getCustomCode('vertex')).toBeNull();
      expect(SAND_PERIOD % 256).toBe(0);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
