import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { initialPose, launchFrom } from '../../src/simulation/pose';
import { planCanyon, canyonPose, canyonShelves, canyonCandidate } from '../../src/game/canyon-flight';
import type { CanyonCandidate } from '../../src/game/canyon-flight';
import { contactAccuracy, predictImpact } from '../../src/simulation/ballistics';
import { distance } from '../../src/simulation/math';
import { canyonSurface } from '../../src/terrain/surface';

describe('canyon candidate selection boundary', () => {
  it('preserves the default phase and first usable shelf over sequential handoffs', () => {
    for (const seed of [0, 7, 19]) {
      let previous = initialPose();
      const selected = createHash('sha256'), authored = createHash('sha256');
      for (let count = 0; count < 15; count++) {
        const encounter = planCanyon(count, seed, previous);
        const candidates = canyonShelves(count, previous);
        let first: CanyonCandidate | undefined;
        for (const index of candidates) {
          first = canyonCandidate(count, seed, previous, index, 0);
          if (first.ok) break;
        }
        expect(first?.ok).toBe(true);
        if (!first?.ok) throw new Error('Missing baseline canyon candidate.');
        selected.update(JSON.stringify(encounter));
        authored.update(JSON.stringify(first.encounter));
        expect(encounter.start).toEqual(previous);
        previous = canyonPose(encounter, encounter.canyon!.endAt);
      }
      expect(selected.digest('hex')).toBe(authored.digest('hex'));
    }
  });

  it('can solve genuinely different release motion to one explicitly selected shelf', () => {
    for (const count of [0, 6, 12]) {
      const previous = initialPose();
      let solved = false;
      for (const index of canyonShelves(count, previous)) {
        const lead = canyonCandidate(count, 7, previous, index);
        if (!lead.ok) continue;
        for (const phase of [-0.12, 0.12]) {
          const follower = canyonCandidate(count, 7, previous, index, phase);
          if (!follower.ok) continue;
          const a = canyonPose(lead.encounter, 0), b = canyonPose(follower.encounter, 0);
          expect(follower.encounter.target).toEqual(lead.encounter.target);
          expect(follower.encounter.targetKind).toBe(lead.encounter.targetKind);
          expect(distance(a.position, b.position)).toBeGreaterThan(0.1);
          expect(distance(a.velocity, b.velocity)).toBeGreaterThan(0.01);
          for (const pose of [a, b]) {
            expect(contactAccuracy(predictImpact(launchFrom(pose), canyonSurface), lead.encounter.target, canyonSurface)).toBe(100);
          }
          solved = true;
          break;
        }
        if (solved) break;
      }
      expect(solved, `tier ${count + 1}`).toBe(true);
    }
  });

  it('bounds shelf selection and reports unusable candidates without silently selecting another target', () => {
    const previous = initialPose();
    expect(canyonShelves(0, previous)).toHaveLength(12);
    expect(canyonShelves(12, previous)).toHaveLength(6);
    for (const index of [-100, 1000]) {
      const result = canyonCandidate(0, 7, previous, index);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).not.toBe('');
    }
    for (const phase of [NaN, Infinity, 4]) expect(() => canyonCandidate(0, 7, previous, 0, phase)).toThrow(/Invalid/);
    expect(() => canyonCandidate(0, 7, previous, 0.5)).toThrow(/Invalid/);
    expect(() => canyonCandidate(0, 7, previous, Number.MAX_SAFE_INTEGER)).toThrow(/Invalid/);
    expect(() => canyonShelves(-1, previous)).toThrow(/Invalid/);
    expect(() => canyonShelves(0, { ...previous, velocity: { x: Infinity, y: 0, z: 0 } })).toThrow(/Invalid/);
  });
});
