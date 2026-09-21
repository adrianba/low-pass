import { CRUISE_HEIGHT, FLOOR, difficulty } from '../config/game';
import type { Bomb } from './ballistics';
import { mix } from './math';
import type { Vec3 } from './math';

export interface Pose { position: Vec3; velocity: Vec3; acceleration: Vec3; bank: number; pitch: number }
export const BOMB_MOUNT = Object.freeze({ x: 0, y: -2.2, z: 0 });

export function aircraftPoint(pose: Pose, local: Vec3): Vec3 {
  const yaw = Math.atan2(pose.velocity.x, pose.velocity.z);
  const x = local.x * Math.cos(pose.bank) - local.y * Math.sin(pose.bank);
  const rolledY = local.x * Math.sin(pose.bank) + local.y * Math.cos(pose.bank);
  const y = rolledY * Math.cos(pose.pitch) - local.z * Math.sin(pose.pitch);
  const z = rolledY * Math.sin(pose.pitch) + local.z * Math.cos(pose.pitch);
  return {
    x: pose.position.x + x * Math.cos(yaw) + z * Math.sin(yaw),
    y: pose.position.y + y,
    z: pose.position.z - x * Math.sin(yaw) + z * Math.cos(yaw),
  };
}

export function launchFrom(pose: Pose): Bomb {
  return { position: aircraftPoint(pose, BOMB_MOUNT), velocity: { ...pose.velocity }, age: 0 };
}

export function initialPose(position: Vec3 = { x: 0, y: FLOOR + CRUISE_HEIGHT, z: 0 }): Pose {
  return { position: { ...position }, velocity: { x: 0, y: 0, z: difficulty(0).speed },
    acceleration: { x: 0, y: 0, z: 0 }, bank: 0, pitch: 0 };
}

export function interpolatePose(previous: Pose, current: Pose, alpha: number): Pose {
  const vector = (a: Vec3, b: Vec3): Vec3 => ({ x: mix(a.x, b.x, alpha), y: mix(a.y, b.y, alpha), z: mix(a.z, b.z, alpha) });
  return { position: vector(previous.position, current.position), velocity: vector(previous.velocity, current.velocity),
    acceleration: vector(previous.acceleration, current.acceleration),
    bank: mix(previous.bank, current.bank, alpha), pitch: mix(previous.pitch, current.pitch, alpha) };
}
