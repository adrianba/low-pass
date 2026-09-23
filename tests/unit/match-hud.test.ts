import { describe, expect, it } from 'vitest';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler.js';
import { snapshotMatchDisplay } from '../../src/network/match-display.js';
import type { MatchPlayerDisplay } from '../../src/network/match-display.js';
import { hostWorldFrame } from '../../src/rendering/host-frame.js';
import { snapshotSharedFrame } from '../../src/rendering/shared-frame.js';
import { predictImpact } from '../../src/simulation/ballistics.js';
import { launchFrom } from '../../src/simulation/pose.js';
import { surfaceFor } from '../../src/terrain/surface.js';
import { matchPlayerStatus, matchPrediction, matchReleaseStatus } from '../../src/ui/match-hud.js';

const player = (): MatchPlayerDisplay => ({ score: 0, misses: 0, assistance: true, assisted: true, eliminated: false, result: null });

describe('frame-aligned multiplayer instruments', () => {
  it.each(['green-valley', 'desert', 'river-canyon'] as const)('predicts canonical %s contact from each drawn aircraft pose', terrain => {
    const scheduler = new FormationScheduler(terrain, 7), plan = scheduler.plan();
    for (const slot of [0, 1] as const) {
      scheduler.advanceTo(plan.attempts[slot].releaseAt);
      const frame = hostWorldFrame(scheduler, slot);
      const display = snapshotMatchDisplay(frame, slot, [player(), player()], null);
      const prediction = matchPrediction(display);
      expect(prediction).toEqual({ position: predictImpact(launchFrom(frame.aircraft[slot].pose), surfaceFor(terrain)), hit: true });
      expect(matchReleaseStatus(display)).toBe('SPACE TO RELEASE');
      expect(matchPrediction({ ...display, players: [{ ...player(), assistance: false }, { ...player(), assistance: false }] })).toBeNull();
      expect(matchPrediction({ ...display, players: [{ ...player(), eliminated: true }, { ...player(), eliminated: true }] })).toBeNull();
      expect(matchPrediction({ ...display, localSlot: slot === 0 ? 1 : 0 })).toBeNull();
      expect(matchPrediction({ ...display, frame: { ...frame, ready: false } })).toBeNull();
    }
  });

  it('never labels a canyon water contact as on target', () => {
    const scheduler = new FormationScheduler('river-canyon', 7);
    scheduler.advanceTo(scheduler.plan().attempts[0].releaseAt);
    const source = hostWorldFrame(scheduler, 0), surface = surfaceFor('river-canyon');
    const z = source.aircraft[0].pose.position.z, x = surface.center(z);
    const pose = { ...source.aircraft[0].pose, position: { x, y: 45, z }, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, bank: 0 };
    const frame = snapshotSharedFrame({ ...source, aircraft: [{ ...source.aircraft[0], pose }, source.aircraft[1]] });
    const prediction = matchPrediction(snapshotMatchDisplay(frame, 0, [player(), player()], null));
    expect(prediction).toMatchObject({ position: { kind: 'water' }, hit: false });
  });

  it('owns both players and distinguishes local bomb, eliminated and spectator status', () => {
    const scheduler = new FormationScheduler('green-valley', 7);
    scheduler.advanceTo(scheduler.plan().attempts[0].releaseAt);
    const source = { ...player(), result: { points: 100, time: 0 } };
    const display = snapshotMatchDisplay(hostWorldFrame(scheduler, 0), 0, [source, player()], null);
    source.result.points = 0;
    expect(display.players[0].result!.points).toBe(100);
    expect(Object.isFrozen(display.players)).toBe(true);
    expect(Object.isFrozen(display.players[0].result)).toBe(true);
    expect(matchPlayerStatus(display.players[0], 1)).toBe('HIT +100');
    expect(matchPlayerStatus({ ...player(), misses: 2, result: { points: 0, time: 3 } }, 4)).toBe('MISS');
    expect(matchPlayerStatus({ ...player(), misses: 2, result: { points: 0, time: 3 } }, 7)).toBe('CRITICAL DAMAGE');
    scheduler.session.release(0, 0);
    const released = { ...display, frame: hostWorldFrame(scheduler, 0) };
    expect(matchReleaseStatus(released)).toBe('BOMB IN FLIGHT');
    expect(matchPrediction(released)).toBeNull();
    const dead = { ...player(), misses: 3, eliminated: true };
    const ending = snapshotMatchDisplay(display.frame, 0, [dead, player()], null);
    expect(matchReleaseStatus(ending)).toBe('AIRCRAFT LOST');
    expect(matchReleaseStatus({ ...ending, frame: { ...ending.frame, viewedSlot: 1 } })).toBe('SPECTATING');
    expect(matchPlayerStatus(dead, 10)).toBe('FLIGHT ENDED');
  });
});
