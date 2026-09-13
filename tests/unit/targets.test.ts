import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TARGET_KINDS, selectTargetKind, targetFromRoll } from '../../src/game/targets';
import { Run, initialPose, planEncounter, poseAt } from '../../src/game/run';
import { TARGET_RADIUS } from '../../src/config/game';
import { TargetModels } from '../../src/rendering/target-model';
import { TargetVehicle } from '../../src/rendering/target-vehicle';
import { TargetRadar } from '../../src/rendering/target-radar';
import { TargetSam } from '../../src/rendering/target-sam';

describe('encounter target selection', () => {
  it('uses equal-width intervals and safely handles the inclusive hash endpoint', () => {
    expect(targetFromRoll(0)).toBe('tank');
    expect(targetFromRoll(1 / 3 - Number.EPSILON)).toBe('tank');
    expect(targetFromRoll(1 / 3)).toBe('radar');
    expect(targetFromRoll(2 / 3 - Number.EPSILON)).toBe('radar');
    expect(targetFromRoll(2 / 3)).toBe('sam');
    expect(targetFromRoll(1)).toBe('sam');
    for (const value of [NaN, Infinity, -0.1, 1.1]) expect(() => targetFromRoll(value)).toThrow();
  });

  it('is repeatable, permits repeats, and distributes choices without a first-pass override', () => {
    const counts = { tank: 0, radar: 0, sam: 0 };
    let repeats = 0;
    for (let count = 0; count < 30_000; count++) {
      const kind = selectTargetKind(count, 71);
      expect(kind).toBe(selectTargetKind(count, 71));
      counts[kind]++;
      if (count && kind === selectTargetKind(count - 1, 71)) repeats++;
    }
    for (const n of Object.values(counts)) expect(n / 30_000).toBeGreaterThan(0.31);
    for (const n of Object.values(counts)) expect(n / 30_000).toBeLessThan(0.36);
    expect(repeats).toBeGreaterThan(0);
    expect(new Set(Array.from({ length: 100 }, (_, seed) => selectTargetKind(0, seed))).size).toBe(3);
  });

  it('stores the selection once without affecting flight or changing during gameplay', () => {
    const encounter = planEncounter(3, 17, initialPose());
    expect(encounter.targetKind).toBe(selectTargetKind(3, 17));
    for (const kind of TARGET_KINDS) {
      expect(poseAt({ ...encounter, targetKind: kind }, 0, 3)).toEqual(poseAt(encounter, 0, 3));
    }
    const run = new Run(19);
    const kind = run.encounter.targetKind;
    run.seeTarget();
    run.release();
    run.status = 'paused';
    run.tick(true);
    expect(run.encounter.targetKind).toBe(kind);
    run.status = 'running';
    for (let step = 0; step < 3000 && !run.result; step++) {
      run.tick(true);
      expect(run.encounter.targetKind).toBe(kind);
    }
    expect(run.result).not.toBeNull();
  });
});

describe('procedural target models', () => {
  const builders = { tank: TargetVehicle, radar: TargetRadar, sam: TargetSam };
  it.each(TARGET_KINDS)('%s stays compact, grounded, non-colliding, and reversibly damaged', kind => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const model = new builders[kind](scene);
      const meshes = model.root.getChildMeshes();
      const transforms = () => [model.root, ...model.root.getChildTransformNodes()]
        .map(node => [node.name, node.position.asArray(), node.rotation.asArray(), node.scaling.asArray()]);
      const intact = transforms();
      const materialColors = () => scene.materials.map(material => material.serialize());
      const intactMaterials = materialColors();
      expect(meshes.every(mesh => !mesh.isPickable && !mesh.checkCollisions && mesh.receiveShadows)).toBe(true);
      const triangles = meshes.reduce((n, mesh) => n + mesh.getTotalIndices() / 3, 0);
      expect(triangles).toBeGreaterThan(100);
      expect(triangles).toBeLessThan(6000);
      for (const destroyed of [false, true]) {
        model.setDestroyed(destroyed);
        for (const heading of [0, 0.7, 2, 4.5]) {
          model.root.rotation.y = heading;
          model.root.computeWorldMatrix(true);
          let lowest = Infinity;
          for (const mesh of meshes) {
            mesh.computeWorldMatrix(true);
            for (const vertex of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
              expect(Math.hypot(vertex.x, vertex.z)).toBeLessThan(TARGET_RADIUS * 0.5);
              lowest = Math.min(lowest, vertex.y);
            }
          }
          expect(lowest).toBeGreaterThanOrEqual(-0.01);
          expect(lowest).toBeLessThan(0.25);
        }
      }
      model.root.rotation.y = 0;
      expect(transforms()).not.toEqual(intact);
      expect(materialColors()).not.toEqual(intactMaterials);
      model.setDestroyed(false);
      expect(transforms()).toEqual(intact);
      expect(materialColors()).toEqual(intactMaterials);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it('has recognizable dish and launch-tube components', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      new TargetRadar(scene);
      new TargetSam(scene);
      expect(scene.getMeshByName('Radar parabolic reflector')).not.toBeNull();
      expect(scene.getMeshByName('Radar equipment shelter')).not.toBeNull();
      expect(scene.meshes.filter(mesh => mesh.name === 'SAM launch tube')).toHaveLength(4);
      expect(scene.meshes.filter(mesh => mesh.name === 'SAM road tire')).toHaveLength(6);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it('reuses exactly three models and resets damage even on repeated same-kind encounters', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const targets = new TargetModels(scene);
      const baseline = [scene.meshes.length, scene.materials.length, scene.geometries.length, scene.transformNodes.length];
      expect(targets.kind).toBeNull();
      expect(targets.root.getChildMeshes().some(mesh => mesh.isEnabled())).toBe(false);
      expect(() => targets.setDestroyed(true)).toThrow();
      for (let pass = 0; pass < 90; pass++) {
        const kind = TARGET_KINDS[Math.floor(pass / 2) % 3]!;
        targets.select(kind);
        const visible = () => targets.root.getChildTransformNodes(true).filter(node => node.isEnabled());
        expect(visible()).toHaveLength(1);
        expect(targets.kind).toBe(kind);
        const model = visible()[0]!;
        const pose = () => model.getChildTransformNodes().map(node => [node.position.asArray(), node.rotation.asArray()]);
        const intact = pose();
        targets.setDestroyed(true);
        expect(pose()).not.toEqual(intact);
        targets.select(kind);
        expect(pose()).toEqual(intact);
        expect([scene.meshes.length, scene.materials.length, scene.geometries.length, scene.transformNodes.length]).toEqual(baseline);
      }
      targets.reset();
      expect(targets.kind).toBeNull();
      expect(targets.root.getChildMeshes().some(mesh => mesh.isEnabled())).toBe(false);
      scene.dispose();
      expect(scene.meshes).toHaveLength(0);
      expect(scene.materials).toHaveLength(0);
    } finally { if (!scene.isDisposed) scene.dispose(); engine.dispose(); }
  });
});
