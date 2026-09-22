import type { TerrainTheme } from '../config/terrain';
import { isTerrainTheme } from '../config/terrain';
import { MAX_SESSION_PLANS } from '../game/multiplayer/session';
import type { PlayerSlot } from '../game/multiplayer/session';
import { TARGET_KINDS } from '../game/targets';
import { readFlightPose, readFlightVector } from '../simulation/flight-track-data';
import type { Vec3 } from '../simulation/math';
import type { Contact } from '../terrain/surface';
import { snapshotAircraft, snapshotTarget } from './world-frame';
import type { TargetFrame, WorldFrame } from './world-frame';

export type SharedTargetFrame = TargetFrame & { readonly destroyed: boolean };
export interface SharedImpactFrame {
  readonly id: number; readonly sequence: number; readonly slot: PlayerSlot; readonly time: number;
  readonly impact: Readonly<Omit<Contact, 'normal'>> & { readonly normal: Readonly<Vec3> };
}
export type SharedAircraftFrame = WorldFrame['aircraft'] & { readonly destroyed: boolean };
type SharedView = { readonly position: Readonly<Vec3>; readonly target: Readonly<Vec3> };
export interface SharedWorldFrame {
  readonly time: number;
  readonly terrain: TerrainTheme;
  readonly viewedSlot: PlayerSlot;
  readonly aircraft: readonly [SharedAircraftFrame, SharedAircraftFrame];
  readonly views: readonly [SharedView, SharedView];
  readonly targets: readonly SharedTargetFrame[];
  readonly impacts: readonly SharedImpactFrame[];
  readonly prediction: WorldFrame['prediction'];
  readonly ready: boolean;
  readonly effectPositions: readonly Readonly<Vec3>[];
}

export function snapshotSharedFrame(frame: SharedWorldFrame): SharedWorldFrame {
  if (!Number.isFinite(frame.time) || frame.time < 0 || frame.time > 1e8 || !isTerrainTheme(frame.terrain) ||
    (frame.viewedSlot !== 0 && frame.viewedSlot !== 1) || frame.aircraft.length !== 2 || frame.views.length !== 2 ||
    !frame.targets.length || frame.targets.length > MAX_SESSION_PLANS ||
    frame.impacts.length > MAX_SESSION_PLANS * 2 || frame.effectPositions.length > MAX_SESSION_PLANS * 2 ||
    typeof frame.ready !== 'boolean' || (frame.prediction && typeof frame.prediction.hit !== 'boolean')) {
    throw new Error('Invalid bounded shared frame.');
  }
  const ids = new Set<number>();
  const targets = frame.targets.map(target => {
    if (!Number.isSafeInteger(target.id) || target.id < 1 || target.id > 100_001 || ids.has(target.id) ||
      !TARGET_KINDS.includes(target.kind) || !Number.isFinite(target.heading) ||
      !Number.isFinite(target.sightDistance) || target.sightDistance <= 0 || target.sightDistance > 3500 ||
      target.canyon !== (frame.terrain === 'river-canyon') || typeof target.destroyed !== 'boolean') {
      throw new Error('Invalid shared target identity or course.');
    }
    readFlightVector(target.position, 'shared target');
    ids.add(target.id);
    return Object.freeze({ ...snapshotTarget(target), destroyed: target.destroyed });
  });
  const impactIds = new Set<number>();
  const impacts = frame.impacts.map(result => {
    if (!Number.isSafeInteger(result.sequence) || !ids.has(result.sequence + 1) ||
      (result.slot !== 0 && result.slot !== 1) || result.id !== result.sequence * 2 + result.slot + 1 ||
      impactIds.has(result.id) || !Number.isFinite(result.time) || result.time < 0 || result.time > frame.time ||
      (result.impact.kind !== 'water' && result.impact.kind !== 'ground') ||
      (result.impact.kind === 'water' && frame.terrain !== 'river-canyon')) throw new Error('Invalid attributed impact.');
    impactIds.add(result.id);
    return Object.freeze({ ...result, impact: Object.freeze({ ...readFlightVector(result.impact, 'shared impact'),
      kind: result.impact.kind, normal: readFlightVector(result.impact.normal, 'impact normal') }) });
  });
  const aircraft = (slot: PlayerSlot): SharedAircraftFrame => {
    const value = frame.aircraft[slot];
    readFlightPose(value.pose);
    if (typeof value.destroyed !== 'boolean' || typeof value.released !== 'boolean') throw new Error('Invalid aircraft visibility.');
    if (value.bomb) {
      readFlightVector(value.bomb.position, 'shared bomb');
      readFlightVector(value.bomb.velocity, 'shared bomb velocity');
      if (!Number.isFinite(value.bomb.age) || value.bomb.age < 0 || value.bomb.age > 20) throw new Error('Invalid shared bomb age.');
    }
    return Object.freeze({ ...snapshotAircraft(value), destroyed: value.destroyed });
  };
  const view = (slot: PlayerSlot): SharedView => {
    const result = Object.freeze({ position: readFlightVector(frame.views[slot].position, 'shared camera'),
      target: readFlightVector(frame.views[slot].target, 'shared camera target') });
    if (Math.hypot(result.target.x - result.position.x, result.target.y - result.position.y,
      result.target.z - result.position.z) < 1e-6) throw new Error('Degenerate shared camera direction.');
    return result;
  };
  return Object.freeze({ ...frame, aircraft: Object.freeze([aircraft(0), aircraft(1)] as const),
    views: Object.freeze([view(0), view(1)] as const), targets: Object.freeze(targets), impacts: Object.freeze(impacts),
    prediction: frame.prediction ? Object.freeze({ ...frame.prediction,
      position: readFlightVector(frame.prediction.position, 'shared prediction') }) : null,
    effectPositions: Object.freeze(frame.effectPositions.map(p => readFlightVector(p, 'shared effect'))) });
}
