import { describe, expect, it } from 'vitest';
import { STEP } from '../../src/config/game.js';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler.js';
import { hostWorldFrame } from '../../src/rendering/host-frame.js';
import { LocalDrop } from '../../src/rendering/local-drop.js';
import { advanceBomb, contactAccuracy, predictImpact } from '../../src/simulation/ballistics.js';
import { launchFrom } from '../../src/simulation/pose.js';
import { surfaceFor } from '../../src/terrain/surface.js';

describe('bounded speculative local bomb presentation', () => {
  it.each((['green-valley', 'desert', 'river-canyon'] as const).flatMap(terrain =>
    ([0, 1] as const).map(slot => ({ terrain, slot }))))('matches $terrain player $slot without authoring outcomes', ({ terrain, slot }) => {
    const scheduler = new FormationScheduler(terrain, 7), attempt = scheduler.plan().attempts[slot];
    scheduler.advanceTo(attempt.releaseAt);
    const source = hostWorldFrame(scheduler, slot), before = structuredClone(source);
    const drop = new LocalDrop(source, slot), surface = surfaceFor(terrain);
    const predicted = predictImpact(launchFrom(source.aircraft[slot].pose), surface);
    const initial = drop.frame(source);
    expect(initial.aircraft[slot].released).toBe(true);
    expect(initial.aircraft[slot].bomb).toEqual(launchFrom(source.aircraft[slot].pose));
    expect(initial.aircraft[slot === 0 ? 1 : 0]).toEqual(source.aircraft[slot === 0 ? 1 : 0]);
    expect(initial.ready).toBe(false);
    expect(initial.prediction).toBeNull();
    expect(() => new LocalDrop(initial, slot)).toThrow('releasable');
    expect(scheduler.session.release(slot, 0).ok).toBe(true);
    const reference = launchFrom(source.aircraft[slot].pose);
    let contacted = false;
    for (let steps = 1; steps < 1200; steps++) {
      const impact = advanceBomb(reference, STEP, surface);
      const time = attempt.releaseAt + steps * STEP;
      const view = drop.frame({ ...source, time });
      scheduler.advanceTo(time);
      const authoritative = scheduler.session.snapshot();
      const actual = authoritative.players[slot]!.bomb;
      expect(view.aircraft[slot].bomb?.position ?? null).toEqual(actual?.value.position ?? null);
      expect(view.impacts).toEqual(source.impacts);
      expect(view.targets).toEqual(source.targets);
      if (impact) {
        expect(impact).toEqual(predicted);
        expect(view.aircraft[slot].bomb).toBeNull();
        expect(view.aircraft[slot].released).toBe(true);
        const result = authoritative.encounters[0]!.attempts[slot]!.result!;
        expect(result.time).toBe(time);
        expect(result.impact).toEqual(predicted);
        expect(result.points).toBe(contactAccuracy(predicted, source.targets[0]!.position, surface));
        contacted = true; break;
      }
    }
    expect(contacted).toBe(true);
    expect(source).toEqual(before);
    expect(initial.aircraft[slot].bomb!.age).toBe(0);
    expect(() => drop.frame(source)).toThrow('clock');
    expect(() => drop.frame({ ...source, time: 100, terrain: terrain === 'river-canyon' ? 'desert' : 'river-canyon' })).toThrow('course');
  });
});
