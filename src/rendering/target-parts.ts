import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';

export class TargetParts {
  readonly root: TransformNode;
  protected readonly paint: PBRMaterial;
  protected readonly dark: PBRMaterial;
  protected readonly metal: PBRMaterial;
  private readonly intactColor = new Color3(0.28, 0.32, 0.19);

  constructor(protected readonly scene: Scene, name: string) {
    this.root = new TransformNode(name, scene);
    this.root.scaling.setAll(1.35);
    this.paint = new PBRMaterial(`${name} paint`, scene);
    this.paint.albedoColor.copyFrom(this.intactColor);
    this.paint.metallic = 0.35;
    this.paint.roughness = 0.72;
    this.dark = new PBRMaterial(`${name} rubber and vents`, scene);
    this.dark.albedoColor.set(0.045, 0.055, 0.04);
    this.dark.roughness = 0.85;
    this.metal = new PBRMaterial(`${name} fittings`, scene);
    this.metal.albedoColor.set(0.48, 0.49, 0.40);
    this.metal.metallic = 0.65;
    this.metal.roughness = 0.55;
  }

  protected box(name: string, width: number, height: number, depth: number, x: number, y: number, z: number,
    material = this.paint, parent = this.root) {
    const mesh = CreateBox(name, { width, height, depth }, this.scene);
    mesh.position.set(x, y, z);
    mesh.material = material;
    mesh.parent = parent;
    return mesh;
  }

  protected cylinder(name: string, height: number, diameter: number, x: number, y: number, z: number,
    material = this.paint, parent = this.root) {
    const mesh = CreateCylinder(name, { height, diameter, tessellation: 12 }, this.scene);
    mesh.position.set(x, y, z);
    mesh.material = material;
    mesh.parent = parent;
    return mesh;
  }

  protected finish(): void {
    for (const mesh of this.root.getChildMeshes()) {
      mesh.isPickable = false;
      mesh.receiveShadows = true;
    }
  }

  protected damagePaint(destroyed: boolean): void {
    this.paint.albedoColor.copyFrom(destroyed ? new Color3(0.06, 0.055, 0.045) : this.intactColor);
  }
}
