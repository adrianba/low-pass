import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';
import { CHUNK } from '../config/game';
import { mix } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import { canyonSurface } from '../terrain/surface';
import { CANYON } from '../terrain/river-canyon';
import { projectRoute, routeMotion } from '../terrain/canyon-route';
import { SplashView } from './splash-view';

class Flow extends MaterialPluginBase {
  time = 0;
  origin = 0;
  constructor(material: PBRMaterial) { super(material, 'RiverFlow', 200, {}, true, true); }
  override getClassName(): string { return 'LowPassRiverFlow'; }
  override getAttributes(attributes: string[]): void { attributes.push('riverCoord', 'riverNormal'); }
  override getUniforms() {
    return { ubo: [{ name: 'riverPhase', size: 2, type: 'vec2' }], fragment: 'uniform vec2 riverPhase;' };
  }
  override bindForSubMesh(buffer: UniformBuffer): void {
    buffer.updateFloat2('riverPhase', this.time, this.origin % 4096);
  }
  override getCustomCode(type: string): Record<string, string> | null {
    if (type === 'vertex') return {
      CUSTOM_VERTEX_DEFINITIONS: 'attribute vec2 riverCoord; attribute vec2 riverNormal; varying vec2 vRiverCoord; varying vec2 vRiverNormal;',
      CUSTOM_VERTEX_MAIN_END: 'vRiverCoord = riverCoord; vRiverNormal = riverNormal;',
    };
    if (type !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: 'varying vec2 vRiverCoord; varying vec2 vRiverNormal;',
      CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
        vec2 waterP = vRiverCoord;
        float waterWave = dot(waterP, vec2(61.0, 173.0)) * (6.28318530718 / 4096.0) + riverPhase.x * 2.0;
        float waterDetail = 1.0 - smoothstep(0.3, 1.5, fwidth(waterWave));
        surfaceAlbedo *= 0.92 + 0.08 * sin(waterWave) * waterDetail;
      `,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
        vec2 riverP = vRiverCoord;
        float riverK = 6.28318530718 / 4096.0;
        float riverA = dot(riverP, vec2(97.0, 153.0)) * riverK + riverPhase.x * 2.0;
        float riverB = dot(riverP, vec2(-181.0, 269.0)) * riverK + riverPhase.x * 3.0;
        float riverFade = 1.0 - smoothstep(0.3, 1.5, max(fwidth(riverA), fwidth(riverB)));
        vec2 riverSide = normalize(vRiverNormal);
        vec2 riverTilt = riverSide * cos(riverA) * 0.11
          + vec2(-riverSide.y, riverSide.x) * cos(riverB) * 0.09;
        normalW = normalize(vec3(riverTilt.x * riverFade, 1.0, riverTilt.y * riverFade));
      `,
    };
  }
}

// Clip the canonical ground triangle against the water level, sharing the shore
// with collision rather than independently approximating the river's outline.
export function wetTriangle(triangle: Vec3[]): Vec3[] {
  const result: Vec3[] = [];
  for (let i = 0; i < triangle.length; i++) {
    const a = triangle[i]!, b = triangle[(i + 1) % triangle.length]!;
    if (a.y < CANYON.water) result.push({ x: a.x, y: CANYON.water, z: a.z });
    if ((a.y < CANYON.water) !== (b.y < CANYON.water)) {
      const t = (CANYON.water - a.y) / (b.y - a.y);
      result.push({ x: mix(a.x, b.x, t), y: CANYON.water, z: mix(a.z, b.z, t) });
    }
  }
  return result;
}

export class River {
  readonly material: PBRMaterial;
  private flow: Flow;
  readonly splashMaterial: StandardMaterial;
  private splashView: SplashView;
  private splashPosition: Vec3 = { x: 0, y: 0, z: 0 };
  private age = Infinity;
  constructor(private scene: Scene) {
    this.material = new PBRMaterial('River water', scene);
    this.material.albedoColor = new Color3(0.035, 0.24, 0.23);
    this.material.metallic = 0.15;
    this.material.roughness = 0.26;
    this.material.environmentIntensity = 0.6;
    this.material.backFaceCulling = false;
    this.flow = new Flow(this.material);
    const foam = new StandardMaterial('River spray', scene);
    this.splashMaterial = foam;
    foam.diffuseColor = new Color3(0.64, 0.84, 0.82);
    foam.emissiveColor = new Color3(0.1, 0.16, 0.16);
    foam.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
    foam.disableDepthWrite = true;
    this.splashView = new SplashView(scene, foam);
  }
  chunk(cx: number, cz: number, origin: number): Mesh {
    const mesh = new Mesh(`River ${cx},${cz}`, this.scene);
    const positions: number[] = [], normals: number[] = [], indices: number[] = [], coordinates: number[] = [], directions: number[] = [];
    const cell = canyonSurface.cell;
    for (let z = 0; z < CHUNK; z += cell) for (let x = 0; x < CHUNK; x += cell) {
      const wx = cx * CHUNK + x, wz = cz * CHUNK + z;
      const vertex = (dx: number, dz: number) => ({ x: wx + dx,
        y: canyonSurface.vertex(wx + dx, wz + dz), z: wz + dz });
      const a = vertex(0, 0), b = vertex(cell, 0), c = vertex(0, cell), d = vertex(cell, cell);
      for (const triangle of [[a, b, c], [b, d, c]]) {
        const wet = wetTriangle(triangle), start = positions.length / 3;
        for (const p of wet) {
          positions.push(p.x, p.y, p.z - cz * CHUNK); normals.push(0, 1, 0);
          const route = projectRoute(p.x, p.z), frame = routeMotion(route.along);
          coordinates.push(route.lateral, route.along - cz * CHUNK + (cz * CHUNK) % 4096);
          directions.push(frame.nx, frame.nz);
        }
        for (let i = 1; i + 1 < wet.length; i++) indices.push(start, start + i, start + i + 1);
      }
    }
    if (indices.length) {
      const data = new VertexData();
      data.positions = positions; data.normals = normals; data.indices = indices;
      data.applyToMesh(mesh);
      mesh.setVerticesData('riverCoord', coordinates, false, 2);
      mesh.setVerticesData('riverNormal', directions, false, 2);
    } else mesh.setEnabled(false);
    mesh.material = this.material;
    mesh.position.z = cz * CHUNK - origin;
    mesh.isPickable = false;
    return mesh;
  }
  splash(position: Vec3): void { this.splashPosition = { ...position }; this.age = 0; }
  reset(): void {
    this.age = Infinity;
    this.flow.time = 0;
    this.splashView.reset();
  }
  setFlowTime(time: number, origin: number): void {
    if (!Number.isFinite(time) || time < 0 || !Number.isFinite(origin)) throw new Error('Invalid river presentation clock.');
    this.flow.time = time % (Math.PI * 2);
    this.flow.origin = origin;
  }
  update(dt: number, origin: number): void {
    this.setFlowTime(this.flow.time + dt, origin);
    this.age += dt;
    this.splashView.update(this.splashPosition, this.age, origin);
  }
}
