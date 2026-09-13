import { describe, expect, it } from 'vitest';
import { advanceRoute, projectRoute, routeBounds, routeDistance, routeMotion, routePoint } from '../../src/terrain/canyon-route';
import { canyonSurface } from '../../src/terrain/surface';
import { initialPose, planEncounter, poseAt } from '../../src/game/run';
import { joinRespectsSpeed, speedOf } from '../../src/simulation/flight-track';
import { distance } from '../../src/simulation/math';
import { difficulty } from '../../src/config/game';
import { chaseView } from '../../src/simulation/chase-camera';

describe('pronounced canyon bends', () => {
  it('bounds hidden speed peaks and does not expose mutable track anchors', () => {
    const a = initialPose(), b = initialPose({ x: 0, y: 167, z: 100 });
    a.velocity.z = b.velocity.z = 0;
    expect(joinRespectsSpeed(a, b, 1, 187)).toBe(false);
    expect(joinRespectsSpeed(a, b, 1, 188)).toBe(true);
    const encounter = planEncounter(0, 7, initialPose(), canyonSurface);
    const before = poseAt(encounter, 0, 0);
    const copy = structuredClone(before);
    before.position.x += 100;
    before.velocity.z = 0;
    expect(poseAt(encounter, 0, 0)).toEqual(copy);
  });
  it('has smooth substantial sweeps and opposite turns without folding the banks', () => {
    let headingMin = Infinity, headingMax = -Infinity, curvature = 0, extent = 0;
    for (let z = -9600; z <= 96000; z += 16) {
      const frame = routeMotion(z), h = 0.1;
      expect((routeMotion(z + h).x - routeMotion(z - h).x) / (2 * h)).toBeCloseTo(frame.slope, 6);
      expect((routeMotion(z + h).slope - routeMotion(z - h).slope) / (2 * h)).toBeCloseTo(frame.second, 7);
      headingMin = Math.min(headingMin, Math.atan(frame.slope));
      headingMax = Math.max(headingMax, Math.atan(frame.slope));
      curvature = Math.max(curvature, Math.abs(frame.curvature));
      extent = Math.max(extent, Math.abs(frame.x));
      for (const lateral of [-160, -84, -24, 0, 24, 84, 160]) {
        const p = routePoint(z, lateral), projected = projectRoute(p.x, p.z);
        expect(projected.along).toBeCloseTo(z, 5);
        expect(projected.lateral).toBeCloseTo(lateral, 5);
      }
    }
    expect(headingMin).toBeLessThan(-Math.PI / 7);
    expect(headingMax).toBeGreaterThan(Math.PI / 7);
    expect(curvature * 160).toBeLessThan(0.3);
    expect(extent).toBeLessThan(1300);
    console.info('Canyon route bounds', { headingDegrees: [headingMin * 180 / Math.PI, headingMax * 180 / Math.PI],
      minimumRadius: 1 / curvature, lateralExtent: extent });
  }, 15_000);
  it('inverts local arc distances and covers interior bends at distant chunk boundaries', () => {
    for (const z of [-9600, -100, 0, 1600, 1800, 3000, 3200, 4800, 5000, 6200, 6400, 1000000]) {
      for (const length of [-900, -40, 95, 300, 1800]) {
        const end = advanceRoute(z, length);
        expect(routeDistance(z, end)).toBeCloseTo(length, 5);
      }
      const bounds = routeBounds(z, z + 256, 300);
      for (let u = z; u <= z + 256; u += 3) {
        expect(routeMotion(u).x - 300).toBeGreaterThanOrEqual(bounds[0]);
        expect(routeMotion(u).x + 300).toBeLessThanOrEqual(bounds[1]);
      }
    }
  });
  it('caps the actual interpolated 3D motion, slows for transit bends, and preserves derivatives', () => {
    let previous = initialPose(), slowdowns = 0, turns = 0, maxDuration = 0;
    const report = [];
    for (let count = 0; count < 26; count++) {
      const before = performance.now(), encounter = planEncounter(count, 7, previous, canyonSurface);
      maxDuration = Math.max(maxDuration, performance.now() - before);
      const flight = encounter.canyon!, limit = difficulty(count).speed;
      let minimum = limit, maximum = 0, minHeading = Infinity, maxHeading = -Infinity, camera = null;
      for (let t = flight.startTime; t < flight.endAt + 1.8; t += 0.05) {
        const p = poseAt(encounter, t, count), speed = speedOf(p);
        expect(speed, `pass ${count + 1} at ${t}`).toBeLessThanOrEqual(limit + 0.001);
        minimum = Math.min(minimum, speed); maximum = Math.max(maximum, speed);
        const heading = Math.atan2(p.velocity.x, p.velocity.z);
        minHeading = Math.min(minHeading, heading); maxHeading = Math.max(maxHeading, heading);
        if (t > flight.startTime + 0.01) {
          const h = 0.0001, a = poseAt(encounter, t - h, count), b = poseAt(encounter, t + h, count);
          expect(distance(p.velocity, { x: (b.position.x - a.position.x) / (2 * h),
            y: (b.position.y - a.position.y) / (2 * h), z: (b.position.z - a.position.z) / (2 * h) })).toBeLessThan(0.001);
          expect(distance(p.acceleration, { x: (b.velocity.x - a.velocity.x) / (2 * h),
            y: (b.velocity.y - a.velocity.y) / (2 * h), z: (b.velocity.z - a.velocity.z) / (2 * h) })).toBeLessThan(0.02);
        }
        camera = chaseView(p, canyonSurface, camera?.position ?? null, 0.05);
        expect(camera.position.y - canyonSurface.height(camera.position.x, camera.position.z)).toBeGreaterThan(20);
      }
      expect(speedOf(poseAt(encounter, 0, count))).toBeGreaterThan(limit * 0.85);
      expect(flight.endAt - flight.startTime).toBeLessThan(35);
      if (count >= 12 && minimum < limit * 0.8 && maximum > limit * 0.95) slowdowns++;
      if (maxHeading - minHeading > Math.PI / 5) turns++;
      report.push([count + 1, minimum, maximum, -flight.acquireAt, flight.endAt - flight.startTime]);
      previous = poseAt(encounter, flight.endAt, count);
    }
    expect(slowdowns).toBeGreaterThan(3);
    expect(turns).toBeGreaterThan(10);
    console.info('Canyon flight (pass,min/max 3D speed,warning,duration)', report, 'max planner milliseconds', maxDuration);
  }, 60_000);
});
