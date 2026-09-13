import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateLathe } from '@babylonjs/core/Meshes/Builders/latheBuilder';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { TargetModel } from './target-model';
import { TargetParts } from './target-parts';

export class TargetRadar extends TargetParts implements TargetModel {
  private readonly dish: TransformNode;

  constructor(scene: Scene) {
    super(scene, 'Target radar station');
    this.box('Radar foundation', 5.6, 0.28, 6.8, 0, 0.14, 0, this.dark);
    this.box('Radar equipment shelter', 4.2, 2.4, 4.5, 0, 1.48, -0.65);
    this.box('Radar shelter roof', 4.5, 0.2, 4.8, 0, 2.78, -0.65);
    this.box('Radar equipment door', 1, 1.9, 0.08, -0.9, 1.35, -2.94, this.metal);
    for (let i = 0; i < 5; i++) {
      this.box('Radar ventilation louver', 0.08, 0.1, 1.5, 2.14, 1.2 + i * 0.22, -0.7, this.dark);
    }
    this.cylinder('Radar mast', 3, 0.6, 0, 4.25, 0.3, this.metal);
    for (const side of [-1, 1]) {
      const brace = this.box('Radar mast brace', 0.14, 3, 0.14, side * 0.65, 4.1, 0.3, this.metal);
      brace.rotation.z = side * 0.42;
    }
    this.dish = new TransformNode('Radar dish assembly', scene);
    this.dish.parent = this.root;
    this.dish.position.set(0, 5.8, 0.3);
    this.dish.rotation.x = Math.PI / 2 - 0.35;
    const shape = Array.from({ length: 9 }, (_, i) => {
      const radius = i * 2.5 / 8;
      return new Vector3(radius, radius * radius * 0.2, 0);
    });
    const reflector = CreateLathe('Radar parabolic reflector', {
      shape, tessellation: 32, cap: Mesh.NO_CAP, sideOrientation: Mesh.DOUBLESIDE,
    }, scene);
    reflector.parent = this.dish;
    reflector.material = this.paint;
    const rim = CreateTorus('Radar dish rim', { diameter: 5, thickness: 0.1, tessellation: 32 }, scene);
    rim.position.y = 1.25;
    rim.parent = this.dish;
    rim.material = this.metal;
    this.cylinder('Radar feed support', 1.75, 0.10, 0, 0.85, 0, this.dark, this.dish);
    this.cylinder('Radar feed horn', 0.28, 0.4, 0, 1.8, 0, this.metal, this.dish);
    this.finish();
  }

  setDestroyed(destroyed: boolean): void {
    this.damagePaint(destroyed);
    this.dish.position.y = destroyed ? 3.8 : 5.8;
    this.dish.rotation.set(destroyed ? 1.8 : Math.PI / 2 - 0.35, destroyed ? 0.3 : 0, destroyed ? -0.55 : 0);
  }
}
