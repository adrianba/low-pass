import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';

export class TargetVehicle {
  readonly root: TransformNode;
  private turret: TransformNode;
  private armor: PBRMaterial;

  constructor(scene: Scene) {
    this.root = new TransformNode('Target tank', scene);
    this.root.scaling.setAll(1.35);
    this.turret = new TransformNode('Tank turret', scene);
    this.turret.parent = this.root;
    this.turret.position.y = 2.2;
    this.armor = new PBRMaterial('Tank olive armor', scene);
    this.armor.albedoColor.set(0.24, 0.29, 0.15);
    this.armor.metallic = 0.45;
    this.armor.roughness = 0.68;
    const track = new PBRMaterial('Tank tracks and barrel bore', scene);
    track.albedoColor.set(0.055, 0.065, 0.045);
    track.metallic = 0.75;
    track.roughness = 0.8;
    const wheel = new PBRMaterial('Tank road wheels', scene);
    wheel.albedoColor.set(0.16, 0.19, 0.11);
    wheel.metallic = 0.6;
    wheel.roughness = 0.55;
    const box = (name: string, width: number, height: number, depth: number, x: number, y: number, z: number,
      material: PBRMaterial, parent = this.root) => {
      const mesh = CreateBox(name, { width, height, depth }, scene);
      mesh.position.set(x, y, z);
      mesh.parent = parent;
      mesh.material = material;
      return mesh;
    };
    box('Tank lower hull', 3.7, 1.15, 6.6, 0, 1.4, 0, this.armor);
    const deck = box('Tank sloping upper armor', 3.5, 0.65, 6.1, 0, 2.05, 0.15, this.armor);
    deck.rotation.x = -0.05;
    for (const side of [-1, 1]) {
      box('Tank track', 0.8, 1.25, 6.9, side * 2, 0.72, 0, track);
      box('Tank side skirt', 0.3, 0.85, 6.6, side * 2.38, 1.54, 0, this.armor);
      for (let i = 0; i < 6; i++) {
        const roadWheel = CreateCylinder('Tank road wheel', { height: 0.15, diameter: 0.92, tessellation: 12 }, scene);
        roadWheel.rotation.z = Math.PI / 2;
        roadWheel.position.set(side * 2.44, 0.75, -2.65 + i * 1.06);
        roadWheel.material = wheel;
        roadWheel.parent = this.root;
      }
      for (let i = 0; i < 9; i++) box('Track tread', 0.84, 0.07, 0.22, side * 2, 1.37, -3.1 + i * 0.77, track);
    }
    const turret = CreateCylinder('Tank armored turret', { height: 1.1, diameterTop: 2.6, diameterBottom: 3.55, tessellation: 8 }, scene);
    turret.position.y = 0.55;
    turret.scaling.z = 1.15;
    turret.parent = this.turret;
    turret.material = this.armor;
    box('Tank mantlet', 1.1, 0.65, 1, 0, 0.6, 1.8, this.armor, this.turret);
    const barrel = CreateCylinder('Tank gun barrel', { height: 4.6, diameter: 0.29, tessellation: 12 }, scene);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.66, 4);
    barrel.parent = this.turret;
    barrel.material = this.armor;
    const muzzle = CreateCylinder('Tank muzzle', { height: 0.25, diameter: 0.31, tessellation: 12 }, scene);
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, 0.66, 6.35);
    muzzle.parent = this.turret;
    muzzle.material = track;
    const hatch = CreateCylinder('Tank hatch', { height: 0.12, diameter: 0.95, tessellation: 16 }, scene);
    hatch.position.set(0.45, 1.16, -0.3);
    hatch.parent = this.turret;
    hatch.material = wheel;
    for (const mesh of this.root.getChildMeshes()) {
      mesh.isPickable = false;
      mesh.receiveShadows = true;
    }
  }

  setDestroyed(destroyed: boolean): void {
    this.armor.albedoColor.copyFrom(destroyed ? new Color3(0.06, 0.055, 0.045) : new Color3(0.24, 0.29, 0.15));
    this.turret.rotation.set(destroyed ? 0.2 : 0, destroyed ? 0.45 : 0, destroyed ? -0.22 : 0);
  }
}
