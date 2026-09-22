import { compareStamps, secondsAt, stampAt } from '../../shared/protocol/game.js';
import type { Snapshot } from '../../shared/protocol/game.js';
import { STEP } from '../config/game.js';
import { FINALE_DURATION } from '../game/combat-timing.js';
import { MAX_BOMB_SECONDS } from '../game/multiplayer/session.js';
import type { PlayerSlot } from '../game/multiplayer/session.js';
import { REPLICA_CLOCK_LIMITS } from '../network/replica-clock.js';
import type { ReplicaPlans } from '../network/replica-plans.js';
import { releaseTime } from '../network/release-time.js';
import { advanceBomb } from '../simulation/ballistics.js';
import type { Bomb } from '../simulation/ballistics.js';
import { hash } from '../simulation/math.js';
import { surfaceFor } from '../terrain/surface.js';
import type { SharedPresentation } from './host-frame.js';
import { snapshotSharedFrame } from './shared-frame.js';
import type { SharedWorldFrame } from './shared-frame.js';

export function replicaWorldFrame(state: Snapshot, plans: ReplicaPlans, seed: number, viewedSlot: PlayerSlot,
  time: number, presentation: SharedPresentation = {}): SharedWorldFrame {
  const at = stampAt(time), sampledAt = secondsAt(state.at);
  const maximum = state.status === 'over' ? FINALE_DURATION : REPLICA_CLOCK_LIMITS.futureSeconds;
  if (!Number.isSafeInteger(seed) || compareStamps(at, state.at) < 0 || compareStamps(at, stampAt(sampledAt + maximum)) > 0 ||
    (state.status === 'paused' || state.status === 'blocked') && compareStamps(at, state.at) !== 0) {
    throw new Error('Replica frame exceeds its authoritative presentation window.');
  }
  if (state.players.some(player => player.eliminated) && (!presentation.poses || !presentation.views || !presentation.destroyed)) {
    throw new Error('Eliminated replica aircraft require frozen combat presentation.');
  }
  const flightTime = state.status === 'over' ? sampledAt : time;
  const retained = state.plans.map(ref => plans.formation(ref)).sort((a, b) => a.sequence - b.sequence);
  const visible = retained.filter(plan => plan.startAt <= flightTime);
  const current = visible.at(-1);
  if (!current || flightTime > current.handoffAt && state.status !== 'over') throw new Error('Replica frame lacks committed flight coverage.');
  const surface = surfaceFor(current.terrain);
  const aircraft = (slot: PlayerSlot) => {
    const player = state.players[slot], source = player.bomb;
    let bomb: Bomb | null = null;
    if (source) {
      const flight = retained.find(plan => plan.sequence === source.sequence);
      if (!flight) throw new Error('Missing replica bomb flight.');
      const releasedAt = releaseTime(source.releasedAt, flight.releaseWindow(slot));
      if (compareStamps(source.releasedAt, state.at) > 0 || compareStamps(stampAt(releasedAt + source.steps * STEP), state.at) > 0) {
        throw new Error('Replica bomb checkpoint is ahead of its snapshot.');
      }
      const value = { position: { ...source.position }, velocity: { ...source.velocity }, age: source.steps * STEP };
      let steps = source.steps, contacted = false;
      while (releasedAt + (steps + 1) * STEP <= time) {
        if (steps >= MAX_BOMB_SECONDS / STEP) throw new Error('Replica bomb exceeds supported flight duration.');
        steps++;
        if (advanceBomb(value, STEP, surface)) { contacted = true; break; }
      }
      if (!contacted) bomb = value;
    }
    const releasedCurrent = source?.sequence === current.sequence || state.results.some(result =>
      result.slot === slot && result.sequence === current.sequence && result.impact !== null);
    return { pose: presentation.poses?.[slot] ?? current.pose(slot, flightTime), bomb,
      released: bomb !== null || releasedCurrent, destroyed: presentation.destroyed?.[slot] ?? false };
  };
  const pair = [aircraft(0), aircraft(1)] as const;
  const player = state.players[viewedSlot], window = current.releaseWindow(viewedSlot);
  const ready = state.status === 'running' && !player.eliminated && !pair[viewedSlot].released &&
    (player.lastResolved ?? -1) < current.sequence && time >= window.acquireAt && time <= window.cutoffAt;
  return snapshotSharedFrame({
    time, terrain: current.terrain, viewedSlot, aircraft: pair,
    views: presentation.views ?? [current.view(0, flightTime), current.view(1, flightTime)],
    targets: visible.map(plan => ({ id: plan.sequence + 1, position: plan.target, kind: plan.targetKind,
      heading: hash(plan.sequence + 1, 7, seed) * Math.PI * 2, sightDistance: plan.sightDistance,
      canyon: plan.terrain === 'river-canyon',
      destroyed: state.results.some(result => result.sequence === plan.sequence && result.points > 0 && result.time <= time) })),
    impacts: state.results.flatMap(result => result.impact && result.time <= time && visible.some(plan => plan.sequence === result.sequence)
      ? [{ id: result.id, sequence: result.sequence, slot: result.slot, time: result.time, impact: result.impact }] : []),
    ready, prediction: presentation.prediction ?? null, effectPositions: presentation.effectPositions ?? [],
  });
}
