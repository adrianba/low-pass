import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { SharedTargets } from '../../src/rendering/shared-targets';
import { SharedImpacts } from '../../src/rendering/shared-impacts';
import { snapshotSharedFrame } from '../../src/rendering/shared-frame';
import type { SharedWorldFrame, SharedTargetFrame, SharedImpactFrame } from '../../src/rendering/shared-frame';
import { initialPose } from '../../src/simulation/pose';

const target = (id: number, destroyed = false): SharedTargetFrame => ({
  id, destroyed, position: { x: 0, y: 12, z: id * 2000 }, kind: 'tank', heading: 0.4, sightDistance: 1500, canyon: false,
});
const impact = (slot: 0 | 1, kind: 'ground' | 'water'): SharedImpactFrame => ({
  id: slot + 1, sequence: 0, slot, time: 10,
  impact: { x: slot * 50, y: kind === 'water' ? 0 : 12, z: 5000, kind, normal: { x: 0, y: 1, z: 0 } },
});
function frame(): SharedWorldFrame {
  return { time: 10, terrain: 'green-valley', viewedSlot: 0,
    aircraft: [0, 1].map(() => ({ pose: initialPose(), bomb: null, released: false, destroyed: false })) as
      [SharedWorldFrame['aircraft'][0], SharedWorldFrame['aircraft'][1]],
    views: [{ position: { x: 0, y: 167, z: -80 }, target: { x: 0, y: 80, z: 80 } },
      { position: { x: 0, y: 167, z: -180 }, target: { x: 0, y: 80, z: -20 } }],
    targets: [target(1)], impacts: [impact(0, 'ground'), impact(1, 'ground')],
    prediction: null, ready: false, effectPositions: [] };
}

describe('owned shared rendering boundaries', () => {
  it('copies and freezes both aircraft, views, targets and attributed impacts', () => {
    const source = frame(), saved = structuredClone(source), snapshot = snapshotSharedFrame(source);
    expect(snapshot).toEqual(saved);
    expect(Reflect.set(source.aircraft[0].pose.position, 'x', 200)).toBe(true);
    expect(snapshot).toEqual(saved);
    expect(Reflect.set(snapshot.aircraft[1].pose.velocity, 'z', 0)).toBe(false);
    expect(Reflect.set(snapshot.views[0].position, 'z', 0)).toBe(false);
    expect(Reflect.set(snapshot.impacts[0]!.impact.normal, 'y', 0)).toBe(false);
    expect(Reflect.set(snapshot.targets, '0', target(2))).toBe(false);
  });
  it('rejects oversized sets, ambiguous identities, future impacts and incompatible courses', () => {
    const source = frame();
    for (const invalid of [{ ...source, time: NaN }, { ...source, targets: [target(1), target(1)] },
      { ...source, targets: Array.from({ length: 5 }, (_, i) => target(i + 1)) },
      { ...source, impacts: [{ ...impact(0, 'ground'), sequence: 1 }] },
      { ...source, impacts: [{ ...impact(0, 'ground'), time: 11 }] },
      { ...source, targets: [{ ...target(1), canyon: true }] }]) expect(() => snapshotSharedFrame(invalid)).toThrow();
  });

  it('retains independent same-kind wrecks and reuses target views without growing shadow registrations', () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const template = CreateGround('Template', { width: 56, height: 56 }, scene);
      template.material = new StandardMaterial('Paint', scene);
      const casters = new Set<AbstractMesh>();
      let registrations = 0;
      const pool = new SharedTargets(scene, {
        addShadowCaster(mesh) { expect(casters.has(mesh)).toBe(false); casters.add(mesh); registrations++; },
        removeShadowCaster(mesh) { casters.delete(mesh); },
      }, template);
      const baseline = [scene.meshes.length, scene.materials.length, registrations];
      for (let id = 1; id <= 30; id++) {
        pool.update([target(id, true), target(id + 1)], 4096);
        const roots = scene.transformNodes.filter(n => n.name.startsWith('Shared target ') && n.name.endsWith('root') && n.isEnabled());
        expect(roots).toHaveLength(2);
        expect(new Set(roots.map(root => root.position.z))).toEqual(new Set([id * 2000 - 4096, (id + 1) * 2000 - 4096]));
        for (const root of roots) {
          const turret = root.getChildTransformNodes().find(n => n.name.endsWith('Tank turret'))!;
          expect(turret.rotation.z !== 0).toBe(root.position.z === id * 2000 - 4096);
        }
        expect([scene.meshes.length, scene.materials.length, registrations]).toEqual(baseline);
        expect(() => pool.update([target(id, false)], 4096)).toThrow('repair');
      }
      pool.reset();
      pool.update([target(1)], 8192);
      expect(scene.transformNodes.filter(n => n.name.endsWith('Tank turret')).every(n => n.rotation.z === 0)).toBe(true);
      pool.dispose(); pool.dispose();
      expect(casters.size).toBe(0);
      expect(scene.meshes).toEqual([template]);
      expect(scene.materials).toContain(template.material);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it('presents simultaneous ground and water impacts at absolute ages and disposes only its own resources', () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const material = new StandardMaterial('Shared effect material', scene);
      const pool = new SharedImpacts(scene, material, material, material);
      const count = scene.meshes.length;
      const input = [impact(0, 'ground'), impact(1, 'water')];
      pool.update(input, 10.5, 4096, true);
      const scars = scene.meshes.filter(m => m.name.endsWith('scar') && m.isEnabled());
      const ripples = scene.meshes.filter(m => m.name.endsWith('Splash ripple') && m.isEnabled());
      expect(scars).toHaveLength(1); expect(ripples).toHaveLength(1);
      expect(scars[0]!.position.z).toBe(904);
      expect(ripples[0]!.position.x).toBe(50);
      const before = scene.meshes.map(m => ({ p: m.position.clone(), visible: m.visibility, enabled: m.isEnabled() }));
      pool.update(input, 10.5, 4096, true);
      expect(scene.meshes.map(m => ({ p: m.position.clone(), visible: m.visibility, enabled: m.isEnabled() }))).toEqual(before);
      pool.update(input, 10.5, 8192, true);
      expect(scars[0]!.position.z).toBe(-3192); expect(ripples[0]!.position.z).toBe(-3192);
      pool.update(input, 20, 8192, true);
      expect(scene.meshes.filter(m => m.isEnabled()).map(m => m.name)).toEqual([scars[0]!.name]);
      expect(scene.meshes.length).toBe(count);
      pool.reset(); expect(scene.meshes.every(m => !m.isEnabled())).toBe(true);
      pool.dispose(); pool.dispose();
      expect(scene.meshes).toHaveLength(0);
      expect(scene.materials).toContain(material);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
