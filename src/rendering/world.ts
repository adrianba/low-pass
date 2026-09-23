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
import { CHUNK, QUALITY, TARGET_RADIUS } from '../config/game';
import { FORMATION_PROFILE } from '../config/multiplayer';
import type { Quality } from '../config/game';
import type { TerrainTheme } from '../config/terrain';
import type { Run } from '../game/run';
import type { Pose } from '../simulation/pose';
import { hash, mix } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import { surfaceFor } from '../terrain/surface';
import type { Surface } from '../terrain/surface';
import { projectRoute, routeBounds } from '../terrain/canyon-route';
import { River } from './river';
import { CHASE_FOV, chaseView, targetInChaseView } from '../simulation/chase-camera';
import type { ChaseView } from '../simulation/chase-camera';
import { createTerrainMaterial, createCanyonMaterial } from './terrain-material';
import { createDesertMaterial } from './desert-material';
import type { DesertSurface } from './desert-material';
import { TERRAIN_PALETTES, terrainTint, terrainProp } from './terrain-style';
import { TargetModels } from './target-model';
import { CombatEffects } from './combat-effects';
import type { MissileView } from '../game/canyon-missile';
import { AircraftView } from './aircraft-view';
import { soloTargetFrame, soloWorldFrame } from './solo-frame';
import type { TargetFrame, WorldEffectHooks, WorldFrame } from './world-frame';
import { snapshotSharedFrame } from './shared-frame';
import type { SharedWorldFrame } from './shared-frame';
import { SharedTargets } from './shared-targets';
import { SharedImpacts } from './shared-impacts';

interface Chunk { mesh: Mesh; trees: Mesh; rocks: Mesh; water: Mesh | null; z: number }
interface Burst { mesh: Mesh; velocity: Vector3; age: number }
export const MAX_SHARED_CHUNKS = (2 * Math.ceil(3500 / CHUNK) + 8) * 10;

export class World {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: FreeCamera;
  private aircraft: AircraftView;
  private chunks = new Map<string, Chunk>();
  private terrainMaterial!: PBRMaterial;
  private terrainMaterials: Record<TerrainTheme, PBRMaterial> | null = null;
  private desertSurface: DesertSurface | null = null;
  private environments: Record<TerrainTheme, RawCubeTexture>;
  private treeTemplate: Mesh;
  private rockTemplate: Mesh;
  private target: Mesh;
  private targetModels: TargetModels;
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
  private lastAhead = 0;
  private containers: AssetContainer[] = [];
  private surface: Surface;
  private river: River;
  private sharedAircraft: AircraftView | null = null;
  private sharedTargets: SharedTargets | null = null;
  private sharedImpacts: SharedImpacts | null = null;
  private sharedActive = false;
  private sharedTime: number | null = null;
  private lastLow = -Infinity;
  private lastHigh = -Infinity;
  private planningCamera: FreeCamera | null = null;

  constructor(canvas: HTMLCanvasElement, quality: Quality, private terrain: TerrainTheme = 'green-valley') {
    this.quality = quality;
    this.surface = surfaceFor(terrain);
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
    this.camera.fov = CHASE_FOV;
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
    this.environments = { 'green-valley': this.makeEnvironment('green-valley'), desert: this.makeEnvironment('desert'),
      'river-canyon': this.makeEnvironment('river-canyon') };
    this.shadows = new ShadowGenerator(QUALITY[quality].shadow, this.sun);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.bias = 0.0005;
    this.shadows.normalBias = 0.03;
    this.aircraft = new AircraftView(this.scene, this.shadows);
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
    this.targetModels = new TargetModels(this.scene);
    for (const mesh of this.targetModels.root.getChildMeshes()) this.shadows.addShadowCaster(mesh);
    this.combat = new CombatEffects(this.scene);
    this.river = new River(this.scene);
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
    this.surface = surfaceFor(theme);
    this.terrainMaterial = this.terrainMaterials[theme];
    this.applyPalette();
    this.clearChunks();
    this.river.reset();
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
    this.aircraft.loadModels(aircraft, bomb);
    this.desertSurface = createDesertMaterial(this.scene);
    this.terrainMaterials = { 'green-valley': terrain, desert: this.desertSurface.material,
      'river-canyon': createCanyonMaterial(this.scene, terrain) };
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
          await this.river.material.forceCompilationAsync(sample);
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

  async prepareSharedScene(signal: AbortSignal): Promise<void> {
    if (!this.sharedActive) throw new Error('Prepare the shared frame before warming its scene.');
    const nodes = [...this.scene.transformNodes, ...this.scene.meshes];
    const enabled = nodes.map(node => node.isEnabled(false));
    const clipping = this.scene.skipFrustumClipping;
    const deadline = performance.now() + 30_000;
    const nextFrame = () => new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Shared scene preparation cancelled.')); return; }
      if (performance.now() >= deadline) { reject(new Error('Shared graphics initialization timed out.')); return; }
      const frame = requestAnimationFrame(() => { clearTimeout(timeout); signal.removeEventListener('abort', cancel); resolve(); });
      const cancel = () => { cancelAnimationFrame(frame); clearTimeout(timeout); reject(new Error('Shared scene preparation cancelled.')); };
      const timeout = setTimeout(() => {
        cancelAnimationFrame(frame); signal.removeEventListener('abort', cancel);
        reject(new Error('Shared graphics initialization timed out. Try reloading with graphics acceleration enabled.'));
      }, Math.max(0, deadline - performance.now()));
      signal.addEventListener('abort', cancel, { once: true });
    });
    try {
      for (const node of nodes) node.setEnabled(true);
      this.scene.skipFrustumClipping = true;
      this.renderOnce();
      while (!this.scene.isReady(true)) await nextFrame();
      this.renderOnce();
      await nextFrame();
    } finally {
      nodes.forEach((node, index) => { if (!node.isDisposed()) node.setEnabled(enabled[index]!); });
      this.scene.skipFrustumClipping = clipping;
    }
  }

  /** Caller owns the returned view and must dispose it before this World. */
  createAircraftView(prefix: string): AircraftView {
    if (!prefix || this.containers.length !== 2 || this.scene.isDisposed ||
      this.scene.getTransformNodeByName(`${prefix}Aircraft pose`)) {
      throw new Error('Extra aircraft views require loaded assets and a unique nonempty prefix.');
    }
    const view = new AircraftView(this.scene, this.shadows, prefix);
    view.loadModels(this.containers[0]!, this.containers[1]!);
    return view;
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
    chunk.water?.dispose();
  }

  private makeChunk(cx: number, cz: number): Chunk {
    const mesh = new Mesh(`Terrain ${cx},${cz}`, this.scene);
    const positions: number[] = [], normals: number[] = [], indices: number[] = [], uvs: number[] = [], colors: number[] = [];
    const CELL = this.surface.cell;
    const vertexHeight = this.surface.vertex;
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
      if (this.surface.canyon ? Math.abs(projectRoute(wx, wz).lateral) < 170
        || this.surface.normal(wx, wz).y < 0.82 : Math.abs(wx - this.surface.center(wz)) < 180) continue;
      const scale = 0.7 + hash(cx + i, cz, 56) * 1.2;
      const matrix = Matrix.Compose(new Vector3(scale, scale, scale), Quaternion.RotationAxis(Vector3.Up(), hash(cx, cz + i) * 6),
        new Vector3(wx, this.surface.height(wx, wz), wz - cz * CHUNK));
      const matrices = prop === 'tree' ? treeMatrices : rockMatrices;
      matrix.copyToArray(matrices, matrices.length);
    }
    trees.position.z = rocks.position.z = mesh.position.z;
    trees.setEnabled(treeMatrices.length > 0);
    rocks.setEnabled(rockMatrices.length > 0);
    if (treeMatrices.length) trees.thinInstanceSetBuffer('matrix', new Float32Array(treeMatrices), 16);
    if (rockMatrices.length) rocks.thinInstanceSetBuffer('matrix', new Float32Array(rockMatrices), 16);
    const waterBounds = this.surface.canyon ? routeBounds(cz * CHUNK - 32, (cz + 1) * CHUNK + 32, 40) : null;
    return { mesh, trees, rocks, water: waterBounds && (cx + 1) * CHUNK >= waterBounds[0] && cx * CHUNK <= waterBounds[1]
      ? this.river.chunk(cx, cz, this.origin) : null, z: cz * CHUNK };
  }

  private stream(z: number, immediate = false, anchors: readonly Readonly<Vec3>[] = []): void {
    const center = Math.floor(z / CHUNK);
    const ahead = Math.ceil(this.scene.fogEnd / CHUNK) + 1;
    const low = Math.min(center, ...anchors.map(p => Math.floor(p.z / CHUNK))) - 3;
    const high = Math.max(center, ...anchors.map(p => Math.floor(p.z / CHUNK))) + ahead;
    if (!Number.isFinite(low) || !Number.isFinite(high) || high - low + 1 > MAX_SHARED_CHUNKS / 10) {
      throw new Error('Formation exceeds bounded terrain coverage.');
    }
    if (center === this.lastChunk && ahead === this.lastAhead && low === this.lastLow && high === this.lastHigh && !immediate) return;
    const required = new Map<string, [number, number]>();
    for (let cz = low; cz <= high; cz++) {
      const bounds = this.surface.canyon ? routeBounds(cz * CHUNK - 256, (cz + 1) * CHUNK + 256, 380) : null;
      const left = bounds ? Math.floor(bounds[0] / CHUNK) : -5, right = bounds ? Math.floor(bounds[1] / CHUNK) : 4;
      for (let cx = left; cx <= right; cx++) required.set(`${cx},${cz}`, [cx, cz]);
    }
    if (required.size > MAX_SHARED_CHUNKS) throw new Error('Formation exceeds the terrain chunk budget.');
    for (const [key, chunk] of this.chunks) {
      if (!required.has(key)) {
        this.disposeChunk(chunk);
        this.chunks.delete(key);
      }
    }
    for (const [key, [cx, cz]] of required) {
      if (!this.chunks.has(key)) this.chunks.set(key, this.makeChunk(cx, cz));
    }
    this.lastChunk = center; this.lastAhead = ahead;
    this.lastLow = low; this.lastHigh = high;
  }

  private local(p: Vec3): Vector3 { return new Vector3(p.x, p.y, p.z - this.origin); }
  get renderOrigin(): number { return this.origin; }

  chaseSnapshot(): ChaseView {
    this.camera.getViewMatrix(true);
    const look = this.camera.getTarget(), p = this.camera.position;
    return { position: { x: p.x, y: p.y, z: p.z + this.origin },
      target: { x: look.x, y: look.y, z: look.z + this.origin } };
  }

  private missileView(): MissileView {
    return { ...this.chaseSnapshot(),
      aspect: this.engine.getRenderWidth() / this.engine.getRenderHeight(), range: this.scene.fogEnd };
  }

  captureMissileView(view: ChaseView, range: number, aspect = this.engine.getRenderWidth() / this.engine.getRenderHeight()): MissileView {
    if (this.scene.isDisposed || !Number.isFinite(aspect) || aspect < FORMATION_PROFILE.viewport.minAspect ||
      aspect > FORMATION_PROFILE.viewport.maxAspect ||
      !Number.isFinite(range) || range <= 0) throw new Error('Invalid missile camera viewport or range.');
    if (!this.planningCamera) {
      this.planningCamera = new FreeCamera('Authored combat camera', Vector3.Zero(), this.scene);
      this.planningCamera.fov = CHASE_FOV;
      this.planningCamera.minZ = this.camera.minZ; this.planningCamera.maxZ = this.camera.maxZ;
    }
    // Authoring can run ahead of displayed chunks; keep its camera coordinates small.
    const origin = Math.floor(view.position.z / CHUNK) * CHUNK;
    this.planningCamera.position.set(view.position.x, view.position.y, view.position.z - origin);
    this.planningCamera.setTarget(new Vector3(view.target.x, view.target.y, view.target.z - origin));
    this.planningCamera.getViewMatrix(true);
    const p = this.planningCamera.position, target = this.planningCamera.getTarget();
    return { position: { x: p.x, y: p.y, z: p.z + origin },
      target: { x: target.x, y: target.y, z: target.z + origin }, aspect, range };
  }

  reset(): void {
    this.resultId = this.lastEncounter = 0;
    this.cameraInitialized = false;
    this.impactMark.setEnabled(false);
    this.aircraft.reset();
    this.targetModels.reset();
    this.combat.reset();
    this.river.reset();
    for (const burst of this.bursts) burst.mesh.dispose();
    this.bursts = [];
    this.sharedActive = false; this.sharedTime = null;
    this.sharedAircraft?.reset();
    this.sharedAircraft?.root.setEnabled(false);
    this.sharedTargets?.reset(); this.sharedImpacts?.reset();
    this.target.setEnabled(true); this.targetModels.root.setEnabled(true);
  }

  update(run: Run, pose: Pose, prediction: Vec3 | null, dt: number, authoredView?: ChaseView): void {
    this.updateFrame(soloWorldFrame(run, pose, prediction), dt, {
      finale: current => this.combat.startFinale(current, run, this.missileView()),
      flyby: () => this.combat.startFlyby(run, this.missileView()),
      damage: () => this.combat.startDamage(run, this.missileView()),
    }, authoredView);
  }

  updateFrame(frame: WorldFrame, dt: number, effects: WorldEffectHooks, authoredView?: ChaseView): void {
    if (this.sharedActive) this.reset();
    let pose = frame.aircraft.pose;
    this.scene.fogEnd = Math.max(QUALITY[this.quality].distance, frame.target.sightDistance + 400);
    if (frame.over) effects.finale(pose);
    this.combat.advance(dt);
    pose = this.combat.finalePose ?? pose;
    this.prepareScene(pose, dt, frame.target.sightDistance, authoredView);
    this.aircraft.update({ pose, bomb: frame.aircraft.bomb, released: frame.aircraft.released,
      destroyed: this.combat.aircraftDestroyed, canyon: frame.target.canyon }, this.origin);
    this.target.position.copyFrom(this.local(frame.target.position));
    this.target.position.y += 0.08;
    this.targetModels.root.position.copyFrom(this.local(frame.target.position));
    this.updatePrediction(frame.prediction, frame.ready);
    if (this.lastEncounter !== frame.target.id) {
      this.lastEncounter = frame.target.id;
      this.impactMark.setEnabled(false);
      this.targetModels.select(frame.target.kind);
      this.targetModels.root.rotation.y = frame.target.heading;
    }
    if (frame.result && this.resultId !== frame.result.id) {
      this.resultId = frame.result.id;
      if (frame.result.impact?.kind === 'water') {
        this.impactMark.setEnabled(false);
        this.river.splash(frame.result.impact);
      } else if (frame.result.impact) this.explode(frame.result.impact);
      if (frame.result.points > 0) {
        this.targetModels.setDestroyed(true);
        if (!frame.over && frame.result.flyby) effects.flyby();
      } else if (!frame.over) effects.damage();
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
    this.river.update(dt, this.origin);
  }

  updateSharedFrame(input: SharedWorldFrame): void {
    const frame = snapshotSharedFrame(input);
    if (frame.terrain !== this.terrain) throw new Error('Shared frame does not match the selected physical course.');
    if (this.sharedTime !== null && frame.time < this.sharedTime) throw new Error('Reset before rewinding a shared scene.');
    if (!this.sharedActive) {
      this.reset();
      this.sharedAircraft ??= this.createAircraftView('Player 2 ');
      this.sharedTargets ??= new SharedTargets(this.scene, this.shadows, this.target);
      if (!this.impactMark.material) throw new Error('Missing shared impact material.');
      this.sharedImpacts ??= new SharedImpacts(this.scene, this.burstMaterial, this.impactMark.material, this.river.splashMaterial);
      this.sharedActive = true;
      this.target.setEnabled(false); this.targetModels.root.setEnabled(false);
    }
    const dt = this.sharedTime === null ? 0 : frame.time - this.sharedTime;
    const pose = frame.aircraft[frame.viewedSlot].pose, view = frame.views[frame.viewedSlot];
    const anchors = frame.aircraft.filter(a => !a.destroyed).map(a => a.pose.position);
    for (const aircraft of frame.aircraft) if (aircraft.bomb) anchors.push(aircraft.bomb.position);
    const range = Math.max(QUALITY[this.quality].distance, ...frame.targets.map(t => t.sightDistance + 400));
    for (const point of frame.effectPositions) {
      if (Math.hypot(point.x - view.position.x, point.y - view.position.y, point.z - view.position.z) <= range + CHUNK) anchors.push(point);
    }
    this.prepareScene(pose, dt, Math.max(...frame.targets.map(t => t.sightDistance)), view, anchors);
    const canyon = frame.terrain === 'river-canyon';
    this.aircraft.update({ ...frame.aircraft[0], canyon }, this.origin);
    this.sharedAircraft!.update({ ...frame.aircraft[1], canyon }, this.origin);
    this.sharedTargets!.update(frame.targets, this.origin);
    this.sharedImpacts!.update(frame.impacts, frame.time, this.origin, canyon);
    this.updatePrediction(frame.prediction, frame.ready && !frame.aircraft[frame.viewedSlot].destroyed);
    this.river.setFlowTime(frame.time, this.origin);
    this.sharedTime = frame.time;
  }

  private prepareScene(pose: Pose, dt: number, sightDistance: number, authoredView?: ChaseView,
    anchors: readonly Readonly<Vec3>[] = []): void {
    this.scene.fogEnd = Math.max(QUALITY[this.quality].distance, sightDistance + 400);
    if (Math.abs(pose.position.z - this.origin) > 4096) {
      const nextOrigin = Math.floor(pose.position.z / CHUNK) * CHUNK;
      const shift = nextOrigin - this.origin;
      this.origin = nextOrigin;
      this.camera.position.z -= shift;
      for (const chunk of this.chunks.values()) {
        chunk.mesh.position.z = chunk.trees.position.z = chunk.rocks.position.z = chunk.z - this.origin;
        if (chunk.water) chunk.water.position.z = chunk.z - this.origin;
      }
      for (const burst of this.bursts) burst.mesh.position.z -= shift;
      this.impactMark.position.z -= shift;
    }
    if (this.desertSurface) this.desertSurface.origin = this.origin;
    this.stream(pose.position.z, false, anchors);
    const view = authoredView ?? chaseView(pose, this.surface, this.cameraInitialized
      ? { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z + this.origin } : null, dt);
    this.camera.position.copyFrom(this.local(view.position));
    this.camera.setTarget(this.local(view.target));
    this.cameraInitialized = true;
    this.sun.position.copyFrom(this.local(pose.position)).addInPlace(new Vector3(160, 290, -150));
  }

  private updatePrediction(prediction: WorldFrame['prediction'], ready: boolean): void {
    this.marker.setEnabled(prediction !== null && ready);
    if (prediction) {
      this.marker.position.copyFrom(this.local(prediction.position));
      this.marker.position.y += 0.5;
      this.alignSurface(this.marker, prediction.position, false);
      const hit = prediction.hit;
      const material = this.marker.material as StandardMaterial;
      material.emissiveColor.set(hit ? 0.3 : 1, hit ? 1 : 0.58, 0.5);
    }
  }

  private explode(impact: Vec3): void {
    this.impactMark.position.copyFrom(this.local(impact));
    this.impactMark.position.y += 0.15;
    this.alignSurface(this.impactMark, impact, true);
    this.impactMark.setEnabled(true);
    for (let i = 0; i < 14; i++) {
      const dust = CreateIcoSphere('Impact dust', { radius: 1.1, subdivisions: 1 }, this.scene);
      dust.position.copyFrom(this.local(impact));
      dust.material = this.burstMaterial;
      this.bursts.push({ mesh: dust, velocity: new Vector3((hash(i, 7) - 0.5) * 18, 4 + hash(i, 31) * 9, (hash(i, 13) - 0.5) * 18), age: 0 });
    }
  }

  private alignSurface(mesh: Mesh, point: Vec3, disc: boolean): void {
    const n = this.surface.canyon && !this.surface.wet(point.x, point.z)
      ? this.surface.normal(point.x, point.z) : { x: 0, y: 1, z: 0 };
    const axis = new Vector3(n.z, 0, -n.x);
    const rotation = axis.lengthSquared() > 1e-10
      ? Quaternion.RotationAxis(axis.normalize(), Math.acos(Math.min(1, n.y))) : Quaternion.Identity();
    mesh.rotationQuaternion = disc ? rotation.multiply(Quaternion.RotationAxis(Vector3.Right(), Math.PI / 2)) : rotation;
  }

  targetVisible(run: Run): boolean {
    return this.targetFrameVisible(soloTargetFrame(run));
  }

  targetFrameVisible(frame: TargetFrame): boolean {
    const target = this.local(frame.position);
    const camera = this.camera.position;
    if (frame.canyon) {
      this.camera.getViewMatrix(true);
      const look = this.camera.getTarget();
      return targetInChaseView(frame.position, {
        position: { x: camera.x, y: camera.y, z: camera.z + this.origin },
        target: { x: look.x, y: look.y, z: look.z + this.origin },
      }, this.surface, this.engine.getRenderWidth() / this.engine.getRenderHeight(),
      frame.sightDistance);
    }
    if (Vector3.Distance(camera, target) > frame.sightDistance) return false;
    const screen = this.projectPoint(frame.position);
    if (!screen || screen.x < 0.05 || screen.x > 0.95 || screen.y < 0.1 || screen.y > 0.94) return false;
    const hit = this.surface.ground({ x: camera.x, y: camera.y, z: camera.z + this.origin },
      { ...frame.position, y: frame.position.y + 0.5 });
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
  renderOnce(): void {
    this.engine.beginFrame();
    try { this.render(); }
    finally { this.engine.endFrame(); }
  }
  dispose(): void {
    this.sharedAircraft?.dispose();
    this.sharedTargets?.dispose(); this.sharedImpacts?.dispose();
    this.aircraft.dispose();
    for (const container of this.containers) container.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}
