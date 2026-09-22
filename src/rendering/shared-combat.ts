import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { FINALE_DURATION, FLYBY_DURATION, MISSILE_INTERCEPT_TIME } from '../game/combat-timing';
import { CombatTimeline, DAMAGE_SMOKE_LIFE, MAX_COMBAT_VIEWS } from '../game/multiplayer/combat-timeline';
import type { PlayerSlot } from '../game/multiplayer/session';
import { aircraftPoint } from '../simulation/pose';
import { hash } from '../simulation/math';
import type { Vec3 } from '../simulation/math';
import type { CombatEffects } from './combat-effects';

interface EffectView {
  id: number | null;
  missile: ReturnType<CombatEffects['createMissileView']>;
  explosion: ReturnType<CombatEffects['createExplosionView']>;
}
const SMOKE_INTERVAL = 0.045;
interface Emission { index: number; finale: number | null; point: Vec3; velocity: Vec3 }

export class SharedCombat {
  readonly timeline = new CombatTimeline();
  private readonly views: EffectView[];
  private readonly damage: readonly [ReturnType<CombatEffects['createDamageView']>, ReturnType<CombatEffects['createDamageView']>];
  private disposed = false;
  private emissions: [Array<Emission | null>, Array<Emission | null>] = [Array.from({ length: 28 }, () => null), Array.from({ length: 28 }, () => null)];
  constructor(template: CombatEffects) {
    this.views = Array.from({ length: MAX_COMBAT_VIEWS }, (_, index) => ({ id: null,
      missile: template.createMissileView(`Shared combat ${index} `),
      explosion: template.createExplosionView(`Shared combat ${index} `) }));
    this.damage = [template.createDamageView('Player 1 '), template.createDamageView('Player 2 ')];
  }

  effectPositions(): Vec3[] {
    return this.timeline.effects.filter(e => {
      const age = this.timeline.time - e.data.bornAt;
      return age >= 0 && age < (e.data.missile.kind === 'finale' ? FINALE_DURATION : FLYBY_DURATION);
    }).map(e => this.timeline.time - e.data.bornAt >= MISSILE_INTERCEPT_TIME && e.data.missile.kind === 'finale'
      ? { ...e.flight.intercept } : e.flight.positionAt(this.timeline.time - e.data.bornAt));
  }

  render(origin: number): void {
    if (this.disposed || !Number.isFinite(origin)) throw new Error('Invalid shared combat render.');
    const time = this.timeline.time, effects = this.timeline.effects;
    for (const view of this.views) if (!effects.some(e => e.data.id === view.id)) this.hide(view);
    for (const { data, flight } of effects) {
      const view = this.views.find(v => v.id === data.id) ?? this.views.find(v => v.id === null)!;
      view.id = data.id;
      const age = time - data.bornAt, duration = data.missile.kind === 'finale' ? FINALE_DURATION : FLYBY_DURATION;
      const visible = age >= 0 && age < duration && (data.missile.kind === 'flyby' || age < MISSILE_INTERCEPT_TIME);
      view.missile.root.setEnabled(visible);
      if (visible) {
        const aircraft = this.timeline.poseAt(data.slot).position;
        const p = flight.positionAt(age, aircraft), ahead = flight.positionAt(age + 0.01, aircraft);
        view.missile.root.position.set(p.x, p.y, p.z - origin);
        view.missile.root.lookAt(new Vector3(ahead.x, ahead.y, ahead.z - origin));
      }
      for (const [i, puff] of view.missile.trail.entries()) {
        const sampleAge = age - i * 0.045;
        puff.setEnabled(age >= 0 && age < duration && sampleAge > 0 && sampleAge < MISSILE_INTERCEPT_TIME);
        if (!puff.isEnabled()) continue;
        const p = flight.positionAt(sampleAge);
        puff.position.set(p.x, p.y, p.z - origin);
        puff.scaling.setAll(0.5 + i * 0.14); puff.visibility = 0.7 * (1 - i / view.missile.trail.length);
      }
      for (const fragment of view.explosion) {
        const elapsed = age - MISSILE_INTERCEPT_TIME, mesh = fragment.mesh;
        mesh.setEnabled(data.missile.kind === 'finale' && elapsed >= 0 && elapsed < fragment.duration);
        if (!mesh.isEnabled()) continue;
        const p = flight.intercept, v = fragment.velocity;
        mesh.position.set(p.x + v.x * elapsed, p.y + v.y * elapsed - (fragment.smoke ? 0 : 11 * elapsed * elapsed),
          p.z - origin + v.z * elapsed);
        mesh.rotation.set(fragment.smoke ? 0 : elapsed, 0, elapsed * 0.7);
        mesh.scaling.setAll(fragment.smoke ? 1 + elapsed * 1.8 : 1);
        mesh.visibility = Math.max(0, 1 - elapsed / fragment.duration);
      }
    }
    for (const slot of [0, 1] as const) this.renderDamage(slot, origin);
  }

  private renderDamage(slot: PlayerSlot, origin: number): void {
    const view = this.damage[slot], now = this.timeline.time, flashAge = this.timeline.flashAge(slot);
    view.flash.setEnabled(this.timeline.aliveAt(slot) && flashAge < 0.4);
    if (view.flash.isEnabled()) {
      const p = this.timeline.poseAt(slot).position;
      view.flash.position.set(p.x, p.y, p.z - origin);
      view.flash.scaling.setAll(1 + flashAge * 3); view.flash.visibility = 1 - flashAge / 0.4;
    }
    for (const puff of view.puffs) puff.setEnabled(false);
    // A bounded absolute emission grid reconstructs the same smoke at any frame rate.
    const end = Math.floor(now / SMOKE_INTERVAL), begin = Math.max(0, end - view.puffs.length + 1);
    for (let emission = begin; emission <= end; emission++) {
      const born = emission * SMOKE_INTERVAL, age = now - born, level = this.timeline.damageAt(slot, born);
      if (age >= DAMAGE_SMOKE_LIFE || level === 0 || !this.timeline.aliveAt(slot, born) || (level === 1 && emission % 2)) continue;
      const puff = view.puffs[emission % view.puffs.length]!, seed = emission % 16_384;
      const side = level === 1 || emission % 2 === 0 ? -1 : 1;
      const index = emission % view.puffs.length, finale = this.timeline.finaleId(slot);
      let cached = this.emissions[slot][index];
      if (!cached || cached.index !== emission || cached.finale !== finale) {
        const pose = this.timeline.poseAt(slot, born);
        cached = { index: emission, finale, point: aircraftPoint(pose, { x: side * 2.2, y: 0.5, z: -4 }),
          velocity: { x: pose.velocity.x * 0.6, y: pose.velocity.y * 0.6 + 3, z: pose.velocity.z * 0.6 } };
        this.emissions[slot][index] = cached;
      }
      const p = cached.point, v = cached.velocity;
      const travel = (1 - Math.exp(-1.4 * age)) / 1.4;
      puff.position.set(p.x + v.x * travel, p.y + v.y * travel, p.z - origin + v.z * travel);
      puff.rotation.set(0, 0, hash(seed, 37) * Math.PI * 2 + (hash(seed, 91) - 0.5) * 0.7 * age);
      puff.scaling.setAll((0.8 + hash(seed, 73) * 0.4) * (0.8 + age * (level === 1 ? 2 : 2.8)));
      puff.visibility = (level === 1 ? 0.9 : 1) * (1 - age / DAMAGE_SMOKE_LIFE);
      puff.setEnabled(true);
    }
  }
  private hide(view: EffectView): void {
    view.id = null; view.missile.root.setEnabled(false);
    for (const puff of view.missile.trail) puff.setEnabled(false);
    for (const fragment of view.explosion) fragment.mesh.setEnabled(false);
  }
  reset(): void {
    this.timeline.reset();
    this.emissions[0].fill(null); this.emissions[1].fill(null);
    for (const view of this.views) this.hide(view);
    for (const damage of this.damage) { damage.flash.setEnabled(false); for (const puff of damage.puffs) puff.setEnabled(false); }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const view of this.views) {
      view.missile.root.dispose();
      for (const puff of view.missile.trail) puff.dispose();
      for (const fragment of view.explosion) fragment.mesh.dispose();
    }
    for (const damage of this.damage) { damage.flash.dispose(); for (const puff of damage.puffs) puff.dispose(); }
    this.timeline.reset();
  }
}
