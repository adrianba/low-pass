import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CombatEffects } from '../../src/rendering/combat-effects';
import { SharedCombat } from '../../src/rendering/shared-combat';
import { CombatTimeline } from '../../src/game/multiplayer/combat-timeline';
import type { CombatActor } from '../../src/game/multiplayer/combat-timeline';
import { readCombatPlanData } from '../../src/game/multiplayer/combat-plan';
import { finaleFlight, MissileFlight, MISSILE_INTERCEPT_TIME } from '../../src/game/missile';
import type { MissileKind } from '../../src/game/missile';
import { initialPose } from '../../src/simulation/pose';
import { chaseView } from '../../src/simulation/chase-camera';
import { valleySurface } from '../../src/terrain/surface';
import { HostCombat, formationAt, formationSampler, spectatorSlot, endingTime } from '../../src/game/multiplayer/host-combat';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler';
import type { SessionEvent } from '../../src/game/multiplayer/session';

const sample = (slot: 0 | 1, time: number) => initialPose({ x: slot * 40, y: 167, z: time * 76 });
function event(slot: 0 | 1, sequence: number, bornAt: number, kind: MissileKind, damageLevel: 0 | 1 | 2) {
  const start = sample(slot, bornAt);
  const flight = kind === 'finale' ? finaleFlight(start) :
    new MissileFlight(kind, start, sample(slot, bornAt + MISSILE_INTERCEPT_TIME).position, 1);
  return readCombatPlanData({ version: 1, id: sequence * 2 + slot + 1, slot, sequence, bornAt, damageLevel,
    view: chaseView(start, valleySurface, null, 0), missile: flight.toData() });
}
const healthy: readonly [CombatActor, CombatActor] = [{ misses: 0, eliminated: false }, { misses: 0, eliminated: false }];

describe('independent shared combat timelines', () => {
  it('can render a controller-owned timeline without resetting it on visual disposal', () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const timeline = new CombatTimeline(), shared = new SharedCombat(new CombatEffects(scene), timeline);
      timeline.update([], 2, healthy, sample);
      shared.render(0); shared.reset(); shared.dispose();
      expect(timeline.time).toBe(2);
      expect(timeline.poseAt(1)).toEqual(sample(1, 2));
    } finally { scene.dispose(); engine.dispose(); }
  });

  it('preserves overlapping damage and finales without suppressing cues or repairing damage', () => {
    const timeline = new CombatTimeline();
    timeline.update([], 0, healthy, sample);
    const plans = [event(0, 0, 2, 'damage', 1), event(0, 1, 2.3, 'damage', 2), event(0, 2, 2.6, 'finale', 2)];
    const actors: readonly [CombatActor, CombatActor] = [{ misses: 3, eliminated: true }, healthy[1]];
    expect(timeline.update(plans, 2, actors, sample).map(c => c.cue)).toEqual(['missile']);
    expect(timeline.damageAt(0)).toBe(0);
    expect(timeline.update(plans, 2.3, actors, sample).map(c => c.cue)).toEqual(['missile']);
    expect(timeline.update(plans, 2.6, actors, sample).map(c => c.cue)).toEqual(['missile']);
    expect(timeline.update(plans, 3.7, actors, sample).map(c => c.cue)).toEqual(['damaged']);
    expect(timeline.damageAt(0)).toBe(1);
    expect(timeline.update(plans, 4, actors, sample).map(c => c.cue)).toEqual(['damaged']);
    expect(timeline.damageAt(0)).toBe(2);
    expect(timeline.update(plans, 4.3, actors, sample).map(c => c.cue)).toEqual(['destroyed']);
    expect(timeline.aliveAt(0)).toBe(false); expect(timeline.aliveAt(1)).toBe(true);
    const frozen = timeline.poseAt(0);
    timeline.update([], 40, actors, sample);
    expect(timeline.poseAt(0)).toEqual(frozen);
    expect(timeline.poseAt(1)).toEqual(sample(1, 40));
    expect(timeline.finaleComplete(0)).toBe(true);
    expect(timeline.damageAt(0)).toBe(2);
  });

  it('restores aged effects without replaying old cues and emits future crossings once', () => {
    const timeline = new CombatTimeline(), plan = event(1, 0, 10, 'damage', 1);
    const actors = [healthy[0], { misses: 1, eliminated: false }] as const;
    expect(timeline.update([plan], 11, actors, sample)).toEqual([]);
    expect(timeline.damageAt(1)).toBe(0);
    expect(timeline.update([plan], 11.7, actors, sample).map(c => c.cue)).toEqual(['damaged']);
    expect(timeline.update([plan], 11.7, actors, sample)).toEqual([]);
    expect(timeline.update([plan], 40, actors, sample)).toEqual([]);
    expect(() => timeline.update([plan], 39, actors, sample)).toThrow();
    expect(() => timeline.update([plan, plan], 40, actors, sample)).toThrow();
    expect(() => timeline.update([{ ...plan, bornAt: 12 }], 40, actors, sample)).toThrow('cannot change');
    timeline.reset();
    expect(timeline.update([plan], 40, actors, sample)).toEqual([]);
    expect(timeline.damageAt(1)).toBe(1);
  });

  it('pools simultaneous visuals, shares alpha textures and leaves the solo template untouched', () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const template = new CombatEffects(scene), base = [scene.meshes.length, scene.materials.length, scene.geometries.length, scene.textures.length];
      const shared = new SharedCombat(template), count = [scene.meshes.length, scene.materials.length, scene.geometries.length, scene.textures.length];
      expect(count[1]).toBe(base[1]); expect(count[3]).toBe(base[3]);
      const plans = [event(0, 0, 2, 'damage', 1), event(1, 0, 2, 'damage', 1)];
      const actors = [{ misses: 1, eliminated: false }, { misses: 1, eliminated: false }] as const;
      shared.timeline.update(plans, 3, actors, sample); shared.render(4096);
      const missiles = scene.transformNodes.filter(n => n.name.startsWith('Shared combat ') && n.name.endsWith('missile') && n.isEnabled());
      expect(missiles).toHaveLength(2);
      for (const missile of missiles) {
        expect(missile.getChildMeshes()).toHaveLength(5);
        expect(missile.getChildMeshes().every(mesh => mesh.isEnabled() && mesh.getTotalVertices() > 0)).toBe(true);
      }
      expect(template.missileActive).toBe(false); expect(template.damageLevel).toBe(0);
      shared.timeline.update(plans, 4, actors, sample); shared.render(4096);
      for (const slot of [1, 2]) {
        const puffs = scene.meshes.filter(m => m.name === `Player ${slot} Aircraft damage smoke` && m.isEnabled());
        expect(puffs.length).toBeGreaterThan(0);
        expect(puffs.every(p => p.rotation.x === 0 && p.rotation.y === 0)).toBe(true);
        const material = puffs[0]!.material;
        expect(material).toBeInstanceOf(StandardMaterial);
        if (!(material instanceof StandardMaterial)) throw new Error('Missing smoke material.');
        expect(material.diffuseTexture?.hasAlpha).toBe(true);
        expect(material.disableDepthWrite).toBe(true);
        expect(material.diffuseTexture).toBe(scene.getMaterialByName('Missile smoke')!.getActiveTextures()[0]);
      }
      const before = scene.meshes.map(m => ({ p: m.position.clone(), r: m.rotation.clone(), v: m.visibility, on: m.isEnabled() }));
      shared.render(4096);
      expect(scene.meshes.map(m => ({ p: m.position.clone(), r: m.rotation.clone(), v: m.visibility, on: m.isEnabled() }))).toEqual(before);
      shared.render(8192);
      const puffs = scene.meshes.filter(m => m.name === 'Player 1 Aircraft damage smoke' && m.isEnabled());
      for (const puff of puffs) {
        const index = scene.meshes.indexOf(puff);
        expect(puff.position.z).toBeCloseTo(before[index]!.p.z - 4096, 9);
      }
      for (let i = 0; i < 10; i++) {
        shared.reset(); shared.timeline.update(plans, 4, actors, sample); shared.render(8192);
        expect([scene.meshes.length, scene.materials.length, scene.geometries.length, scene.textures.length]).toEqual(count);
      }
      shared.dispose(); shared.dispose();
      expect([scene.meshes.length, scene.materials.length, scene.geometries.length, scene.textures.length]).toEqual(base);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it('reconstructs identical smoke and explosions directly or through incremental frames', () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const shared = new SharedCombat(new CombatEffects(scene));
      const plans = [event(0, 2, 2, 'finale', 2), event(1, 1, 2.2, 'damage', 2)];
      const actors = [{ misses: 3, eliminated: true }, { misses: 2, eliminated: false }] as const;
      const state = () => scene.meshes.filter(m => m.isEnabled()).map(m => ({
        name: m.name, position: m.position.asArray(), scale: m.scaling.asArray(), rotation: m.rotation.asArray(), visibility: m.visibility,
      }));
      for (let i = 0; i <= 60; i++) { shared.timeline.update(plans, i / 10, actors, sample); shared.render(4096); }
      const incremental = state();
      shared.reset(); shared.timeline.update(plans, 6, actors, sample); shared.render(4096);
      expect(state()).toEqual(incremental);
      expect(scene.meshes.some(m => m.name.includes('Aircraft explosion') && m.isEnabled())).toBe(true);
      expect(scene.meshes.some(m => m.name === 'Player 2 Aircraft damage smoke' && m.isEnabled())).toBe(true);
      expect(shared.timeline.aliveAt(0)).toBe(false);
      shared.dispose();
    } finally { scene.dispose(); engine.dispose(); }
  });

  it('preserves owned finale cameras, selects either survivor and never samples a dead live track', () => {
    for (const slot of [0, 1] as const) {
      const timeline = new CombatTimeline(), other = slot === 0 ? 1 : 0;
      const plans = [event(slot, 2, 10, 'finale', 2)];
      const actors = slot === 0 ? [{ misses: 3, eliminated: true }, healthy[1]] as const :
        [healthy[0], { misses: 3, eliminated: true }] as const;
      timeline.update(plans, 10, actors, sample);
      expect(timeline.finaleView(slot)).toEqual(plans[0]!.view);
      expect(spectatorSlot(slot, timeline)).toBe(slot);
      timeline.update(plans, 12, actors, (requested, time) => {
        if (requested === slot) throw new Error('Dead live track was sampled.');
        return sample(requested, time);
      });
      expect(spectatorSlot(slot, timeline)).toBe(other);
      const frozen = timeline.poseAt(slot), pose = timeline.poseAt(slot), view = timeline.finaleView(slot)!;
      pose.position.x += 1000; view.position.x += 1000;
      expect(timeline.poseAt(slot).position.x).not.toBe(pose.position.x);
      expect(timeline.finaleView(slot)!.position.x).not.toBe(view.position.x);
      timeline.update([], 30, actors, sample);
      expect(timeline.finaleComplete(slot)).toBe(true);
      expect(timeline.poseAt(slot)).toEqual(frozen);
    }
    const timeline = new CombatTimeline();
    expect(() => timeline.update([], 0, [{ misses: 3, eliminated: true }, healthy[1]], sample)).toThrow('frozen finale');
    timeline.update([], 0, [{ misses: 1, eliminated: false }, healthy[1]], sample);
    expect(() => timeline.update([], 1, healthy, sample)).toThrow('repairing');
  });

  it.each(['green-valley', 'desert', 'river-canyon'] as const)('authors bounded %s effects, deduplicates outcomes and retains both final cameras', terrain => {
    const scheduler = new FormationScheduler(terrain, 7);
    let cameras = 0;
    const director = new HostCombat(scheduler, (_slot, view, range) => {
      cameras++; return { ...view, aspect: 1.15, range };
    });
    const timeline = new CombatTimeline();
    let resolved: SessionEvent | undefined;
    while (scheduler.session.status !== 'over') {
      expect(scheduler.advanceTo(scheduler.session.time + 0.25).ok).toBe(true);
      const events = scheduler.session.drainEvents();
      director.consume(events);
      resolved ??= events.find(event => event.type === 'resolved');
      const state = scheduler.session.snapshot(), plans = director.at(state.time);
      expect(plans.length).toBeLessThanOrEqual(8);
      timeline.update(plans, state.time, [
        { misses: state.players[0]!.misses, eliminated: !!state.players[0]!.completion },
        { misses: state.players[1]!.misses, eliminated: !!state.players[1]!.completion },
      ], formationSampler(scheduler));
    }
    expect(cameras).toBe(6);
    expect(() => director.consume([resolved!])).toThrow('already authored');
    const end = endingTime(scheduler)!;
    expect(end).toBe(scheduler.session.time + 5.5);
    const finales = director.at(end);
    expect(finales).toHaveLength(2);
    expect(finales.every(p => p.missile.kind === 'finale')).toBe(true);
    timeline.update(finales, end, [{ misses: 3, eliminated: true }, { misses: 3, eliminated: true }], () => {
      throw new Error('Ended gameplay must not be sampled.');
    });
    expect(timeline.aliveAt(0)).toBe(false); expect(timeline.aliveAt(1)).toBe(false);
    expect(timeline.finaleComplete(0)).toBe(true); expect(timeline.finaleComplete(1)).toBe(true);
    expect(spectatorSlot(0, timeline)).toBe(1);
    expect(() => formationAt([scheduler.plan()], -1)).toThrow('history');
    expect(timeline.poseAt(0)).not.toEqual(timeline.poseAt(1));
  });
});
