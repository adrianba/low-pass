import { describe, expect, it } from 'vitest';
import { difficulty, STEP, TARGET_RADIUS } from '../../src/config/game';
import { contactAccuracy, predictImpact } from '../../src/simulation/ballistics';
import { distance } from '../../src/simulation/math';
import { initialPose, launchFrom } from '../../src/simulation/pose';
import { valleySurface } from '../../src/terrain/surface';
import { FormationTrack } from '../../src/game/formation/track';
import { FORMATION_FUTURE, formationPose, planValleyFormation } from '../../src/game/formation/valley';
import type { ValleyFormation, ValleyFormationInput } from '../../src/game/formation/valley';
import { releaseWindows } from '../helpers/flight-probe';

// Measurement candidates only. G1 must still approve lag, path and viewport.
function input(seed = 1): ValleyFormationInput {
  return {
    encounterId: 'formation-1', count: 0, seed, terrain: 'green-valley', startAt: 0,
    previous: [initialPose(), initialPose({ x: -8, y: 167, z: -114 })],
    previousViews: [null, null],
    candidates: [{ lag: 1.5, maxLagAdjustment: 0.1, phaseDelta: 0.35, maxLateralCorrection: 80, maxForwardCorrection: 20 }],
    viewport: { minAspect: 0.75, maxAspect: 2 }, acquisitionMargin: 0.1,
  };
}
function requirePlan(value: ValleyFormationInput): ValleyFormation {
  const result = planValleyFormation(value);
  if (!result.ok) throw new Error(JSON.stringify({ count: value.count, seed: value.seed, failures: result.failures }));
  return result.plan;
}

describe('bounded paired valley formation prototype', () => {
  it('authors one shared target and two independent, moving release-zero tracks', () => {
    const request = input(), plan = requirePlan(request);
    expect(plan.radius).toBe(TARGET_RADIUS);
    expect(plan.attempts[1].releaseAt - plan.attempts[0].releaseAt).toBeCloseTo(plan.releaseLag, 12);
    expect(plan.releaseLag).toBeGreaterThanOrEqual(1.5);
    expect(plan.releaseLag).toBeLessThanOrEqual(1.6);
    for (const attempt of plan.attempts) {
      expect(attempt.encounterId).toBe(plan.encounterId);
      expect(formationPose(attempt, plan.startAt)).toEqual(request.previous[attempt.slot]);
      expect(formationPose(attempt, plan.startAt + STEP).position.z).toBeGreaterThan(request.previous[attempt.slot].position.z);
      expect(attempt.track.at(0)).toEqual(attempt.track.motion.knots.find(k => k.time === 0)!.pose);
      expect(contactAccuracy(predictImpact(launchFrom(attempt.track.at(0)), valleySurface), plan.target, valleySurface)).toBe(100);
      expect(() => formationPose(attempt, plan.startAt - STEP)).toThrow(/cover/);
      expect(attempt.track.motion.knots.length).toBeLessThan(300);
      expect(formationPose(attempt, plan.coverageEndAt).position.z).toBeGreaterThan(formationPose(attempt, plan.handoffAt).position.z);
      expect(plan.coverageEndAt - plan.handoffAt).toBe(FORMATION_FUTURE);
    }
    const lead = plan.attempts[0].track.at(0), follower = plan.attempts[1].track.at(0);
    expect(distance(lead.velocity, follower.velocity)).toBeGreaterThan(0.1);
    expect(distance(lead.position, follower.position)).toBeGreaterThan(0.1);
  });

  it.each([1, 19, 827])('measures both release windows, camera envelopes and sequential tiers for seed %i', seed => {
    let request = input(seed);
    const measurements: Array<{ slot: number; hit: number; precision: number }> = [];
    for (let count = 0; count < 15; count++) {
      request = { ...request, count, encounterId: `seed-${seed}-${count}` };
      const plan = requirePlan(request);
      expect(plan.releaseLag).toBeGreaterThanOrEqual(plan.candidate.lag);
      expect(plan.releaseLag).toBeLessThanOrEqual(plan.candidate.lag + plan.candidate.maxLagAdjustment);
      for (const attempt of plan.attempts) {
        expect(formationPose(attempt, plan.startAt)).toEqual(request.previous[attempt.slot]);
        if (request.previousViews[attempt.slot]) {
          expect(attempt.camera.at(attempt.track.startTime)).toEqual(request.previousViews[attempt.slot]);
        }
        const imported = FormationTrack.fromData(JSON.parse(JSON.stringify(attempt.track.toData())));
        for (const shared of [plan.startAt, attempt.acquireAt, attempt.releaseAt, attempt.cutoffAt, plan.handoffAt, plan.coverageEndAt]) {
          expect(imported.at(shared - attempt.releaseAt)).toEqual(formationPose(attempt, shared));
        }
        const release = attempt.track.at(0);
        expect(release.velocity.z).toBe(difficulty(count).speed);
        // Valley retains forward-speed timing, not Canyon's full-3D cap.
        expect(Math.hypot(release.velocity.x, release.velocity.z)).toBeGreaterThanOrEqual(difficulty(count).speed);
        const windows = releaseWindows(t =>
          contactAccuracy(predictImpact(launchFrom(attempt.track.at(t)), valleySurface), plan.target, valleySurface),
        -0.6, 0.6);
        expect(windows.hits).toHaveLength(1);
        expect(windows.precision).toHaveLength(1);
        expect(windows.hits[0]!.start).toBeLessThan(-0.06);
        expect(windows.hits[0]!.end).toBeGreaterThan(0.06);
        expect(windows.precision[0]!.start).toBeLessThan(-0.003);
        expect(windows.precision[0]!.end).toBeGreaterThan(0.003);
        measurements.push({ slot: attempt.slot, hit: windows.hits[0]!.end - windows.hits[0]!.start,
          precision: windows.precision[0]!.end - windows.precision[0]!.start });
        const localAcquisition = attempt.acquireAt - attempt.releaseAt;
        expect(localAcquisition).toBeLessThanOrEqual(-difficulty(count).diveDuration - 0.5);
        if (count >= 8) expect(localAcquisition).toBeGreaterThan(-6);
        expect(attempt.track.motion.knots.length).toBeLessThan(320);
        for (const aspect of [0.75, 1, 4 / 3, 16 / 9, 2]) {
          expect(attempt.camera.verify(localAcquisition, attempt.camera.at(localAcquisition), aspect, attempt.acquisition)).toEqual({ ok: true });
        }
        const a = attempt.track.at(0), b = attempt.track.at(0);
        a.position.x += 100;
        expect(attempt.track.at(0)).toEqual(b);
        for (let i = 1; i < attempt.track.motion.knots.length; i++) {
          const a = attempt.track.motion.knots[i - 1]!, b = attempt.track.motion.knots[i]!;
          const middle = attempt.track.at((a.time + b.time) / 2);
          for (const axis of ['bank', 'pitch'] as const) {
            expect(middle[axis]).toBeGreaterThanOrEqual(Math.min(a.pose[axis], b.pose[axis]) - 1e-12);
            expect(middle[axis]).toBeLessThanOrEqual(Math.max(a.pose[axis], b.pose[axis]) + 1e-12);
          }
        }
        // Check position, velocity, acceleration AND attitude around every knot.
        for (const knot of attempt.track.motion.knots.slice(1, -1)) {
          expect(attempt.track.at(knot.time)).toEqual(knot.pose);
          const before = attempt.track.at(knot.time - 1e-8), after = attempt.track.at(knot.time + 1e-8);
          expect(distance(before.position, after.position)).toBeLessThan(0.001);
          expect(distance(before.velocity, after.velocity)).toBeLessThan(0.001);
          expect(distance(before.acceleration, after.acceleration),
            JSON.stringify({ count, slot: attempt.slot, time: knot.time, before, after })).toBeLessThan(0.001);
          expect(Math.abs(before.bank - after.bank)).toBeLessThan(0.001);
          expect(Math.abs(before.pitch - after.pitch)).toBeLessThan(0.001);
        }
      }
      request = { ...request, startAt: plan.handoffAt,
        previous: [formationPose(plan.attempts[0], plan.handoffAt), formationPose(plan.attempts[1], plan.handoffAt)],
        previousViews: [plan.attempts[0].camera.at(plan.handoffAt - plan.attempts[0].releaseAt),
          plan.attempts[1].camera.at(plan.handoffAt - plan.attempts[1].releaseAt)] };
    }
    console.info('Unapproved formation prototype window widths', JSON.stringify({ seed, slots: [0, 1].map(slot => {
      const values = measurements.filter(m => m.slot === slot);
      return { slot, hit: [Math.min(...values.map(m => m.hit)), Math.max(...values.map(m => m.hit))],
        precision: [Math.min(...values.map(m => m.precision)), Math.max(...values.map(m => m.precision))] };
    }) }));
  }, 120_000);

  it('keeps Green Valley and Desert physics identical without rerolling selection', () => {
    const green = requirePlan(input(29)), desert = requirePlan({ ...input(29), terrain: 'desert' });
    expect(desert.target).toEqual(green.target);
    expect(desert.targetKind).toBe(green.targetKind);
    for (const slot of [0, 1] as const) {
      expect(desert.attempts[slot].track.toData()).toEqual(green.attempts[slot].track.toData());
      expect(desert.attempts[slot].acquireAt).toBe(green.attempts[slot].acquireAt);
    }
  });

  it('joins full incoming dive motion instead of replacing it with cruise or a waiting pose', () => {
    const prior = requirePlan(input()), shared = prior.startAt + 0.5;
    const previous = [formationPose(prior.attempts[0], shared), formationPose(prior.attempts[1], shared)] as const;
    expect(Math.abs(previous[0].velocity.y)).toBeGreaterThan(1);
    expect(Math.abs(previous[0].acceleration.y)).toBeGreaterThan(1);
    const next = requirePlan({ ...input(), count: 1, startAt: 37, previous, previousViews: [
      prior.attempts[0].camera.at(shared - prior.attempts[0].releaseAt),
      prior.attempts[1].camera.at(shared - prior.attempts[1].releaseAt),
    ] });
    for (const attempt of next.attempts) {
      expect(formationPose(attempt, next.startAt)).toEqual(previous[attempt.slot]);
      const after = formationPose(attempt, next.startAt + 1e-8), before = previous[attempt.slot];
      expect(distance(before.position, after.position)).toBeLessThan(0.001);
      expect(distance(before.velocity, after.velocity)).toBeLessThan(0.001);
      expect(distance(before.acceleration, after.acceleration)).toBeLessThan(0.001);
      expect(Math.abs(before.bank - after.bank)).toBeLessThan(0.001);
      expect(Math.abs(before.pitch - after.pitch)).toBeLessThan(0.001);
    }
  });

  it('rejects invalid inputs and reports candidate exhaustion without a fallback', () => {
    expect(() => planValleyFormation({ ...input(), candidates: [] })).toThrow(/Invalid/);
    expect(() => planValleyFormation({ ...input(), terrain: 'river-canyon' as 'desert' })).toThrow(/Invalid/);
    expect(() => planValleyFormation({ ...input(), viewport: { minAspect: 2, maxAspect: 1 } })).toThrow(/Invalid/);
    expect(() => planValleyFormation({ ...input(), acquisitionMargin: 0 })).toThrow(/Invalid/);
    expect(() => planValleyFormation({ ...input(), candidates: Array(9).fill(input().candidates[0]) })).toThrow(/Invalid/);
    expect(() => planValleyFormation({ ...input(), previous: [initialPose(), {
      ...initialPose(), velocity: { x: 0, y: 0, z: Number.NaN },
    }] })).toThrow(/Invalid/);
    const request = input();
    const bad = { ...request.candidates[0]!, maxLateralCorrection: 0.00001 };
    const exhausted = planValleyFormation({ ...request, candidates: [bad, bad] });
    expect(exhausted).toMatchObject({ ok: false, failures: [
      { candidate: 0, reason: 'correction_bounds' }, { candidate: 1, reason: 'correction_bounds' },
    ] });
    const recovered = requirePlan({ ...request, candidates: [bad, ...request.candidates] });
    expect(recovered.rejected).toHaveLength(1);
    const hidden = planValleyFormation({ ...request, viewport: { minAspect: 0.001, maxAspect: 0.001 } });
    expect(hidden).toMatchObject({ ok: false, failures: [{ reason: 'acquisition' }] });
    const noTimingAllowance = planValleyFormation({ ...request,
      previous: [request.previous[0], initialPose({ x: -8, y: 167, z: -124 })],
      candidates: [{ ...request.candidates[0]!, maxLagAdjustment: 0 }] });
    expect(noTimingAllowance).toMatchObject({ ok: false, failures: [{ reason: 'lag_bounds' }] });
    const unsafe = planValleyFormation({ ...request,
      previous: [initialPose({ x: 0, y: 13, z: 0 }), request.previous[1]] });
    expect(unsafe).toMatchObject({ ok: false, failures: [{ reason: 'clearance' }] });
  });
});
