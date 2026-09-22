import type { FormationPlan } from './approved.js';
import type { FlightTrackData } from '../../simulation/flight-track-data.js';
import { FlightTrack } from '../../simulation/flight-track.js';
import { FormationTrack } from './track.js';
import { ChaseTimeline } from '../../simulation/chase-timeline.js';
import { surfaceFor } from '../../terrain/surface.js';

type NumericAttempt<T> = Omit<T, 'track' | 'camera'> & {
  track: FlightTrackData; camera: ChaseTimeline['samples'];
};
type NumericPlan<T extends FormationPlan> = Omit<T, 'attempts'> & {
  attempts: readonly [NumericAttempt<T['attempts'][0]>, NumericAttempt<T['attempts'][1]>];
};
export type SerializedFormation = NumericPlan<Extract<FormationPlan, { terrain: 'river-canyon' }>> |
  NumericPlan<Exclude<FormationPlan, { terrain: 'river-canyon' }>>;

export function serializeFormation(plan: FormationPlan): SerializedFormation {
  if (plan.terrain === 'river-canyon') return { ...plan, attempts: [
    { ...plan.attempts[0], track: plan.attempts[0].track.toData(), camera: plan.attempts[0].camera.samples },
    { ...plan.attempts[1], track: plan.attempts[1].track.toData(), camera: plan.attempts[1].camera.samples },
  ] };
  return { ...plan, attempts: [
    { ...plan.attempts[0], track: plan.attempts[0].track.toData(), camera: plan.attempts[0].camera.samples },
    { ...plan.attempts[1], track: plan.attempts[1].track.toData(), camera: plan.attempts[1].camera.samples },
  ] };
}

export function restoreFormation(plan: SerializedFormation): FormationPlan {
  const camera = (samples: ChaseTimeline['samples']) =>
    new ChaseTimeline(samples, surfaceFor(plan.terrain), samples[0]!.time, samples.at(-1)!.time);
  if (plan.terrain === 'river-canyon') return { ...plan, attempts: [
    { ...plan.attempts[0], track: FlightTrack.fromData(plan.attempts[0].track), camera: camera(plan.attempts[0].camera) },
    { ...plan.attempts[1], track: FlightTrack.fromData(plan.attempts[1].track), camera: camera(plan.attempts[1].camera) },
  ] };
  return { ...plan, attempts: [
    { ...plan.attempts[0], track: FormationTrack.fromData(plan.attempts[0].track), camera: camera(plan.attempts[0].camera) },
    { ...plan.attempts[1], track: FormationTrack.fromData(plan.attempts[1].track), camera: camera(plan.attempts[1].camera) },
  ] };
}
