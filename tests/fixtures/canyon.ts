import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { World } from '../../src/rendering/world';
import { Run, initialPose, planEncounter, poseAt } from '../../src/game/run';
import { canyonSurface } from '../../src/terrain/surface';
import { canyonWarning } from '../../src/game/canyon-flight';
import { STEP } from '../../src/config/game';
import { contactAccuracy, predictImpact } from '../../src/simulation/ballistics';
import { launchFrom } from '../../src/game/run';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { CANYON, shelfSide } from '../../src/terrain/river-canyon';
import { projectChase } from '../../src/simulation/chase-camera';

let world: World;
let current: Run;
declare global {
  interface Window {
    canyonProbe(): Promise<{ pass: number; visible: number | null; score: number; cameraClearance: number; projectionError: number }[]>;
    canyonFrame(pass: number, closeup: boolean): Promise<void>;
    canyonSplash(): Promise<{ frozen: boolean; reset: boolean; waterMeshes: number }>;
    canyonLifecycle(): Promise<boolean>;
    canyonWall(index: number, reverse: boolean): Promise<{ source: boolean; distinct: boolean; cullingDifference: number }>;
  }
}
async function setup() {
  if (world) return;
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Missing canyon canvas.');
  world = new World(canvas, 'low', 'river-canyon');
  await world.load(() => {});
}
function runAt(count: number, z = 0): Run {
  const run = new Run(7, 'river-canyon');
  run.encounter = planEncounter(count, 7, initialPose({ x: canyonSurface.center(z), y: 167, z }), canyonSurface);
  return run;
}
window.canyonProbe = async () => {
  await setup();
  const reports = [];
  let previous = initialPose();
  for (let count = 0; count < 24; count++) {
    world.reset();
    const run = new Run(0, 'river-canyon');
    run.encounter = planEncounter(count, run.seed, previous, canyonSurface);
    const start = -canyonWarning(count) - 2;
    const dt = count % 2 ? 0.1 : 1 / 30;
    let cameraClearance = Infinity, projectionError = 0;
    for (let t = start; t < 0.2; t += dt) {
      run.encounter.time = t;
      world.update(run, poseAt(run.encounter, t - STEP, count), null, dt);
      if (run.encounter.visibleAt === null && world.targetVisible(run)) run.seeTarget();
      const local = world.scene.getTransformNodeByName('Encounter target');
      if (!local) throw new Error('Missing target root.');
      const origin = run.encounter.target.z - local.position.z;
      const actual = world.projectPoint(run.encounter.target);
      const look = world.camera.getTarget();
      const projected = projectChase(run.encounter.target, {
        position: { x: world.camera.position.x, y: world.camera.position.y, z: world.camera.position.z + origin },
        target: { x: look.x, y: look.y, z: look.z + origin },
      }, world.engine.getRenderWidth() / world.engine.getRenderHeight());
      if (projected && actual) projectionError = Math.max(projectionError,
        Math.abs(projected.x - actual.x), Math.abs(projected.y - actual.y));
      cameraClearance = Math.min(cameraClearance, world.camera.position.y
        - canyonSurface.height(world.camera.position.x, world.camera.position.z + origin));
    }
    const impact = predictImpact(launchFrom(poseAt(run.encounter, 0, count)), canyonSurface);
    reports.push({ pass: count + 1, visible: run.encounter.visibleAt,
      score: contactAccuracy(impact, run.encounter.target, canyonSurface), cameraClearance, projectionError });
    previous = poseAt(run.encounter, 7, count);
  }
  return reports;
};
window.canyonFrame = async (pass, closeup) => {
  await setup();
  world.reset();
  current = runAt(pass - 1, pass * 4000);
  current.encounter.visibleAt = -canyonWarning(pass - 1);
  for (let t = current.encounter.visibleAt - 0.5; t <= -0.2; t += STEP * 4) {
    current.encounter.time = t;
    world.update(current, current.pose, current.prediction, STEP * 4);
  }
  if (closeup) {
    const target = world.scene.getTransformNodeByName('Encounter target')!;
    world.camera.position.copyFrom(target.position).addInPlace(new Vector3(-current.encounter.canyon!.side * 105, 95, -145));
    world.camera.setTarget(target.position.add(new Vector3(-current.encounter.canyon!.side * 35, 0, 0)));
  }
  await world.scene.whenReadyAsync();
  world.render();
};
window.canyonSplash = async () => {
  await window.canyonFrame(1, true);
  const z = current.encounter.target.z, x = canyonSurface.center(z);
  current.result = { id: current.encounter.id, points: 0,
    impact: { x, y: 0, z, kind: 'water', normal: { x: 0, y: 1, z: 0 } } };
  world.update(current, current.pose, null, 0.3);
  world.render();
  const drops = () => world.scene.meshes.filter(m => m.name === 'Splash droplet')
    .map(m => [m.isEnabled(), ...m.position.asArray()]);
  const before = JSON.stringify(drops());
  world.update(current, current.pose, null, 0);
  const frozen = before === JSON.stringify(drops());
  const waterMeshes = world.scene.meshes.filter(m => m.name.startsWith('River ') && m.isEnabled()).length;
  world.reset();
  return { frozen, reset: drops().every(d => d[0] === false), waterMeshes };
};

window.canyonLifecycle = async () => {
  await setup();
  const counts = new Map<string, string>();
  for (let i = 0; i < 12; i++) for (const terrain of ['green-valley', 'desert', 'river-canyon'] as const) {
    world.reset();
    world.setTerrain(terrain);
    const run = new Run(7, terrain);
    world.update(run, run.pose, null, 0);
    const count = JSON.stringify([world.scene.meshes.length, world.scene.materials.length,
      world.scene.textures.length, world.scene.geometries.length,
      world.scene.lights.reduce((n, l) => n + (l.getShadowGenerator()?.getShadowMap()?.renderList?.length ?? 0), 0)]);
    if (counts.has(terrain) && counts.get(terrain) !== count) return false;
    counts.set(terrain, count);
    if (terrain !== 'river-canyon' && world.scene.meshes.some(m => m.name.startsWith('River '))) return false;
  }
  return true;
};

window.canyonWall = async (index, reverse) => {
  await setup();
  world.reset();
  world.setTerrain('river-canyon');
  const z = CANYON.shelfOrigin + index * CANYON.shelfSpacing;
  const run = runAt(0, z - 800);
  run.encounter.time = 0;
  world.update(run, run.pose, null, 0);
  const target = world.scene.getTransformNodeByName('Encounter target')!;
  const origin = run.encounter.target.z - target.position.z;
  const side = shelfSide(index), center = canyonSurface.center(z);
  world.camera.position.set(center - side * 30, 125, z - origin + (reverse ? 550 : -550));
  world.camera.setTarget(new Vector3(center + side * 150, 100, z - origin + (reverse ? 270 : -270)));
  await world.scene.whenReadyAsync();
  world.render();
  const cliff = world.scene.materials.find(m => m.name === 'Canyon meadow and cliffs');
  const valley = world.scene.materials.find(m => m.name === 'Meadow and exposed rock');
  if (!(cliff instanceof PBRMaterial) || !(valley instanceof PBRMaterial)) throw new Error('Missing wall materials.');
  const mesh = world.scene.getActiveMeshes().data.find(m => m?.name.startsWith('Terrain ') && m.material === cliff && m.subMeshes?.[0]?.effect);
  if (!mesh) throw new Error('Missing rendered wall.');
  const effect = mesh.subMeshes![0]!.effect!;
  const source = effect.fragmentSourceCode.includes('wallWeights');
  const read = async () => {
    const pixels = await world.engine.readPixels(0, 0, world.engine.getRenderWidth(), world.engine.getRenderHeight());
    return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  };
  const culled = await read();
  cliff.backFaceCulling = false;
  world.render();
  const unculled = await read();
  const cullingDifference = culled.reduce((sum, channel, i) => sum + Math.abs(channel - unculled[i]!), 0) / culled.length;
  cliff.backFaceCulling = true;
  mesh.material = valley;
  await valley.forceCompilationAsync(mesh);
  world.render();
  const distinct = mesh.subMeshes![0]!.effect !== effect;
  mesh.material = cliff;
  world.render();
  return { source, distinct, cullingDifference };
};
