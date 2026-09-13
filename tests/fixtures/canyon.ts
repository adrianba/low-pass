import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { World } from '../../src/rendering/world';
import { Run, initialPose, planEncounter, poseAt } from '../../src/game/run';
import { canyonSurface } from '../../src/terrain/surface';
import { STEP } from '../../src/config/game';
import { contactAccuracy, predictImpact } from '../../src/simulation/ballistics';
import { launchFrom } from '../../src/game/run';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { CANYON, shelfSide } from '../../src/terrain/river-canyon';
import { projectChase } from '../../src/simulation/chase-camera';
import { projectRoute, routePoint } from '../../src/terrain/canyon-route';
import { speedOf } from '../../src/simulation/flight-track';
import type { Quality } from '../../src/config/game';
import type { MissileKind } from '../../src/game/missile';

let world: World;
let current: Run;
declare global {
  interface Window {
    canyonProbe(): Promise<{ pass: number; visible: number | null; score: number; cameraClearance: number; projectionError: number }[]>;
    canyonFrame(pass: number, closeup: boolean): Promise<void>;
    canyonSplash(): Promise<{ frozen: boolean; reset: boolean; waterMeshes: number }>;
    canyonLifecycle(): Promise<boolean>;
    canyonWall(index: number, reverse: boolean): Promise<{ source: boolean; distinct: boolean; cullingDifference: number }>;
    canyonTwist(along: number, quality: Quality, overhead: boolean): Promise<{ speed: number; terrain: number; water: number; covered: boolean }>;
    canyonRebase(): Promise<number>;
    canyonMissile(kind: MissileKind, pass: number, turn: boolean, age: number, quality: Quality): Promise<{
      launchY: number; ground: number; visible: boolean; below: boolean; frozen: boolean; meshes: number;
      bank: number; origin: number; turnError: number;
    }>;
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
    const start = run.encounter.canyon!.acquireAt - 2;
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
    previous = poseAt(run.encounter, run.encounter.canyon!.endAt, count);
  }
  return reports;
};
window.canyonFrame = async (pass, closeup) => {
  await setup();
  world.reset();
  current = runAt(pass - 1, pass * 4000);
  current.encounter.visibleAt = current.encounter.canyon!.acquireAt;
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
  world.update(run, initialPose({ x: canyonSurface.center(z), y: 167, z }), null, 0);
  const target = world.scene.getTransformNodeByName('Encounter target')!;
  const origin = run.encounter.target.z - target.position.z;
  const side = shelfSide(index);
  const camera = routePoint(z + (reverse ? 550 : -550), -side * 30);
  const look = routePoint(z + (reverse ? 270 : -270), side * 150);
  world.camera.position.set(camera.x, 125, camera.z - origin);
  world.camera.setTarget(new Vector3(look.x, 100, look.z - origin));
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

window.canyonTwist = async (along, quality, overhead) => {
  await setup();
  world.reset();
  world.configure(quality);
  const run = runAt(12);
  const flight = run.encounter.canyon!;
  const knot = flight.track.knots.reduce((best, k) =>
    Math.abs(projectRoute(k.pose.position.x, k.pose.position.z).along - along)
      < Math.abs(projectRoute(best.pose.position.x, best.pose.position.z).along - along) ? k : best);
  for (let t = Math.max(flight.startTime, knot.time - 3); t <= knot.time + 0.001; t += 1 / 30) {
    run.encounter.time = t;
    world.update(run, run.pose, null, 1 / 30);
  }
  const p = run.pose.position, origin = p.z - world.scene.getTransformNodeByName('Aircraft pose')!.position.z;
  if (overhead) {
    world.camera.position.set(p.x - 180, 950, p.z - origin - 350);
    world.camera.setTarget(new Vector3(p.x, 0, p.z - origin + 200));
  }
  await world.scene.whenReadyAsync();
  world.render();
  let covered = true;
  for (let z = p.z - 400; z <= p.z + 1000; z += 32) {
    for (const side of [-220, 0, 220]) {
      const point = routePoint(z, side), cx = Math.floor(point.x / 256), cz = Math.floor(point.z / 256);
      if (!world.scene.getMeshByName(`Terrain ${cx},${cz}`)) covered = false;
      if (side === 0 && !world.scene.getMeshByName(`River ${cx},${cz}`)?.isEnabled()) covered = false;
    }
  }
  return { speed: speedOf(run.pose), covered,
    terrain: world.scene.meshes.filter(m => m.name.startsWith('Terrain ')).length,
    water: world.scene.meshes.filter(m => m.name.startsWith('River ') && m.isEnabled()).length };
};

window.canyonRebase = async () => {
  await setup();
  const run = runAt(12);
  run.encounter.time = 0;
  const pose = run.pose;
  const visit = (z: number) => world.update(run, initialPose({ x: canyonSurface.center(z), y: 167, z }), null, 0);
  const capture = async () => {
    world.reset();
    world.update(run, pose, null, 0);
    await world.scene.whenReadyAsync();
    world.render();
    const pixels = await world.engine.readPixels(0, 0, world.engine.getRenderWidth(), world.engine.getRenderHeight());
    return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  };

  visit(pose.position.z + 9000);
  const before = await capture();
  visit(pose.position.z + 4100);
  const after = await capture();
  return before.reduce((sum, value, i) => sum + Math.abs(value - after[i]!), 0) / before.length;
};

window.canyonMissile = async (kind, pass, turn, age, quality) => {
  await setup();
  world.configure(quality);
  world.reset();
  const run = runAt(pass - 1, turn ? 9600 : 0);
  const flight = run.encounter.canyon!;
  const turnAlong = turn ? 12000 : 2400;
  const time = turn ? flight.track.knots.reduce((best, k) =>
    Math.abs(projectRoute(k.pose.position.x, k.pose.position.z).along - turnAlong)
      < Math.abs(projectRoute(best.pose.position.x, best.pose.position.z).along - turnAlong) ? k : best).time : 2.2;
  for (let t = time - 2; t < time; t += 1 / 30) {
    run.encounter.time = t;
    world.update(run, run.pose, null, 1 / 30);
  }
  run.encounter.time = time;
  world.update(run, run.pose, null, 0);
  const turnError = Math.abs(projectRoute(run.pose.position.x, run.pose.position.z).along - turnAlong);
  const target = world.scene.getTransformNodeByName('Encounter target')!;
  const origin = run.encounter.target.z - target.position.z;
  world.camera.getViewMatrix(true);
  const look = world.camera.getTarget(), camera = world.camera.position;
  const view = { position: { x: camera.x, y: camera.y, z: camera.z + origin },
    target: { x: look.x, y: look.y, z: look.z + origin },
    aspect: world.engine.getRenderWidth() / world.engine.getRenderHeight(), range: world.scene.fogEnd };
  if (kind === 'flyby') world.combat.startFlyby(run, view);
  else if (kind === 'damage') world.combat.startDamage(run, view);
  else { run.status = 'over'; world.combat.startFinale(run.pose, run, view); }
  world.combat.render(run.pose, origin, 0);
  const missile = world.scene.getTransformNodeByName('Surface-to-air missile')!;
  const launch = { x: missile.position.x, y: missile.position.y, z: missile.position.z + origin };
  let elapsed = 0, frame = 0;
  const frameSteps = turn ? [0.1, 1 / 60, 1 / 30] : [1 / 60];
  while (elapsed < age) {
    const dt = Math.min(frameSteps[frame++ % frameSteps.length]!, age - elapsed);
    elapsed += dt;
    if (kind !== 'finale') run.encounter.time = time + elapsed;
    world.update(run, run.pose, null, dt);
  }
  await world.scene.whenReadyAsync();
  world.render();
  const currentOrigin = run.encounter.target.z - target.position.z;
  const point = { x: missile.position.x, y: missile.position.y, z: missile.position.z + currentOrigin };
  const screen = world.projectPoint(point);
  const before = missile.position.clone();
  world.update(run, run.pose, null, 0);
  const aircraft = world.scene.getTransformNodeByName('Aircraft pose')!;
  return { launchY: launch.y, ground: canyonSurface.height(launch.x, launch.z),
    visible: !!screen && screen.x > 0 && screen.x < 1 && screen.y > 0 && screen.y < 1,
    below: missile.position.y < aircraft.position.y, frozen: missile.position.equals(before), meshes: world.scene.meshes.length,
    bank: Math.sign(projectRoute(launch.x, launch.z).lateral), origin, turnError };
};
