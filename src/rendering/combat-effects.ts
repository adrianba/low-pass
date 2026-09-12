import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import { hash, noise } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import { MissileFlight, finaleFlight, MISSILE_INTERCEPT_TIME } from '../game/missile';
import type { CombatCue, FinalePhase } from '../game/missile';
import { poseAt, aircraftPoint } from '../game/run';
import type { Pose, Run } from '../game/run';

interface Fragment {
  mesh: Mesh; position: Vec3; velocity: Vec3; age: number; duration: number; smoke: boolean;
}
interface DamagePuff { mesh: Mesh; position: Vec3; velocity: Vec3; age: number; size: number; spin: number }

function cloudTexture(scene: Scene): RawTexture {
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const radius = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
    const variation = noise(x / 24, y / 24, 61) * 0.7 + noise(x / 8, y / 8, 29) * 0.3;
    const density = Math.max(0, 1 - radius * radius) ** 1.8 * (0.2 + variation * 0.8);
    const index = (y * size + x) * 4;
    pixels[index] = pixels[index + 1] = pixels[index + 2] = 150 + variation * 105;
    pixels[index + 3] = density * 230;
  }
  const texture = RawTexture.CreateRGBATexture(pixels, size, size, scene, true, false);
  texture.hasAlpha = true;
  texture.wrapU = texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  return texture;
}

function smokeMaterial(scene: Scene, name: string, cloud: RawTexture, color: Color3): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = color;
  material.specularColor = Color3.Black();
  material.diffuseTexture = cloud;
  material.useAlphaFromDiffuseTexture = true;
  material.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
  material.disableDepthWrite = true;
  return material;
}

export class CombatEffects {
  readonly events: CombatCue[] = [];
  private flight: MissileFlight | null = null;
  private missile: TransformNode;
  private trail: Mesh[] = [];
  private fragments: Fragment[] = [];
  private smoke: StandardMaterial;
  private fire: StandardMaterial;
  private debris: StandardMaterial;
  private hits = 0;
  private damageTrail: DamagePuff[] = [];
  private smokeClock = 0;
  private smokeIndex = 0;
  private damageFlash: Mesh;
  private flashAge = Infinity;

  constructor(private readonly scene: Scene) {
    this.missile = new TransformNode('Surface-to-air missile', scene);
    const shell = new StandardMaterial('Missile casing', scene);
    shell.diffuseColor = new Color3(0.83, 0.84, 0.77);
    shell.specularColor = new Color3(0.5, 0.5, 0.5);
    this.debris = new StandardMaterial('Aircraft debris', scene);
    this.debris.diffuseColor = new Color3(0.11, 0.13, 0.12);
    this.fire = new StandardMaterial('Explosion fire', scene);
    this.fire.emissiveColor = new Color3(1, 0.34, 0.035);
    this.fire.disableLighting = true;
    const cloud = cloudTexture(scene);
    this.fire.diffuseTexture = cloud;
    this.fire.emissiveTexture = cloud;
    this.fire.useAlphaFromDiffuseTexture = true;
    this.fire.alphaMode = Constants.ALPHA_ADD;
    this.fire.disableDepthWrite = true;
    this.smoke = smokeMaterial(scene, 'Missile smoke', cloud, new Color3(0.25, 0.27, 0.25));
    const body = CreateCylinder('Missile body', { height: 4, diameter: 0.48, tessellation: 12 }, scene);
    body.rotation.x = Math.PI / 2;
    body.material = shell;
    body.parent = this.missile;
    const nose = CreateCylinder('Missile nose', { height: 1.2, diameterTop: 0, diameterBottom: 0.48, tessellation: 12 }, scene);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 2.6;
    nose.material = this.debris;
    nose.parent = this.missile;
    for (const angle of [0, Math.PI / 2]) {
      const fin = CreateBox('Missile fins', { width: 1.6, height: 0.08, depth: 0.95 }, scene);
      fin.position.z = -1.3;
      fin.rotation.z = angle;
      fin.material = shell;
      fin.parent = this.missile;
    }
    const exhaust = CreateCylinder('Missile exhaust', { height: 3.5, diameterTop: 0.48, diameterBottom: 0, tessellation: 8 }, scene);
    exhaust.rotation.x = Math.PI / 2;
    exhaust.position.z = -3.5;
    exhaust.material = this.fire;
    exhaust.parent = this.missile;
    for (const mesh of this.missile.getChildMeshes()) mesh.isPickable = false;
    for (let i = 0; i < 20; i++) {
      const puff = CreatePlane('Missile smoke trail', { size: 2.8 }, scene);
      puff.material = this.smoke;
      puff.billboardMode = Mesh.BILLBOARDMODE_ALL;
      puff.rotation.z = hash(i, 57) * Math.PI * 2;
      puff.isPickable = false;
      puff.setEnabled(false);
      this.trail.push(puff);
    }
    const oilSmoke = smokeMaterial(scene, 'Aircraft oil smoke', cloud, new Color3(0.055, 0.06, 0.055));
    for (let i = 0; i < 28; i++) {
      const mesh = CreatePlane('Aircraft damage smoke', { size: 3.6 }, scene);
      mesh.material = oilSmoke;
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      this.damageTrail.push({
        mesh, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
        age: Infinity, size: 1, spin: 0,
      });
    }
    this.damageFlash = CreatePlane('Survivable missile impact', { size: 9 }, scene);
    this.damageFlash.material = this.fire;
    this.damageFlash.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.damageFlash.isPickable = false;
    this.damageFlash.setEnabled(false);
    this.missile.setEnabled(false);
  }

  get finalePhase(): FinalePhase | null { return this.flight?.finalePhase ?? null; }
  get aircraftDestroyed(): boolean { return this.finalePhase !== null && this.finalePhase !== 'incoming'; }
  get finalePose(): Pose | null { return this.flight?.kind === 'finale' ? this.flight.aircraftPose() : null; }
  get missileActive(): boolean { return this.missile.isEnabled(); }
  get damageLevel(): number { return this.hits; }

  startFlyby(run: Run): void {
    this.startIncoming('flyby', run);
  }

  startDamage(run: Run): void {
    this.startIncoming('damage', run);
  }

  private startIncoming(kind: 'flyby' | 'damage', run: Run): void {
    if (this.flight) return;
    const future = poseAt(run.encounter, run.encounter.time + MISSILE_INTERCEPT_TIME, run.encounter.id - 1);
    this.flight = new MissileFlight(kind, run.pose, future.position, hash(run.encounter.id, 18, run.seed) < 0.5 ? -1 : 1);
    this.events.push('missile');
  }

  startFinale(pose: Pose): void {
    if (this.flight?.kind === 'finale') return;
    this.flight = finaleFlight(pose);
    this.events.push('missile');
  }

  advance(dt: number): void {
    const event = this.flight?.advance(dt);
    if (event) {
      this.events.push(event);
      if (event === 'destroyed' && this.flight) this.explode(this.flight.intercept);
      if (event === 'damaged') {
        this.hits = Math.min(2, this.hits + 1);
        this.flashAge = 0;
      }
    }
    if (this.flight && this.flight.kind !== 'finale' && this.flight.finished) this.flight = null;
  }

  render(pose: Pose, origin: number, dt: number): void {
    const flight = this.flight;
    const visible = flight !== null && (flight.kind === 'flyby' || !flight.hasImpacted);
    this.missile.setEnabled(visible);
    if (flight && visible) {
      const position = flight.positionAt(flight.age, pose.position);
      const ahead = flight.positionAt(flight.age + 0.01, pose.position);
      this.missile.position.set(position.x, position.y, position.z - origin);
      this.missile.lookAt(new Vector3(ahead.x, ahead.y, ahead.z - origin));
    }
    for (let i = 0; i < this.trail.length; i++) {
      const puff = this.trail[i]!;
      const sampleAge = (flight?.age ?? 0) - i * 0.045;
      const trailVisible = !!flight && !flight.finished && sampleAge > 0 && sampleAge < MISSILE_INTERCEPT_TIME;
      puff.setEnabled(trailVisible);
      if (flight && trailVisible) {
        const position = flight.positionAt(sampleAge);
        puff.position.set(position.x, position.y, position.z - origin);
        puff.scaling.setAll(0.5 + i * 0.14);
        puff.visibility = 0.7 * (1 - i / this.trail.length);
      }
    }
    for (const fragment of this.fragments) {
      fragment.age += dt;
      for (const axis of ['x', 'y', 'z'] as const) fragment.position[axis] += fragment.velocity[axis] * dt;
      if (!fragment.smoke) fragment.velocity.y -= 22 * dt;
      fragment.mesh.position.set(fragment.position.x, fragment.position.y, fragment.position.z - origin);
      if (!fragment.smoke) fragment.mesh.rotation.x += dt;
      fragment.mesh.rotation.z += dt * 0.7;
      fragment.mesh.scaling.setAll(fragment.smoke ? 1 + fragment.age * 1.8 : 1);
      fragment.mesh.visibility = Math.max(0, 1 - fragment.age / fragment.duration);
      if (fragment.age >= fragment.duration) fragment.mesh.dispose();
    }
    this.fragments = this.fragments.filter(fragment => fragment.age < fragment.duration);
    this.renderDamage(pose, origin, dt);
  }

  private renderDamage(pose: Pose, origin: number, dt: number): void {
    this.flashAge += dt;
    this.damageFlash.setEnabled(this.flashAge < 0.4 && !this.aircraftDestroyed);
    if (this.damageFlash.isEnabled()) {
      this.damageFlash.position.set(pose.position.x, pose.position.y, pose.position.z - origin);
      this.damageFlash.scaling.setAll(1 + this.flashAge * 3);
      this.damageFlash.visibility = 1 - this.flashAge / 0.4;
    }
    for (const puff of this.damageTrail) {
      puff.age += dt;
      if (puff.age >= 1.1) continue;
      puff.mesh.rotation.z += puff.spin * dt;
      for (const axis of ['x', 'y', 'z'] as const) {
        puff.position[axis] += puff.velocity[axis] * dt;
        puff.velocity[axis] *= Math.exp(-dt * 1.4);
      }
    }
    if (this.hits > 0 && !this.aircraftDestroyed && dt > 0) {
      this.smokeClock += dt;
      const interval = this.hits === 1 ? 0.09 : 0.045;
      while (this.smokeClock >= interval) {
        this.smokeClock -= interval;
        const puff = this.damageTrail[this.smokeIndex % this.damageTrail.length]!;
        const side = this.hits === 1 || this.smokeIndex % 2 === 0 ? -1 : 1;
        puff.size = 0.8 + hash(this.smokeIndex, 73) * 0.4;
        puff.spin = (hash(this.smokeIndex, 91) - 0.5) * 0.7;
        puff.mesh.rotation.z = hash(this.smokeIndex, 37) * Math.PI * 2;
        this.smokeIndex++;
        puff.position = aircraftPoint(pose, { x: side * 2.2, y: 0.5, z: -4 });
        puff.velocity = { x: pose.velocity.x * 0.6, y: pose.velocity.y * 0.6 + 3, z: pose.velocity.z * 0.6 };
        puff.age = 0;
      }
    }
    for (const puff of this.damageTrail) {
      puff.mesh.setEnabled(puff.age < 1.1);
      if (!puff.mesh.isEnabled()) continue;
      puff.mesh.position.set(puff.position.x, puff.position.y, puff.position.z - origin);
      puff.mesh.scaling.setAll(puff.size * (0.8 + puff.age * (this.hits === 1 ? 2 : 2.8)));
      puff.mesh.visibility = (this.hits === 1 ? 0.9 : 1) * (1 - puff.age / 1.1);
    }
  }

  private explode(position: Vec3): void {
    for (let i = 0; i < 36; i++) {
      const smoke = i < 24;
      const mesh = smoke
        ? CreatePlane('Aircraft explosion', { size: i < 12 ? 8 : 7 }, this.scene)
        : CreateBox('Falling aircraft debris', { width: 0.8 + hash(i, 21) * 2, height: 0.3, depth: 1.7 }, this.scene);
      if (smoke) mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      mesh.material = i < 12 ? this.fire : smoke ? this.smoke : this.debris;
      mesh.isPickable = false;
      this.fragments.push({
        mesh, position: { ...position },
        velocity: { x: (hash(i, 13) - 0.5) * 34, y: 5 + hash(i, 47) * 19, z: (hash(i, 31) - 0.5) * 30 },
        age: 0, duration: i < 12 ? 1.6 : 3.5, smoke,
      });
    }
  }

  reset(): void {
    this.flight = null;
    this.events.length = 0;
    this.missile.setEnabled(false);
    for (const puff of this.trail) puff.setEnabled(false);
    for (const fragment of this.fragments) fragment.mesh.dispose();
    this.fragments = [];
    this.hits = this.smokeClock = this.smokeIndex = 0;
    this.flashAge = Infinity;
    this.damageFlash.setEnabled(false);
    for (const puff of this.damageTrail) {
      puff.age = Infinity;
      puff.mesh.setEnabled(false);
    }
  }
}
