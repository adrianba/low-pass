import { Scene } from '@babylonjs/core/scene';
import { Engine } from '@babylonjs/core/Engines/engine';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateIcoSphere } from '@babylonjs/core/Meshes/Builders/icoSphereBuilder';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import '@babylonjs/loaders/glTF/2.0/glTFLoader';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import { CHUNK, CELL, QUALITY, TARGET_RADIUS, FLOOR, targetSightDistance } from '../config/game';
import type { Quality } from '../config/game';
import type { TerrainTheme } from '../config/terrain';
import type { Run, Pose } from '../game/run';
import { hash, mix } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import { terrainHeight, terrainImpact, vertexHeight, valleyCenter } from '../terrain/heightfield';
import { createTerrainMaterial } from './terrain-material';
import { createDesertMaterial } from './desert-material';
import type { DesertSurface } from './desert-material';
import { TERRAIN_PALETTES, terrainTint, terrainProp } from './terrain-style';
import { TargetVehicle } from './target-vehicle';
import { CombatEffects } from './combat-effects';
import { shouldFlyby } from '../game/missile';

interface Chunk { mesh: Mesh; trees: Mesh; rocks: Mesh; z: number }
interface Burst { mesh: Mesh; velocity: Vector3; age: number }

export class World {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: FreeCamera;
  private aircraft: TransformNode;
  private bombRoot: TransformNode;
  private carriedBomb: TransformNode | null = null;
  private chunks = new Map<string, Chunk>();
  private terrainMaterial!: PBRMaterial;
  private terrainMaterials: Record<TerrainTheme, PBRMaterial> | null = null;
  private desertSurface: DesertSurface | null = null;
  private environments: Record<TerrainTheme, RawCubeTexture>;
  private treeTemplate: Mesh;
  private rockTemplate: Mesh;
  private target: Mesh;
  private vehicle: TargetVehicle;
  readonly combat: CombatEffects;
  private marker: Mesh;
  private impactMark: Mesh;
  private sun: DirectionalLight;
  private ambient: HemisphericLight;
  private rockMaterial: StandardMaterial;
  private shadows: ShadowGenerator;
  private origin = 0;
  private quality: Quality;
  private bursts: Burst[] = [];
  private burstMaterial: StandardMaterial;
  private resultId = 0;
  private lastEncounter = 0;
  private cameraInitialized = false;
  private lastChunk = -Infinity;
  private containers: AssetContainer[] = [];

  constructor(canvas: HTMLCanvasElement, quality: Quality, private terrain: TerrainTheme = 'green-valley') {
    this.quality = quality;
    this.engine = new Engine(canvas, true, { stencil: true, powerPreference: 'high-performance' });
    if (this.engine.webGLVersion < 2) {
      this.engine.dispose();
      throw new Error('WebGL2 is unavailable. Enable graphics acceleration in Edge, update your graphics driver, and reload.');
    }
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.49, 0.65, 0.74, 1);
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogColor = new Color3(0.49, 0.65, 0.74);
    this.scene.fogStart = 650;
    this.scene.fogEnd = QUALITY[quality].distance;
    this.scene.imageProcessingConfiguration.toneMappingEnabled = true;
    this.scene.imageProcessingConfiguration.exposure = 1.25;
    this.scene.imageProcessingConfiguration.contrast = 1.12;
    this.camera = new FreeCamera('Chase camera', new Vector3(0, 180, -40), this.scene);
    this.camera.minZ = 0.5;
    this.camera.maxZ = 3500;
    this.camera.fov = 0.92;
    this.sun = new DirectionalLight('Afternoon sun', new Vector3(-0.5, -0.85, 0.45).normalize(), this.scene);
    this.sun.diffuse = new Color3(1, 0.92, 0.78);
    this.sun.intensity = 2.7;
    this.sun.shadowMinZ = 1;
    this.sun.shadowMaxZ = 750;
    this.sun.autoUpdateExtends = false;
    this.sun.orthoLeft = -150;
    this.sun.orthoRight = 150;
    this.sun.orthoTop = 150;
    this.sun.orthoBottom = -150;
    const ambient = new HemisphericLight('Sky fill', Vector3.Up(), this.scene);
    this.ambient = ambient;
    ambient.intensity = 0.35;
    ambient.diffuse = new Color3(0.69, 0.8, 1);
    ambient.groundColor = new Color3(0.21, 0.25, 0.16);
    this.environments = { 'green-valley': this.makeEnvironment('green-valley'), desert: this.makeEnvironment('desert') };
    this.shadows = new ShadowGenerator(QUALITY[quality].shadow, this.sun);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.bias = 0.0005;
    this.shadows.normalBias = 0.03;
    this.aircraft = new TransformNode('Aircraft pose', this.scene);
    this.bombRoot = new TransformNode('Bomb pose', this.scene);
    const foliage = new StandardMaterial('Pine foliage', this.scene);
    foliage.diffuseColor = new Color3(0.10, 0.19, 0.09);
    foliage.specularColor = Color3.Black();
    const trunk = new StandardMaterial('Bark', this.scene);
    trunk.diffuseColor = new Color3(0.2, 0.145, 0.09);
    trunk.specularColor = Color3.Black();
    const pieces: Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const crown = CreateCylinder('Crown', { height: 7 - i, diameterTop: 0.2, diameterBottom: 5.8 - i, tessellation: 8 }, this.scene);
      crown.position.y = 6 + i * 2.5;
      crown.material = foliage;
      pieces.push(crown);
    }
    const stem = CreateCylinder('Trunk', { height: 6, diameter: 0.7, tessellation: 6 }, this.scene);
    stem.position.y = 3;
    stem.material = trunk;
    pieces.push(stem);
    const merged = Mesh.MergeMeshes(pieces, true, true, undefined, false, true);
    if (!merged) throw new Error('Could not build tree mesh.');
    this.treeTemplate = merged;
    this.treeTemplate.setEnabled(false);
    const rockMaterial = new StandardMaterial('Rock props', this.scene);
    this.rockMaterial = rockMaterial;
    rockMaterial.diffuseColor = new Color3(0.36, 0.37, 0.32);
    rockMaterial.specularColor = Color3.Black();
    this.rockTemplate = CreateIcoSphere('Rock', { radius: 2, subdivisions: 1, flat: true }, this.scene);
    this.rockTemplate.material = rockMaterial;
    this.rockTemplate.setEnabled(false);
    this.target = this.makeTarget();
    this.vehicle = new TargetVehicle(this.scene);
    for (const mesh of this.vehicle.root.getChildMeshes()) this.shadows.addShadowCaster(mesh);
    this.combat = new CombatEffects(this.scene);
    const markerMaterial = new StandardMaterial('Impact predictor', this.scene);
    markerMaterial.emissiveColor = new Color3(0.38, 1, 0.82);
    markerMaterial.disableLighting = true;
    this.marker = CreateTorus('Predicted impact', { diameter: 6, thickness: 0.6, tessellation: 36 }, this.scene);
    this.marker.material = markerMaterial;
    this.marker.isPickable = false;
    const markMaterial = new StandardMaterial('Impact crater mark', this.scene);
    markMaterial.diffuseColor = new Color3(0.065, 0.055, 0.036);
    markMaterial.specularColor = Color3.Black();
    this.impactMark = CreateDisc('Impact scar', { radius: 3.2, tessellation: 24 }, this.scene);
    this.impactMark.rotation.x = Math.PI / 2;
    this.impactMark.material = markMaterial;
    this.impactMark.setEnabled(false);
    this.burstMaterial = new StandardMaterial('Dust', this.scene);
    this.burstMaterial.diffuseColor = new Color3(0.5, 0.43, 0.31);
    this.burstMaterial.specularColor = Color3.Black();
    this.applyPalette();
    this.configure(quality);
  }

  private makeEnvironment(theme: TerrainTheme): RawCubeTexture {
    const palette = TERRAIN_PALETTES[theme];
    const size = 32;
    const faces = Array.from({ length: 6 }, (_, face) => {
      const data = new Uint8Array(size * size * 3);
      for (let y = 0; y < size; y++) {
        const height = face === 2 ? 1 : face === 3 ? 0 : 1 - y / size;
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 3;
          for (let channel = 0; channel < 3; channel++) {
            data[i + channel] = mix(palette.reflectionGround[channel]!, palette.reflectionSky[channel]!, height);
          }
        }
      }
      return data;
    });
    const environment = new RawCubeTexture(this.scene, faces, size, Constants.TEXTUREFORMAT_RGB,
      Constants.TEXTURETYPE_UNSIGNED_BYTE, true, false);
    environment.gammaSpace = true;
    this.scene.environmentIntensity = 0.65;
    return environment;
  }

  private applyPalette(): void {
    const palette = TERRAIN_PALETTES[this.terrain];
    this.scene.clearColor.set(palette.sky.r, palette.sky.g, palette.sky.b, 1);
    this.scene.fogColor.copyFrom(palette.sky);
    this.sun.diffuse.copyFrom(palette.sun);
    this.ambient.diffuse.copyFrom(palette.fill);
    this.ambient.groundColor.copyFrom(palette.ground);
    this.rockMaterial.diffuseColor.copyFrom(palette.rock);
    this.burstMaterial.diffuseColor.copyFrom(palette.dust);
    this.scene.environmentTexture = this.environments[this.terrain];
  }

  setTerrain(theme: TerrainTheme): void {
    if (theme === this.terrain) return;
    if (!this.terrainMaterials) throw new Error('Terrain materials are not ready.');
    this.terrain = theme;
    this.terrainMaterial = this.terrainMaterials[theme];
    this.applyPalette();
    this.clearChunks();
  }

  private makeTarget(): Mesh {
    const texture = new DynamicTexture('Concentric target rings', { width: 1024, height: 1024 }, this.scene, true);
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, 1024, 1024);
    for (let i = 5; i >= 1; i--) {
      ctx.beginPath();
      ctx.arc(512, 512, i * 100, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? '#ecddd0' : '#b33f2e';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(512, 512, 27, 0, Math.PI * 2);
    ctx.fillStyle = '#3b2623';
    ctx.fill();
    texture.update();
    texture.hasAlpha = true;
    const material = new StandardMaterial('Painted range target', this.scene);
    material.diffuseTexture = texture;
    material.useAlphaFromDiffuseTexture = true;
    material.specularColor = Color3.Black();
    material.emissiveColor = new Color3(0.1, 0.09, 0.08);
    material.backFaceCulling = false;
    const target = CreateGround('Target', { width: TARGET_RADIUS * 2 * 512 / 500, height: TARGET_RADIUS * 2 * 512 / 500 }, this.scene);
    target.material = material;
    target.receiveShadows = true;
    target.isPickable = false;
    return target;
  }

  async load(progress: (value: string) => void): Promise<void> {
    progress('Loading aircraft and terrain materials...');
    const [aircraft, bomb, terrain] = await Promise.all([
      LoadAssetContainerAsync('/assets/kestrel.glb', this.scene),
      LoadAssetContainerAsync('/assets/practice-bomb.glb', this.scene),
      createTerrainMaterial(this.scene),
    ]);
    this.containers = [aircraft, bomb];
    aircraft.addAllToScene();
    for (const mesh of aircraft.rootNodes) {
      mesh.parent = this.aircraft;
      if (mesh instanceof TransformNode) mesh.rotate(Vector3.Up(), Math.PI);
    }
    for (const mesh of this.aircraft.getChildMeshes()) {
      this.shadows.addShadowCaster(mesh);
      mesh.isPickable = false;
    }
    bomb.addAllToScene();
    for (const mesh of bomb.rootNodes) {
      mesh.parent = this.bombRoot;
      if (mesh instanceof TransformNode) mesh.rotate(Vector3.Up(), Math.PI);
    }
    const carried = bomb.instantiateModelsToScene(name => `Carried ${name}`, true);
    this.carriedBomb = new TransformNode('Carried bomb', this.scene);
    this.carriedBomb.parent = this.aircraft;
    this.carriedBomb.position.y = -2.2;
    for (const node of carried.rootNodes) node.parent = this.carriedBomb;
    this.bombRoot.setEnabled(false);
    this.desertSurface = createDesertMaterial(this.scene);
    this.terrainMaterials = { 'green-valley': terrain, desert: this.desertSurface.material };
    this.terrainMaterial = this.terrainMaterials[this.terrain];
    progress('Building the flight corridor...');
    this.stream(0, true);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          const sample = this.chunks.values().next().value?.mesh;
          if (!sample) throw new Error('Missing terrain shader preview.');
          for (const material of Object.values(this.terrainMaterials!)) {
            await material.forceCompilationAsync(sample);
          }
          await this.scene.whenReadyAsync();
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Graphics initialization timed out. Try reloading with graphics acceleration enabled.')), 30_000);
        }),
      ]);
    } finally { clearTimeout(timeout); }
  }

  configure(quality: Quality): void {
    this.quality = quality;
    const preset = QUALITY[quality];
    this.engine.setHardwareScalingLevel(preset.scale / Math.min(window.devicePixelRatio, 1.5));
    this.scene.fogEnd = preset.distance;
    this.shadows.mapSize = preset.shadow;
    this.clearChunks();
    this.engine.resize();
  }

  private clearChunks(): void {
    this.lastChunk = -Infinity;
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
  }

  private disposeChunk(chunk: Chunk): void {
    chunk.mesh.dispose();
    chunk.trees.dispose();
    chunk.rocks.dispose();
  }

  private makeChunk(cx: number, cz: number): Chunk {
    const mesh = new Mesh(`Terrain ${cx},${cz}`, this.scene);
    const positions: number[] = [], normals: number[] = [], indices: number[] = [], uvs: number[] = [], colors: number[] = [];
    const n = CHUNK / CELL;
    for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) {
      const wx = cx * CHUNK + x * CELL, wz = cz * CHUNK + z * CELL;
      positions.push(wx, vertexHeight(wx, wz), z * CELL);
      const normal = new Vector3(vertexHeight(wx - CELL, wz) - vertexHeight(wx + CELL, wz),
        2 * CELL, vertexHeight(wx, wz - CELL) - vertexHeight(wx, wz + CELL)).normalize();
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(wx / 24, ((cz % 24) * CHUNK + z * CELL) / 24);
      colors.push(...terrainTint(this.terrain, wx, wz));
    }
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      const a = z * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
    const data = new VertexData();
    data.positions = positions; data.normals = normals; data.indices = indices; data.uvs = uvs; data.colors = colors;
    data.applyToMesh(mesh);
    mesh.material = this.terrainMaterial;
    mesh.position.z = cz * CHUNK - this.origin;
    mesh.receiveShadows = true;
    mesh.isPickable = false;
    const trees = this.treeTemplate.clone(`Trees ${cx},${cz}`);
    const rocks = this.rockTemplate.clone(`Rocks ${cx},${cz}`);
    trees.makeGeometryUnique();
    rocks.makeGeometryUnique();
    const treeMatrices: number[] = [], rockMatrices: number[] = [];
    const density = QUALITY[this.quality].trees;
    for (let i = 0; i < density; i++) {
      const prop = terrainProp(this.terrain, i);
      if (!prop) continue;
      const wx = (cx + hash(cx * 41 + i, cz, 12)) * CHUNK;
      const wz = (cz + hash(cx, cz * 37 + i, 45)) * CHUNK;
      if (Math.abs(wx - valleyCenter(wz)) < 180) continue;
      const scale = 0.7 + hash(cx + i, cz, 56) * 1.2;
      const matrix = Matrix.Compose(new Vector3(scale, scale, scale), Quaternion.RotationAxis(Vector3.Up(), hash(cx, cz + i) * 6),
        new Vector3(wx, terrainHeight(wx, wz), wz - cz * CHUNK));
      const matrices = prop === 'tree' ? treeMatrices : rockMatrices;
      matrix.copyToArray(matrices, matrices.length);
    }
    trees.position.z = rocks.position.z = mesh.position.z;
    trees.setEnabled(treeMatrices.length > 0);
    rocks.setEnabled(rockMatrices.length > 0);
    if (treeMatrices.length) trees.thinInstanceSetBuffer('matrix', new Float32Array(treeMatrices), 16);
    if (rockMatrices.length) rocks.thinInstanceSetBuffer('matrix', new Float32Array(rockMatrices), 16);
    return { mesh, trees, rocks, z: cz * CHUNK };
  }

  private stream(z: number, immediate = false): void {
    const center = Math.floor(z / CHUNK);
    if (center === this.lastChunk && !immediate) return;
    this.lastChunk = center;
    const ahead = Math.ceil(this.scene.fogEnd / CHUNK) + 1;
    for (const [key, chunk] of this.chunks) {
      if (chunk.z < (center - 3) * CHUNK || chunk.z > (center + ahead) * CHUNK) {
        this.disposeChunk(chunk);
        this.chunks.delete(key);
      }
    }
    for (let cz = center - 3; cz <= center + ahead; cz++) for (let cx = -5; cx <= 4; cx++) {
      const key = `${cx},${cz}`;
      if (!this.chunks.has(key)) this.chunks.set(key, this.makeChunk(cx, cz));
    }
  }

  private local(p: Vec3): Vector3 { return new Vector3(p.x, p.y, p.z - this.origin); }

  reset(): void {
    this.resultId = this.lastEncounter = 0;
    this.cameraInitialized = false;
    this.impactMark.setEnabled(false);
    this.aircraft.setEnabled(true);
    this.vehicle.setDestroyed(false);
    this.combat.reset();
    for (const burst of this.bursts) burst.mesh.dispose();
    this.bursts = [];
  }

  update(run: Run, pose: Pose, prediction: Vec3 | null, dt: number): void {
    this.scene.fogEnd = Math.max(QUALITY[this.quality].distance, targetSightDistance(run.encounter.id - 1) + 400);
    if (run.status === 'over') this.combat.startFinale(pose);
    this.combat.advance(dt);
    pose = this.combat.finalePose ?? pose;
    if (Math.abs(pose.position.z - this.origin) > 4096) {
      const nextOrigin = Math.floor(pose.position.z / CHUNK) * CHUNK;
      const shift = nextOrigin - this.origin;
      this.origin = nextOrigin;
      this.camera.position.z -= shift;
      for (const chunk of this.chunks.values()) chunk.mesh.position.z = chunk.trees.position.z = chunk.rocks.position.z = chunk.z - this.origin;
      for (const burst of this.bursts) burst.mesh.position.z -= shift;
      this.impactMark.position.z -= shift;
    }
    if (this.desertSurface) this.desertSurface.origin = this.origin;
    this.stream(pose.position.z);
    this.aircraft.position.copyFrom(this.local(pose.position));
    this.aircraft.setEnabled(!this.combat.aircraftDestroyed);
    this.aircraft.rotation.set(pose.pitch, Math.atan2(pose.velocity.x, pose.velocity.z), pose.bank);
    this.carriedBomb?.setEnabled(!run.encounter.released);
    this.bombRoot.setEnabled(run.bomb !== null);
    if (run.bomb) {
      this.bombRoot.position.copyFrom(this.local(run.bomb.position));
      this.bombRoot.rotation.set(-Math.atan2(run.bomb.velocity.y, run.bomb.velocity.z),
        Math.atan2(run.bomb.velocity.x, run.bomb.velocity.z), 0);
    }
    const center = valleyCenter(pose.position.z);
    const desired = this.local({ x: mix(center, pose.position.x, 0.7), y: pose.position.y + 16, z: pose.position.z - 40 });
    desired.y = Math.max(desired.y, terrainHeight(desired.x, desired.z + this.origin) + 16);
    if (!this.cameraInitialized) {
      this.camera.position.copyFrom(desired);
      this.cameraInitialized = true;
    } else Vector3.LerpToRef(this.camera.position, desired, 1 - Math.exp(-dt * 6), this.camera.position);
    this.camera.setTarget(this.local({ x: mix(valleyCenter(pose.position.z + 95), pose.position.x, 0.45), y: pose.position.y - 9, z: pose.position.z + 95 }));
    this.sun.position.copyFrom(this.aircraft.position).addInPlace(new Vector3(160, 290, -150));
    this.target.position.copyFrom(this.local(run.encounter.target));
    this.target.position.y += 0.08;
    this.vehicle.root.position.copyFrom(this.local(run.encounter.target));
    this.marker.setEnabled(prediction !== null && run.ready);
    if (prediction) {
      this.marker.position.copyFrom(this.local(prediction));
      this.marker.position.y += 0.5;
      const radius = Math.hypot(prediction.x - run.encounter.target.x, prediction.z - run.encounter.target.z);
      const material = this.marker.material as StandardMaterial;
      material.emissiveColor.set(radius <= TARGET_RADIUS ? 0.3 : 1, radius <= TARGET_RADIUS ? 1 : 0.58, 0.5);
    }
    if (this.lastEncounter !== run.encounter.id) {
      this.lastEncounter = run.encounter.id;
      this.impactMark.setEnabled(false);
      this.vehicle.setDestroyed(false);
      this.vehicle.root.rotation.y = hash(run.encounter.id, 7, run.seed) * Math.PI * 2;
    }
    if (run.result && this.resultId !== run.result.id) {
      this.resultId = run.result.id;
      if (run.result.impact) this.explode(run.result.impact);
      if (run.result.points > 0) {
        this.vehicle.setDestroyed(true);
        if (run.status !== 'over' && shouldFlyby(run.encounter.id, run.seed)) this.combat.startFlyby(run);
      } else if (run.status !== 'over') this.combat.startDamage(run);
    }
    for (const burst of this.bursts) {
      burst.age += dt;
      burst.mesh.position.addInPlace(burst.velocity.scale(dt));
      burst.velocity.y -= dt * 5;
      burst.mesh.scaling.setAll(1 + burst.age * 3);
      burst.mesh.visibility = Math.max(0, 1 - burst.age / 2);
      if (burst.age >= 2) burst.mesh.dispose();
    }
    this.bursts = this.bursts.filter(burst => burst.age < 2);
    this.combat.render(pose, this.origin, dt);
  }

  private explode(impact: Vec3): void {
    this.impactMark.position.copyFrom(this.local(impact));
    this.impactMark.position.y += 0.15;
    this.impactMark.setEnabled(true);
    for (let i = 0; i < 14; i++) {
      const dust = CreateIcoSphere('Impact dust', { radius: 1.1, subdivisions: 1 }, this.scene);
      dust.position.copyFrom(this.local(impact));
      dust.material = this.burstMaterial;
      this.bursts.push({ mesh: dust, velocity: new Vector3((hash(i, 7) - 0.5) * 18, 4 + hash(i, 31) * 9, (hash(i, 13) - 0.5) * 18), age: 0 });
    }
  }

  targetVisible(run: Run): boolean {
    const target = this.local(run.encounter.target);
    const camera = this.camera.position;
    if (Vector3.Distance(camera, target) > targetSightDistance(run.encounter.id - 1)) return false;
    const screen = this.projectPoint(run.encounter.target);
    if (!screen || screen.x < 0.05 || screen.x > 0.95 || screen.y < 0.1 || screen.y > 0.94) return false;
    const hit = terrainImpact({ x: camera.x, y: camera.y, z: camera.z + this.origin },
      { ...run.encounter.target, y: FLOOR + 0.5 });
    return hit === null;
  }

  projectPoint(point: Vec3): { x: number; y: number } | null {
    this.scene.updateTransformMatrix();
    const width = this.engine.getRenderWidth(), height = this.engine.getRenderHeight();
    const screen = Vector3.Project(this.local(point), Matrix.Identity(), this.scene.getTransformMatrix(),
      this.camera.viewport.toGlobal(width, height));
    if (screen.z < 0 || screen.z > 1 || screen.x < 0 || screen.x > width || screen.y < 0 || screen.y > height) return null;
    return { x: screen.x / width, y: screen.y / height };
  }

  render(): void { this.scene.render(); }
  dispose(): void {
    for (const container of this.containers) container.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}
