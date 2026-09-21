import { CRUISE_HEIGHT, FLOOR, difficulty } from '../../config/game';
import { FORMATION_PROFILE } from '../../config/multiplayer';
import type { TerrainTheme } from '../../config/terrain';
import { initialPose } from '../../simulation/pose';
import type { Pose } from '../../simulation/pose';
import { routePoint } from '../../terrain/canyon-route';

export function initialFormationPoses(terrain: TerrainTheme): [Pose, Pose] {
  const speed = difficulty(0).speed, y = FLOOR + CRUISE_HEIGHT;
  switch (terrain) {
    case 'green-valley':
    case 'desert':
      return [initialPose(), initialPose({ x: FORMATION_PROFILE.valley.initialLateral, y,
        z: -speed * FORMATION_PROFILE.valley.candidates[0].lag })];
    case 'river-canyon': {
      const { initialAlong, candidates } = FORMATION_PROFILE.canyon;
      return [initialPose({ ...routePoint(initialAlong, 0), y }),
        initialPose({ ...routePoint(initialAlong - speed * candidates[0].lag, 0), y })];
    }
    default: throw new Error('Invalid formation terrain.');
  }
}
