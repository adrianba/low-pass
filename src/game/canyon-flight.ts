import { ATTACK_HEIGHT, CRUISE_HEIGHT, FLOOR, GRAVITY, DIFFICULTY_STEPS, STEP, difficulty } from '../config/game';
import { joinMotion } from '../simulation/curves';
import type { Motion } from '../simulation/curves';
import { clamp, hash } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import { CANYON, shelfSide } from '../terrain/river-canyon';
import { canyonSurface, Surface } from '../terrain/surface';
import { predictImpact } from '../simulation/ballistics';
import { launchFrom } from './run';
import type { Encounter, Pose } from './run';
import { selectTargetKind } from './targets';
import { chaseView, targetInChaseView } from '../simulation/chase-camera';
import type { ChaseView } from '../simulation/chase-camera';

export interface CanyonFlight { startTime: number; offset: number; side: number }
const shelfPlane = new Surface(false, () => FLOOR);
export const canyonWarning = (count: number): number => difficulty(count).diveDuration + 0.85;
export const canyonSightDistance = (count: number): number => Math.hypot(
  difficulty(count).speed * (Math.sqrt(2 * (ATTACK_HEIGHT - 2.2) / GRAVITY) + canyonWarning(count)) + 110,
  CRUISE_HEIGHT + 16, 160,
);
export const canyonJink = (count: number) => {
  const level = clamp(count, 0, DIFFICULTY_STEPS) / DIFFICULTY_STEPS;
  return { amplitude: 17 + 7 * level, frequency: 0.95 + 1.2 * level };
};

export function canyonPose(encounter: Encounter, time: number, count: number): Pose {
  const flight = encounter.canyon;
  if (!flight) throw new Error('Missing canyon flight plan.');
  const d = difficulty(count), j = canyonJink(count), course = canyonSurface;
  const nominal = (t: number): Record<keyof Vec3, Motion> => {
    const z = encounter.origin + d.speed * t;
    const center = (s: number): Motion => {
      const p = encounter.origin + d.speed * s;
      return { position: course.center(p), velocity: course.slope(p) * d.speed,
        acceleration: course.curvature(p) * d.speed ** 2 };
    };
    const attack = (s: number): Motion => {
      const c = center(s), phase = s * j.frequency + encounter.phase;
      return { position: c.position + flight.offset + flight.side * j.amplitude * Math.sin(phase),
        velocity: c.velocity + flight.side * j.amplitude * j.frequency * Math.cos(phase),
        acceleration: c.acceleration - flight.side * j.amplitude * j.frequency ** 2 * Math.sin(phase) };
    };
    const x = t < -5 ? center(t) : t < -2 ? joinMotion(center(-5), attack(-2), 3, t + 5)
      : t < 2.2 ? attack(t) : t < 5.2 ? joinMotion(attack(2.2), center(5.2), 3, t - 2.2) : center(t);
    return { x, y: { position: FLOOR + CRUISE_HEIGHT, velocity: 0, acceleration: 0 },
      z: { position: z, velocity: d.speed, acceleration: 0 } };
  };
  const approach = (t: number) => {
    if (t >= flight.startTime + 3) return nominal(t);
    const motion = nominal(flight.startTime + 3);
    for (const axis of ['x', 'y', 'z'] as const) motion[axis] = joinMotion({
      position: encounter.start.position[axis], velocity: encounter.start.velocity[axis],
      acceleration: encounter.start.acceleration[axis],
    }, motion[axis], 3, t - flight.startTime);
    return motion;
  };
  const motion = approach(time);
  if (encounter.visibleAt !== null && time >= encounter.visibleAt) {
    const low = { position: FLOOR + ATTACK_HEIGHT, velocity: 0, acceleration: 0 };
    motion.y = time < 2.2 ? joinMotion(approach(encounter.visibleAt).y, low, d.diveDuration, time - encounter.visibleAt)
      : joinMotion(low, { position: FLOOR + CRUISE_HEIGHT, velocity: 0, acceleration: 0 }, 3, time - 2.2);
  }
  const position = { x: motion.x.position, y: motion.y.position, z: motion.z.position };
  const velocity = { x: motion.x.velocity, y: motion.y.velocity, z: motion.z.velocity };
  const acceleration = { x: motion.x.acceleration, y: motion.y.acceleration, z: motion.z.acceleration };
  return { position, velocity, acceleration, bank: clamp(-acceleration.x / 32, -0.65, 0.65),
    pitch: -Math.atan2(velocity.y, velocity.z) };
}

export function planCanyon(count: number, seed: number, previous: Pose): Encounter {
  const d = difficulty(count);
  const fall = Math.sqrt(2 * (ATTACK_HEIGHT - 2.2) / GRAVITY);
  const index = Math.ceil((previous.position.z + d.speed * (8 + fall) - CANYON.shelfOrigin) / CANYON.shelfSpacing);
  for (let candidate = index; candidate < index + 4; candidate++) {
    const encounter = canyonCandidate(count, seed, previous, candidate);
    const checkpoint = -d.diveDuration - 0.8;
    let view: ChaseView | null = null;
    for (let step = 0; step <= 30; step++) {
      view = chaseView(canyonPose(encounter, checkpoint - 3 + step / 10, count), canyonSurface, view?.position ?? null, 0.1);
    }
    if (view && targetInChaseView(encounter.target, view, canyonSurface, 0.75, canyonSightDistance(count))) return encounter;
  }
  throw new Error('Could not construct a visible, fair River Canyon approach.');
}

function canyonCandidate(count: number, seed: number, previous: Pose, index: number): Encounter {
  const d = difficulty(count);
  const fall = Math.sqrt(2 * (ATTACK_HEIGHT - 2.2) / GRAVITY);
  const targetZ = CANYON.shelfOrigin + index * CANYON.shelfSpacing;
  const origin = targetZ - d.speed * fall;
  const startTime = (previous.position.z - origin - (d.speed - previous.velocity.z) * 1.5) / d.speed;
  const encounter: Encounter = {
    id: count + 1, targetKind: selectTargetKind(count, seed), surface: canyonSurface,
    time: startTime, origin, phase: -0.65 - hash(count, 491, seed) * 0.15,
    start: structuredClone(previous), visibleAt: null,
    target: { x: 0, y: FLOOR, z: targetZ }, released: false, resolvedAt: null,
    canyon: { startTime, offset: 0, side: shelfSide(index) },
  };
  const flight = encounter.canyon!;
  // Solve against the dry shelf plane first, then verify actual first canyon contact.
  for (let n = 0; n < 8; n++) {
    const planned = { ...encounter, visibleAt: -canyonWarning(count) };
    const impact = predictImpact(launchFrom(canyonPose(planned, 0, count)), shelfPlane);
    const error = canyonSurface.center(impact.z) + flight.side * CANYON.bankTarget - impact.x;
    flight.offset += error;
    if (Math.abs(error) < 0.00001) break;
  }
  const planned = { ...encounter, visibleAt: -canyonWarning(count) };
  const impact = predictImpact(launchFrom(canyonPose(planned, 0, count)), canyonSurface);
  encounter.target = { x: impact.x, y: FLOOR, z: impact.z };
  if (impact.kind !== 'ground' || Math.abs(impact.y - FLOOR) > 0.001
    || Math.abs(impact.z - targetZ) > 40
    || Math.abs(impact.x - canyonSurface.center(impact.z) - flight.side * CANYON.bankTarget) > 0.01) {
    throw new Error(`Could not plan a dry River Canyon target on pass ${count + 1}: ${JSON.stringify(impact)}; shelf ${targetZ}, offset ${flight.offset}.`);
  }
  let last = canyonPose(planned, startTime, count);
  for (let t = startTime; t <= 8.9; t = Math.min(t + STEP * 12, 9)) {
    const pose = canyonPose(planned, t, count);
    for (const dx of [-14, 0, 14]) for (const dz of [-10, 0, 10]) {
      const a = { x: last.position.x + dx, y: last.position.y - 12, z: last.position.z + dz };
      const b = { x: pose.position.x + dx, y: pose.position.y - 12, z: pose.position.z + dz };
      if (canyonSurface.ground(a, b)) {
        throw new Error('River Canyon flight clearance could not be established.');
      }
    }
    last = pose;
  }
  return encounter;
}
