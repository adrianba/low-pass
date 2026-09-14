import { describe, expect, it } from 'vitest';
import { STEP } from '../../src/config/game';
import { Run, launchFrom, poseAt } from '../../src/game/run';
import { contactAccuracy, predictImpact } from '../../src/simulation/ballistics';
import { releaseWindows, seededCourse } from '../helpers/flight-probe';

describe('release measurement driver', () => {
  it('refines separate hit and precision boundaries without merging disconnected windows', () => {
    const windows = releaseWindows(t => Math.abs(t) < 0.1 ? 100 : t > 0.3 && t < 0.5 ? 40 : 0);
    expect(windows.hits).toHaveLength(2);
    expect(windows.precision).toHaveLength(1);
    expect(windows.hits[0]!.start).toBeCloseTo(-0.1, 8);
    expect(windows.hits[0]!.end).toBeCloseTo(0.1, 8);
    expect(windows.hits[1]!.start).toBeCloseTo(0.3, 8);
    expect(windows.hits[1]!.end).toBeCloseTo(0.5, 8);
    expect(windows.precision[0]).toEqual(windows.hits[0]);
  });

  it('reports empty windows and rejects misleading or unbounded measurements', () => {
    expect(releaseWindows(() => 0)).toEqual({ hits: [], precision: [] });
    expect(() => releaseWindows(() => 100)).toThrow(/clips/);
    expect(() => releaseWindows(() => NaN)).toThrow(/score/);
    for (const step of [0, -1, NaN, 1e-20]) {
      expect(() => releaseWindows(() => 0, -1, 1, step)).toThrow(/range/);
    }
    expect(() => [...seededCourse(7, 'green-valley', 0)]).toThrow(/length/);
  });
});

describe('solo baseline before multiplayer', () => {
  it.each(['green-valley', 'desert', 'river-canyon'] as const)(
    'reproduces a seeded %s course through the speed cap with usable release windows', terrain => {
      const course = [...seededCourse(7, terrain, 14)];
      const again = [...seededCourse(7, terrain, 14)];
      expect(course.map(e => [e.targetKind, e.target, e.start]))
        .toEqual(again.map(e => [e.targetKind, e.target, e.start]));
      for (const count of [0, 12, 13]) {
        const encounter = course[count]!;
        const scoreAt = (time: number) => contactAccuracy(
          predictImpact(launchFrom(poseAt(encounter, time, count)), encounter.surface),
          encounter.target, encounter.surface);
        const windows = releaseWindows(scoreAt);
        expect(scoreAt(0)).toBe(100);
        expect(windows.hits).toHaveLength(1);
        expect(windows.precision).toHaveLength(1);
        expect(windows.hits[0]!.end - windows.hits[0]!.start).toBeGreaterThan(0.08);
        expect(windows.precision[0]!.end - windows.precision[0]!.start).toBeGreaterThan(0.005);
        const next = course[count + 1];
        if (next) expect(next.start).toEqual(poseAt(encounter, encounter.canyon?.endAt ?? 7, count));
      }
    });

  it.each(['green-valley', 'desert', 'river-canyon'] as const)(
    'does not mutate a completed %s run when a frame or input arrives late', terrain => {
      const run = new Run(7, terrain);
      for (let tick = 0; tick < 20_000 && run.status !== 'over'; tick++) {
        if (run.encounter.visibleAt === null && run.encounter.time >= (run.encounter.canyon?.acquireAt ?? -6)) {
          run.seeTarget();
        }
        run.tick(false);
      }
      expect(run.status).toBe('over');
      expect(run.misses).toBe(3);
      const state = structuredClone({
        pose: run.pose, time: run.encounter.time, result: run.result,
        score: run.score, resolved: run.resolved, events: run.events,
      });
      for (let tick = 0; tick < Math.ceil(0.1 / STEP); tick++) {
        run.tick(true);
        run.seeTarget();
        expect(run.release()).toBe(false);
      }
      expect(run.assisted).toBe(false);
      expect({
        pose: run.pose, time: run.encounter.time, result: run.result,
        score: run.score, resolved: run.resolved, events: run.events,
      }).toEqual(state);
    });
});
