import { FORMATION_PROFILE } from '../../config/multiplayer';
import type { TerrainTheme } from '../../config/terrain';
import type { ChaseView } from '../../simulation/chase-camera';
import type { Pose } from '../../simulation/pose';
import { planCanyonFormation } from './canyon';
import type { CanyonFormation, CanyonFormationResult } from './canyon';
import { planValleyFormation } from './valley';
import type { ValleyFormation, FormationResult } from './valley';

export type FormationPlan = ValleyFormation | CanyonFormation;
export interface FormationRequest {
  readonly encounterId: string;
  readonly terrain: TerrainTheme;
  readonly count: number;
  readonly seed: number;
  readonly startAt: number;
  readonly previous: readonly [Pose, Pose];
  readonly previousViews: readonly [ChaseView | null, ChaseView | null];
}

export function planFormation(input: FormationRequest): FormationResult | CanyonFormationResult {
  const common = { ...input, viewport: FORMATION_PROFILE.viewport, acquisitionMargin: FORMATION_PROFILE.acquisitionMargin };
  switch (input.terrain) {
    case 'green-valley':
    case 'desert':
      return planValleyFormation({ ...common, terrain: input.terrain, candidates: FORMATION_PROFILE.valley.candidates });
    case 'river-canyon':
      return planCanyonFormation({ ...common, candidates: FORMATION_PROFILE.canyon.candidates,
        departure: FORMATION_PROFILE.canyon.departure });
    default: throw new Error('Invalid formation terrain.');
  }
}
