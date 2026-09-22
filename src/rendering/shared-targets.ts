import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import { MAX_SESSION_PLANS } from '../game/multiplayer/session';
import type { SharedTargetFrame } from './shared-frame';
import { TargetModels } from './target-model';

interface Shadows {
  addShadowCaster(mesh: AbstractMesh): void;
  removeShadowCaster(mesh: AbstractMesh): void;
}
interface TargetSlot { id: number | null; models: TargetModels; ring: Mesh; destroyed: boolean }

export class SharedTargets {
  private readonly slots: TargetSlot[];
  private disposed = false;
  constructor(scene: Scene, private readonly shadows: Shadows, template: Mesh) {
    this.slots = Array.from({ length: MAX_SESSION_PLANS }, (_, index) => {
      const models = new TargetModels(scene), prefix = `Shared target ${index} `;
      models.root.name = `${prefix}root`;
      for (const node of models.root.getDescendants()) node.name = `${prefix}${node.name}`;
      for (const mesh of models.root.getChildMeshes()) shadows.addShadowCaster(mesh);
      const ring = template.clone(`${prefix}rings`, null);
      ring.setEnabled(false); models.root.setEnabled(false);
      return { id: null, models, ring, destroyed: false };
    });
  }

  update(targets: readonly SharedTargetFrame[], origin: number): void {
    if (this.disposed) throw new Error('Shared targets are disposed.');
    if (targets.length > this.slots.length || new Set(targets.map(t => t.id)).size !== targets.length) {
      throw new Error('Shared target pool capacity or identity conflict.');
    }
    for (const target of targets) {
      const slot = this.slots.find(s => s.id === target.id);
      if (slot && (slot.models.kind !== target.kind || (slot.destroyed && !target.destroyed))) {
        throw new Error('An existing shared target cannot change kind or repair damage.');
      }
    }
    for (const slot of this.slots) if (!targets.some(target => target.id === slot.id)) this.clear(slot);
    for (const target of targets) {
      const slot = this.slots.find(s => s.id === target.id) ?? this.slots.find(s => s.id === null)!;
      if (slot.id !== target.id) { slot.models.select(target.kind); slot.id = target.id; }
      slot.models.root.setEnabled(true); slot.ring.setEnabled(true);
      slot.models.root.position.set(target.position.x, target.position.y, target.position.z - origin);
      slot.models.root.rotation.y = target.heading;
      slot.ring.position.set(target.position.x, target.position.y + 0.08, target.position.z - origin);
      slot.models.setDestroyed(target.destroyed);
      slot.destroyed = target.destroyed;
    }
  }

  reset(): void { for (const slot of this.slots) this.clear(slot); }
  private clear(slot: TargetSlot): void {
    if (slot.id === null) return;
    slot.id = null; slot.destroyed = false;
    slot.models.reset(); slot.models.root.setEnabled(false); slot.ring.setEnabled(false);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) {
      for (const mesh of slot.models.root.getChildMeshes()) this.shadows.removeShadowCaster(mesh);
      const materials = new Set(slot.models.root.getChildMeshes().map(mesh => mesh.material));
      slot.models.root.dispose();
      for (const material of materials) material?.dispose(false, false);
      slot.ring.dispose();
    }
  }
}
