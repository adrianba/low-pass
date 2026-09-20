import type { Pose } from '../simulation/pose';
import type { Bomb } from '../simulation/ballistics';
import type { Vec3 } from '../simulation/math';
import type { Contact } from '../terrain/surface';
import type { TargetKind } from '../game/targets';

type Immutable<T> = T extends object ? { readonly [Key in keyof T]: Immutable<T[Key]> } : T;

export type TargetFrame = Immutable<{
  id: number; position: Vec3; kind: TargetKind; heading: number; sightDistance: number; canyon: boolean;
}>;
export type WorldFrame = Immutable<{
  aircraft: { pose: Pose; bomb: Bomb | null; released: boolean };
  target: TargetFrame;
  prediction: { position: Vec3; hit: boolean } | null;
  ready: boolean;
  over: boolean;
  result: { id: number; points: number; impact: Contact | null; flyby: boolean } | null;
}>;
export interface WorldEffectHooks {
  finale(pose: Pose): void;
  flyby(): void;
  damage(): void;
}

const vector = (value: Readonly<Vec3>): Readonly<Vec3> => Object.freeze({ x: value.x, y: value.y, z: value.z });

export function snapshotTarget(target: TargetFrame): TargetFrame {
  return Object.freeze({ ...target, position: vector(target.position) });
}

export function snapshotWorldFrame(frame: WorldFrame): WorldFrame {
  const { pose, bomb } = frame.aircraft;
  const impact = frame.result?.impact;
  return Object.freeze({
    aircraft: Object.freeze({
      pose: Object.freeze({ ...pose, position: vector(pose.position), velocity: vector(pose.velocity),
        acceleration: vector(pose.acceleration) }),
      bomb: bomb ? Object.freeze({ ...bomb, position: vector(bomb.position), velocity: vector(bomb.velocity) }) : null,
      released: frame.aircraft.released,
    }),
    target: snapshotTarget(frame.target),
    prediction: frame.prediction ? Object.freeze({ ...frame.prediction, position: vector(frame.prediction.position) }) : null,
    ready: frame.ready, over: frame.over,
    result: frame.result ? Object.freeze({ ...frame.result,
      impact: impact ? Object.freeze({ ...impact, normal: vector(impact.normal) }) : null }) : null,
  });
}
