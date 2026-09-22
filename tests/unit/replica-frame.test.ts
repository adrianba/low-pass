import { describe, expect, it } from 'vitest';
import { snapshot } from '../../shared/protocol/game.js';
import { STEP } from '../../src/config/game.js';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler.js';
import { formationData } from '../../src/network/formation-data.js';
import { ReplicaPlans } from '../../src/network/replica-plans.js';
import { sessionSnapshot } from '../../src/network/session-snapshot.js';
import { hostWorldFrame } from '../../src/rendering/host-frame.js';
import { replicaWorldFrame } from '../../src/rendering/replica-frame.js';
import { advanceBomb } from '../../src/simulation/ballistics.js';
import { launchFrom } from '../../src/simulation/pose.js';
import { surfaceFor } from '../../src/terrain/surface.js';
import type { TerrainTheme } from '../../src/config/terrain.js';

function setup(terrain: TerrainTheme) {
  const scheduler = new FormationScheduler(terrain, 7), plans = new ReplicaPlans();
  const references = new Map([0, 1].map(sequence => {
    const reference = { id: `flight-${sequence}`, digest: 'a'.repeat(64) };
    plans.installVerified({ reference, payload: { kind: 'formation', data: formationData(scheduler.plan(sequence), sequence) } });
    return [sequence, reference] as const;
  }));
  plans.commit([...references.values()]);
  const take = () => snapshot.parse(JSON.parse(JSON.stringify(sessionSnapshot(scheduler.session, {
    plans: references, planRevision: 0, eventSequence: scheduler.session.lastEventId,
    coreEventId: scheduler.session.lastEventId, lastInputs: [0, 0], effects: [],
  }))));
  return { scheduler, plans, take };
}
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe('plan-driven guest render frames', () => {
  it.each(['green-valley', 'desert', 'river-canyon'] as const)('matches the host %s frame and advances canonical bomb checkpoints', terrain => {
    const state = setup(terrain), plan = state.scheduler.plan();
    state.scheduler.advanceTo(plan.attempts[0].releaseAt);
    state.scheduler.session.release(0, 0);
    state.scheduler.advanceTo(state.scheduler.session.time + 10 * STEP + 0.003);
    const checkpoint = state.take(), before = structuredClone(checkpoint);
    const now = state.scheduler.session.time;
    const received = replicaWorldFrame(checkpoint, state.plans, 7, 1, now);
    const original = hostWorldFrame(state.scheduler, 1);
    expect(received.aircraft[0].bomb!.age).toBeCloseTo(original.aircraft[0].bomb!.age, 12);
    expect(normalized({ ...received, aircraft: received.aircraft.map(aircraft => ({ ...aircraft,
      bomb: aircraft.bomb ? { ...aircraft.bomb, age: 0 } : null })) })).toEqual(
      normalized({ ...original, aircraft: original.aircraft.map(aircraft => ({ ...aircraft,
        bomb: aircraft.bomb ? { ...aircraft.bomb, age: 0 } : null })) }));
    const future = now + 0.2;
    const forecast = replicaWorldFrame(checkpoint, state.plans, 7, 1, future);
    state.scheduler.advanceTo(future);
    const actual = hostWorldFrame(state.scheduler, 1);
    expect(forecast.aircraft[0].bomb!.position).toEqual(actual.aircraft[0].bomb!.position);
    expect(forecast.aircraft[0].bomb!.velocity).toEqual(actual.aircraft[0].bomb!.velocity);
    expect(forecast.views).toEqual(actual.views);
    expect(forecast.aircraft.map(aircraft => aircraft.pose)).toEqual(actual.aircraft.map(aircraft => aircraft.pose));
    expect(checkpoint).toEqual(before);
    expect(() => replicaWorldFrame(checkpoint, state.plans, 7, 1, now + 0.51)).toThrow('window');
  });

  it.each(['green-valley', 'desert', 'river-canyon'] as const)('hides the predicted %s contact without inventing an authoritative hit or wreck', terrain => {
    const state = setup(terrain), plan = state.scheduler.plan(), releaseAt = plan.attempts[0].releaseAt;
    const bomb = launchFrom(plan.attempts[0].track.at(0)), surface = surfaceFor(terrain);
    let steps = 0;
    while (++steps <= 2400 && !advanceBomb(bomb, STEP, surface)) { /* Count canonical steps to first contact. */ }
    expect(steps).toBeLessThan(2400);
    const contactAt = releaseAt + steps * STEP;
    state.scheduler.advanceTo(releaseAt); state.scheduler.session.release(0, 0);
    state.scheduler.advanceTo(contactAt - 0.05);
    const checkpoint = state.take(), frame = replicaWorldFrame(checkpoint, state.plans, 7, 0, contactAt + 0.01);
    expect(frame.aircraft[0].bomb).toBeNull(); expect(frame.aircraft[0].released).toBe(true);
    expect(frame.impacts).toEqual([]); expect(frame.targets[0]!.destroyed).toBe(false);
    expect(checkpoint.players[0].score).toBe(0);
    state.scheduler.advanceTo(contactAt + 0.01);
    const committed = replicaWorldFrame(state.take(), state.plans, 7, 0, state.scheduler.session.time);
    expect(committed.impacts).toHaveLength(1); expect(committed.targets[0]!.destroyed).toBe(true);
    expect(state.scheduler.session.snapshot().players[0]!.score).toBe(100);
  });

  it('freezes paused frames and rejects ahead-of-state bomb steps or incomplete finale presentation', () => {
    const state = setup('green-valley'), plan = state.scheduler.plan();
    state.scheduler.advanceTo(plan.attempts[0].releaseAt); state.scheduler.session.release(0, 0);
    state.scheduler.session.pause();
    const checkpoint = state.take();
    expect(replicaWorldFrame(checkpoint, state.plans, 7, 0, state.scheduler.session.time).ready).toBe(false);
    expect(() => replicaWorldFrame(checkpoint, state.plans, 7, 0, state.scheduler.session.time + 0.01)).toThrow('window');
    checkpoint.players[0].bomb!.steps++;
    expect(() => replicaWorldFrame(checkpoint, state.plans, 7, 0, state.scheduler.session.time)).toThrow('checkpoint');
    const dead = state.take(); dead.players[0].misses = 3; dead.players[0].eliminated = true; dead.players[0].bomb = null;
    expect(() => replicaWorldFrame(dead, state.plans, 7, 0, state.scheduler.session.time)).toThrow('frozen combat');
  });
});
