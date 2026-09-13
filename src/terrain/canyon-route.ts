import { clamp, hash } from '../simulation/math';

function bend(z: number): [number, number, number] {
  const section = Math.floor(z / 3200), local = z - section * 3200, sign = section % 2 ? -1 : 1;
  if (local <= 1600) return [sign * (-440 + 0.55 * local), sign * 0.55, 0];
  const length = hash(section, 817, 23) < 0.35 ? 1200 : 1600;
  const lead = (1600 - length) / 2, s = local - 1600;
  const u = clamp((s - lead) / length, 0, 1);
  const integral = u ** 4 * (2.5 - 3 * u + u * u);
  const extra = Math.max(0, s - lead - length);
  const x = 440 + 0.55 * (Math.min(s, lead) + length * (u - 2 * integral) - extra);
  const slope = 0.55 * (1 - 2 * u ** 3 * (10 - 15 * u + 6 * u * u));
  const second = -1.1 / length * 30 * u * u * (1 - u) ** 2;
  return [sign * x, sign * slope, sign * second];
}

export function routeMotion(z: number) {
  const [offset, slope, second] = bend(z);
  const x = 440 + offset + 35 * Math.sin(z / 2500);
  const dx = slope + 35 / 2500 * Math.cos(z / 2500);
  const ddx = second - 35 / 2500 ** 2 * Math.sin(z / 2500);
  const length = Math.hypot(1, dx);
  return { x, z, slope: dx, second: ddx, curvature: ddx / length ** 3,
    tx: dx / length, tz: 1 / length, nx: 1 / length, nz: -dx / length };
}

export function routePoint(z: number, lateral = 0) {
  const frame = routeMotion(z);
  return { x: frame.x + frame.nx * lateral, z: z + frame.nz * lateral };
}

export function projectRoute(x: number, z: number) {
  let along = z;
  for (let i = 0; i < 10; i++) {
    const frame = routeMotion(along);
    const gradient = (frame.x - x) * frame.slope + along - z;
    const hessian = 1 + frame.slope ** 2 + (frame.x - x) * frame.second;
    const delta = clamp(gradient / Math.max(0.25, hessian), -128, 128);
    along -= delta;
    if (Math.abs(delta) < 0.00001) break;
  }
  const frame = routeMotion(along);
  return { along, lateral: (x - frame.x) * frame.nx + (z - along) * frame.nz };
}

export function routeBounds(from: number, to: number, margin: number): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let z = from; z <= to + 32; z += 32) {
    const x = routeMotion(Math.min(z, to)).x;
    lo = Math.min(lo, x); hi = Math.max(hi, x);
  }

  return [lo - margin - 32, hi + margin + 32];
}

export function routeDistance(from: number, to: number): number {
  const n = Math.max(1, Math.ceil(Math.abs(to - from) / 32));
  const h = (to - from) / n;
  let result = 0;
  for (let i = 0; i < n; i++) {
    const a = from + i * h;
    result += h / 6 * (1 / routeMotion(a).tz + 4 / routeMotion(a + h / 2).tz + 1 / routeMotion(a + h).tz);
  }
  return result;
}

export function advanceRoute(from: number, distance: number): number {
  let to = from + distance * routeMotion(from).tz;
  for (let i = 0; i < 6; i++) {
    const error = routeDistance(from, to) - distance;
    to -= error * routeMotion(to).tz;
    if (Math.abs(error) < 0.00001) break;
  }
  return to;
}
