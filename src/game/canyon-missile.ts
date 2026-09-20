import { FLOOR } from '../config/game';
import { distance, mix } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import { chaseView, projectChase } from '../simulation/chase-camera';
import type { ChaseView } from '../simulation/chase-camera';
import { advanceRoute, projectRoute, routeMotion, routePoint } from '../terrain/canyon-route';
import { CANYON } from '../terrain/river-canyon';
import type { Surface } from '../terrain/surface';
import type { Pose } from '../simulation/pose';
import type { MissileKind } from './missile';

export interface MissileView extends ChaseView { aspect: number; range: number }
export interface CanyonMissilePlan {
  launch: Vec3;
  intercept: Vec3;
  positionAt(age: number): Vec3;
}
interface Options {
  kind: MissileKind;
  side: number;
  surface: Surface;
  aircraftAt(age: number): Pose;
  view: MissileView;
  interceptTime: number;
  duration: number;
  clearance: number;
}
const ease = (u: number) => u ** 3 * (10 - 15 * u + 6 * u * u);
const BODY_RADIUS = 3.4;

function visible(point: Vec3, view: ChaseView, options: Options): boolean {
  const screen = projectChase(point, view, options.view.aspect);
  return !!screen && screen.x > 0.04 && screen.x < 0.96 && screen.y > 0.06 && screen.y < 0.96
    && distance(point, view.position) < options.view.range && !options.surface.ground(view.position, point);
}

export function planCanyonMissile(options: Options): CanyonMissilePlan {
  const { surface, aircraftAt, interceptTime: arrival, duration, kind } = options;
  const start = aircraftAt(0), future = aircraftAt(arrival);
  const from = projectRoute(start.position.x, start.position.z);
  const futureRoute = projectRoute(future.position.x, future.position.z);
  const bank = (CANYON.bankEdge + CANYON.corridor) / 2;
  const sites = [160, 220, 300, 100, 380, 460, 60].map(ahead => advanceRoute(from.along, ahead));
  sites.push(advanceRoute(futureRoute.along, -120), futureRoute.along, advanceRoute(futureRoute.along, 120));
  const samples: { age: number; aircraft: Pose; camera: ChaseView }[] = [];
  let camera: ChaseView = options.view;
  const end = kind === 'flyby' ? duration : arrival;
  const steps = Math.ceil(end / 0.025);
  for (let i = 0; i <= steps; i++) {
    const age = end * i / steps, aircraft = aircraftAt(age);
    if (i) camera = chaseView(aircraft, surface, camera.position, end / steps);
    samples.push({ age, aircraft, camera });
  }
  const failures = new Set<string>();
  for (const side of [options.side, -options.side]) for (const along of sites) {
    const point = routePoint(along, side * bank);
    const footprint = [-2, 0, 2].every(dx => [-2, 0, 2].every(dz =>
      Math.abs(surface.height(point.x + dx, point.z + dz) - FLOOR) < 0.05
      && surface.normal(point.x + dx, point.z + dz).y > 0.99));
    if (!footprint) { failures.add('dry floor footprint'); continue; }
    const launch = { ...point, y: surface.height(point.x, point.z) + 8 };
    if (!visible(launch, options.view, options)) { failures.add('launch visibility'); continue; }
    const intercept = { ...future.position };
    if (kind === 'flyby') {
      const frame = routeMotion(futureRoute.along);
      intercept.x += side * 24 * frame.nx;
      intercept.z += side * 24 * frame.nz;
      intercept.y += 12;
    }
    const target = projectRoute(intercept.x, intercept.z);
    const frame = routeMotion(target.along);
    const forward = Math.max(40, (future.velocity.x * frame.tx + future.velocity.z * frame.tz) * frame.tz);
    for (const power of [2, 3, 4]) {
      const positionAt = (age: number): Vec3 => {
        const u = Math.max(0, age) / arrival, progress = ease(Math.min(u, 1));
        const elapsed = Math.max(0, age - arrival), exit = Math.min(1, elapsed / (duration - arrival));
        const route = mix(along, target.along, progress) + forward * elapsed ** 3 / (3 * (duration - arrival) ** 2);
        const lateral = mix(side * bank, target.lateral, progress) * (1 - ease(exit));
        return { ...routePoint(route, lateral),
          y: launch.y + (intercept.y - launch.y) * (0.25 * u + 0.75 * u ** power) };
      };
      let previous = launch, valid = true;
      for (const sample of samples) {
        const p = positionAt(sample.age), u = sample.age / arrival;
        if (sample.age <= arrival * 0.35 && !visible(p, sample.camera, options)) {
          failures.add('visible ascent'); valid = false; break;
        }
        if ((kind !== 'flyby' && u < 1 || kind === 'flyby' && u <= 0.75)
          && p.y >= sample.aircraft.position.y - 0.01 * (1 - Math.min(u, 1))) {
          failures.add('below-aircraft approach'); valid = false; break;
        }
        if (kind === 'flyby' && distance(p, sample.aircraft.position) < options.clearance + 3) {
          failures.add('flyby separation'); valid = false; break;
        }
        for (const dx of [-BODY_RADIUS, BODY_RADIUS]) for (const dz of [-BODY_RADIUS, BODY_RADIUS]) {
          if (surface.ground({ x: previous.x + dx, y: previous.y - BODY_RADIUS, z: previous.z + dz },
            { x: p.x + dx, y: p.y - BODY_RADIUS, z: p.z + dz })) valid = false;
        }
        if (!valid) { failures.add('body clearance'); break; }
        previous = p;
      }
      const arrivalSpeed = (intercept.y - launch.y) * (0.25 + 0.75 * power) / arrival;
      if (kind !== 'flyby' && arrivalSpeed <= future.velocity.y) valid = false;
      if (valid) return { launch, intercept, positionAt };
    }
  }
  throw new Error(`Cannot plan a canyon-floor ${kind} missile: ${[...failures].join(', ')}.`);
}
