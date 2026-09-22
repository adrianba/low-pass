import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { World, MAX_SHARED_CHUNKS } from '../../src/rendering/world';
import { hostWorldFrame } from '../../src/rendering/host-frame';
import { snapshotSharedFrame } from '../../src/rendering/shared-frame';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler';
import type { PlayerSlot } from '../../src/game/multiplayer/session';
import type { TerrainTheme } from '../../src/config/terrain';
import type { Quality } from '../../src/config/game';
import { CHUNK } from '../../src/config/game';
import { distance } from '../../src/simulation/math';
import { initialPose } from '../../src/simulation/pose';
import { Run } from '../../src/game/run';
import { projectRoute, routePoint } from '../../src/terrain/canyon-route';

const canvas = document.querySelector('canvas');
if (!canvas) throw new Error('Missing shared-scene canvas.');
const world = new World(canvas, 'low');
const loaded = world.load(() => {});
let scheduler: FormationScheduler | null = null;

async function prepare(terrain: TerrainTheme, count: number, quality: Quality) {
  await loaded;
  world.reset(); world.setTerrain(terrain); world.configure(quality);
  scheduler = new FormationScheduler(terrain, 7);
  for (let i = 0; i < count; i++) {
    const plan = scheduler.plan();
    for (const slot of [0, 1] as const) {
      scheduler.advanceTo(plan.attempts[slot].releaseAt); scheduler.session.release(slot, i);
    }
    scheduler.advanceTo(plan.handoffAt); scheduler.session.drainEvents();
  }
}
async function show(slot: PlayerSlot, simultaneous = false) {
  if (!scheduler) throw new Error('Missing shared session.');
  const base = hostWorldFrame(scheduler, slot);
  const target = base.targets.at(-1)!.position;
  const water = routePoint(projectRoute(target.x, target.z).along, 0);
  const frame = simultaneous ? snapshotSharedFrame({ ...base, impacts: [0, 1].map(i => ({
    id: scheduler!.sequence * 2 + i + 1, sequence: scheduler!.sequence, slot: i === 0 ? 0 : 1,
    time: base.time - 0.5, impact: i === 1 && base.terrain === 'river-canyon'
      ? { ...water, y: 0, kind: 'water', normal: { x: 0, y: 1, z: 0 } }
      : { ...target, x: target.x + i * 40, kind: 'ground', normal: { x: 0, y: 1, z: 0 } },
  })) }) : base;
  world.updateSharedFrame(frame);
  await world.scene.whenReadyAsync(); world.render();
  const origin = world.renderOrigin, camera = world.chaseSnapshot(), expected = frame.views[slot];
  const aircraft = [world.scene.getTransformNodeByName('Aircraft pose')!, world.scene.getTransformNodeByName('Player 2 Aircraft pose')!];
  const rings = world.scene.meshes.filter(m => m.name.startsWith('Shared target ') && m.name.endsWith('rings') && m.isEnabled());
  const roots = world.scene.transformNodes.filter(n => n.name.startsWith('Shared target ') && n.name.endsWith('root') && n.isEnabled());
  const terrain = world.scene.meshes.filter(m => m.name.startsWith('Terrain '));
  const keys = new Set(terrain.map(m => m.name.slice('Terrain '.length)));
  const covered = frame.aircraft.every(a => [-14, 14].every(dx => [-14, 14].every(dz =>
    keys.has(`${Math.floor((a.pose.position.x + dx) / CHUNK)},${Math.floor((a.pose.position.z + dz) / CHUNK)}`))));
  return {
    origin, cameraError: Math.max(distance(camera.position, expected.position), distance(camera.target, expected.target)),
    aircraft: aircraft.map(a => ({ enabled: a.isEnabled(), position: a.position.asArray() })),
    expectedAircraft: frame.aircraft.map(a => [a.pose.position.x, a.pose.position.y, a.pose.position.z - origin]),
    bombs: ['Bomb pose', 'Player 2 Bomb pose'].map(name => world.scene.getTransformNodeByName(name)!.isEnabled()),
    targets: roots.map(r => ({ position: r.position.asArray(), destroyed: r.getChildTransformNodes()
      .some(n => n.name.endsWith('Tank turret') && n.rotation.z !== 0) })),
    targetPositions: frame.targets.map(t => [t.position.x, t.position.y, t.position.z - origin]),
    sharedRings: rings.every(r => r instanceof Mesh && r.geometry === (world.scene.getMeshByName('Target') as Mesh).geometry),
    soloHidden: !world.scene.getMeshByName('Target')!.isEnabled() && !world.scene.getTransformNodeByName('Encounter target')!.isEnabled(),
    counts: [world.scene.meshes.length, world.scene.materials.length, world.scene.geometries.length, world.scene.textures.length],
    chunks: terrain.length, chunkBudget: MAX_SHARED_CHUNKS, covered,
    scars: world.scene.meshes.filter(m => m.name.startsWith('Shared impact ') && m.name.endsWith('scar') && m.isEnabled()).length,
    ripples: world.scene.meshes.filter(m => m.name.startsWith('Shared impact ') && m.name.endsWith('Splash ripple') && m.isEnabled()).length,
    scores: scheduler.session.snapshot().players.map(p => p.score),
  };
}
const api = {
  async configure(terrain: TerrainTheme, count = 13, quality: Quality = 'low') {
    await prepare(terrain, count, quality);
    const plan = scheduler!.plan();
    scheduler!.advanceTo(plan.attempts[0].releaseAt);
    scheduler!.session.release(0, scheduler!.sequence);
    scheduler!.advanceTo(plan.attempts[1].releaseAt);
    scheduler!.session.release(1, scheduler!.sequence);
    return show(1);
  },
  show,
  async freshOrigin(slot: PlayerSlot) {
    if (!scheduler) throw new Error('Missing shared session.');
    world.reset();
    const run = new Run(7, scheduler.terrain);
    world.update(run, run.pose, null, 0);
    world.reset();
    return show(slot);
  },
  async settle(slot: PlayerSlot) {
    scheduler!.advanceTo(scheduler!.plan().handoffAt);
    return show(slot);
  },
  async solo() {
    world.reset(); world.setTerrain('green-valley');
    const run = new Run(7);
    world.update(run, initialPose(), null, 0);
    await world.scene.whenReadyAsync(); world.render();
    return { otherHidden: !world.scene.getTransformNodeByName('Player 2 Aircraft pose')!.isEnabled(),
      targetsHidden: world.scene.meshes.filter(m => m.name.startsWith('Shared target ') && m.name.endsWith('rings')).every(m => !m.isEnabled()),
      impactsHidden: world.scene.meshes.filter(m => m.name.startsWith('Shared impact ')).every(m => !m.isEnabled()) };
  },
  dispose() { world.dispose(); },
};
declare global { interface Window { sharedScene: typeof api } }
window.sharedScene = api;
