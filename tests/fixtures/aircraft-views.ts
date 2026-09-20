import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { AircraftView } from '../../src/rendering/aircraft-view';
import { initialPose, launchFrom } from '../../src/simulation/pose';

interface Report {
  lead: boolean; follower: boolean; carried: boolean[]; falling: boolean[];
  sharedGeometry: boolean; sharedMaterials: boolean; counts: number[]; casterCount: number;
}
declare global {
  interface Window { aircraftViews(action: 'ready' | 'drop' | 'destroy' | 'reset' | 'rebase'): Promise<Report> }
}
let scene: Scene, engine: Engine, lead: AircraftView, follower: AircraftView, shadows: ShadowGenerator;

async function setup(): Promise<void> {
  if (scene) return;
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Missing aircraft fixture canvas.');
  engine = new Engine(canvas, true);
  scene = new Scene(engine);
  const camera = new FreeCamera('Aircraft fixture', new Vector3(0, 40, -75), scene);
  camera.setTarget(new Vector3(0, 20, 10));
  new HemisphericLight('Sky', Vector3.Up(), scene);
  const sun = new DirectionalLight('Sun', new Vector3(-0.5, -1, 0.5), scene);
  shadows = new ShadowGenerator(256, sun);
  const [aircraft, bomb] = await Promise.all([
    LoadAssetContainerAsync('/assets/kestrel.glb', scene),
    LoadAssetContainerAsync('/assets/practice-bomb.glb', scene),
  ]);
  lead = new AircraftView(scene, shadows);
  follower = new AircraftView(scene, shadows, 'Follower ');
  lead.loadModels(aircraft, bomb);
  follower.loadModels(aircraft, bomb);
}

window.aircraftViews = async action => {
  await setup();
  const origin = action === 'rebase' ? 8192 : 0;
  const first = initialPose({ x: -18, y: 20, z: 15 + origin });
  const second = initialPose({ x: 18, y: 20, z: origin });
  const dropped = action === 'drop' || action === 'destroy';
  const bomb = dropped ? launchFrom(first) : null;
  if (bomb) bomb.position.y -= 6;
  if (action === 'reset') { lead.reset(); follower.reset(); }
  lead.update({ pose: first, bomb, released: dropped, destroyed: action === 'destroy', canyon: false }, origin);
  follower.update({ pose: second, bomb: null, released: false, destroyed: false, canyon: false }, origin);
  await scene.whenReadyAsync();
  scene.render();
  const meshes = [lead, follower].map(view => view.root.getChildMeshes()
    .find(mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0));
  const a = meshes[0], b = meshes[1];
  if (!(a instanceof Mesh) || !(b instanceof Mesh)) throw new Error('Missing real aircraft meshes.');
  return {
    lead: lead.root.isEnabled(), follower: follower.root.isEnabled(),
    carried: [lead.carriedBomb.isEnabled(), follower.carriedBomb.isEnabled()],
    falling: [lead.bombRoot.isEnabled(), follower.bombRoot.isEnabled()],
    sharedGeometry: a.geometry === b.geometry, sharedMaterials: a.material === b.material,
    counts: [scene.meshes.length, scene.materials.length, scene.geometries.length, scene.textures.length],
    casterCount: shadows.getShadowMap()?.renderList?.length ?? 0,
  };
};
