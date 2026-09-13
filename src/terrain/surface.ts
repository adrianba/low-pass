import { CELL } from '../config/game';
import type { TerrainTheme } from '../config/terrain';
import type { Vec3 } from '../simulation/math';
import { mix } from '../simulation/math';
import { terrainHeight, terrainImpact, valleyCenter, valleyCurvature, valleySlope, vertexHeight } from './heightfield';
import { CANYON, canyonCenter, canyonCurvature, canyonSlope, canyonVertex } from './river-canyon';

export interface Contact extends Vec3 { kind: 'ground' | 'water'; normal: Vec3 }

export class Surface {
  readonly cell: number;
  readonly vertex: (x: number, z: number) => number;
  readonly center: (z: number) => number;
  readonly slope: (z: number) => number;
  readonly curvature: (z: number) => number;
  constructor(readonly canyon = false, vertex?: (x: number, z: number) => number) {
    this.cell = canyon ? CANYON.cell : CELL;
    this.vertex = vertex ?? (canyon ? canyonVertex : vertexHeight);
    this.center = canyon ? canyonCenter : valleyCenter;
    this.slope = canyon ? canyonSlope : valleySlope;
    this.curvature = canyon ? canyonCurvature : valleyCurvature;
  }
  height = (x: number, z: number): number => terrainHeight(x, z, this.vertex, this.cell);
  wet(x: number, z: number): boolean { return this.canyon && this.height(x, z) < CANYON.water - 1e-7; }
  normal(x: number, z: number): Vec3 {
    const c = this.cell, gx = Math.floor(x / c) * c, gz = Math.floor(z / c) * c;
    const upper = (x - gx + z - gz) / c > 1;
    const dx = upper ? this.vertex(gx + c, gz + c) - this.vertex(gx, gz + c)
      : this.vertex(gx + c, gz) - this.vertex(gx, gz);
    const dz = upper ? this.vertex(gx + c, gz + c) - this.vertex(gx + c, gz)
      : this.vertex(gx, gz + c) - this.vertex(gx, gz);
    const length = Math.hypot(dx, c, dz);
    return { x: -dx / length, y: c / length, z: -dz / length };
  }
  ground(a: Vec3, b: Vec3): Vec3 | null { return terrainImpact(a, b, this.height, this.cell); }
  contact(a: Vec3, b: Vec3): Contact | null {
    const ground = this.ground(a, b);
    if (this.canyon && a.y >= CANYON.water && b.y <= CANYON.water && a.y !== b.y) {
      const t = (a.y - CANYON.water) / (a.y - b.y);
      const water = { x: mix(a.x, b.x, t), y: CANYON.water, z: mix(a.z, b.z, t) };
      if (this.wet(water.x, water.z) && (!ground || ground.y < CANYON.water - 1e-7)) {
        return { ...water, kind: 'water', normal: { x: 0, y: 1, z: 0 } };
      }
    }
    return ground ? { ...ground, kind: 'ground', normal: this.normal(ground.x, ground.z) } : null;
  }
}

export const valleySurface = new Surface();
export const canyonSurface = new Surface(true);
export const surfaceFor = (theme: TerrainTheme): Surface => theme === 'river-canyon' ? canyonSurface : valleySurface;
