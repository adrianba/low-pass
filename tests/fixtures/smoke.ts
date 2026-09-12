import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { CombatEffects } from '../../src/rendering/combat-effects';

declare global {
  interface Window {
    smokeProbe: () => Promise<{ center: number; corners: number[]; softPixels: number; fadedCenter: number }>;
  }
}

window.smokeProbe = async () => {
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Missing smoke probe canvas');
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true });
  const scene = new Scene(engine);
  try {
    engine.setSize(256, 256);
    scene.clearColor = new Color4(1, 1, 1, 1);
    const camera = new FreeCamera('Smoke probe camera', new Vector3(0, 0, -20), scene);
    camera.setTarget(Vector3.Zero());
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = camera.orthoBottom = -10;
    camera.orthoRight = camera.orthoTop = 10;
    new HemisphericLight('Smoke probe light', Vector3.Up(), scene);
    new CombatEffects(scene);
    const puff = scene.getMeshByName('Aircraft damage smoke');
    if (!puff) throw new Error('Missing production smoke mesh');
    puff.setEnabled(true);
    puff.scaling.setAll(3);
    puff.visibility = 1;
    await scene.whenReadyAsync();
    scene.render();
    const pixels = await engine.readPixels(0, 0, 256, 256);
    if (!(pixels instanceof Uint8Array)) throw new Error('Expected RGBA byte pixels');
    const red = (x: number, y: number) => Number(pixels[(y * 256 + x) * 4]);
    const center = red(128, 128);
    const corners = [[64, 64], [191, 64], [64, 191], [191, 191]].map(([x, y]) => red(x!, y!));
    let softPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (Number(pixels[i]) > center + 10 && Number(pixels[i]) < 245) softPixels++;
    }
    puff.visibility = 0.5;
    scene.render();
    const faded = await engine.readPixels(128, 128, 1, 1);
    if (!(faded instanceof Uint8Array)) throw new Error('Expected RGBA byte pixels');
    return { center, corners, softPixels, fadedCenter: Number(faded[0]) };
  } finally {
    scene.dispose();
    engine.dispose();
  }
};
