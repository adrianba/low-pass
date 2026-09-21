import { describe, expect, it } from 'vitest';
import { difficulty, FLOOR, STEP, TARGET_RADIUS } from '../../src/config/game';
import { canyonFormationPose, MAX_CANYON_PAIR_DURATION, MAX_CLEARANCE_NODES, planCanyonFormation } from '../../src/game/formation/canyon';
import type { CanyonFormation, CanyonFormationInput } from '../../src/game/formation/canyon';
import { FlightTrack, motionPose, speedOf } from '../../src/simulation/flight-track';
import { initialPose, launchFrom } from '../../src/simulation/pose';
import type { Pose } from '../../src/simulation/pose';
import { advanceBomb, contactAccuracy, predictImpact } from '../../src/simulation/ballistics';
import { projectChase } from '../../src/simulation/chase-camera';
import { canyonCandidate } from '../../src/game/canyon-flight';
import { distance } from '../../src/simulation/math';
import { routePoint } from '../../src/terrain/canyon-route';
import { canyonSurface } from '../../src/terrain/surface';
import { releaseWindows } from '../helpers/flight-probe';

function input(seed = 7): CanyonFormationInput {
  return {
    encounterId: 'paired-canyon-0', count: 0, seed, startAt: 0,
    previous: [initialPose({ ...routePoint(600, 0), y: 167 }),
      initialPose({ ...routePoint(600 - 76 * 1.2, 0), y: 167 })],
    previousViews: [null, null],
    candidates: [
      { lag: 1.2, phaseDelta: 0.12, entryPadding: 0, maxEntryExtension: 3 },
      { lag: 1.2, phaseDelta: -0.12, entryPadding: 0, maxEntryExtension: 3 },
    ],
    viewport: { minAspect: 0.75, maxAspect: 2 }, acquisitionMargin: 0.1,
    departure: { before: 0.1, after: 0.2, screenMargin: 0.02 },
  };
}
function requirePlan(request: CanyonFormationInput): CanyonFormation {
  const result = planCanyonFormation(request);
  if (!result.ok) throw new Error(JSON.stringify({ count: request.count, seed: request.seed,
    work: result.work, failures: result.failures }));
  return result.plan;
}
function expectSamePose(actual: Pose, expected: Pose): void {
  // Track data intentionally canonicalizes signed zero for JSON. Numeric
  // equality is exact here; no motion or attitude tolerance masks a handoff.
  for (const field of ['position', 'velocity', 'acceleration'] as const) {
    for (const axis of ['x', 'y', 'z'] as const) expect(actual[field][axis] === expected[field][axis]).toBe(true);
  }
  expect(actual.bank === expected.bank).toBe(true);
  expect(actual.pitch === expected.pitch).toBe(true);
}

describe('paired Canyon prototype', () => {
  it('solves two independent physical releases to one dry shelf on a shared clock', () => {
    const request = input(), plan = requirePlan(request);
    expect(plan.radius).toBe(TARGET_RADIUS);
    expect(plan.attempts[1].releaseAt - plan.attempts[0].releaseAt).toBeCloseTo(1.2, 10);
    for (const attempt of plan.attempts) {
      expect(attempt.encounterId).toBe(plan.encounterId);
      expectSamePose(canyonFormationPose(attempt, plan.startAt), request.previous[attempt.slot]);
      expect(distance(canyonFormationPose(attempt, plan.startAt + STEP).position,
        request.previous[attempt.slot].position)).toBeGreaterThan(0);
      expect(contactAccuracy(predictImpact(launchFrom(attempt.track.at(0)), canyonSurface),
        plan.target, canyonSurface)).toBe(100);
      expect(attempt.track.respectsSpeed(difficulty(0).speed)).toBe(true);
      expect(() => canyonFormationPose(attempt, plan.startAt - STEP)).toThrow(/cover/);
    }
    expect(distance(plan.attempts[0].track.at(0).velocity, plan.attempts[1].track.at(0).velocity)).toBeGreaterThan(0.1);
    expect(distance(plan.attempts[0].track.at(0).position, plan.attempts[1].track.at(0).position)).toBeGreaterThan(0.1);
    expect(canyonSurface.height(plan.target.x, plan.target.z)).toBe(FLOOR);
  });

  it.each([7, 29])('preserves full shared-time handoffs through 28 sequential passes for seed %i', seed => {
    let request = input(seed);
    const sides = new Set<number>();
    const widths: Array<{ hit: number; precision: number }> = [];
    let nativeCandidates = 0, pairedCandidates = 0, clearanceNodes = 0, knots = 0, maxMs = 0, duration = 0, extension = 0;
    for (let count = 0; count < 28; count++) {
      request = { ...request, count, encounterId: `paired-canyon-${count}` };
      const started = performance.now(), plan = requirePlan(request);
      maxMs = Math.max(maxMs, performance.now() - started);
      sides.add(plan.side);
      nativeCandidates = Math.max(nativeCandidates, plan.work.nativeCandidates);
      pairedCandidates = Math.max(pairedCandidates, plan.work.pairedCandidates);
      clearanceNodes = Math.max(clearanceNodes, plan.work.clearanceNodes);
      duration = Math.max(duration, plan.coverageEndAt - plan.startAt);
      expect(plan.work.nativeCandidates).toBeLessThanOrEqual(12 * (1 + request.candidates.length));
      expect(plan.work.pairedCandidates).toBeLessThanOrEqual(12 * request.candidates.length);
      expect(plan.work.clearanceNodes).toBeLessThanOrEqual(2 * MAX_CLEARANCE_NODES * plan.work.pairedCandidates);
      expect(plan.coverageEndAt - plan.handoffAt).toBeCloseTo(5.5, 10);
      for (let dx = -TARGET_RADIUS; dx <= TARGET_RADIUS; dx += 4) {
        for (let dz = -TARGET_RADIUS; dz <= TARGET_RADIUS; dz += 4) {
          expect(canyonSurface.height(plan.target.x + dx, plan.target.z + dz)).toBe(FLOOR);
        }
      }
      for (const attempt of plan.attempts) {
        expectSamePose(canyonFormationPose(attempt, plan.startAt), request.previous[attempt.slot]);
        expect(attempt.track.respectsSpeed(difficulty(count).speed)).toBe(true);
        knots = Math.max(knots, attempt.track.knots.length);
        extension = Math.max(extension, attempt.entryExtension);
        expect(attempt.entryExtension).toBeLessThanOrEqual(plan.candidate.maxEntryExtension + 1e-9);
        expect(attempt.track.endTime - attempt.track.startTime).toBeLessThanOrEqual(MAX_CANYON_PAIR_DURATION);
        expect(attempt.track.knots.length).toBeLessThan(500);
        if (request.previousViews[attempt.slot]) {
          expect(attempt.camera.at(attempt.track.startTime)).toEqual(request.previousViews[attempt.slot]);
        }
        const imported = FlightTrack.fromData(JSON.parse(JSON.stringify(attempt.track.toData())));
        for (const shared of [plan.startAt, attempt.entryEndAt, attempt.acquireAt, attempt.releaseAt,
          attempt.cutoffAt, attempt.endAt, plan.handoffAt, plan.coverageEndAt]) {
          expect(imported.at(shared - attempt.releaseAt)).toEqual(canyonFormationPose(attempt, shared));
        }
        for (const knot of attempt.track.knots.slice(1, -1)) {
          expect(attempt.track.at(knot.time)).toEqual(knot.pose);
          const before = attempt.track.at(knot.time - 1e-8), after = attempt.track.at(knot.time + 1e-8);
          expect(distance(before.position, after.position)).toBeLessThan(0.001);
          expect(distance(before.velocity, after.velocity)).toBeLessThan(0.001);
          expect(distance(before.acceleration, after.acceleration)).toBeLessThan(0.001);
          expect(Math.abs(before.bank - after.bank)).toBeLessThan(0.001);
          expect(Math.abs(before.pitch - after.pitch)).toBeLessThan(0.001);
        }
        const windows = releaseWindows(t => contactAccuracy(
          predictImpact(launchFrom(attempt.track.at(t)), canyonSurface), plan.target, canyonSurface),
        attempt.acquireAt - attempt.releaseAt, attempt.cutoffAt - attempt.releaseAt, STEP / 2);
        expect(windows.hits).toHaveLength(1);
        expect(windows.precision).toHaveLength(1);
        const hit = windows.hits[0]!.end - windows.hits[0]!.start;
        const precision = windows.precision[0]!.end - windows.precision[0]!.start;
        expect(hit).toBeGreaterThan(0.08);
        expect(precision).toBeGreaterThan(0.005);
        widths.push({ hit, precision });
        const acquired = attempt.acquireAt - attempt.releaseAt;
        expect(attempt.acquireAt + request.acquisitionMargin).toBeLessThanOrEqual(attempt.diveAt + 1e-8);
        for (const aspect of [0.75, 1, 16 / 9, 2]) {
          expect(attempt.camera.verify(acquired, attempt.camera.at(acquired), aspect, attempt.acquisition)).toEqual({ ok: true });
        }
        for (let shared = plan.startAt; shared < plan.coverageEndAt; shared += 0.1) {
          const pose = canyonFormationPose(attempt, shared);
          const derived = motionPose(pose.position, pose.velocity, pose.acceleration);
          expect(pose.bank).toBeCloseTo(derived.bank, 10);
          expect(pose.pitch).toBeCloseTo(derived.pitch, 10);
          expect(speedOf(pose)).toBeLessThanOrEqual(difficulty(count).speed + 0.001);
          expect(pose.velocity.z).toBeGreaterThan(0);
          for (const dx of [-14, 0, 14]) for (const dz of [-14, 0, 14]) {
            expect(pose.position.y - canyonSurface.height(pose.position.x + dx, pose.position.z + dz)).toBeGreaterThan(14);
          }
        }
      }
      const lead = plan.attempts[0], follower = plan.attempts[1];
      const bomb = launchFrom(lead.track.at(0));
      for (let tick = -12; tick <= 24; tick++) {
        const shared = lead.releaseAt + tick * STEP;
        const pose = canyonFormationPose(lead, shared);
        const view = follower.camera.at(shared - follower.releaseAt);
        const points = [];
        for (const x of [-14, 14]) for (const y of [-14, 14]) for (const z of [-14, 14]) {
          points.push({ x: pose.position.x + x, y: pose.position.y + y, z: pose.position.z + z });
        }
        if (tick > 0) expect(advanceBomb(bomb, STEP, canyonSurface)).toBeNull();
        if (tick >= 0) points.push(bomb.position);
        for (const point of points) for (const aspect of [0.75, 1, 16 / 9, 2]) {
          const screen = projectChase(point, view, aspect);
          expect(screen).not.toBeNull();
          expect(screen!.x).toBeGreaterThanOrEqual(request.departure.screenMargin);
          expect(screen!.x).toBeLessThanOrEqual(1 - request.departure.screenMargin);
          expect(screen!.y).toBeGreaterThanOrEqual(request.departure.screenMargin);
          expect(screen!.y).toBeLessThanOrEqual(1 - request.departure.screenMargin);
          expect(canyonSurface.ground(view.position, point)).toBeNull();
        }
      }
      request = { ...request, startAt: plan.handoffAt,
        previous: [canyonFormationPose(plan.attempts[0], plan.handoffAt), canyonFormationPose(plan.attempts[1], plan.handoffAt)],
        previousViews: [plan.attempts[0].camera.at(plan.handoffAt - plan.attempts[0].releaseAt),
          plan.attempts[1].camera.at(plan.handoffAt - plan.attempts[1].releaseAt)] };
    }
    expect(sides.size).toBe(2);
    console.info('Unapproved paired Canyon measurements', JSON.stringify({
      hit: [Math.min(...widths.map(w => w.hit)), Math.max(...widths.map(w => w.hit))],
      precision: [Math.min(...widths.map(w => w.precision)), Math.max(...widths.map(w => w.precision))],
      seed, nativeCandidates, pairedCandidates, clearanceNodes, knots, duration, extension, maxMs,
    }));
  }, 120_000);

  it('retains native knots and exact release anchors instead of fitting across native quintics', () => {
    const request = input(), plan = requirePlan(request);
    for (const attempt of plan.attempts) {
      const native = canyonCandidate(request.count, request.seed, request.previous[attempt.slot], plan.shelfIndex,
        attempt.slot ? plan.candidate.phaseDelta : 0);
      expect(native.ok).toBe(true);
      if (!native.ok) throw new Error(native.reason);
      const flight = native.encounter.canyon!;
      expect(attempt.track.at(0)).toEqual(flight.track.at(0));
      for (const knot of flight.track.knots) {
        if (knot.time <= flight.entryEnd || knot.time >= attempt.track.endTime) continue;
        expect(attempt.track.knots.find(k => k.time === knot.time)).toEqual(knot);
      }
      for (let t = flight.entryEnd; t <= attempt.track.endTime; t += 0.071) {
        const actual = attempt.track.at(t), expected = flight.track.at(t);
        expect(distance(actual.position, expected.position)).toBeLessThan(1e-8);
        expect(distance(actual.velocity, expected.velocity)).toBeLessThan(1e-8);
        expect(distance(actual.acceleration, expected.acceleration)).toBeLessThan(1e-8);
        expect(actual.bank).toBeCloseTo(expected.bank, 9);
        expect(actual.pitch).toBeCloseTo(expected.pitch, 9);
      }
      const snapshot = attempt.track.toData(), before = attempt.track.at(0);
      const changed = attempt.track.at(0); changed.position.x += 100;
      expect(attempt.track.at(0)).toEqual(before);
      expect(Object.isFrozen(snapshot.knots[0]!.pose.position)).toBe(true);
    }
  });

  it('rejects invalid or unsafe envelopes explicitly and bounds exhausted searches', () => {
    const request = input();
    expect(() => planCanyonFormation({ ...request, candidates: [] })).toThrow(/Invalid/);
    expect(() => planCanyonFormation({ ...request, candidates: Array(9).fill(request.candidates[0]) })).toThrow(/Invalid/);
    expect(() => planCanyonFormation({ ...request, viewport: { minAspect: 2, maxAspect: 1 } })).toThrow(/Invalid/);
    expect(() => planCanyonFormation({ ...request, acquisitionMargin: 0 })).toThrow(/Invalid/);
    expect(() => planCanyonFormation({ ...request, candidates: [{ ...request.candidates[0]!, phaseDelta: 0 }] })).toThrow(/Invalid/);
    expect(() => planCanyonFormation({ ...request, departure: { ...request.departure, after: Number.NaN } })).toThrow(/Invalid/);
    expect(() => planCanyonFormation({ ...request,
      previous: [{ ...request.previous[0], velocity: { x: 0, y: 0, z: 0 } }, request.previous[1]] })).toThrow(/Invalid/);
    for (const narrowed of [
      { ...request, candidates: request.candidates.map(c => ({ ...c, maxEntryExtension: 0 })) },
      { ...request, viewport: { minAspect: 0.001, maxAspect: 0.001 } },
    ]) {
      const result = planCanyonFormation(narrowed);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('An unsupported envelope must not receive a fallback.');
      expect(result.failures.length).toBeLessThanOrEqual(12 * request.candidates.length);
      expect(result.work.nativeCandidates).toBeLessThanOrEqual(12 * (1 + request.candidates.length));
      expect(result.work.pairedCandidates).toBeLessThanOrEqual(12 * request.candidates.length);
      expect(result.failures.some(f => f.reason === (narrowed.viewport.minAspect === 0.001
        ? 'acquisition' : 'entry_timing'))).toBe(true);
    }
    const recovery = requirePlan({ ...request, candidates: [
      { ...request.candidates[0]!, maxEntryExtension: 0 }, ...request.candidates,
    ] });
    expect(recovery.rejected[0]?.reason).toBe('entry_timing');
    const badAttitude = planCanyonFormation({ ...request,
      previous: [{ ...request.previous[0], bank: 0.2 }, request.previous[1]] });
    expect(badAttitude.ok).toBe(false);
    if (!badAttitude.ok) expect(badAttitude.failures.some(f => f.reason === 'attitude')).toBe(true);
    const hiddenDeparture = planCanyonFormation({ ...request,
      candidates: request.candidates.map(c => ({ ...c, lag: 0.01 })) });
    expect(hiddenDeparture.ok).toBe(false);
    if (!hiddenDeparture.ok) {
      expect(hiddenDeparture.failures.some(f => f.reason === 'departure'), JSON.stringify(hiddenDeparture.failures)).toBe(true);
    }
    const overextended = planCanyonFormation({ ...request,
      candidates: [{ ...request.candidates[0]!, lag: 4, entryPadding: 3, maxEntryExtension: 6 }] });
    expect(overextended.ok).toBe(false);
    if (!overextended.ok) {
      expect(overextended.failures.some(f => f.reason === 'speed'), JSON.stringify(overextended.failures)).toBe(true);
    }
  }, 30_000);
});
