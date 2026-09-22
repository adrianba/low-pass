import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder';
import { CreateIcoSphere } from '@babylonjs/core/Meshes/Builders/icoSphereBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Material } from '@babylonjs/core/Materials/material';
import type { Scene } from '@babylonjs/core/scene';
import { MAX_SESSION_PLANS } from '../game/multiplayer/session';
import { hash } from '../simulation/math';
import type { SharedImpactFrame } from './shared-frame';
import { SplashView } from './splash-view';

interface ImpactSlot { id: number | null; scar: Mesh; dust: Mesh[]; splash: SplashView }

export class SharedImpacts {
  private readonly slots: ImpactSlot[];
  private disposed = false;
  constructor(scene: Scene, dustMaterial: Material, scarMaterial: Material, splashMaterial: Material) {
    this.slots = Array.from({ length: MAX_SESSION_PLANS * 2 }, (_, index) => {
      const prefix = `Shared impact ${index} `;
      const scar = CreateDisc(`${prefix}scar`, { radius: 3.2, tessellation: 24 }, scene);
      scar.material = scarMaterial; scar.isPickable = false; scar.setEnabled(false);
      const dust = Array.from({ length: 14 }, () => {
        const mesh = CreateIcoSphere(`${prefix}dust`, { radius: 1.1, subdivisions: 1 }, scene);
        mesh.material = dustMaterial; mesh.isPickable = false; mesh.setEnabled(false);
        return mesh;
      });
      return { id: null, scar, dust, splash: new SplashView(scene, splashMaterial, prefix) };
    });
  }
  update(impacts: readonly SharedImpactFrame[], time: number, origin: number, canyon: boolean): void {
    if (this.disposed || impacts.length > this.slots.length || new Set(impacts.map(i => i.id)).size !== impacts.length) {
      throw new Error('Invalid shared impact pool update.');
    }
    for (const slot of this.slots) if (!impacts.some(impact => impact.id === slot.id)) this.clear(slot);
    for (const result of impacts) {
      const slot = this.slots.find(s => s.id === result.id) ?? this.slots.find(s => s.id === null)!;
      slot.id = result.id;
      const p = result.impact, age = time - result.time, ground = p.kind === 'ground';
      slot.splash.update(p, ground ? Infinity : age, origin);
      slot.scar.setEnabled(ground && age >= 0);
      if (ground) {
        slot.scar.position.set(p.x, p.y + 0.15, p.z - origin);
        const n = canyon ? p.normal : { x: 0, y: 1, z: 0 }, axis = new Vector3(n.z, 0, -n.x);
        const rotation = axis.lengthSquared() > 1e-10
          ? Quaternion.RotationAxis(axis.normalize(), Math.acos(Math.max(-1, Math.min(1, n.y)))) : Quaternion.Identity();
        slot.scar.rotationQuaternion = rotation.multiply(Quaternion.RotationAxis(Vector3.Right(), Math.PI / 2));
      }
      for (let i = 0; i < slot.dust.length; i++) {
        const mesh = slot.dust[i]!;
        mesh.setEnabled(ground && age >= 0 && age < 2);
        if (!mesh.isEnabled()) continue;
        mesh.position.set(p.x + (hash(i, 7) - 0.5) * 18 * age,
          p.y + (4 + hash(i, 31) * 9) * age - 2.5 * age * age,
          p.z - origin + (hash(i, 13) - 0.5) * 18 * age);
        mesh.scaling.setAll(1 + age * 3); mesh.visibility = Math.max(0, 1 - age / 2);
      }
    }
  }
  reset(): void { for (const slot of this.slots) this.clear(slot); }
  private clear(slot: ImpactSlot): void {
    slot.id = null; slot.scar.setEnabled(false); slot.splash.reset();
    for (const mesh of slot.dust) mesh.setEnabled(false);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) { slot.scar.dispose(); slot.splash.dispose(); for (const mesh of slot.dust) mesh.dispose(); }
  }
}
