import { combatCues } from '../game/multiplayer/combat-timeline.js';
import type { CombatCueSource } from '../game/multiplayer/combat-timeline.js';
import type { MatchDisplay } from '../network/match-display.js';
import { speedOf } from '../simulation/flight-track.js';
import type { FlightAudio } from './audio.js';

type AudioOutput = Pick<FlightAudio, 'start' | 'pause' | 'reset' | 'update' | 'cue'>;

export class MultiplayerAudio {
  private previous: MatchDisplay | null = null;
  private active = false;
  constructor(private readonly output: AudioOutput) {}
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) void this.output.start();
    else void this.output.pause();
  }
  update(display: MatchDisplay, effects: readonly CombatCueSource[]): void {
    const previous = this.previous, frame = display.frame, slot = frame.viewedSlot, aircraft = frame.aircraft[slot];
    const restored = !previous || previous.epoch !== display.epoch || previous.frame.viewedSlot !== slot;
    if (restored) this.output.reset();
    this.output.update(speedOf(aircraft.pose), aircraft.bomb?.age ?? null, !aircraft.destroyed);
    if (previous && !restored && this.active) {
      if (frame.time < previous.frame.time) throw new Error('Audio presentation regressed without a restored epoch.');
      if (aircraft.released && !previous.frame.aircraft[slot].released && aircraft.bomb) this.output.cue('release');
      if (frame.ready && !previous.frame.ready && slot === display.localSlot) this.output.cue('target');
      const result = display.players[slot].result;
      if (result && result.time !== previous.players[slot].result?.time && frame.time - result.time < 1.2) {
        const impact = frame.impacts.find(impact => impact.slot === slot && impact.time === result.time);
        this.output.cue(result.points > 0 ? 'hit' : impact?.impact.kind === 'water' ? 'splash' : 'miss');
      }
      if (display.players[slot].eliminated && !previous.players[slot].eliminated) this.output.cue('over');
      for (const cue of combatCues(effects, previous.frame.time, frame.time)) {
        if (cue.slot === slot) this.output.cue(cue.cue);
      }
    }
    this.previous = display;
  }
  reset(): void {
    this.setActive(false); this.output.reset(); this.previous = null;
  }
}
