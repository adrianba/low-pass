import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';

export const SAND_PERIOD = 6144;

// Integer harmonics make the pattern periodic across bounded origin offsets.
export class DesertSurface extends MaterialPluginBase {
  origin = 0;

  constructor(readonly material: PBRMaterial) {
    super(material, 'DesertSurface', 200, {}, true, true);
  }

  override getUniforms() {
    return {
      ubo: [{ name: 'sandOrigin', size: 1, type: 'float' }],
      fragment: 'uniform float sandOrigin;',
    };
  }

  override bindForSubMesh(buffer: UniformBuffer): void {
    buffer.updateFloat('sandOrigin', ((this.origin % SAND_PERIOD) + SAND_PERIOD) % SAND_PERIOD);
  }

  override getCustomCode(type: string): Record<string, string> | null {
    if (type !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
        vec2 sandPhase() {
          return fract((vPositionW.xz + vec2(0.0, sandOrigin)) / ${SAND_PERIOD}.0) * ${2 * Math.PI};
        }
        float sandDune(vec2 p) {
          return dot(p, vec2(19.0, 13.0)) + 1.3 * sin(dot(p, vec2(7.0, -5.0)))
            + 0.5 * sin(dot(p, vec2(31.0, 17.0)));
        }
        float sandRipple(vec2 p) {
          return dot(p, vec2(1553.0, 997.0)) + 3.0 * sin(dot(p, vec2(43.0, 29.0)))
            + 1.2 * sin(sandDune(p));
        }
        float sandDetail(float phase) {
          return 1.0 - smoothstep(0.35, 2.0, fwidth(phase));
        }
      `,
      CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
        vec2 sandP = sandPhase();
        float dune = sandDune(sandP);
        float ripple = sandRipple(sandP);
        float detail = sandDetail(ripple);
        float shade = 0.5 + 0.5 * sin(dune);
        vec3 sandColor = mix(vec3(0.48, 0.29, 0.12), vec3(0.82, 0.64, 0.36), shade);
        surfaceAlbedo *= sandColor * (1.0 + 0.055 * cos(ripple) * detail);
      `,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
        vec3 sandN = normalize(vNormalW);
        vec3 sandT = normalize(vec3(1.0, -sandN.x / max(0.01, sandN.y), 0.0));
        vec3 sandB = normalize(cross(sandT, sandN));
        float sandWave = sandRipple(sandPhase());
        float sandSlope = cos(sandWave) * 0.12 * sandDetail(sandWave);
        normalW = normalize(sandN + (sandT * 0.84 + sandB * 0.54) * sandSlope);
      `,
    };
  }
}

export function createDesertMaterial(scene: Scene): DesertSurface {
  const material = new PBRMaterial('Wind-rippled desert sand', scene);
  material.metallic = 0;
  material.roughness = 0.96;
  material.environmentIntensity = 0.45;
  return new DesertSurface(material);
}
