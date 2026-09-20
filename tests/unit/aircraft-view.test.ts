import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { AssetContainer } from '@babylonjs/core/assetContainer';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { AircraftView } from '../../src/rendering/aircraft-view';
import { initialPose, launchFrom } from '../../src/simulation/pose';

function template(scene: Scene, name: string): AssetContainer {
  const container = new AssetContainer(scene);
  const mesh = CreateBox(name, { size: 2 }, scene);
  const material = new StandardMaterial(name + ' material', scene);
  mesh.material = material;
  container.meshes.push(mesh);
  container.rootNodes.push(mesh);
  container.materials.push(material);
  container.geometries.push(mesh.geometry!);
  container.removeAllFromScene();
  return container;
}

describe('independent aircraft and bomb views', () => {
  it('shares immutable assets but isolates transforms, drops, destruction and resets', () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const aircraft = template(scene, 'Airframe'), bomb = template(scene, 'Practice bomb');
    const casters = new Set<AbstractMesh>();
    const shadows = {
      addShadowCaster: (mesh: AbstractMesh) => { expect(casters.has(mesh)).toBe(false); casters.add(mesh); },
      removeShadowCaster: (mesh: AbstractMesh) => { expect(casters.delete(mesh)).toBe(true); },
    };
    const lead = new AircraftView(scene, shadows), follower = new AircraftView(scene, shadows, 'Follower ');
    try {
      lead.loadModels(aircraft, bomb);
      follower.loadModels(aircraft, bomb);
      expect(casters.size).toBe(2);
      const leadMesh = scene.getMeshByName('Airframe'), followerMesh = scene.getMeshByName('Follower Airframe');
      expect(leadMesh).toBeInstanceOf(Mesh);
      expect(followerMesh).toBeInstanceOf(Mesh);
      if (!(leadMesh instanceof Mesh) || !(followerMesh instanceof Mesh)) throw new Error('Missing cloned model.');
      expect(leadMesh.geometry).toBe(followerMesh.geometry);
      expect(leadMesh.material).toBe(followerMesh.material);
      expect(leadMesh).not.toBe(followerMesh);
      const leadPose = initialPose({ x: 10, y: 100, z: 10_000 });
      leadPose.bank = 0.3;
      const followerPose = initialPose({ x: -10, y: 105, z: 9900 });
      const leadFrame = { pose: leadPose, bomb: launchFrom(leadPose), released: true, destroyed: false, canyon: true };
      const followerFrame = { pose: followerPose, bomb: null, released: false, destroyed: false, canyon: true };
      lead.update(leadFrame, 8192);
      follower.update(followerFrame, 8192);
      expect(lead.root.position.asArray()).toEqual([10, 100, 1808]);
      expect(follower.root.position.asArray()).toEqual([-10, 105, 1708]);
      expect(lead.bombRoot.isEnabled()).toBe(true);
      expect(lead.carriedBomb.isEnabled()).toBe(false);
      expect(follower.bombRoot.isEnabled()).toBe(false);
      expect(follower.carriedBomb.isEnabled()).toBe(true);
      const followerState = follower.root.position.clone();
      lead.update({ ...leadFrame, destroyed: true }, 8192);
      expect(lead.root.isEnabled()).toBe(false);
      expect(follower.root.isEnabled()).toBe(true);
      lead.reset();
      expect(lead.root.isEnabled()).toBe(true);
      expect(lead.carriedBomb.isEnabled()).toBe(true);
      expect(lead.bombRoot.isEnabled()).toBe(false);
      lead.update({ ...leadFrame, bomb: null }, 9984);
      expect(lead.root.position.z).toBe(16);
      expect(follower.root.position.equals(followerState)).toBe(true);
      expect(casters.size).toBe(2);
      expect(lead.root.getChildMeshes().every(mesh => !mesh.isPickable)).toBe(true);
      expect(() => lead.loadModels(aircraft, bomb)).toThrow(/once/);
      lead.dispose();
      lead.dispose();
      expect(casters.size).toBe(1);
      expect(follower.root.isDisposed()).toBe(false);
      expect(followerMesh.geometry).not.toBeNull();
      follower.update(followerFrame, 8192);
      expect(() => lead.update(leadFrame, 0)).toThrow(/disposed/);
    } finally {
      lead.dispose(); follower.dispose();
      expect(casters.size).toBe(0);
      aircraft.dispose(); bomb.dispose();
      expect(scene.meshes.length).toBe(0);
      expect(scene.transformNodes.length).toBe(0);
      scene.dispose(); engine.dispose();
    }
  });

  it('keeps resources and shadow lists bounded across repeated view creation', () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const aircraft = template(scene, 'Airframe'), bomb = template(scene, 'Practice bomb');
    const casters = new Set<AbstractMesh>();
    const shadows = {
      addShadowCaster: (mesh: AbstractMesh) => { casters.add(mesh); },
      removeShadowCaster: (mesh: AbstractMesh) => { casters.delete(mesh); },
    };
    try {
      let baseline: number[] | undefined;
      for (let index = 0; index < 20; index++) {
        const view = new AircraftView(scene, shadows, `Player ${index} `);
        view.loadModels(aircraft, bomb);
        view.dispose();
        const counts = [scene.meshes.length, scene.transformNodes.length, scene.materials.length,
          scene.geometries.length, scene.skeletons.length, scene.animationGroups.length, casters.size];
        baseline ??= counts;
        expect(counts).toEqual(baseline);
        expect(casters.size).toBe(0);
      }
    } finally { aircraft.dispose(); bomb.dispose(); scene.dispose(); engine.dispose(); }
  });
});
