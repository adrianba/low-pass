import { describe, expect, it } from 'vitest';
import { FLOOR, STEP, TARGET_RADIUS, difficulty } from '../../src/config/game';
import { Run, initialPose, launchFrom, planEncounter, poseAt } from '../../src/game/run';
import { canyonWarning } from '../../src/game/canyon-flight';
import { advanceBomb, contactAccuracy, predictImpact } from '../../src/simulation/ballistics';
import { CANYON } from '../../src/terrain/river-canyon';
import { canyonSurface, valleySurface } from '../../src/terrain/surface';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { River, wetTriangle } from '../../src/rendering/river';
import { CombatEffects } from '../../src/rendering/combat-effects';
import { MissileFlight, MISSILE_INTERCEPT_TIME } from '../../src/game/missile';

describe('River Canyon', () => {
  it('retains the old shared physical course and gives canyon its own surface', () => {
    expect(new Run(7).surface).toBe(valleySurface);
    expect(new Run(7, 'desert').surface).toBe(valleySurface);
    expect(new Run(7, 'river-canyon').surface).toBe(canyonSurface);
  });
  it('stops bombs at water before the bed and agrees with prediction', () => {
    const launch = { position: { x: canyonSurface.center(1000), y: 50, z: 1000 },
      velocity: { x: 0, y: -20, z: 0 }, age: 0 };
    const predicted = predictImpact(launch, canyonSurface);
    expect(predicted.kind).toBe('water');
    expect(predicted.y).toBe(CANYON.water);
    let impact = null;
    for (let i = 0; i < 2400 && !impact; i++) impact = advanceBomb(launch, STEP, canyonSurface);
    expect(impact).toEqual(predicted);
  });
  it('resolves water misses once and ends on the third miss', () => {
    const run = new Run(7, 'river-canyon');
    for (let miss = 1; miss <= 3; miss++) {
      const z = run.encounter.target.z;
      run.bomb = { position: { x: canyonSurface.center(z), y: 1, z },
        velocity: { x: 0, y: -200, z: 0 }, age: 0 };
      run.encounter.released = true;
      run.tick(true);
      expect(run.result?.impact?.kind).toBe('water');
      expect(run.result?.points).toBe(0);
      expect(run.misses).toBe(miss);
      expect(run.events.filter(e => e === 'splash')).toHaveLength(miss);
      for (let i = 0; i < 10; i++) run.tick(true);
      expect(run.misses).toBe(miss);
      if (miss < 3) {
        run.encounter.time = 7;
        run.tick(true);
        expect(run.result).toBeNull();
      }
    }
    expect(run.status).toBe('over');
    expect(run.events.filter(e => e === 'over')).toHaveLength(1);
    expect(run.release()).toBe(false);
  });
  it('chooses first water/ground contact on long segments and does not flood dry ground', () => {
    const z = CANYON.shelfOrigin, x = canyonSurface.center(z);
    const crossing = canyonSurface.contact({ x: x - 100, y: 100, z }, { x: x + 100, y: -100, z });
    expect(crossing?.kind).toBe('water');
    const wall = canyonSurface.contact({ x, y: 80, z }, { x: x + 300, y: -60, z });
    expect(wall?.kind).toBe('ground');
    expect(wall!.y).toBeGreaterThan(0);
    const bank = canyonSurface.contact({ x: x + 50, y: 50, z }, { x: x + 50, y: -40, z });
    expect(bank?.kind).toBe('ground');
    expect(bank?.y).toBe(FLOOR);
  });
  it('allows a real release to miss into the river', () => {
    const run = new Run(7, 'river-canyon');
    run.encounter.visibleAt = -canyonWarning(0);
    let waterTime: number | null = null;
    for (let t = run.encounter.visibleAt; t < 5; t += STEP) {
      run.encounter.time = t;
      if (!run.ready) break;
      if (run.prediction.kind === 'water') { waterTime = t; break; }
    }
    expect(waterTime).not.toBeNull();
    console.info('First-pass river release time', waterTime);
    expect(run.release()).toBe(true);
    while (!run.result) run.tick(true);
    expect(run.result.impact?.kind).toBe('water');
    expect(run.misses).toBe(1);
  });
  it('shares exact wet triangle boundaries and keeps splash resources bounded', () => {
    const wet = wetTriangle([{ x: 0, y: -10, z: 0 }, { x: 8, y: 10, z: 0 }, { x: 0, y: 10, z: 8 }]);
    expect(wet).toEqual([{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 0, y: 0, z: 4 }]);
    const engine = new NullEngine(), scene = new Scene(engine), river = new River(scene);
    const counts = [scene.meshes.length, scene.materials.length, scene.textures.length];
    for (let i = 0; i < 90; i++) {
      river.splash({ x: 0, y: 0, z: i * 1600 });
      river.update(0.2, i * 1600);
      const before = scene.meshes.map(m => m.position.asArray());
      river.update(0, i * 1600);
      expect(scene.meshes.map(m => m.position.asArray())).toEqual(before);
      river.reset();
      expect(scene.meshes.every(m => !m.isEnabled())).toBe(true);
    }
    expect([scene.meshes.length, scene.materials.length, scene.textures.length]).toEqual(counts);
    scene.dispose();
    expect(scene.meshes).toHaveLength(0);
    engine.dispose();
  });
  it('launches missiles from dry terrain and continues the finale inside the gorge', () => {
    const engine = new NullEngine(), scene = new Scene(engine), combat = new CombatEffects(scene);
    for (const count of [0, 6, 12]) {
      const run = new Run(7, 'river-canyon');
      run.encounter = planEncounter(count, 7, initialPose(), canyonSurface);
      run.encounter.visibleAt = -canyonWarning(count);
      run.encounter.time = 2.2;
      run.status = 'over';
      const pose = run.pose, future = poseAt(run.encounter, 2.2 + MISSILE_INTERCEPT_TIME, count);
      const missile = new MissileFlight('damage', pose, future.position, 1, canyonSurface);
      expect(canyonSurface.wet(missile.launch.x, missile.launch.z)).toBe(false);
      for (let t = 0; t < MISSILE_INTERCEPT_TIME; t += STEP) {
        const p = missile.positionAt(t);
        expect(p.y - canyonSurface.height(p.x, p.z)).toBeGreaterThan(2);
      }
      combat.reset();
      combat.startFinale(pose, run);
      expect(combat.finalePose?.position).toEqual(pose.position);
      for (let t = 0; t < MISSILE_INTERCEPT_TIME; t += STEP) {
        combat.advance(STEP);
        const p = combat.finalePose!.position;
        expect(p.y - canyonSurface.height(p.x, p.z)).toBeGreaterThan(30);
      }
      expect(run.status).toBe('over');
      expect(run.encounter.time).toBe(2.2);
    }
    scene.dispose();
    engine.dispose();
  });
  it('plans dry targets and safe continuous flights at every tier on successive banks', () => {
    let previous = initialPose();
    const sides = new Set<number>();
    for (let count = 0; count < 30; count++) {
      const encounter = planEncounter(count, 7, previous, canyonSurface);
      const start = poseAt(encounter, encounter.time, count);
      expect(start.position).toEqual(previous.position);
      expect(start.velocity).toEqual(previous.velocity);
      expect(start.acceleration).toEqual(previous.acceleration);
      expect(start.bank).toBeCloseTo(previous.bank, 12);
      expect(start.pitch).toBeCloseTo(previous.pitch, 12);
      encounter.visibleAt = -canyonWarning(count);
      sides.add(encounter.canyon!.side);
      for (let dz = -32; dz <= 32; dz += 4) for (let dx = -32; dx <= 32; dx += 4) {
        expect(canyonSurface.height(encounter.target.x + dx, encounter.target.z + dz)).toBe(FLOOR);
      }
      const impact = predictImpact(launchFrom(poseAt(encounter, 0, count)), canyonSurface);
      expect(contactAccuracy(impact, encounter.target, canyonSurface)).toBe(100);
      let hits = 0;
      for (let t = -0.5; t <= 0.5; t += STEP) {
        const p = predictImpact(launchFrom(poseAt(encounter, t, count)), canyonSurface);
        if (contactAccuracy(p, encounter.target, canyonSurface)) hits++;
      }
      expect(hits * STEP).toBeGreaterThanOrEqual(0.08);
      expect(TARGET_RADIUS).toBe(28);
      expect(difficulty(count).speed).toBeLessThanOrEqual(350);
      previous = poseAt(encounter, 7, count);
    }
    expect(sides.size).toBe(2);
  });
  it('has shorter measured release windows than the valley at every tier', () => {
    const widths: number[][] = [];
    for (let count = 0; count <= 12; count++) {
      let canyon = 0, valley = 0;
      for (let seed = 0; seed < 8; seed++) {
        for (const surface of [valleySurface, canyonSurface]) {
          const encounter = planEncounter(count, seed, initialPose({ x: 0, y: 167, z: seed * 9000 }), surface);
          encounter.visibleAt = surface.canyon ? -canyonWarning(count) : -6;
          let hits = 0;
          for (let i = -120; i <= 120; i++) {
            const impact = predictImpact(launchFrom(poseAt(encounter, i * STEP, count)), surface);
            if (contactAccuracy(impact, encounter.target, surface)) hits++;
          }
          if (surface.canyon) { canyon += hits; expect(hits * STEP).toBeGreaterThanOrEqual(0.08); }
          else valley += hits;
        }
      }
      widths.push([count + 1, canyon * STEP / 8, valley * STEP / 8]);
      expect(canyon, `tier ${count + 1}`).toBeLessThan(valley * 0.98);
    }
    console.info('Release windows (pass, canyon seconds, valley seconds)', widths);
  }, 30_000);
});
