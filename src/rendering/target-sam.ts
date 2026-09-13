import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import type { TargetModel } from './target-model';
import { TargetParts } from './target-parts';

export class TargetSam extends TargetParts implements TargetModel {
  private readonly rack: TransformNode;

  constructor(scene: Scene) {
    super(scene, 'Target SAM launcher');
    this.box('SAM chassis', 3.6, 0.6, 7.2, 0, 1.15, 0, this.dark);
    this.box('SAM equipment deck', 3.5, 0.6, 5, 0, 1.7, -0.9);
    this.box('SAM truck cab', 3.4, 1.85, 2.1, 0, 2.28, 2.5);
    this.box('SAM windscreen', 2.85, 0.68, 0.08, 0, 2.65, 3.57, this.dark);
    this.box('SAM bumper', 3.8, 0.3, 0.3, 0, 1.3, 3.7, this.metal);
    for (const side of [-1, 1]) {
      for (const z of [-2.5, -0.7, 2.4]) {
        const tire = this.cylinder('SAM road tire', 0.6, 1.5, side * 1.95, 0.75, z, this.dark);
        tire.rotation.z = Math.PI / 2;
        const hub = this.cylinder('SAM wheel hub', 0.64, 0.72, side * 1.95, 0.75, z, this.metal);
        hub.rotation.z = Math.PI / 2;
      }
      for (const z of [-2, 1]) {
        this.box('SAM outrigger', 1.3, 0.18, 0.2, side * 2.25, 0.9, z, this.metal);
        this.cylinder('SAM stabilizer', 0.8, 0.18, side * 2.8, 0.5, z, this.metal);
        this.box('SAM stabilizer foot', 0.65, 0.2, 0.7, side * 2.8, 0.1, z, this.dark);
      }
    }
    this.cylinder('SAM launcher pedestal', 0.9, 1.65, 0, 2.4, -1);
    this.rack = new TransformNode('SAM tube rack', scene);
    this.rack.parent = this.root;
    this.rack.position.set(0, 3.15, -1);
    this.rack.rotation.x = -0.65;
    this.box('SAM rack cradle', 3.1, 0.18, 3.5, 0, -0.55, 0, this.metal, this.rack);
    for (const x of [-0.85, 0.85]) for (const y of [0, 0.9]) {
      const tube = this.cylinder('SAM launch tube', 4.8, 0.78, x, y, 0, this.paint, this.rack);
      tube.rotation.x = Math.PI / 2;
      for (const z of [-2.43, 2.43]) {
        const cap = this.cylinder('SAM tube end cap', 0.1, 0.8, x, y, z, this.dark, this.rack);
        cap.rotation.x = Math.PI / 2;
      }
      for (const z of [-1.5, 1.5]) {
        const band = this.cylinder('SAM tube retaining band', 0.15, 0.84, x, y, z, this.metal, this.rack);
        band.rotation.x = Math.PI / 2;
      }
    }
    this.finish();
  }

  setDestroyed(destroyed: boolean): void {
    this.damagePaint(destroyed);
    this.rack.position.y = destroyed ? 2.65 : 3.15;
    this.rack.rotation.set(destroyed ? -0.15 : -0.65, destroyed ? 0.2 : 0, destroyed ? 0.3 : 0);
  }
}
