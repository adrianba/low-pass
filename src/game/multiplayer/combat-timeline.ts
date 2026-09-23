import { MAX_MISSES } from '../../config/game';
import { readFlightPose } from '../../simulation/flight-track-data';
import type { Pose } from '../../simulation/pose';
import { ChaseTimeline } from '../../simulation/chase-timeline';
import type { ChaseView } from '../../simulation/chase-camera';
import { canyonSurface, valleySurface } from '../../terrain/surface';
import { AircraftMotion } from '../aircraft-motion';
import { FINALE_DURATION, FLYBY_DURATION, MISSILE_INTERCEPT_TIME } from '../combat-timing';
import type { CombatCue } from '../combat-timing';
import { MissileFlight } from '../missile';
import { readCombatPlanData } from './combat-plan';
import type { CombatPlanData } from './combat-plan';
import { MAX_SESSION_PLANS } from './session';
import type { PlayerSlot } from './session';

export interface CombatActor { readonly misses: number; readonly eliminated: boolean }
export type CombatPoseSampler = (slot: PlayerSlot, time: number) => Pose;
export interface CombatEntry {
  readonly data: CombatPlanData; readonly flight: MissileFlight; readonly motion: AircraftMotion;
  readonly camera: ChaseTimeline | null;
}
export const MAX_COMBAT_VIEWS = MAX_SESSION_PLANS * 2;
export const DAMAGE_SMOKE_LIFE = 1.1;
export type CombatCueSource = Pick<CombatPlanData, 'id' | 'slot' | 'bornAt'> & {
  missile: Pick<CombatPlanData['missile'], 'kind'>;
};
export function combatCues(plans: readonly CombatCueSource[], previous: number | null, time: number) {
  const cues: Array<{ id: number; slot: PlayerSlot; cue: CombatCue }> = [];
  if (previous === null) return cues;
  for (const data of plans) {
    const age = time - data.bornAt, impactAt = data.bornAt + MISSILE_INTERCEPT_TIME;
    if (previous < data.bornAt && time >= data.bornAt && age < MISSILE_INTERCEPT_TIME) {
      cues.push({ id: data.id, slot: data.slot, cue: 'missile' });
    }
    const kind = data.missile.kind;
    if (previous < impactAt && time >= impactAt &&
      time - impactAt < (kind === 'finale' ? 1.6 : kind === 'damage' ? 0.4 : FLYBY_DURATION - MISSILE_INTERCEPT_TIME)) {
      cues.push({ id: data.id, slot: data.slot, cue: kind === 'finale' ? 'destroyed' : kind === 'damage' ? 'damaged' : 'flyby' });
    }
  }
  return cues;
}

export class CombatTimeline {
  private entries = new Map<number, CombatEntry>();
  private sources = new Map<number, CombatPlanData>();
  private finales: [CombatEntry | null, CombatEntry | null] = [null, null];
  private actors: readonly [CombatActor, CombatActor] = [{ misses: 0, eliminated: false }, { misses: 0, eliminated: false }];
  private sampler: CombatPoseSampler | null = null;
  private clock: number | null = null;
  get time(): number { if (this.clock === null) throw new Error('Combat timeline is not initialized.'); return this.clock; }
  get effects(): readonly CombatEntry[] { return [...this.entries.values()]; }

  update(plans: readonly CombatPlanData[], time: number, actors: readonly [CombatActor, CombatActor], sampler: CombatPoseSampler) {
    if (!Number.isFinite(time) || time < 0 || time > 1e8 || (this.clock !== null && time < this.clock) ||
      plans.length > MAX_COMBAT_VIEWS || new Set(plans.map(p => p.id)).size !== plans.length ||
      actors.length !== 2 || actors.some(a => !Number.isInteger(a.misses) || a.misses < 0 ||
        a.misses > MAX_MISSES || a.eliminated !== (a.misses === MAX_MISSES))) throw new Error('Invalid bounded combat timeline update.');
    if (this.clock !== null && actors.some((a, slot) => a.misses < this.actors[slot]!.misses)) {
      throw new Error('Reset before repairing a player combat state.');
    }
    const next = new Map<number, CombatEntry>(), sources = new Map<number, CombatPlanData>();
    const finales: [CombatEntry | null, CombatEntry | null] = [...this.finales];
    for (const source of plans) {
      let entry = this.entries.get(source.id);
      if (this.sources.get(source.id) !== source) {
        const data = readCombatPlanData(source);
        if (entry && JSON.stringify(entry.data) !== JSON.stringify(data)) throw new Error('A combat event cannot change after authoring.');
        if (!entry) {
          const motion = AircraftMotion.fromData(data.missile.motion);
          entry = { data, flight: MissileFlight.fromData(data.missile), motion,
            camera: data.missile.kind === 'finale' ? new ChaseTimeline(
              age => motion.at(Math.min(age, MISSILE_INTERCEPT_TIME)),
              data.missile.curve.kind === 'canyon' ? canyonSurface : valleySurface, 0, FINALE_DURATION, data.view) : null };
        }
      }
      if (!entry) throw new Error('Missing combat event cache.');
      const actor = actors[entry.data.slot];
      if (entry.data.damageLevel > Math.min(2, actor.misses)) throw new Error('Combat damage exceeds the player outcome.');
      if (entry.data.missile.kind === 'finale') {
        const old = finales[entry.data.slot];
        if (!actor.eliminated || (old && old.data.id !== entry.data.id)) throw new Error('Invalid player finale identity.');
        finales[entry.data.slot] = entry;
      }
      next.set(entry.data.id, entry); sources.set(entry.data.id, source);
    }
    if (actors.some((actor, slot) => actor.eliminated && !finales[slot])) {
      throw new Error('Eliminated players require their frozen finale.');
    }
    const cues = combatCues([...next.values()].map(entry => entry.data), this.clock, time);
    this.entries = next; this.sources = sources; this.finales = finales;
    this.actors = structuredClone(actors); this.sampler = sampler; this.clock = time;
    return cues;
  }

  aliveAt(slot: PlayerSlot, time = this.time): boolean {
    if (!this.actors[slot].eliminated) return true;
    const finale = this.finales[slot];
    return !!finale && time < finale.data.bornAt + MISSILE_INTERCEPT_TIME;
  }
  damageAt(slot: PlayerSlot, time = this.time): number {
    let level = Math.min(2, this.actors[slot].misses);
    for (const { data } of this.entries.values()) {
      if (data.slot === slot && data.missile.kind === 'damage' && time < data.bornAt + MISSILE_INTERCEPT_TIME) {
        level = Math.min(level, data.damageLevel - 1);
      }
    }
    return level;
  }
  poseAt(slot: PlayerSlot, time = this.time): Pose {
    if (!this.sampler || !Number.isFinite(time) || time < 0) throw new Error('Invalid combat pose query.');
    const finale = this.finales[slot];
    const pose = finale && time >= finale.data.bornAt
      ? finale.motion.at(Math.min(MISSILE_INTERCEPT_TIME, time - finale.data.bornAt)) : this.sampler(slot, time);
    return structuredClone(readFlightPose(pose));
  }
  flashAge(slot: PlayerSlot): number {
    const times = [...this.entries.values()].filter(e => e.data.slot === slot && e.data.missile.kind === 'damage')
      .map(e => this.time - e.data.bornAt - MISSILE_INTERCEPT_TIME).filter(age => age >= 0);
    return Math.min(Infinity, ...times);
  }
  finaleComplete(slot: PlayerSlot): boolean {
    const finale = this.finales[slot];
    return this.actors[slot].eliminated && (!finale || this.time >= finale.data.bornAt + FINALE_DURATION);
  }
  finaleId(slot: PlayerSlot): number | null { return this.finales[slot]?.data.id ?? null; }
  finaleBornAt(slot: PlayerSlot): number { return this.finales[slot]?.data.bornAt ?? -Infinity; }
  finaleView(slot: PlayerSlot): ChaseView | null {
    const finale = this.finales[slot];
    if (!finale?.camera || this.time < finale.data.bornAt) return null;
    return finale.camera.at(Math.min(FINALE_DURATION, this.time - finale.data.bornAt));
  }
  reset(): void {
    this.entries.clear(); this.sources.clear(); this.finales = [null, null];
    this.actors = [{ misses: 0, eliminated: false }, { misses: 0, eliminated: false }];
    this.sampler = null; this.clock = null;
  }
}
