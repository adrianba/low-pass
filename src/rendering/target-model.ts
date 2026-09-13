import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import type { TargetKind } from '../game/targets';
import { TargetVehicle } from './target-vehicle';
import { TargetRadar } from './target-radar';
import { TargetSam } from './target-sam';

export interface TargetModel {
  readonly root: TransformNode;
  setDestroyed(destroyed: boolean): void;
}

export class TargetModels {
  readonly root: TransformNode;
  private readonly models: Record<TargetKind, TargetModel>;
  private active: TargetKind | null = null;

  constructor(scene: Scene) {
    this.root = new TransformNode('Encounter target', scene);
    this.models = { tank: new TargetVehicle(scene), radar: new TargetRadar(scene), sam: new TargetSam(scene) };
    for (const model of Object.values(this.models)) model.root.parent = this.root;
    this.reset();
  }

  get kind(): TargetKind | null { return this.active; }

  select(kind: TargetKind): void {
    if (this.active) this.models[this.active].root.setEnabled(false);
    this.active = kind;
    this.models[kind].setDestroyed(false);
    this.models[kind].root.setEnabled(true);
  }

  setDestroyed(destroyed: boolean): void {
    if (!this.active) throw new Error('Cannot damage a target before selection.');
    this.models[this.active].setDestroyed(destroyed);
  }

  reset(): void {
    this.active = null;
    this.root.position.setAll(0);
    this.root.rotation.setAll(0);
    for (const model of Object.values(this.models)) {
      model.setDestroyed(false);
      model.root.setEnabled(false);
    }
  }
}
