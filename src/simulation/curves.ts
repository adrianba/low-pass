export interface Motion {
  position: number;
  velocity: number;
  acceleration: number;
}

// Quintic Hermite interpolation preserves position, velocity, and acceleration.
export function joinMotion(start: Motion, end: Motion, duration: number, elapsed: number): Motion {
  if (elapsed <= 0) return { ...start };
  if (elapsed >= duration) return { ...end };
  const t = elapsed / duration;
  const v = start.velocity * duration;
  const a = start.acceleration * duration * duration;
  const dp = end.position - start.position - v - a / 2;
  const dv = end.velocity * duration - v - a;
  const da = (end.acceleration - start.acceleration) * duration * duration;
  const c3 = 10 * dp - 4 * dv + da / 2;
  const c4 = -15 * dp + 7 * dv - da;
  const c5 = 6 * dp - 3 * dv + da / 2;
  return {
    position: start.position + v * t + a * t * t / 2 + c3 * t ** 3 + c4 * t ** 4 + c5 * t ** 5,
    velocity: (v + a * t + 3 * c3 * t * t + 4 * c4 * t ** 3 + 5 * c5 * t ** 4) / duration,
    acceleration: (a + 6 * c3 * t + 12 * c4 * t * t + 20 * c5 * t ** 3) / (duration * duration),
  };
}
