import { describe, expect, it } from 'vitest';
import { accuracy, advanceBomb, predictImpact } from '../../src/simulation/ballistics';
import { Run, launchFrom, planEncounter, poseAt, initialPose, interpolatePose, APPROACH_DURATION } from '../../src/game/run';
import { FLOOR, STEP, TARGET_RADIUS, MAX_SPEED, DIFFICULTY_STEPS, difficulty, targetSightDistance } from '../../src/config/game';
import { terrainHeight, terrainImpact, vertexHeight, valleyCenter } from '../../src/terrain/heightfield';
import { ReleaseKey } from '../../src/input/keyboard';
import { joinMotion } from '../../src/simulation/curves';

describe('accuracy', () => {
  const center = { x: 0, y: FLOOR, z: 0 };
  it('scores the center, intermediate distances, and outer edge', () => {
    expect(accuracy(center, center)).toBe(100);
    expect(accuracy({ ...center, x: TARGET_RADIUS / 2 }, center)).toBe(51);
    expect(accuracy({ ...center, x: TARGET_RADIUS }, center)).toBe(1);
    expect(accuracy({ ...center, x: TARGET_RADIUS + 0.001 }, center)).toBe(0);
  });
});

describe('terrain and ballistics', () => {
  it('uses the canonical surface at grid vertices and through valleys', () => {
    for (let x = -800; x < 800; x += 16) {
      expect(terrainHeight(x, 640)).toBe(vertexHeight(x, 640));
    }
    expect(terrainHeight(valleyCenter(98765), 98765)).toBe(FLOOR);
  });
  it('finds the first terrain contact on a long swept segment', () => {
    const hit = terrainImpact({ x: -600, y: 500, z: 300 }, { x: 600, y: -30, z: 1300 });
    expect(hit).not.toBeNull();
    expect(hit!.y).toBeCloseTo(terrainHeight(hit!.x, hit!.z), 8);
  });
  it('prediction and actual stepped flight use identical collision', () => {
    for (let seed = 0; seed < 20; seed++) {
      const encounter = { ...planEncounter(seed, seed, initialPose({ x: 0, y: 167, z: seed * 1500 })), visibleAt: -6 };
      const bomb = launchFrom(poseAt(encounter, 0.17, seed));
      const predicted = predictImpact(bomb);
      let actual = null;
      for (let i = 0; i < 2400 && !actual; i++) actual = advanceBomb(bomb);
      expect(actual).toEqual(predicted);
    }
  });
});

describe('fairness', () => {
  it('caps difficulty and preserves real center and hit windows across seeds and levels', () => {
    expect(MAX_SPEED).toBe(350);
    expect(difficulty(100)).toEqual(difficulty(DIFFICULTY_STEPS));
    expect(difficulty(DIFFICULTY_STEPS).speed).toBe(MAX_SPEED);
    expect(difficulty(4).speed).toBeGreaterThan(142);
    for (let count = 0; count <= DIFFICULTY_STEPS; count++) {
      for (let seed = 0; seed < 24; seed++) {
        const d = difficulty(count);
        const encounter = { ...planEncounter(count, seed, initialPose({ x: 0, y: 167, z: count * 7000 })),
          visibleAt: -d.diveDuration - 0.5 };
        const hit = (t: number) => accuracy(predictImpact(launchFrom(poseAt(encounter, t, count))), encounter.target);
        expect(hit(0)).toBe(100);
        expect(hit(-0.003)).toBeGreaterThanOrEqual(95);
        expect(hit(0.003)).toBeGreaterThanOrEqual(95);
        expect(hit(-0.06)).toBeGreaterThan(0);
        expect(hit(0.06)).toBeGreaterThan(0);
        const pose = poseAt(encounter, encounter.visibleAt, count);
        const range = Math.hypot(encounter.target.x - pose.position.x,
          encounter.target.y - pose.position.y - 16, encounter.target.z - pose.position.z + 40);
        expect(range).toBeLessThan(targetSightDistance(count));
      }
    }
  });
  it('narrows the actual successful-release window as speed increases', () => {
    const countWindow = (count: number) => {
      const encounter = { ...planEncounter(count, 7, initialPose()), visibleAt: -6 };
      let hits = 0;
      for (let step = -60; step <= 60; step++) {
        if (accuracy(predictImpact(launchFrom(poseAt(encounter, step * STEP, count))), encounter.target)) hits++;
      }
      return hits;
    };
    expect(countWindow(DIFFICULTY_STEPS)).toBeLessThan(countWindow(0) / 2);
  });
});

describe('continuous flight transitions', () => {
  it('joins motion with matching velocity and acceleration at both endpoints', () => {
    const start = { position: 20, velocity: -5, acceleration: 2 };
    const end = { position: 80, velocity: 13, acceleration: -4 };
    expect(joinMotion(start, end, 3, 0)).toEqual(start);
    expect(joinMotion(start, end, 3, 3)).toEqual(end);
    const before = joinMotion(start, end, 3, 1.4999);
    const middle = joinMotion(start, end, 3, 1.5);
    const after = joinMotion(start, end, 3, 1.5001);
    expect((after.position - before.position) / 0.0002).toBeCloseTo(middle.velocity, 5);
    expect((after.velocity - before.velocity) / 0.0002).toBeCloseTo(middle.acceleration, 5);
  });
  it('carries attitude, velocity and acceleration into every new encounter without speed overshoot', () => {
    for (let seed = 0; seed < 16; seed++) {
      let previous = initialPose();
      for (let count = 0; count <= DIFFICULTY_STEPS + 1; count++) {
        const encounter = planEncounter(count, seed, previous);
        const start = poseAt(encounter, -8, count);
        expect(start.position).toEqual(previous.position);
        expect(start.velocity).toEqual(previous.velocity);
        expect(start.acceleration).toEqual(previous.acceleration);
        expect(start.bank).toBeCloseTo(previous.bank, 12);
        expect(start.pitch).toBeCloseTo(previous.pitch, 12);
        for (let t = 0; t <= APPROACH_DURATION; t += 0.05) {
          const speed = poseAt(encounter, -8 + t, count).velocity.z;
          expect(speed).toBeGreaterThanOrEqual(previous.velocity.z - 1e-7);
          expect(speed).toBeLessThanOrEqual(difficulty(count).speed + 1e-7);
          expect(speed).toBeLessThanOrEqual(MAX_SPEED + 1e-7);
        }
        const left = poseAt(encounter, -8 + APPROACH_DURATION - 1e-6, count);
        const right = poseAt(encounter, -8 + APPROACH_DURATION + 1e-6, count);
        expect(Math.abs(left.bank - right.bank)).toBeLessThan(0.0001);
        expect(Math.abs(left.velocity.x - right.velocity.x)).toBeLessThan(0.001);
        encounter.visibleAt = -6;
        previous = poseAt(encounter, 7, count);
      }
    }
  });
  it('starts a dive from then-current motion, including during the approach blend', () => {
    for (const count of [0, 4, 8, DIFFICULTY_STEPS]) {
      const previousEncounter = { ...planEncounter(count, 15, initialPose()), visibleAt: -6 };
      const previous = poseAt(previousEncounter, 4.5, count);
      for (const time of [-7.8, -6, -4, -difficulty(count).diveDuration - 0.5]) {
        const encounter = planEncounter(count, 91, previous);
        const before = poseAt(encounter, time, count);
        encounter.visibleAt = time;
        const after = poseAt(encounter, time, count);
        expect(after).toEqual(before);
      }
    }
  });
  it('interpolates heading and attitude along with position between simulation steps', () => {
    const encounter = { ...planEncounter(5, 11, initialPose()), visibleAt: -6 };
    const before = poseAt(encounter, -5.7, 5);
    const after = poseAt(encounter, -5.7 + STEP, 5);
    const middle = interpolatePose(before, after, 0.5);
    expect(middle.bank).toBeCloseTo((before.bank + after.bank) / 2);
    expect(middle.pitch).toBeCloseTo((before.pitch + after.pitch) / 2);
    expect(middle.velocity.x).toBeCloseTo((before.velocity.x + after.velocity.x) / 2);
  });
});

function advance(run: Run, until: () => boolean) {
  for (let n = 0; n < 10000 && !until(); n++) {
    if (run.encounter.visibleAt === null && run.encounter.time >= -6) run.seeTarget();
    run.tick(true);
  }
  expect(until()).toBe(true);
}

describe('run lifecycle', () => {
  it('counts three cumulative misses, without double-counting timeouts', () => {
    const run = new Run(8);
    advance(run, () => run.resolved === 1);
    expect(run.misses).toBe(1);
    advance(run, () => run.encounter.id === 2 && run.encounter.time >= 0);
    expect(run.release()).toBe(true);
    expect(run.release()).toBe(false);
    advance(run, () => run.resolved === 2);
    expect(run.score).toBeGreaterThanOrEqual(95);
    expect(run.misses).toBe(1);
    advance(run, () => run.status === 'over');
    expect(run.resolved).toBe(4);
    expect(run.misses).toBe(3);
    const score = run.score;
    for (let i = 0; i < 1000; i++) run.tick(true);
    expect(run.score).toBe(score);
    expect(run.misses).toBe(3);
    expect(run.release()).toBe(false);
  });
  it('pauses simulation and tags any assistance used', () => {
    const run = new Run();
    run.status = 'paused';
    run.tick(true);
    expect(run.encounter.time).toBe(-8);
    expect(run.assisted).toBe(false);
    run.status = 'running';
    run.tick(true);
    expect(run.encounter.time).toBe(-8 + STEP);
    expect(run.assisted).toBe(true);
    run.tick(false);
    expect(run.assisted).toBe(true);
  });
  it('ignores input before visibility and rejects unfair late visibility', () => {
    const run = new Run();
    expect(run.release()).toBe(false);
    run.encounter.time = -1;
    expect(() => run.seeTarget()).toThrow(/early enough/);
  });
  it('does not repeat releases while Space is held', () => {
    const key = new ReleaseKey();
    expect(key.down(false)).toBe(true);
    expect(key.down(true)).toBe(false);
    expect(key.down(false)).toBe(false);
    key.up();
    expect(key.down(false)).toBe(true);
  });
});
