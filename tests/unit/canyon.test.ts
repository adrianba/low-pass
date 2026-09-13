import { describe, expect, it } from 'vitest';
import { FLOOR, STEP, TARGET_RADIUS, difficulty } from '../../src/config/game';
import { Run, initialPose, launchFrom, planEncounter, poseAt } from '../../src/game/run';
import { advanceBomb, contactAccuracy, predictImpact } from '../../src/simulation/ballistics';
import { CANYON } from '../../src/terrain/river-canyon';
import { canyonSurface, valleySurface } from '../../src/terrain/surface';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { River, wetTriangle } from '../../src/rendering/river';
import { CombatEffects } from '../../src/rendering/combat-effects';
import { MissileFlight, MISSILE_INTERCEPT_TIME } from '../../src/game/missile';
import { projectRoute, routeMotion } from '../../src/terrain/canyon-route';

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
        run.encounter.time = run.encounter.canyon!.endAt;
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
    run.encounter.visibleAt = run.encounter.canyon!.acquireAt;
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
  it('keeps bent river flow coordinates continuous across the periodic chunk seam', () => {
    const engine = new NullEngine(), scene = new Scene(engine), river = new River(scene);
    const x = Math.floor(routeMotion(4096).x / 256), vertices = new Map<number, number[]>();
    let matched = 0;
    for (const z of [15, 16]) {
      const mesh = river.chunk(x, z, 0);
      const positions = mesh.getVerticesData('position')!, coordinates = mesh.getVerticesData('riverCoord')!;
      for (let i = 0; i < positions.length / 3; i++) {
        if (Math.abs(positions[i * 3 + 2]! + z * 256 - 4096) > 0.001) continue;
        const px = positions[i * 3]!, u = coordinates[i * 2]!, v = coordinates[i * 2 + 1]!;
        const frame = projectRoute(px, 4096);
        expect(u).toBeCloseTo(frame.lateral, 3);
        const phase = (61 * u + 173 * v) * Math.PI * 2 / 4096;
        const value = [Math.sin(phase), Math.cos(phase)];
        if (z === 15) vertices.set(px, value);
        else if (vertices.has(px)) {
          expect(value[0]).toBeCloseTo(vertices.get(px)![0]!, 3);
          expect(value[1]).toBeCloseTo(vertices.get(px)![1]!, 3);
          matched++;
        }
      }
    }
    expect(matched).toBeGreaterThan(2);
    scene.dispose(); engine.dispose();
  });
  it('launches missiles from dry terrain and continues the finale inside the gorge', () => {
    const engine = new NullEngine(), scene = new Scene(engine), combat = new CombatEffects(scene);
    for (const count of [0, 6, 12]) {
      const run = new Run(7, 'river-canyon');
      run.encounter = planEncounter(count, 7, initialPose(), canyonSurface);
      run.encounter.visibleAt = run.encounter.canyon!.acquireAt;
      run.encounter.time = 2.2;
      run.status = 'over';
      const pose = run.pose, future = poseAt(run.encounter, 2.2 + MISSILE_INTERCEPT_TIME, count);
      const missile = new MissileFlight('damage', pose, future.position, 1, canyonSurface);
      expect(canyonSurface.wet(missile.launch.x, missile.launch.z)).toBe(false);
      for (let t = 0; t < MISSILE_INTERCEPT_TIME; t += STEP) {
        const p = missile.positionAt(t);
        expect(p.y - canyonSurface.height(p.x, p.z)).toBeGreaterThan(2);
      }
      const flyby = new MissileFlight('flyby', pose, future.position, -1, canyonSurface);
      for (let t = 0; t <= 2.8; t += STEP) {
        const p = flyby.positionAt(t);
        expect(p.y - canyonSurface.height(p.x, p.z)).toBeGreaterThan(2);
        expect(p.y).toBeLessThan(2000);
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
      encounter.visibleAt = encounter.canyon!.acquireAt;
      sides.add(encounter.canyon!.side);
      for (let dz = -32; dz <= 32; dz += 4) for (let dx = -32; dx <= 32; dx += 4) {
        if (Math.hypot(dx, dz) <= 32) expect(canyonSurface.height(encounter.target.x + dx, encounter.target.z + dz)).toBe(FLOOR);
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
      previous = poseAt(encounter, encounter.canyon!.endAt, count);
    }
    expect(sides.size).toBe(2);
  }, 30_000);
  it('keeps measured release windows close to the original challenge at every tier', () => {
    const widths: number[][] = [];
    for (let count = 0; count <= 12; count++) {
      let canyon = 0, valley = 0;
      for (let seed = 0; seed < 8; seed++) {
        for (const surface of [valleySurface, canyonSurface]) {
          const z = seed * 9000;
          const encounter = planEncounter(count, seed, initialPose({ x: surface.canyon ? surface.center(z) : 0, y: 167, z }), surface);
          encounter.visibleAt = encounter.canyon?.acquireAt ?? -6;
          let hits = 0, intervals = 0, wasHit = false, nearCenter = 0;
          let first = Infinity, last = -Infinity, firstNear = Infinity, lastNear = -Infinity;
          const scoreAt = (t: number) => contactAccuracy(predictImpact(launchFrom(poseAt(encounter, t, count)), surface),
            encounter.target, surface);
          for (let i = -120; i <= 120; i++) {
            const points = scoreAt(i * STEP);
            if (points) {
              hits++; if (!wasHit) intervals++;
              first = Math.min(first, i * STEP); last = i * STEP;
            }
            if (points >= 95) { nearCenter++; firstNear = Math.min(firstNear, i * STEP); lastNear = i * STEP; }
            wasHit = points > 0;
          }
          expect(intervals).toBe(1);
          expect(nearCenter).toBeGreaterThan(0);
          if (surface.canyon) {
            const boundary = (inside: number, outside: number, minimum: number) => {
              for (let i = 0; i < 10; i++) {
                const midpoint = (inside + outside) / 2;
                if (scoreAt(midpoint) >= minimum) inside = midpoint; else outside = midpoint;
              }
              return inside;
            };
            expect(boundary(last, last + STEP, 1) - boundary(first, first - STEP, 1)).toBeGreaterThan(0.08);
            expect(boundary(lastNear, lastNear + STEP, 95) - boundary(firstNear, firstNear - STEP, 95)).toBeGreaterThan(0.005);
          }
          if (surface.canyon) { canyon += hits; expect(hits * STEP).toBeGreaterThanOrEqual(0.08); }
          else valley += hits;
        }
      }
      widths.push([count + 1, canyon * STEP / 8, valley * STEP / 8]);
      expect(canyon, `tier ${count + 1}`).toBeLessThan(valley * 1.1);
      if (count === 0 || count === 12) {
        const baseline = count === 0 ? 0.674 : 0.141;
        expect(canyon * STEP / 8).toBeLessThan(baseline * 1.15);
      }
    }
    console.info('Release windows (pass, canyon seconds, valley seconds)', widths);
  }, 30_000);
});
