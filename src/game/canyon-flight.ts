import { ATTACK_HEIGHT, CRUISE_HEIGHT, FLOOR, GRAVITY, STEP, difficulty } from '../config/game';
import { clamp, distance, hash } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import { FlightTrack, joinPose, joinRespectsSpeed, pathPose, speedOf, TRACK_SPEED_FRACTION } from '../simulation/flight-track';
import { CANYON, shelfSide } from '../terrain/river-canyon';
import { projectRoute, routeMotion, routePoint } from '../terrain/canyon-route';
import { canyonSurface, Surface } from '../terrain/surface';
import { predictImpact } from '../simulation/ballistics';
import { launchFrom } from './run';
import type { Encounter, Pose } from './run';
import { selectTargetKind } from './targets';
import { chaseView, projectChase, targetInChaseView } from '../simulation/chase-camera';
import type { ChaseView } from '../simulation/chase-camera';

export interface CanyonFlight {
  startTime: number; offset: number; side: number; track: FlightTrack;
  entryEnd: number; acquireAt: number; diveAt: number; cutoffAt: number; endAt: number; sightDistance: number;
}
const shelfPlane = new Surface(false, () => FLOOR);
const ease = (value: number): number => {
  const t = clamp(value, 0, 1);
  return t ** 3 * (10 - 15 * t + 6 * t * t);
};
export const canyonJink = (count: number) => {
  const level = clamp(count, 0, 12) / 12;
  return { amplitude: 17 + 7 * level, frequency: 0.95 + 1.2 * level };
};

export function canyonPose(encounter: Encounter, time: number): Pose {
  const flight = encounter.canyon;
  if (!flight) throw new Error('Missing canyon flight plan.');
  if (time < flight.entryEnd) return joinPose(encounter.start, flight.track.at(flight.entryEnd),
    flight.entryEnd - flight.startTime, time - flight.startTime);
  return flight.track.at(time);
}

function canyonPath(count: number, releaseZ: number, offset: number, side: number, phase: number) {
  const d = difficulty(count), j = canyonJink(count);
  const diveDuration = Math.max(d.diveDuration, 3 * 76 / d.speed);
  const divePhase = -diveDuration - 0.8;
  const path = (u: number): Vec3 => {
    const blend = ease((u + 7) / 4) * (1 - ease((u - 2.2) / 4));
    const lateral = (offset + side * j.amplitude * Math.sin(u * j.frequency + phase)) * blend;
    const point = routePoint(releaseZ + d.speed * u, lateral);
    const altitude = CRUISE_HEIGHT - (CRUISE_HEIGHT - ATTACK_HEIGHT) * ease((u - divePhase) / diveDuration)
      + (CRUISE_HEIGHT - ATTACK_HEIGHT) * ease((u - 2.2) / 4);
    return { ...point, y: FLOOR + altitude };
  };
  return { path, divePhase };
}

function buildFlight(count: number, previous: Pose, releaseZ: number, offset: number, side: number, phase: number, target: Vec3): CanyonFlight {
  const d = difficulty(count), { path, divePhase } = canyonPath(count, releaseZ, offset, side, phase);
  const start = (projectRoute(previous.position.x, previous.position.z).along - releaseZ) / d.speed;
  const track = new FlightTrack(path, u => Math.min(d.speed,
    Math.sqrt(70 / Math.max(0.000001, Math.abs(routeMotion(releaseZ + d.speed * u).curvature)))), start, 36);
  const diveAt = track.timeAt(divePhase);
  return { track, startTime: track.startTime, entryEnd: track.startTime + 3, offset, side,
    acquireAt: diveAt - 0.65, diveAt, cutoffAt: track.timeAt(3), endAt: track.timeAt(6.5),
    sightDistance: distance(track.at(diveAt - 0.65).position, target) + 110 };
}

export function planCanyon(count: number, seed: number, previous: Pose): Encounter {
  const d = difficulty(count), fall = Math.sqrt(2 * (ATTACK_HEIGHT - 2.2) / GRAVITY);
  const previousAlong = projectRoute(previous.position.x, previous.position.z).along;
  const first = Math.ceil((previousAlong + d.speed * (8 + fall) / 1.3 - CANYON.shelfOrigin) / CANYON.shelfSpacing);
  const reasons: string[] = [];
  for (let index = first; index < first + 12; index++) {
    if (index % 2 !== 0 && d.speed > 170) continue;
    const side = shelfSide(index), targetZ = CANYON.shelfOrigin + index * CANYON.shelfSpacing;
    const target = { ...routePoint(targetZ, side * CANYON.bankTarget), y: FLOOR };
    const phase = -0.65 - hash(count, 491, seed) * 0.15;
    let releaseZ = targetZ - d.speed * fall * routeMotion(targetZ).tz, offset = 0;
    for (let iteration = 0; iteration < 12; iteration++) {
      const { path } = canyonPath(count, releaseZ, offset, side, phase);
      const impact = predictImpact(launchFrom(pathPose(path, 0, d.speed * TRACK_SPEED_FRACTION)), shelfPlane);
      const error = { x: target.x - impact.x, z: target.z - impact.z };
      if (Math.hypot(error.x, error.z) < 0.005) break;
      const frame = routeMotion(releaseZ);
      offset += clamp((error.x * frame.nx + error.z * frame.nz) * 0.85, -100, 100);
      releaseZ += clamp((error.x * frame.tx + error.z * frame.tz) * frame.tz * 0.85, -250, 250);
    }
    if (Math.abs(offset) > 115) { reasons.push('offset'); continue; }
    const flight = buildFlight(count, previous, releaseZ, offset, side, phase, target);
    flight.cutoffAt = flight.track.timeAt((targetZ + 90 - releaseZ) / d.speed);
    const encounter: Encounter = { id: count + 1, targetKind: selectTargetKind(count, seed), surface: canyonSurface,
      time: flight.startTime, origin: releaseZ, phase, start: structuredClone(previous), visibleAt: null,
      target, released: false, resolvedAt: null, canyon: flight };
    const impact = predictImpact(launchFrom(flight.track.at(0)), canyonSurface);
    if (impact.kind !== 'ground' || distance(impact, target) > 0.05) { reasons.push('impact'); continue; }
    if (speedOf(flight.track.at(0)) < d.speed * 0.85) { reasons.push('attack-speed'); continue; }
    if (!flight.track.respectsSpeed(d.speed)) { reasons.push('track-speed'); continue; }
    let entryValid = false;
    for (const padding of [0, 0.25, 0.5, 1, 2, 3]) {
      flight.startTime = flight.track.startTime - padding;
      entryValid = joinRespectsSpeed(encounter.start, flight.track.at(flight.entryEnd), flight.entryEnd - flight.startTime, d.speed);
      if (entryValid) break;
    }
    if (!entryValid) { reasons.push('entry-speed'); continue; }
    encounter.time = flight.startTime;
    let clear = true, last = canyonPose(encounter, flight.startTime);
    for (let t = flight.startTime; t < flight.endAt + 3; t += 0.1) {
      const pose = canyonPose(encounter, t);
      if (speedOf(pose) > d.speed + 0.001) { clear = false; break; }
      for (const dx of [-14, 14]) for (const dz of [-14, 14]) {
        if (canyonSurface.ground({ x: last.position.x + dx, y: last.position.y - 12, z: last.position.z + dz },
          { x: pose.position.x + dx, y: pose.position.y - 12, z: pose.position.z + dz })) clear = false;
      }
      last = pose;
    }
    if (!clear) { reasons.push('clearance/speed'); continue; }
    let view: ChaseView | null = null, visible = true, visibilityFailure = '';
    for (let t = flight.acquireAt - 2; t <= 0; t += 0.1) {
      view = chaseView(canyonPose(encounter, t - STEP), canyonSurface, view?.position ?? null, 0.1);
      if (t >= flight.acquireAt && !targetInChaseView(target, view, canyonSurface, 0.75, flight.sightDistance)) {
        if (visible) visibilityFailure = JSON.stringify({ t, screen: projectChase(target, view, 0.75),
          blocked: canyonSurface.ground(view.position, { ...target, y: FLOOR + 0.5 }) });
        visible = false;
      }
    }
    if (!visible) { reasons.push(`visibility ${visibilityFailure}`); continue; }
    return encounter;
  }
  throw new Error(`Could not construct a safe winding canyon pass ${count + 1}: ${reasons.join(', ')}.`);
}
