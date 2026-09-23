import { describe, expect, it, vi } from 'vitest';
import { MultiplayerAudio } from '../../src/audio/multiplayer.js';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler.js';
import type { CombatCueSource } from '../../src/game/multiplayer/combat-timeline.js';
import type { MatchDisplay } from '../../src/network/match-display.js';
import { snapshotMatchDisplay } from '../../src/network/match-display.js';
import { hostWorldFrame } from '../../src/rendering/host-frame.js';

function fixture() {
  const scheduler = new FormationScheduler('green-valley', 7);
  const player = { score: 0, misses: 0, assistance: false, assisted: false, eliminated: false, result: null };
  const initial = snapshotMatchDisplay(hostWorldFrame(scheduler, 0), 0, [player, player], null, 1);
  const output = { start: vi.fn(async () => {}), pause: vi.fn(async () => {}), reset: vi.fn(), update: vi.fn(), cue: vi.fn() };
  return { initial, output, audio: new MultiplayerAudio(output) };
}
const effects: CombatCueSource[] = [
  { id: 1, slot: 0, bornAt: 1, missile: { kind: 'damage' } },
  { id: 2, slot: 1, bornAt: 1, missile: { kind: 'finale' } },
];

describe('view-aligned multiplayer audio', () => {
  it('follows only the viewed aircraft, using full velocity and its bomb age', () => {
    const { audio, output, initial } = fixture();
    audio.setActive(true); audio.update(initial, []);
    const follow: MatchDisplay = { ...initial, frame: { ...initial.frame, viewedSlot: 1, time: 1,
      aircraft: [initial.frame.aircraft[0], { ...initial.frame.aircraft[1],
        pose: { ...initial.frame.aircraft[1].pose, velocity: { x: 30, y: 40, z: 0 } }, destroyed: true,
        bomb: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, age: 0.7 } }] } };
    audio.update(follow, effects);
    expect(output.update).toHaveBeenLastCalledWith(50, 0.7, false);
    expect(output.cue).not.toHaveBeenCalled();
    expect(output.reset).toHaveBeenCalledTimes(2);
    audio.update({ ...follow, frame: { ...follow.frame, time: 2.8 } }, effects);
    expect(output.cue.mock.calls.map(([cue]) => cue)).toEqual(['destroyed']);
  });
  it('deduplicates canonical cues and skips aged cues after restored epochs or skipped frames', () => {
    const { audio, output, initial } = fixture();
    audio.setActive(true); audio.update(initial, effects);
    const at = (time: number, epoch = 1): MatchDisplay => ({ ...initial, epoch, frame: { ...initial.frame, time } });
    audio.update(at(1), effects); audio.update(at(1), effects);
    expect(output.cue.mock.calls.map(([cue]) => cue)).toEqual(['missile']);
    audio.update(at(2.8), effects); audio.update(at(2.8), effects);
    expect(output.cue.mock.calls.map(([cue]) => cue)).toEqual(['missile', 'damaged']);
    audio.setActive(false); audio.update(at(2.7, 2), effects);
    audio.setActive(true); audio.update(at(2.8, 3), effects); audio.update(at(4, 3), effects);
    expect(output.cue).toHaveBeenCalledTimes(2);
    audio.reset(); audio.setActive(true); audio.update(at(20, 4), effects);
    expect(output.cue).toHaveBeenCalledTimes(2);
    expect(output.pause).toHaveBeenCalledTimes(2);
  });
  it('plays displayed release/result cues once, without producing a hit from a speculative bomb', () => {
    const { audio, output, initial } = fixture();
    audio.setActive(true); audio.update(initial, []);
    const released: MatchDisplay = { ...initial, frame: { ...initial.frame, time: 0.1, aircraft: [
      { ...initial.frame.aircraft[0], released: true, bomb: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, age: 0 } },
      initial.frame.aircraft[1],
    ] } };
    audio.update(released, []); audio.update(released, []);
    expect(output.cue.mock.calls.map(([cue]) => cue)).toEqual(['release']);
    const resolved: MatchDisplay = { ...released, frame: { ...released.frame, time: 1 },
      players: [{ ...released.players[0], score: 100, result: { time: 1, points: 100 } }, released.players[1]] };
    audio.update(resolved, []); audio.update(resolved, []);
    expect(output.cue.mock.calls.map(([cue]) => cue)).toEqual(['release', 'hit']);
  });
});
