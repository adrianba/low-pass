import { describe, expect, it } from 'vitest';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler.js';
import { planFormation } from '../../src/game/formation/approved.js';
import { restoreFormation, serializeFormation } from '../../src/game/formation/serialized.js';
import { formationData } from '../../src/network/formation-data.js';
import { ChaseTimeline } from '../../src/simulation/chase-timeline.js';
import { valleySurface } from '../../src/terrain/surface.js';

describe('off-thread authored formation ownership', () => {
  it.each(['green-valley', 'desert', 'river-canyon'] as const)('preserves exact %s tracks, camera samples and numeric handoffs', terrain => {
    const scheduled = new FormationScheduler(terrain, 7), external = new FormationScheduler(terrain, 7);
    external.useExternalLookahead();
    for (let sequence = 0; sequence < 5; sequence++) {
      const request = external.nextRequest();
      if (request) {
        const authored = planFormation(request);
        if (!authored.ok) throw new Error('Expected authored worker plan.');
        const numeric = structuredClone(serializeFormation(authored.plan));
        const restored = restoreFormation(numeric);
        expect(formationData(restored, request.count)).toEqual(formationData(authored.plan, request.count));
        const original = restored.attempts[0].camera.at(restored.startAt - restored.attempts[0].releaseAt);
        const point = numeric.attempts[0].track.knots[0]!.pose.position;
        const originalPoint = restored.attempts[0].track.at(restored.attempts[0].track.startTime).position;
        Object.assign(point, { x: point.x + 100 });
        expect(restored.attempts[0].track.at(restored.attempts[0].track.startTime).position).toEqual(originalPoint);
        expect(restored.attempts[0].camera.at(restored.startAt - restored.attempts[0].releaseAt)).toEqual(original);
        external.installLookahead(request.count, restored);
      }
      expect(formationData(external.plan(), sequence)).toEqual(formationData(scheduled.plan(), sequence));
      const plan = external.plan();
      for (const slot of [0, 1] as const) {
        scheduled.advanceTo(plan.attempts[slot].releaseAt); scheduled.session.release(slot, sequence);
        external.advanceTo(plan.attempts[slot].releaseAt); external.session.release(slot, sequence);
      }
      scheduled.advanceTo(plan.handoffAt); external.advanceTo(plan.handoffAt);
      scheduled.session.drainEvents(); external.session.drainEvents();
      expect(external.retainedSequences.length).toBeLessThanOrEqual(4);
    }
  }, 60_000);

  it('rejects malformed imported camera intervals without regenerating samples', () => {
    const samples = [{ time: 0, position: { x: 0, y: 20, z: 0 }, target: { x: 0, y: 20, z: 10 } },
      { time: 1, position: { x: 0, y: 20, z: 1 }, target: { x: 0, y: 20, z: 11 } }];
    const camera = new ChaseTimeline(samples, valleySurface, 0, 1);
    samples[0]!.position.x = 40;
    expect(camera.at(0).position.x).toBe(0);
    expect(() => new ChaseTimeline([samples[1]!, samples[0]!], valleySurface, 0, 1)).toThrow('samples');
    expect(() => new ChaseTimeline([samples[0]!, samples[0]!], valleySurface, 0, 1)).toThrow('samples');
  });
});
