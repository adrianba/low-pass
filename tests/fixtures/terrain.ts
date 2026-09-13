import { World } from '../../src/rendering/world';
import { Run, initialPose, planEncounter } from '../../src/game/run';
import type { TerrainTheme } from '../../src/config/terrain';
import type { Quality } from '../../src/config/game';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { createDesertMaterial } from '../../src/rendering/desert-material';

interface Counts { meshes: number; materials: number; textures: number; geometries: number }
interface WorldReport {
  baseline: Counts; after: Counts; sameGeometry: boolean; desertTrees: number; valleyTrees: number;
  highSpeedCovered: boolean; maxStreamedChunks: number;
}

declare global {
  interface Window {
    terrainWorld: (theme: TerrainTheme, quality: Quality) => Promise<WorldReport>;
    sandPixels: () => Promise<{ seam: number; rebase: number; warmPixels: number; variation: number }>;
  }
}

let world: World | null = null;
window.terrainWorld = async (theme, quality) => {
  world?.dispose();
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Missing terrain canvas');
  const view = new World(canvas, 'low');
  world = view;
  await view.load(() => {});
  let run = new Run(7);
  run.encounter.visibleAt = -5;
  run.encounter.time = -2;
  const render = () => { view.update(run, run.pose, run.prediction, 0); view.render(); };
  const counts = (): Counts => ({
    meshes: view.scene.meshes.length, materials: view.scene.materials.length,
    textures: view.scene.textures.length, geometries: view.scene.geometries.length,
  });
  render();
  const geometry = () => view.scene.meshes.filter(mesh => mesh.name.startsWith('Terrain '))
    .map(mesh => [mesh.name, Array.from(mesh.getVerticesData('position')!), Array.from(mesh.getIndices()!)]);
  const valleyGeometry = JSON.stringify(geometry());
  const trees = () => view.scene.meshes.filter(mesh => mesh.name.startsWith('Trees ') && mesh.isEnabled()).length;
  const valleyTrees = trees();
  const baseline = counts();
  view.setTerrain('desert');
  render();
  const sameGeometry = valleyGeometry === JSON.stringify(geometry());
  const desertTrees = trees();
  for (let i = 0; i < 6; i++) {
    view.setTerrain(i % 2 ? 'green-valley' : 'desert');
    view.configure(i % 2 ? 'low' : 'medium');
    render();
  }
  const after = counts();
  view.setTerrain(theme);
  let highSpeedCovered = true, maxStreamedChunks = 0;
  const savedRun = run;
  for (const z of [4096, 8192, 32768]) {
    run = new Run(7);
    run.encounter = planEncounter(12, 7, initialPose({ x: 0, y: 167, z }));
    run.encounter.visibleAt = -3;
    run.encounter.time = -2;
    view.reset();
    render();
    const ground = view.scene.meshes.filter(mesh => mesh.name.startsWith('Terrain '));
    const front = Math.max(...ground.map(mesh => mesh.getBoundingInfo().boundingBox.maximumWorld.z));
    const back = Math.min(...ground.map(mesh => mesh.getBoundingInfo().boundingBox.minimumWorld.z));
    const plane = view.scene.getTransformNodeByName('Aircraft pose');
    if (!plane) throw new Error('Missing aircraft');
    highSpeedCovered &&= run.pose.velocity.z === 350 && front >= plane.position.z + view.scene.fogEnd && back < view.camera.position.z;
    maxStreamedChunks = Math.max(maxStreamedChunks, ground.length);
  }
  run = savedRun;
  view.reset();
  view.configure(quality);
  render();
  await view.scene.whenReadyAsync();
  render();
  return { baseline, after, sameGeometry, desertTrees, valleyTrees, highSpeedCovered, maxStreamedChunks };
};

window.sandPixels = async () => {
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Missing sand canvas');
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true });
  engine.setSize(256, 256);
  const scene = new Scene(engine);
  try {
    const camera = new FreeCamera('Sand test camera', new Vector3(0, 100, 6144), scene);
    camera.upVector = Vector3.Forward();
    camera.setTarget(new Vector3(0, 0, 6144));
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = camera.orthoBottom = -128;
    camera.orthoRight = camera.orthoTop = 128;
    new HemisphericLight('Sand test light', Vector3.Up(), scene);
    const sand = createDesertMaterial(scene);
    const whole = CreateGround('Whole ground', { width: 256, height: 256 }, scene);
    whole.position.z = 6144;
    whole.material = sand.material;
    const halves = [-64, 64].map(offset => {
      const mesh = CreateGround('Split ground', { width: 256, height: 128 }, scene);
      mesh.position.z = 6144 + offset;
      mesh.material = sand.material;
      mesh.setEnabled(false);
      return mesh;
    });
    const read = async () => {
      scene.render();
      const pixels = await engine.readPixels(0, 0, 256, 256);
      if (!(pixels instanceof Uint8Array)) throw new Error('Expected RGBA bytes');
      return pixels;
    };
    await scene.whenReadyAsync();
    const original = await read();
    whole.setEnabled(false);
    for (const mesh of halves) mesh.setEnabled(true);
    const split = await read();
    const difference = (a: Uint8Array, b: Uint8Array) =>
      a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0) / a.length;
    let rebase = 0;
    for (const origin of [4096, 6144, 12288]) {
      sand.origin = origin;
      camera.position.z = 6144 - origin;
      camera.setTarget(new Vector3(0, 0, 6144 - origin));
      for (const [i, mesh] of halves.entries()) mesh.position.z = 6144 + (i ? 64 : -64) - origin;
      rebase = Math.max(rebase, difference(split, await read()));
    }
    let warmPixels = 0, min = 255, max = 0;
    for (let i = 0; i < original.length; i += 4) {
      if (original[i]! > original[i + 2]! + 20) warmPixels++;
      min = Math.min(min, original[i]!);
      max = Math.max(max, original[i]!);
    }
    return { seam: difference(original, split), rebase, warmPixels, variation: max - min };
  } finally { scene.dispose(); engine.dispose(); }
};
