export interface Vec3 { x: number; y: number; z: number }
export const vec = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => { const v = clamp(t, 0, 1); return v * v * (3 - 2 * v); };
export const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function hash(x: number, z: number, seed = 0): number {
  let n = Math.imul(x ^ seed, 374761393) ^ Math.imul(z, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

export function noise(x: number, z: number, seed = 0): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  return mix(
    mix(hash(ix, iz, seed), hash(ix + 1, iz, seed), smooth(x - ix)),
    mix(hash(ix, iz + 1, seed), hash(ix + 1, iz + 1, seed), smooth(x - ix)),
    smooth(z - iz),
  );
}
