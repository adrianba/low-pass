import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { AssetContainer, InstantiatedEntries } from '@babylonjs/core/assetContainer';
import type { Scene } from '@babylonjs/core/scene';
import type { Bomb } from '../simulation/ballistics';
import type { Pose } from '../simulation/pose';

interface ShadowRegistry {
  addShadowCaster(mesh: AbstractMesh, includeDescendants?: boolean): void;
  removeShadowCaster(mesh: AbstractMesh, includeDescendants?: boolean): void;
}
export interface AircraftFrame {
  readonly pose: Pose;
  readonly bomb: Bomb | null;
  readonly released: boolean;
  readonly destroyed: boolean;
  readonly canyon: boolean;
}

export class AircraftView {
  readonly root: TransformNode;
  readonly bombRoot: TransformNode;
  readonly carriedBomb: TransformNode;
  private entries: InstantiatedEntries[] = [];
  private casters: AbstractMesh[] = [];
  private disposed = false;

  constructor(private readonly scene: Scene, private readonly shadows: ShadowRegistry, private readonly prefix = '') {
    this.root = new TransformNode(`${prefix}Aircraft pose`, scene);
    this.bombRoot = new TransformNode(`${prefix}Bomb pose`, scene);
    this.carriedBomb = new TransformNode(`${prefix}Carried bomb`, scene);
    this.carriedBomb.parent = this.root;
    this.carriedBomb.position.y = -2.2;
    this.bombRoot.setEnabled(false);
  }

  loadModels(aircraft: AssetContainer, bomb: AssetContainer): void {
    if (this.disposed || this.entries.length) throw new Error('Aircraft models can only be attached once to a live view.');
    if (aircraft.scene !== this.scene || bomb.scene !== this.scene) throw new Error('Aircraft assets belong to another scene.');
    const attach = (container: AssetContainer, parent: TransformNode, label: string) => {
      const entries = container.instantiateModelsToScene(name => `${this.prefix}${label}${name}`, false, { doNotInstantiate: true });
      this.entries.push(entries);
      for (const node of entries.rootNodes) {
        node.parent = parent;
        if (node instanceof TransformNode) node.rotate(Vector3.Up(), Math.PI);
      }
      for (const mesh of parent.getChildMeshes()) mesh.isPickable = false;
    };
    attach(aircraft, this.root, '');
    this.casters = this.root.getChildMeshes();
    for (const mesh of this.casters) this.shadows.addShadowCaster(mesh, false);
    attach(bomb, this.bombRoot, '');
    attach(bomb, this.carriedBomb, 'Carried ');
  }

  update(frame: AircraftFrame, origin: number): void {
    if (this.disposed) throw new Error('Cannot update a disposed aircraft view.');
    const { pose, bomb } = frame;
    this.root.position.set(pose.position.x, pose.position.y, pose.position.z - origin);
    this.root.rotation.set(pose.pitch, Math.atan2(pose.velocity.x, pose.velocity.z), pose.bank);
    this.root.setEnabled(!frame.destroyed);
    this.carriedBomb.setEnabled(!frame.released);
    this.bombRoot.setEnabled(bomb !== null);
    if (bomb) {
      this.bombRoot.position.set(bomb.position.x, bomb.position.y, bomb.position.z - origin);
      this.bombRoot.rotation.set(-Math.atan2(bomb.velocity.y, frame.canyon
        ? Math.hypot(bomb.velocity.x, bomb.velocity.z) : bomb.velocity.z),
      Math.atan2(bomb.velocity.x, bomb.velocity.z), 0);
    }
  }

  reset(): void {
    if (this.disposed) throw new Error('Cannot reset a disposed aircraft view.');
    this.root.setEnabled(true);
    this.carriedBomb.setEnabled(true);
    this.bombRoot.setEnabled(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.casters) this.shadows.removeShadowCaster(mesh, false);
    for (const entry of this.entries) entry.dispose();
    this.entries = [];
    this.casters = [];
    this.root.dispose();
    this.bombRoot.dispose();
  }
}
