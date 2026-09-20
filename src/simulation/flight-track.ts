import { joinMotion } from './curves';
import { clamp, distance } from './math';
import type { Vec3 } from './math';
import type { Pose } from './pose';

interface Knot { phase: number; time: number; pose: Pose }
export const TRACK_SPEED_FRACTION = 0.985;
export const speedOf = (pose: Pose): number => Math.hypot(pose.velocity.x, pose.velocity.y, pose.velocity.z);

export function motionPose(position: Vec3, velocity: Vec3, acceleration: Vec3): Pose {
  const horizontal = Math.hypot(velocity.x, velocity.z);
  const lateral = horizontal > 0 ? (velocity.z * acceleration.x - velocity.x * acceleration.z) / horizontal : 0;
  return { position, velocity, acceleration, bank: clamp(-lateral / 32, -0.65, 0.65),
    pitch: -Math.atan2(velocity.y, horizontal) };
}

export function joinPose(a: Pose, b: Pose, duration: number, elapsed: number): Pose {
  if (elapsed <= 0) return structuredClone(a);
  if (elapsed >= duration) return structuredClone(b);
  const position = { x: 0, y: 0, z: 0 }, velocity = { ...position }, acceleration = { ...position };
  for (const axis of ['x', 'y', 'z'] as const) {
    const motion = joinMotion({ position: a.position[axis], velocity: a.velocity[axis], acceleration: a.acceleration[axis] },
      { position: b.position[axis], velocity: b.velocity[axis], acceleration: b.acceleration[axis] }, duration, elapsed);
    position[axis] = motion.position; velocity[axis] = motion.velocity; acceleration[axis] = motion.acceleration;
  }
  return motionPose(position, velocity, acceleration);
}

// The derivative's Bezier control hull bounds speed between samples, including
// an encounter join. Subdivision tightens the bound without missing a peak.
export function joinRespectsSpeed(a: Pose, b: Pose, duration: number, limit: number): boolean {
  const controls = Array.from({ length: 5 }, () => ({ x: 0, y: 0, z: 0 }));
  for (const axis of ['x', 'y', 'z'] as const) {
    controls[0]![axis] = a.velocity[axis];
    controls[1]![axis] = a.velocity[axis] + a.acceleration[axis] * duration / 4;
    controls[2]![axis] = 5 * (b.position[axis] - a.position[axis]) / duration
      - 2 * (a.velocity[axis] + b.velocity[axis]) + (b.acceleration[axis] - a.acceleration[axis]) * duration / 4;
    controls[3]![axis] = b.velocity[axis] - b.acceleration[axis] * duration / 4;
    controls[4]![axis] = b.velocity[axis];
  }
  const bounded = (points: Vec3[], depth: number): boolean => {
    if (points.every(p => Math.hypot(p.x, p.y, p.z) <= limit + 1e-7)) return true;
    if (depth === 8) return false;
    const left = [points[0]!], right = [points[points.length - 1]!];
    let row = points;
    while (row.length > 1) {
      row = row.slice(1).map((p, i) => ({ x: (p.x + row[i]!.x) / 2, y: (p.y + row[i]!.y) / 2, z: (p.z + row[i]!.z) / 2 }));
      left.push(row[0]!); right.unshift(row[row.length - 1]!);
    }
    return bounded(left, depth + 1) && bounded(right, depth + 1);
  };
  return bounded(controls, 0);
}

export function pathPose(path: (phase: number) => Vec3, phase: number, speed: number, tangential = 0): Pose {
  const h = 0.002, a = path(phase - h), p = path(phase), b = path(phase + h);
  const derivative = { x: (b.x - a.x) / (2 * h), y: (b.y - a.y) / (2 * h), z: (b.z - a.z) / (2 * h) };
  const second = { x: (b.x + a.x - 2 * p.x) / h ** 2, y: (b.y + a.y - 2 * p.y) / h ** 2, z: (b.z + a.z - 2 * p.z) / h ** 2 };
  const norm = Math.hypot(derivative.x, derivative.y, derivative.z);
  const dot = derivative.x * second.x + derivative.y * second.y + derivative.z * second.z;
  const velocity = { x: 0, y: 0, z: 0 }, acceleration = { ...velocity };
  for (const axis of ['x', 'y', 'z'] as const) {
    velocity[axis] = derivative[axis] / norm * speed;
    acceleration[axis] = (second[axis] / norm ** 2 - derivative[axis] * dot / norm ** 4) * speed * speed
      + derivative[axis] / norm * tangential;
  }
  return motionPose(p, velocity, acceleration);
}

export class FlightTrack {
  readonly knots: readonly Knot[];
  constructor(path: (phase: number) => Vec3, limit: (phase: number) => number, start: number, end: number) {
    const phases = [start];
    for (let i = Math.ceil(start * 10); i <= Math.floor(end * 10); i++) {
      if (i / 10 > start) phases.push(i / 10);
    }
    const points = phases.map(path), lengths = [0];
    for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + distance(points[i - 1]!, points[i]!));
    const limits = phases.map(u => limit(u) * TRACK_SPEED_FRACTION);
    for (let i = 1; i < limits.length; i++) limits[i] = Math.min(limits[i]!,
      Math.sqrt(limits[i - 1]! ** 2 + 80 * (lengths[i]! - lengths[i - 1]!)));
    for (let i = limits.length - 2; i >= 0; i--) limits[i] = Math.min(limits[i]!,
      Math.sqrt(limits[i + 1]! ** 2 + 80 * (lengths[i + 1]! - lengths[i]!)));
    const safe = limits.map((_, i) => Math.min(...limits.slice(Math.max(0, i - 4), i + 5)));
    const speeds = safe.map((_, i) => [1, 4, 6, 4, 1].reduce((sum, weight, j) =>
      sum + weight * safe[clamp(i + j - 2, 0, safe.length - 1)]!, 0) / 16);
    const knots: Knot[] = [];
    for (let i = 0; i < phases.length; i++) {
      const u = phases[i]!, v = speeds[i]!;
      const lo = Math.max(0, i - 1), hi = Math.min(phases.length - 1, i + 1);
      const tangential = (speeds[hi]! ** 2 - speeds[lo]! ** 2) / (2 * (lengths[hi]! - lengths[lo]!));
      knots.push({ phase: u, time: i ? knots[i - 1]!.time + 2 * (lengths[i]! - lengths[i - 1]!) / (v + speeds[i - 1]!) : 0,
        pose: pathPose(path, u, v, tangential) });
    }
    const zero = knots.find(k => k.phase === 0);
    if (!zero) throw new Error('Flight track is missing its release anchor.');
    const origin = zero.time;
    for (const knot of knots) knot.time -= origin;
    this.knots = knots;
  }
  get startTime(): number { return this.knots[0]!.time; }
  respectsSpeed(limit: number): boolean {
    return this.knots.slice(1).every((b, i) => {
      const a = this.knots[i]!;
      return joinRespectsSpeed(a.pose, b.pose, b.time - a.time, limit);
    });
  }
  timeAt(phase: number): number {
    const i = this.knots.findIndex(k => k.phase >= phase);
    if (i < 0) throw new Error('Flight phase exceeds planned coverage.');
    if (i === 0) return this.startTime;
    const a = this.knots[i - 1]!, b = this.knots[i]!;
    return a.time + (b.time - a.time) * (phase - a.phase) / (b.phase - a.phase);
  }
  at(time: number): Pose {
    if (time <= this.startTime) return structuredClone(this.knots[0]!.pose);
    const last = this.knots[this.knots.length - 1]!;
    if (time > last.time) throw new Error('Flight time exceeds planned coverage.');
    let lo = 0, hi = this.knots.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (this.knots[mid]!.time < time) lo = mid; else hi = mid;
    }
    const a = this.knots[lo]!, b = this.knots[hi]!;
    return joinPose(a.pose, b.pose, b.time - a.time, time - a.time);
  }
}
