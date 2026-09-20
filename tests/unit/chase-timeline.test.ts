import { describe, expect, it } from 'vitest';
import { ChaseTimeline, MAX_CHASE_SAMPLES } from '../../src/simulation/chase-timeline';
import { chaseView } from '../../src/simulation/chase-camera';
import { FLOOR, STEP, difficulty, targetSightDistance } from '../../src/config/game';
import { initialPose } from '../../src/simulation/pose';
import { poseAt } from '../../src/game/run';
import { Surface, valleySurface } from '../../src/terrain/surface';
import { seededCourse } from '../helpers/flight-probe';
import { projectRoute } from '../../src/terrain/canyon-route';

describe('authored multiplayer chase timelines', () => {
  it('agrees with fixed-step camera evaluation, independent of render cadence and query order', () => {
    const motion = (time: number) => initialPose({ x: time * 3, y: 150 + time ** 2, z: time * 70 });
    const timeline = new ChaseTimeline(motion, valleySurface, -2, 1.002);
    let previous = null;
    for (let index = 0; index < timeline.samples.length; index++) {
      const sample = timeline.samples[index]!;
      const dt = index ? sample.time - timeline.samples[index - 1]!.time : 0;
      const view = chaseView(motion(sample.time), valleySurface, previous, dt);
      expect(timeline.at(sample.time)).toEqual(view);
      previous = view.position;
    }
    const independent = new ChaseTimeline(motion, valleySurface, -2, 1.002);
    for (const cadence of [[1 / 60], [1 / 30], [0.1], [0.016, 0.1, 0.033]]) {
      let time = -2, index = 0;
      while (time <= timeline.endTime) {
        const expected = independent.at(time);
        expect(timeline.at(time)).toEqual(expected);
        timeline.at(0.123).position.x = 999;
        expect(timeline.at(time)).toEqual(expected);
        time += cadence[index++ % cadence.length]!;
      }
    }
    expect(timeline.at(1.002)).toEqual(independent.at(1.002));
    expect(() => Object.assign(timeline.samples[0]!.position, { x: 999 })).toThrow(TypeError);
  });

  it.each(['green-valley', 'desert', 'river-canyon'] as const)(
    'acquires complete %s targets with margin across tiers and both banks', terrain => {
      const banks = new Set<number>();
      for (const encounter of seededCourse(7, terrain, 14)) {
        if (![1, 2, 13, 14].includes(encounter.id)) continue;
        const count = encounter.id - 1;
        const deadline = encounter.canyon?.diveAt ?? -difficulty(count).diveDuration - 0.5;
        const timeline = new ChaseTimeline(time => poseAt(encounter, time, count),
          encounter.surface, encounter.time, 0.1);
        const before = encounter.canyon ? structuredClone(encounter.canyon.track.knots) : null;
        const window = { target: encounter.target, earliest: Math.max(timeline.startTime, deadline - 3),
          deadline, range: encounter.canyon?.sightDistance ?? targetSightDistance(count),
          margin: 0.1, viewport: { minAspect: 0.75, maxAspect: 32 / 9 } };
        const acquired = timeline.acquire(window);
        expect(acquired).toBeLessThanOrEqual(deadline - 0.1);
        for (const aspect of [0.75, 16 / 9, 32 / 9]) {
          expect(timeline.verify(acquired, timeline.at(acquired), aspect, window)).toEqual({ ok: true });
        }
        if (encounter.canyon) {
          expect(encounter.canyon.track.knots).toEqual(before);
          banks.add(Math.sign(projectRoute(encounter.target.x, encounter.target.z).lateral));
        }
      }
      if (terrain === 'river-canyon') expect(banks.size).toBe(2);
    }, 20_000);

  it('carries initial camera motion without mutating a prior view', () => {
    const motion = (time: number) => initialPose({ x: time, y: 100, z: time * 70 });
    const before = new ChaseTimeline(motion, valleySurface, -2, 0);
    const view = before.at(0), frozen = structuredClone(view);
    const after = new ChaseTimeline(motion, valleySurface, 0, 2, view);
    expect(after.at(0)).toEqual(view);
    expect(view).toEqual(frozen);
    view.position.x = 999;
    expect(after.at(0)).toEqual(frozen);
  });

  it('reports viewport/camera changes for paused revalidation without changing the authored clock', () => {
    const motion = (time: number) => initialPose({ x: 0, y: 100, z: time * 70 });
    const timeline = new ChaseTimeline(motion, valleySurface, -2, 1);
    const window = { target: { x: 0, y: FLOOR, z: 400 }, earliest: -1, deadline: 0,
      margin: 0.1, range: 1000, viewport: { minAspect: 0.75, maxAspect: 2 } };
    const time = timeline.acquire(window), actual = timeline.at(time);
    expect(timeline.verify(time, actual, 0.5, window)).toEqual({ ok: false, reason: 'viewport_changed' });
    expect(timeline.verify(time, actual, 16 / 9, window)).toEqual({ ok: true });
    actual.position.x += 1;
    expect(timeline.verify(time, actual, 16 / 9, window)).toEqual({ ok: false, reason: 'camera_mismatch' });
    expect(timeline.verify(time, timeline.at(time), 16 / 9, { ...window, range: 1 }))
      .toEqual({ ok: false, reason: 'target_hidden' });
    expect(timeline.at(time)).not.toEqual(actual);
  });

  it('fails hidden targets, incomplete coverage and invalid input explicitly with bounded work', () => {
    const surface = new Surface(false, () => 1000);
    const timeline = new ChaseTimeline(() => initialPose(), surface, -2, 1);
    const window = { target: { x: 0, y: 0, z: 400 }, earliest: -2, deadline: 0,
      margin: 0.1, range: 2000, viewport: { minAspect: 0.75, maxAspect: 2 } };
    expect(() => timeline.acquire(window)).toThrow(/cannot acquire/);
    expect(() => timeline.acquire({ ...window, earliest: -3 })).toThrow(/window/);
    expect(() => timeline.acquire({ ...window, viewport: { minAspect: 0, maxAspect: 2 } })).toThrow(/window/);
    for (const time of [-3, 2, NaN, Infinity]) expect(() => timeline.at(time)).toThrow(/coverage/);
    expect(() => new ChaseTimeline(() => initialPose(), surface, 0, MAX_CHASE_SAMPLES * STEP)).toThrow(/bounded/);
    expect(() => new ChaseTimeline(() => initialPose({ x: NaN, y: 0, z: 0 }), surface, 0, 1)).toThrow(/motion/);
  });
});
