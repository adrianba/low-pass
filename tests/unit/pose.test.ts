import { describe, expect, it } from 'vitest';
import { aircraftPoint, initialPose, interpolatePose, launchFrom } from '../../src/simulation/pose';
import * as compatibility from '../../src/game/run';
import { CRUISE_HEIGHT, FLOOR, difficulty } from '../../src/config/game';

describe('shared aircraft pose primitives', () => {
  it('retains the solo compatibility exports without another implementation', () => {
    expect(compatibility.aircraftPoint).toBe(aircraftPoint);
    expect(compatibility.initialPose).toBe(initialPose);
    expect(compatibility.interpolatePose).toBe(interpolatePose);
    expect(compatibility.launchFrom).toBe(launchFrom);
    expect(initialPose()).toEqual({
      position: { x: 0, y: FLOOR + CRUISE_HEIGHT, z: 0 },
      velocity: { x: 0, y: 0, z: difficulty(0).speed },
      acceleration: { x: 0, y: 0, z: 0 }, bank: 0, pitch: 0,
    });
  });

  it('applies bank, pitch and yaw in the existing launch order', () => {
    const pose = initialPose({ x: 10, y: 20, z: 30 });
    pose.bank = Math.PI / 2;
    pose.velocity = { x: 10, y: 0, z: 0 };
    const point = aircraftPoint(pose, { x: 2, y: 3, z: 4 });
    expect(point.x).toBeCloseTo(14, 12);
    expect(point.y).toBeCloseTo(22, 12);
    expect(point.z).toBeCloseTo(33, 12);
    const launch = launchFrom(pose);
    expect(launch.position.x).toBeCloseTo(10, 12);
    expect(launch.position.y).toBeCloseTo(20, 12);
    expect(launch.position.z).toBeCloseTo(27.8, 12);
    pose.bank = 0;
    pose.pitch = Math.PI / 2;
    pose.velocity = { x: 0, y: 0, z: 10 };
    const pitched = aircraftPoint(pose, { x: 2, y: 3, z: 4 });
    expect(pitched.x).toBeCloseTo(12, 12);
    expect(pitched.y).toBeCloseTo(16, 12);
    expect(pitched.z).toBeCloseTo(33, 12);
  });

  it('interpolates full motion and keeps all input and launch vectors independent', () => {
    const origin = { x: 1, y: 2, z: 3 };
    const a = initialPose(origin);
    origin.x = 100;
    expect(a.position.x).toBe(1);
    const b = {
      position: { x: 5, y: 6, z: 7 }, velocity: { x: 4, y: 8, z: 12 },
      acceleration: { x: 4, y: 8, z: 12 }, bank: 0.4, pitch: -0.8,
    };
    const blended = interpolatePose(a, b, 0.25);
    expect(blended.position).toEqual({ x: 2, y: 3, z: 4 });
    expect(blended.velocity).toEqual({ x: 1, y: 2, z: a.velocity.z * 0.75 + 3 });
    expect(blended.acceleration).toEqual({ x: 1, y: 2, z: 3 });
    expect(blended.bank).toBe(0.1);
    expect(blended.pitch).toBe(-0.2);
    const launch = launchFrom(a);
    launch.position.x = launch.velocity.z = -999;
    blended.position.x = blended.velocity.z = -999;
    expect(a.position.x).toBe(1);
    expect(a.velocity.z).toBe(difficulty(0).speed);
    expect(interpolatePose(a, b, 0)).toEqual(a);
    expect(interpolatePose(a, b, 1)).toEqual(b);
  });
});
