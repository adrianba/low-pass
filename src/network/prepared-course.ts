import { FormationScheduler } from '../game/multiplayer/scheduler.js';
import type { TerrainTheme } from '../config/terrain.js';
import { formationData } from './formation-data.js';
import { RELEASE_GRACE_SECONDS } from './release-authority.js';
import { createTransfer } from './transfer.js';

export type OutgoingTransfer = Awaited<ReturnType<typeof createTransfer>>;
export interface PreparedHostCourse {
  scheduler: FormationScheduler;
  transfers: [OutgoingTransfer, OutgoingTransfer];
}
export async function prepareHostCourse(terrain: TerrainTheme, seed: number, revision: number): Promise<PreparedHostCourse> {
  const scheduler = new FormationScheduler(terrain, seed, undefined, { releaseGraceSeconds: RELEASE_GRACE_SECONDS });
  const first = formationData(scheduler.plan(0), 0), next = formationData(scheduler.plan(1), 1);
  const transfers = await Promise.all([createTransfer({ kind: 'formation', data: first }, `course-${revision}-${first.encounterId}`),
    createTransfer({ kind: 'formation', data: next }, `course-${revision}-${next.encounterId}`)]);
  return { scheduler, transfers };
}
