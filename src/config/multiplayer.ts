import type { ValleyCandidate } from '../game/formation/valley';
import type { CanyonPairCandidate } from '../game/formation/canyon';

export const FORMATION_PROFILE = Object.freeze({
  version: 1,
  viewport: Object.freeze({ minAspect: 0.75, maxAspect: 2 }),
  acquisitionMargin: 0.1,
  valley: Object.freeze({
    initialLateral: -8,
    candidates: Object.freeze([
      Object.freeze({ lag: 1.5, maxLagAdjustment: 0.1, phaseDelta: 0.35,
        maxLateralCorrection: 80, maxForwardCorrection: 20 } satisfies ValleyCandidate),
    ] as const),
  }),
  canyon: Object.freeze({
    initialAlong: 600,
    candidates: Object.freeze([
      Object.freeze({ lag: 1.2, phaseDelta: 0.12, entryPadding: 0, maxEntryExtension: 3 } satisfies CanyonPairCandidate),
      Object.freeze({ lag: 1.2, phaseDelta: -0.12, entryPadding: 0, maxEntryExtension: 3 } satisfies CanyonPairCandidate),
    ] as const),
    departure: Object.freeze({ before: 0.1, after: 0.2, screenMargin: 0.02 }),
  }),
});
