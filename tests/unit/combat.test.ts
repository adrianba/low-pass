import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { MissileFlight, finaleFlight, MISSILE_INTERCEPT_TIME, FLYBY_DURATION, FINALE_DURATION, FLYBY_CLEARANCE, shouldFlyby } from '../../src/game/missile';
import { Run, poseAt, aircraftPoint } from '../../src/game/run';
import type { Pose } from '../../src/game/run';
import { distance } from '../../src/simulation/math';
import { CombatEffects } from '../../src/rendering/combat-effects';
import { TargetVehicle } from '../../src/rendering/target-vehicle';

const pose: Pose = {
  position: { x: 20, y: 85, z: 4200 }, velocity: { x: 8, y: 12, z: 350 },
  acceleration: { x: -9.6, y: 0, z: 0 }, pitch: -0.03, bank: 0.3,
};

describe('missile choreography', () => {
  it('intercepts the moving aircraft exactly once, then finishes the explosion', () => {
    const flight = finaleFlight(pose);
    expect(flight.finalePhase).toBe('incoming');
    expect(flight.advance(0)).toBeNull();
    expect(flight.age).toBe(0);
    expect(flight.advance(MISSILE_INTERCEPT_TIME)).toBe('destroyed');
    expect(distance(flight.positionAt(flight.age), flight.aircraftPose().position)).toBeLessThan(1e-8);
    expect(flight.finalePhase).toBe('destroyed');
    expect(flight.advance(0.1)).toBeNull();
    flight.advance(FINALE_DURATION);
    expect(flight.finished).toBe(true);
    expect(flight.finalePhase).toBe('complete');
  });
  it('keeps flybys away from the aircraft and never produces a destruction event', () => {
    const flight = new MissileFlight('flyby', pose, pose.position, -1);
    for (let t = 0; t < FLYBY_DURATION; t += 0.01) {
      const closeAircraft = flight.positionAt(t);
      expect(distance(flight.positionAt(t, closeAircraft), closeAircraft)).toBeGreaterThanOrEqual(FLYBY_CLEARANCE - 1e-9);
    }
    expect(flight.advance(FLYBY_DURATION)).toBe('flyby');
    expect(flight.advance(1)).toBeNull();
    expect(flight.finished).toBe(true);
  });
  it('introduces a flyby on the first hit and varies later encounters reproducibly', () => {
    expect(shouldFlyby(1, 7)).toBe(true);
    const decisions = Array.from({ length: 40 }, (_, i) => shouldFlyby(i + 2, 19));
    expect(decisions).toContain(true);
    expect(decisions).toContain(false);
    expect(decisions).toEqual(Array.from({ length: 40 }, (_, i) => shouldFlyby(i + 2, 19)));
  });
  it('hits the future aircraft position without ending the run for a damage missile', () => {
    const run = new Run(8);
    run.encounter.visibleAt = -6;
    run.encounter.time = 3;
    const future = poseAt(run.encounter, run.encounter.time + MISSILE_INTERCEPT_TIME, 0);
    const flight = new MissileFlight('damage', run.pose, future.position, 1);
    expect(flight.advance(MISSILE_INTERCEPT_TIME)).toBe('damaged');
    expect(distance(flight.positionAt(flight.age), future.position)).toBeLessThan(1e-8);
    expect(flight.advance(0.1)).toBeNull();
    expect(flight.finalePhase).toBeNull();
    expect(run.status).toBe('running');
  });
});

describe('combat rendering lifecycle', () => {
  it('preserves the cloud alpha channel for aircraft smoke instead of rendering solid quads', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      new CombatEffects(scene);
      const smoke = scene.getMaterialByName('Aircraft oil smoke');
      expect(smoke).toBeInstanceOf(StandardMaterial);
      if (!(smoke instanceof StandardMaterial)) throw new Error('Missing aircraft smoke material');
      expect(smoke.diffuseTexture?.hasAlpha).toBe(true);
      expect(smoke.useAlphaFromDiffuseTexture).toBe(true);
      expect(smoke.needAlphaBlending()).toBe(true);
      expect(smoke.disableDepthWrite).toBe(true);
      expect(smoke.diffuseTexture).toBe(scene.getMaterialByName('Missile smoke')?.getActiveTextures()[0]);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it('renders missile movement, destroys the aircraft, and reclaims explosion meshes on restart', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const effects = new CombatEffects(scene);
      const baseline = scene.meshes.length;
      for (let run = 0; run < 5; run++) {
        effects.startFinale(pose);
        effects.advance(0.8);
        effects.render(pose, 4096, 0);
        expect(effects.missileActive).toBe(true);
        const missile = scene.getTransformNodeByName('Surface-to-air missile')!;
        const expected = finaleFlight(pose).positionAt(0.8);
        expect(missile.position.z).toBeCloseTo(expected.z - 4096);
        effects.advance(MISSILE_INTERCEPT_TIME - 0.8);
        effects.render(effects.finalePose!, 4096, 0.1);
        expect(effects.aircraftDestroyed).toBe(true);
        expect(effects.missileActive).toBe(false);
        expect(scene.meshes.length).toBe(baseline + 36);
        expect(scene.meshes.filter(mesh => mesh.name === 'Aircraft explosion').every(mesh => mesh.rotation.x === 0)).toBe(true);
        expect(effects.events.filter(event => event === 'destroyed')).toHaveLength(1);
        effects.advance(FINALE_DURATION);
        effects.render(effects.finalePose!, 4096, 4);
        expect(effects.finalePhase).toBe('complete');
        expect(scene.meshes.length).toBe(baseline);
        effects.reset();
        expect(effects.finalePhase).toBeNull();
        expect(effects.aircraftDestroyed).toBe(false);
        expect(effects.events).toEqual([]);
      }
    } finally { scene.dispose(); engine.dispose(); }
  });
  it('renders a harmless flyby without changing the run or leaving active missiles', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const run = new Run(9);
      run.encounter.visibleAt = -6;
      run.encounter.time = 2.2;
      const effects = new CombatEffects(scene);
      effects.startFlyby(run);
      effects.advance(0.8);
      effects.render(run.pose, 0, 0.8);
      expect(effects.missileActive).toBe(true);
      effects.advance(FLYBY_DURATION);
      effects.render(run.pose, 0, 0);
      expect(effects.missileActive).toBe(false);
      expect(effects.aircraftDestroyed).toBe(false);
      expect(effects.events).toContain('flyby');
      expect(run.misses).toBe(0);
      expect(run.score).toBe(0);
      expect(run.status).toBe('running');
    } finally { scene.dispose(); engine.dispose(); }
  });
  it('builds a tank with tracks and a turret that resets after a target hit', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const tank = new TargetVehicle(scene);
      expect(tank.root.getChildMeshes().some(mesh => mesh.name === 'Tank track')).toBe(true);
      expect(tank.root.getChildMeshes().some(mesh => mesh.name === 'Tank gun barrel')).toBe(true);
      expect(tank.root.getChildMeshes().every(mesh => !mesh.isPickable)).toBe(true);
      tank.setDestroyed(true);
      const turret = scene.getTransformNodeByName('Tank turret')!;
      expect(turret.rotation.z).not.toBe(0);
      tank.setDestroyed(false);
      expect(turret.rotation.length()).toBe(0);
    } finally { scene.dispose(); engine.dispose(); }
  });
  it('keeps smoke after two survivable hits, freezes it on pause, and clears it on restart', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const run = new Run(9);
      run.encounter.visibleAt = -6;
      run.encounter.time = 3;
      const effects = new CombatEffects(scene);
      const baseline = scene.meshes.length;
      for (let hit = 1; hit <= 2; hit++) {
        effects.startDamage(run);
        effects.advance(MISSILE_INTERCEPT_TIME);
        effects.render(run.pose, 4096, 0.1);
        expect(effects.damageLevel).toBe(hit);
        expect(effects.aircraftDestroyed).toBe(false);
        expect(effects.finalePose).toBeNull();
        const smoke = scene.meshes.filter(mesh => mesh.name === 'Aircraft damage smoke' && mesh.isEnabled());
        expect(smoke.length).toBeGreaterThan(0);
        if (hit === 1) {
          const source = aircraftPoint(run.pose, { x: -2.2, y: 0.5, z: -4 });
          expect(smoke[0]!.position.x).toBeCloseTo(source.x);
          expect(smoke[0]!.position.y).toBeCloseTo(source.y);
          expect(smoke[0]!.position.z).toBeCloseTo(source.z - 4096);
        }
        const positions = smoke.map(mesh => mesh.position.clone());
        effects.advance(0);
        effects.render(run.pose, 4096, 0);
        expect(smoke.map(mesh => mesh.position)).toEqual(positions);
        effects.advance(FLYBY_DURATION);
        for (let frame = 0; frame < 50; frame++) effects.render(run.pose, 8192, 0.05);
        expect(scene.meshes.some(mesh => mesh.name === 'Aircraft damage smoke' && mesh.isEnabled())).toBe(true);
        expect(scene.meshes.length).toBe(baseline);
      }
      effects.startFlyby(run);
      effects.advance(FLYBY_DURATION);
      expect(effects.damageLevel).toBe(2);
      expect(effects.events.filter(event => event === 'damaged')).toHaveLength(2);
      expect(run.status).toBe('running');
      expect(run.misses).toBe(0);
      effects.reset();
      expect(effects.damageLevel).toBe(0);
      expect(scene.meshes.filter(mesh => mesh.name === 'Aircraft damage smoke').every(mesh => !mesh.isEnabled())).toBe(true);
      expect(scene.meshes.length).toBe(baseline);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
