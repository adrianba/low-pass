import { describe, expect, it } from 'vitest';
import { FORMATION_PROFILE } from '../../src/config/multiplayer';
import { initialFormationPoses } from '../../src/game/formation/initial';
import { initialPose } from '../../src/simulation/pose';
import { routePoint } from '../../src/terrain/canyon-route';
import { planFormation } from '../../src/game/formation/approved';
import { contactAccuracy, predictImpact } from '../../src/simulation/ballistics';
import { launchFrom } from '../../src/simulation/pose';
import { surfaceFor } from '../../src/terrain/surface';

describe('accepted G1 formation profile', () => {
  it('records the reviewed spacing and candidate allowances without retuning', () => {
    expect(FORMATION_PROFILE.version).toBe(1);
    expect(FORMATION_PROFILE.viewport).toEqual({ minAspect: 0.75, maxAspect: 2 });
    expect(FORMATION_PROFILE.acquisitionMargin).toBe(0.1);
    expect(FORMATION_PROFILE.valley.candidates).toEqual([
      { lag: 1.5, maxLagAdjustment: 0.1, phaseDelta: 0.35, maxLateralCorrection: 80, maxForwardCorrection: 20 },
    ]);
    expect(FORMATION_PROFILE.canyon.candidates).toEqual([
      { lag: 1.2, phaseDelta: 0.12, entryPadding: 0, maxEntryExtension: 3 },
      { lag: 1.2, phaseDelta: -0.12, entryPadding: 0, maxEntryExtension: 3 },
    ]);
    expect(FORMATION_PROFILE.canyon.departure).toEqual({ before: 0.1, after: 0.2, screenMargin: 0.02 });
    expect(Reflect.set(FORMATION_PROFILE, 'version', 2)).toBe(false);
    expect(Reflect.set(FORMATION_PROFILE.viewport, 'minAspect', 1)).toBe(false);
    expect(Reflect.set(FORMATION_PROFILE.valley.candidates[0], 'lag', 1)).toBe(false);
    expect(Reflect.set(FORMATION_PROFILE.canyon.candidates, '0', {})).toBe(false);
  });

  it('reproduces the reviewed initial full poses and keeps callers independent', () => {
    expect(initialFormationPoses('green-valley')).toEqual([
      initialPose(), initialPose({ x: -8, y: 167, z: -114 }),
    ]);
    expect(initialFormationPoses('desert')).toEqual(initialFormationPoses('green-valley'));
    const canyon = initialFormationPoses('river-canyon');
    expect(canyon).toEqual([
      initialPose({ ...routePoint(600, 0), y: 167 }),
      initialPose({ ...routePoint(600 - 76 * 1.2, 0), y: 167 }),
    ]);
    canyon[0].position.z += 100;
    expect(initialFormationPoses('river-canyon')[0].position).not.toEqual(canyon[0].position);
  });

  it.each(['green-valley', 'desert', 'river-canyon'] as const)('authors %s using the recorded profile', terrain => {
    const result = planFormation({ encounterId: 'approved-1', terrain, count: 0, seed: 7, startAt: 0,
      previous: initialFormationPoses(terrain), previousViews: [null, null] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(result.plan.candidate).toEqual(terrain === 'river-canyon'
      ? FORMATION_PROFILE.canyon.candidates[0] : FORMATION_PROFILE.valley.candidates[0]);
    for (const attempt of result.plan.attempts) {
      expect(attempt.acquisition.viewport).toEqual(FORMATION_PROFILE.viewport);
      expect(attempt.acquisition.margin).toBe(FORMATION_PROFILE.acquisitionMargin);
      expect(contactAccuracy(predictImpact(launchFrom(attempt.track.at(0)), surfaceFor(terrain)),
        result.plan.target, surfaceFor(terrain))).toBe(100);
    }
  });
});
