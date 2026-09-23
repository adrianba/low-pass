import { STEP } from '../config/game.js';
import type { TerrainTheme } from '../config/terrain.js';
import { MAX_BOMB_SECONDS } from '../game/multiplayer/session.js';
import type { PlayerSlot } from '../game/multiplayer/session.js';
import { advanceBomb } from '../simulation/ballistics.js';
import type { Bomb } from '../simulation/ballistics.js';
import { launchFrom } from '../simulation/pose.js';
import { surfaceFor } from '../terrain/surface.js';
import type { Surface } from '../terrain/surface.js';
import { snapshotSharedFrame } from './shared-frame.js';
import type { SharedWorldFrame } from './shared-frame.js';

/** Presentation only: contact hides this bomb, never creates an authoritative impact. */
export class LocalDrop {
  readonly releasedAt: number;
  private readonly bomb: Bomb;
  private readonly surface: Surface;
  private readonly terrain: TerrainTheme;
  private steps = 0;
  private contacted = false;
  private lastTime: number;
  constructor(frame: SharedWorldFrame, readonly slot: PlayerSlot) {
    if (!frame.ready || frame.viewedSlot !== slot || frame.aircraft[slot].released ||
      frame.aircraft[slot].destroyed || frame.aircraft[slot].bomb) throw new Error('Local prediction requires a releasable drawn aircraft.');
    this.releasedAt = frame.time; this.lastTime = frame.time;
    this.bomb = launchFrom(frame.aircraft[slot].pose);
    this.surface = surfaceFor(frame.terrain);
    this.terrain = frame.terrain;
  }
  frame(source: SharedWorldFrame): SharedWorldFrame {
    if (source.time < this.lastTime || source.terrain !== this.terrain) throw new Error('Local drop presentation changed its clock or course.');
    this.lastTime = source.time;
    while (!this.contacted && this.releasedAt + (this.steps + 1) * STEP <= source.time) {
      if (this.steps >= MAX_BOMB_SECONDS / STEP) throw new Error('Local bomb prediction exceeded its supported flight duration.');
      this.steps++;
      this.contacted = advanceBomb(this.bomb, STEP, this.surface) !== null;
    }
    const aircraft = { ...source.aircraft[this.slot], released: true, bomb: this.contacted ? null : this.bomb };
    return snapshotSharedFrame({ ...source, ready: false, prediction: null,
      aircraft: this.slot === 0 ? [aircraft, source.aircraft[1]] : [source.aircraft[0], aircraft] });
  }
}
