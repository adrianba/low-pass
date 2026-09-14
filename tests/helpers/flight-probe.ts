import { STEP } from '../../src/config/game';
import type { TerrainTheme } from '../../src/config/terrain';
import { initialPose, planEncounter, poseAt, Run } from '../../src/game/run';
import type { Encounter } from '../../src/game/run';

export interface Interval { start: number; end: number }
export interface ReleaseWindows { hits: Interval[]; precision: Interval[] }

export function releaseWindows(scoreAt: (time: number) => number,
  start = -1, end = 1, step = STEP / 4): ReleaseWindows {
  const count = Math.ceil((end - start) / step);
  if (![start, end, step].every(Number.isFinite) || end <= start || step <= 0 || count > 100_000) {
    throw new Error('Invalid release-window sampling range.');
  }
  const score = (time: number): number => {
    const value = scoreAt(time);
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Invalid sampled score.');
    return value;
  };
  const samples = Array.from({ length: count + 1 }, (_, i) => {
    const time = Math.min(end, start + i * step);
    return { time, score: score(time) };
  });
  if (samples[0]!.score || samples.at(-1)!.score) {
    throw new Error('Sampling range clips a successful-release interval.');
  }
  const intervals = (minimum: number): Interval[] => {
    const result: Interval[] = [];
    let opening: number | null = null;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!, b = samples[i]!;
      const before = a.score >= minimum, after = b.score >= minimum;
      if (before === after) continue;
      let left = a.time, right = b.time;
      for (let iteration = 0; iteration < 20; iteration++) {
        const middle = (left + right) / 2;
        if ((score(middle) >= minimum) === before) left = middle;
        else right = middle;
      }
      if (after) opening = (left + right) / 2;
      else {
        if (opening === null) throw new Error('Missing release-window opening.');
        result.push({ start: opening, end: (left + right) / 2 });
        opening = null;
      }
    }
    return result;
  };
  return { hits: intervals(1), precision: intervals(95) };
}

export function* seededCourse(seed: number, terrain: TerrainTheme, passes: number): Generator<Encounter> {
  if (!Number.isInteger(passes) || passes < 1 || passes > 1000) throw new Error('Invalid course length.');
  const run = new Run(seed, terrain);
  let previous = initialPose(run.encounter.start.position);
  for (let count = 0; count < passes; count++) {
    const encounter = planEncounter(count, seed, previous, run.surface);
    encounter.visibleAt = encounter.canyon?.acquireAt ?? -6;
    yield encounter;
    previous = poseAt(encounter, encounter.canyon?.endAt ?? 7, count);
  }
}
