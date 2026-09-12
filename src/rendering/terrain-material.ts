import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';

export async function loadTexture(scene: Scene, url: string): Promise<Texture> {
  return new Promise((resolve, reject) => {
    const texture = new Texture(url, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE,
      () => resolve(texture), (message) => reject(new Error(`Could not load ${url}: ${message}`)));
    texture.anisotropicFilteringLevel = 4;
  });
}

class TerrainBlend extends MaterialPluginBase {
  constructor(material: PBRMaterial, private readonly maps: Record<string, Texture>) {
    super(material, 'TerrainBlend', 200, {}, true, true);
  }
  override getSamplers(samplers: string[]): void { samplers.push(...Object.keys(this.maps)); }
  override bindForSubMesh(buffer: UniformBuffer): void {
    for (const [name, texture] of Object.entries(this.maps)) buffer.setTexture(name, texture);
  }
  override getCustomCode(type: string): Record<string, string> | null {
    if (type !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
        uniform sampler2D rockColor;
        uniform sampler2D grassNormal;
        uniform sampler2D rockNormal;
        uniform sampler2D grassRough;
        uniform sampler2D rockRough;
        float terrainMix() { return smoothstep(0.04, 0.26, 1.0 - normalize(vNormalW).y); }
      `,
      CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
        vec3 rock = toLinearSpace(texture2D(rockColor, vMainUV1 * 0.65).rgb) * 0.8;
        surfaceAlbedo = mix(surfaceAlbedo, rock, terrainMix());
      `,
      CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: `
        metallicRoughness.g = mix(texture2D(grassRough, vMainUV1).r,
          texture2D(rockRough, vMainUV1 * 0.65).r, terrainMix());
      `,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
        vec3 terrainN = normalize(vNormalW);
        vec3 terrainT = normalize(vec3(1.0, -terrainN.x / max(0.01, terrainN.y), 0.0));
        vec3 terrainB = normalize(cross(terrainT, terrainN));
        vec3 detailN = mix(texture2D(grassNormal, vMainUV1).xyz,
          texture2D(rockNormal, vMainUV1 * 0.65).xyz, terrainMix()) * 2.0 - 1.0;
        normalW = normalize(terrainT * detailN.x * 0.35 + terrainB * detailN.y * 0.35
          + terrainN * max(0.3, detailN.z));
      `,
    };
  }
}

export async function createTerrainMaterial(scene: Scene): Promise<PBRMaterial> {
  const path = '/assets/terrain/';
  const [albedo, rockColor, grassNormal, rockNormal, grassRough, rockRough] = await Promise.all([
    'Ground037_1K-JPG_Color.jpg', 'Rock030_1K-JPG_Color.jpg',
    'Ground037_1K-JPG_NormalGL.jpg', 'Rock030_1K-JPG_NormalGL.jpg',
    'Ground037_1K-JPG_Roughness.jpg', 'Rock030_1K-JPG_Roughness.jpg',
  ].map(name => loadTexture(scene, path + name)));
  if (!albedo || !rockColor || !grassNormal || !rockNormal || !grassRough || !rockRough) throw new Error('Incomplete terrain material.');
  const material = new PBRMaterial('Meadow and exposed rock', scene);
  material.albedoTexture = albedo;
  material.metallic = 0;
  material.roughness = 0.94;
  material.environmentIntensity = 0.45;
  new TerrainBlend(material, { rockColor, grassNormal, rockNormal, grassRough, rockRough });
  return material;
}
