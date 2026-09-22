import { CreateIcoSphere } from '@babylonjs/core/Meshes/Builders/icoSphereBuilder';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Material } from '@babylonjs/core/Materials/material';
import type { Scene } from '@babylonjs/core/scene';
import { hash } from '../simulation/math';
import type { Vec3 } from '../simulation/math';

export class SplashView {
  private readonly drops: Mesh[];
  private readonly ripple: Mesh;
  constructor(scene: Scene, material: Material, prefix = '') {
    this.drops = Array.from({ length: 20 }, () => {
      const drop = CreateIcoSphere(`${prefix}Splash droplet`, { radius: 0.38, subdivisions: 1 }, scene);
      drop.material = material; drop.isPickable = false; drop.setEnabled(false);
      return drop;
    });
    this.ripple = CreateTorus(`${prefix}Splash ripple`, { diameter: 2, thickness: 0.16, tessellation: 48 }, scene);
    this.ripple.material = material; this.ripple.isPickable = false; this.ripple.setEnabled(false);
  }
  update(p: Readonly<Vec3>, age: number, origin: number): void {
    const t = age;
    for (let i = 0; i < this.drops.length; i++) {
      const drop = this.drops[i]!, height = (10 + hash(i, 271) * 12) * t - 12 * t * t;
      drop.setEnabled(t >= 0 && t < 2 && height >= 0);
      if (!drop.isEnabled()) continue;
      const angle = i * Math.PI * 2 / this.drops.length;
      drop.position.set(p.x + Math.cos(angle) * t * 8, p.y + height, p.z - origin + Math.sin(angle) * t * 8);
      drop.scaling.set(1, 1.8, 1); drop.visibility = Math.max(0, 1 - t / 2);
    }
    this.ripple.setEnabled(t >= 0 && t < 2.4);
    if (this.ripple.isEnabled()) {
      this.ripple.position.set(p.x, p.y + 0.08, p.z - origin);
      this.ripple.scaling.set(1 + t * 9, 1, 1 + t * 9);
      this.ripple.visibility = Math.max(0, 1 - t / 2.4);
    }
  }
  reset(): void { for (const drop of this.drops) drop.setEnabled(false); this.ripple.setEnabled(false); }
  dispose(): void { for (const drop of this.drops) drop.dispose(); this.ripple.dispose(); }
}
