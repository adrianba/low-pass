import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { World } from '../../src/rendering/world';
import { Run, initialPose, planEncounter } from '../../src/game/run';
import type { TargetKind } from '../../src/game/targets';
import type { TerrainTheme } from '../../src/config/terrain';
import { CHUNK } from '../../src/config/game';

const roots = { tank: 'Target tank', radar: 'Target radar station', sam: 'Target SAM launcher' };
let world: World | null = null;

async function view(): Promise<World> {
  if (world) return world;
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Missing target fixture canvas');
  world = new World(canvas, 'low');
  await world.load(() => {});
  return world;
}

function encounter(kind: TargetKind, count = 0, z = 0): Run {
  const run = new Run(7);
  run.encounter = {
    ...planEncounter(count, run.seed, initialPose({ x: 0, y: 167, z })),
    targetKind: kind, visibleAt: -5, time: 0,
  };
  return run;
}

interface TargetReport {
  enabled: string[]; stableDamage: boolean; sameKindReset: boolean; restartReset: boolean;
  rebaseError: number; shadowCounts: number[]; resourceCounts: number[][];
}

declare global {
  interface Window {
    targetProbe: (kind: TargetKind) => Promise<TargetReport>;
    targetFrame: (kind: TargetKind, terrain: TerrainTheme, damaged: boolean, closeup: boolean, count?: number) => Promise<void>;
  }
}

window.targetProbe = async kind => {
  const world = await view();
  world.reset();
  let run = encounter(kind);
  const render = (dt = 0) => { world.update(run, run.pose, null, dt); world.render(); };
  const model = world.scene.getTransformNodeByName(roots[kind]);
  const parent = world.scene.getTransformNodeByName('Encounter target');
  if (!model || !parent) throw new Error('Missing target root');
  const state = () => JSON.stringify(model.getChildTransformNodes().map(node => ({
    position: node.position.asArray(), rotation: node.rotation.asArray(),
  })));
  const counts = () => [world.scene.meshes.length, world.scene.materials.length, world.scene.geometries.length];
  const shadows = () => world.scene.lights.reduce((n, light) => n + (light.getShadowGenerator()?.getShadowMap()?.renderList?.length ?? 0), 0);
  render();
  const intact = state();
  const enabled = Object.values(roots).filter(name => world.scene.getTransformNodeByName(name)?.isEnabled());
  const resourceCounts = [counts()], shadowCounts = [shadows()];
  run.result = { id: run.encounter.id, points: 80, impact: { ...run.encounter.target, kind: 'ground', normal: { x: 0, y: 1, z: 0 } } };
  render(3);
  render();
  const damaged = state();
  world.configure('medium');
  world.setTerrain('desert');
  render();
  const stableDamage = state() === damaged && damaged !== intact;
  run = encounter(kind, 1);
  render();
  const sameKindReset = state() === intact;
  run.result = { id: run.encounter.id, points: 80, impact: { ...run.encounter.target, kind: 'ground', normal: { x: 0, y: 1, z: 0 } } };
  render(3);
  world.reset();
  run = encounter(kind);
  world.configure('low');
  render();
  const restartReset = state() === intact;
  resourceCounts.push(counts());
  shadowCounts.push(shadows());
  run = encounter(kind, 12, 32768);
  render();
  const origin = Math.floor(run.pose.position.z / CHUNK) * CHUNK;
  const rebaseError = Vector3.Distance(parent.position,
    new Vector3(run.encounter.target.x, run.encounter.target.y, run.encounter.target.z - origin));
  shadowCounts.push(shadows());
  world.reset();
  run = encounter(kind);
  render();
  resourceCounts.push(counts());
  return { enabled, stableDamage, sameKindReset, restartReset, rebaseError, shadowCounts, resourceCounts };
};

window.targetFrame = async (kind, terrain, damaged, closeup, count = 0) => {
  const world = await view();
  world.reset();
  world.setTerrain(terrain);
  world.configure('low');
  const run = encounter(kind, count);
  run.encounter.time = closeup ? 2.2 : -1.5;
  if (damaged) run.result = { id: run.encounter.id, points: 80, impact: { ...run.encounter.target, kind: 'ground', normal: { x: 0, y: 1, z: 0 } } };
  world.update(run, run.pose, null, damaged ? 3 : 0);
  world.update(run, run.pose, null, 0);
  if (closeup) {
    const root = world.scene.getTransformNodeByName('Encounter target');
    if (!root) throw new Error('Missing target root');
    world.camera.position.copyFrom(root.position).addInPlace(new Vector3(15, 13, 19));
    world.camera.setTarget(root.position.add(new Vector3(0, 3, 0)));
  }
  await world.scene.whenReadyAsync();
  world.render();
};
