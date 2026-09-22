import { QUALITY } from '../../src/config/game';
import type { Quality } from '../../src/config/game';
import { FORMATION_PROFILE } from '../../src/config/multiplayer';
import { isTerrainTheme } from '../../src/config/terrain';
import type { TerrainTheme } from '../../src/config/terrain';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler';
import { HostCombat, formationSampler, spectatorSlot, endingTime } from '../../src/game/multiplayer/host-combat';
import type { PlayerSlot } from '../../src/game/multiplayer/session';
import { ReleaseKey } from '../../src/input/keyboard';
import { contactAccuracy, predictImpact } from '../../src/simulation/ballistics';
import { launchFrom } from '../../src/simulation/pose';
import { distance } from '../../src/simulation/math';
import { surfaceFor } from '../../src/terrain/surface';
import { hostWorldFrame } from '../../src/rendering/host-frame';
import { SharedCombat } from '../../src/rendering/shared-combat';
import { World } from '../../src/rendering/world';

const scenarios = ['lead-first', 'follower-first', 'early-lead', 'draw', 'hits', 'manual'] as const;
type Scenario = typeof scenarios[number];
export interface CombatPreviewConfig { terrain: TerrainTheme; seed: number; pass: number; quality: Quality; scenario: Scenario }
function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing combat preview element: ${selector}`);
  return found;
}
const canvas = element<HTMLCanvasElement>('canvas'), status = element('#status'), hud = element('#hud');
const reticle = element('#reticle'), key = new ReleaseKey();
let world: World | null = null, effects: SharedCombat | null = null;
let scheduler: FormationScheduler | null = null, director: HostCombat | null = null;
let config: CombatPreviewConfig = { terrain: 'green-valley', seed: 7, pass: 1, quality: 'low', scenario: 'lead-first' };
let time = 0, startTime = 0, paused = true, busy = false, disposed = false, preferred: PlayerSlot = 1, viewed: PlayerSlot = 1;
let failure = '', viewportReason = '', cameraError = 0, animation = 0, lastWallTime = 0;
let prediction: { points: number; x: number; y: number } | null = null;
let feedback = '', feedbackUntil = 0;
let cueCounts = { missile: 0, flyby: 0, damaged: 0, destroyed: 0 };

function current() {
  if (!world || !effects || !scheduler || !director || disposed) throw new Error('Combat preview is not ready.');
  return { world, effects, scheduler, director };
}
function checkViewport(): boolean {
  if (!world) return false;
  const aspect = world.engine.getRenderWidth() / world.engine.getRenderHeight(), envelope = FORMATION_PROFILE.viewport;
  const supported = Number.isFinite(aspect) && aspect >= envelope.minAspect && aspect <= envelope.maxAspect;
  viewportReason = supported ? '' : `Paused: canvas aspect ${aspect.toFixed(3)} is outside ${envelope.minAspect}-${envelope.maxAspect}. Resize the window.`;
  if (!supported) { paused = true; scheduler?.session.pause(); }
  return supported;
}
function finished(): boolean {
  if (!scheduler) return false;
  const end = endingTime(scheduler);
  return end !== null && time >= end;
}
function plannedDrop(slot: PlayerSlot): number | null {
  const game = current().scheduler, plan = game.plan(), state = game.session.snapshot();
  if (state.players[slot]!.completion ||
    state.encounters.find(e => e.sequence === game.sequence)!.attempts[slot]!.releasedAt !== null) return null;
  const pass = game.sequence - config.pass + 1, losing = config.scenario === 'follower-first' ? 1 : 0;
  if (config.scenario === 'manual' || config.scenario === 'draw') return null;
  if (config.scenario === 'hits' || (slot !== losing && pass < 3)) return plan.attempts[slot].releaseAt;
  if (config.scenario === 'early-lead' && slot === 0 && pass < 3) {
    return Math.max(plan.attempts[slot].acquireAt, plan.attempts[slot].releaseAt - 3.85);
  }
  return null;
}
function scriptedDrops(): void {
  const game = current().scheduler;
  for (const slot of [0, 1] as const) {
    const at = plannedDrop(slot);
    if (at !== null && at <= game.session.time) {
      const result = game.session.release(slot, game.sequence);
      if (!result.ok) throw new Error(`Scripted release rejected: ${result.reason}.`);
    }
  }
}
function consume(): void {
  const state = current();
  state.director.consume(state.scheduler.session.drainEvents());
}
function advanceTo(target: number): void {
  const state = current();
  if (!Number.isFinite(target) || target < time || target - time > 60) throw new Error('Invalid preview advance.');
  if (!checkViewport()) throw new Error(viewportReason);
  if (state.scheduler.session.status === 'paused') {
    const resumed = state.scheduler.session.resume();
    if (!resumed.ok) throw new Error(`Cannot resume preview: ${resumed.reason}.`);
  }
  while (time < target && !finished()) {
    if (state.scheduler.session.status === 'over') { time = Math.min(target, endingTime(state.scheduler)!); break; }
    scriptedDrops(); consume();
    let next = Math.min(target, time + 0.25);
    for (const slot of [0, 1] as const) {
      const drop = plannedDrop(slot);
      if (drop !== null && drop > time) next = Math.min(next, drop);
    }
    const result = state.scheduler.advanceTo(next);
    if (!result.ok) throw new Error(`Cannot advance preview: ${result.reason}.`);
    const end = endingTime(state.scheduler);
    time = end === null ? state.scheduler.session.time : Math.min(next, end);
    consume();
  }
  if (state.scheduler.session.status === 'running') { scriptedDrops(); consume(); }
  if (paused) state.scheduler.session.pause();
  if (finished()) paused = true;
}

function present(): void {
  const state = current(), snapshot = state.scheduler.session.snapshot(), plan = state.scheduler.plan();
  const cues = state.effects.timeline.update(state.director.at(time), time,
    [{ misses: snapshot.players[0]!.misses, eliminated: snapshot.players[0]!.completion !== null },
      { misses: snapshot.players[1]!.misses, eliminated: snapshot.players[1]!.completion !== null }],
    formationSampler(state.scheduler));
  for (const cue of cues) cueCounts[cue.cue]++;
  viewed = spectatorSlot(preferred, state.effects.timeline);
  const poses = [state.effects.timeline.poseAt(0), state.effects.timeline.poseAt(1)] as const;
  const views = [state.effects.timeline.finaleView(0) ?? plan.attempts[0].camera.at(snapshot.time - plan.attempts[0].releaseAt),
    state.effects.timeline.finaleView(1) ?? plan.attempts[1].camera.at(snapshot.time - plan.attempts[1].releaseAt)] as const;
  const ready = state.scheduler.session.releaseState(preferred, state.scheduler.sequence).ok;
  const impact = ready && snapshot.players[preferred]!.assistance ? predictImpact(launchFrom(poses[preferred]), surfaceFor(config.terrain)) : null;
  const points = impact ? contactAccuracy(impact, plan.target, surfaceFor(config.terrain)) : 0;
  const frame = hostWorldFrame(state.scheduler, viewed, { time, poses, views,
    destroyed: [!state.effects.timeline.aliveAt(0), !state.effects.timeline.aliveAt(1)],
    effectPositions: state.effects.effectPositions(),
    prediction: impact ? { position: impact, hit: points > 0 } : null });
  state.world.updateSharedFrame(frame);
  state.effects.render(state.world.renderOrigin);
  state.world.render();
  const actual = state.world.chaseSnapshot(), expected = views[viewed];
  cameraError = Math.max(distance(actual.position, expected.position), distance(actual.target, expected.target));
  if (cameraError > 0.001) throw new Error(`Combat camera mismatch: ${cameraError}.`);
  prediction = null;
  if (impact) {
    const projected = state.world.projectPoint(impact);
    if (projected) prediction = { points, ...projected };
  }
  reticle.hidden = !prediction || !ready || viewed !== preferred;
  if (prediction) { reticle.style.left = `${prediction.x * 100}%`; reticle.style.top = `${prediction.y * 100}%`; }
  const name = viewed === 0 ? 'LEAD' : 'FOLLOWER';
  hud.textContent = `${viewed === preferred ? name : `SPECTATING ${name}`} - pass ${state.scheduler.sequence + 1}\n`
    + `Lead: ${snapshot.players[0]!.score} points, ${snapshot.players[0]!.misses}/3 misses\n`
    + `Follower: ${snapshot.players[1]!.score} points, ${snapshot.players[1]!.misses}/3 misses\n`
    + `Speed ${Math.hypot(poses[viewed].velocity.x, poses[viewed].velocity.y, poses[viewed].velocity.z).toFixed(0)}`
    + (prediction ? ` - predicted ${prediction.points} points` : '');
  refresh();
}
function refresh(): void {
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) {
    control.disabled = busy;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('button')) button.disabled ||= !!failure;
  element<HTMLButtonElement>('#configure').disabled = busy;
  if (busy || !scheduler) return;
  const state = scheduler.session.snapshot(), end = endingTime(scheduler);
  const winner = scheduler.session.winner;
  status.textContent = failure || viewportReason || (time < feedbackUntil ? feedback :
    finished() ? winner === 'draw' ? 'Draw. Both players have finished.' : `${winner === 0 ? 'Lead' : 'Follower'} wins. Both players have finished.` :
      end !== null ? 'Both eliminated. The final presentation is still running; pause freezes it.' :
        paused ? 'Paused. Play to continue; Space drops for the selected pilot in Manual mode.' : 'Playing the local shared simulation.');
  status.classList.toggle('error', !!failure || !!viewportReason);
  element<HTMLButtonElement>('#play').disabled ||= finished() || !!viewportReason;
  element<HTMLButtonElement>('#step').disabled ||= finished() || !!viewportReason;
  element<HTMLButtonElement>('#next-pass').disabled ||= finished() || !!viewportReason;
  element('#play').textContent = paused ? 'Play' : 'Pause';
  element<HTMLButtonElement>('#drop').disabled ||= paused || config.scenario !== 'manual' || !scheduler.session.releaseState(preferred, scheduler.sequence).ok;
  const assistance = element<HTMLInputElement>('#assist');
  assistance.checked = state.players[preferred]!.assistance;
  assistance.disabled = busy || state.players[preferred]!.completion !== null;
}
function fail(error: unknown): void {
  failure = error instanceof Error ? error.message : String(error);
  paused = true; scheduler?.session.pause();
  console.error('Combat preview failed:', failure);
  if (scheduler) refresh(); else status.textContent = failure;
}

async function configure(input: Partial<CombatPreviewConfig>) {
  if (busy || disposed) throw new Error('Combat preview is busy or disposed.');
  const next = { ...config, ...input };
  if (!isTerrainTheme(next.terrain) || !Number.isSafeInteger(next.seed) || next.seed < 0 || next.seed > 2147483647 ||
    !Number.isInteger(next.pass) || next.pass < 1 || next.pass > 30 ||
    (next.quality !== 'low' && next.quality !== 'medium' && next.quality !== 'high') || !scenarios.includes(next.scenario)) {
    throw new Error('Invalid combat preview configuration.');
  }
  busy = true; paused = true; failure = ''; feedback = ''; status.textContent = 'Building the shared course...';
  refresh();
  try {
    if (!world) { world = new World(canvas, next.quality, next.terrain); await world.load(text => { status.textContent = text; }); }
    world.reset(); world.setTerrain(next.terrain); world.configure(next.quality);
    effects ??= new SharedCombat(world.combat);
    effects.reset();
    config = next;
    element<HTMLSelectElement>('#terrain').value = config.terrain;
    element<HTMLInputElement>('#seed').value = String(config.seed);
    element<HTMLInputElement>('#pass').value = String(config.pass);
    element<HTMLSelectElement>('#quality').value = config.quality;
    element<HTMLSelectElement>('#scenario').value = config.scenario;
    scheduler = new FormationScheduler(config.terrain, config.seed);
    for (let count = 0; count < config.pass - 1; count++) {
      const plan = scheduler.plan();
      for (const slot of [0, 1] as const) {
        const advanced = scheduler.advanceTo(plan.attempts[slot].releaseAt);
        if (!advanced.ok) throw new Error(`Warmup flight failed: ${advanced.reason}.`);
        const released = scheduler.session.release(slot, count);
        if (!released.ok) throw new Error(`Warmup release failed: ${released.reason}.`);
      }
      const advanced = scheduler.advanceTo(plan.handoffAt);
      if (!advanced.ok) throw new Error(`Warmup handoff failed: ${advanced.reason}.`);
      scheduler.session.drainEvents();
    }
    director = new HostCombat(scheduler, (_slot, view, range) => world!.captureMissileView(view, Math.max(QUALITY[config.quality].distance, range)));
    time = startTime = scheduler.session.time;
    scheduler.session.pause();
    cueCounts = { missile: 0, flyby: 0, damaged: 0, destroyed: 0 };
    checkViewport(); present();
    await world.scene.whenReadyAsync(); world.render();
  } finally { busy = false; if (scheduler) refresh(); }
  return snapshot();
}
function snapshot() {
  const state = current(), players = state.scheduler.session.snapshot().players;
  return { config: { ...config }, time, startTime, simulationTime: state.scheduler.session.time,
    sequence: state.scheduler.sequence, handoffAt: state.scheduler.plan().handoffAt,
    paused, preferred, viewed, finished: finished(), winner: state.scheduler.session.winner,
    status: state.scheduler.session.status, origin: state.world.renderOrigin, cameraError,
    viewportSupported: !viewportReason, failure, prediction, cueCounts: { ...cueCounts },
    players: players.map((p, slot) => ({ score: p.score, misses: p.misses, assisted: p.assisted,
      eliminated: p.completion !== null, visible: state.effects.timeline.aliveAt(slot === 0 ? 0 : 1),
      damage: state.effects.timeline.damageAt(slot === 0 ? 0 : 1) })),
    releaseAt: state.scheduler.plan().attempts.map(a => a.releaseAt), cutoffAt: state.scheduler.plan().attempts.map(a => a.cutoffAt),
    effects: state.effects.timeline.effects.map(e => ({ id: e.data.id, slot: e.data.slot, kind: e.data.missile.kind, age: time - e.data.bornAt })),
    counts: [state.world.scene.meshes.length, state.world.scene.materials.length, state.world.scene.geometries.length, state.world.scene.textures.length],
    smoke: [1, 2].map(i => state.world.scene.meshes.filter(m => m.name === `Player ${i} Aircraft damage smoke` && m.isEnabled()).length),
  };
}
function pause(value = !paused) {
  paused = value || finished();
  if (paused) scheduler?.session.pause();
  else if (scheduler?.session.status === 'paused') scheduler.session.resume();
  present(); return snapshot();
}
function drop() {
  const state = current();
  if (paused || config.scenario !== 'manual') throw new Error('Manual drops require a playing Manual scenario.');
  const result = state.scheduler.session.release(preferred, state.scheduler.sequence);
  feedback = result.ok ? 'Bomb released.' : `No drop: ${result.reason}.`; feedbackUntil = time + 1;
  consume(); present(); return snapshot();
}
const api = {
  ready: () => initialized,
  configure,
  snapshot,
  pause,
  view(slot: PlayerSlot) {
    if (slot !== 0 && slot !== 1) throw new Error('Invalid pilot.');
    preferred = slot; element<HTMLSelectElement>('#view').value = String(slot);
    present(); return snapshot();
  },
  advance(seconds: number) { advanceTo(time + seconds); present(); return snapshot(); },
  drop,
  assist(enabled: boolean) {
    const result = current().scheduler.session.setAssistance(preferred, enabled);
    if (!result.ok) throw new Error(`Assistance rejected: ${result.reason}.`);
    present(); return snapshot();
  },
  dispose() { disposed = true; cancelAnimationFrame(animation); effects?.dispose(); world?.dispose(); },
};
export type CombatPreviewSnapshot = ReturnType<typeof snapshot>;
declare global { interface Window { combatPreview: typeof api } }
window.combatPreview = api;
function action(callback: () => unknown): void { try { callback(); } catch (error) { fail(error); } }
element('#configure').addEventListener('click', () => {
  void configure({ terrain: element<HTMLSelectElement>('#terrain').value as TerrainTheme,
    seed: Number(element<HTMLInputElement>('#seed').value), pass: Number(element<HTMLInputElement>('#pass').value),
    quality: element<HTMLSelectElement>('#quality').value as Quality, scenario: element<HTMLSelectElement>('#scenario').value as Scenario }).catch(fail);
});
element('#play').addEventListener('click', () => action(() => { pause(); canvas.focus(); }));
element('#restart').addEventListener('click', () => { void configure(config).catch(fail); });
element('#step').addEventListener('click', () => action(() => api.advance(1)));
element('#next-pass').addEventListener('click', () => action(() => {
  const end = endingTime(current().scheduler);
  api.advance(Math.min(60, (end ?? current().scheduler.plan().handoffAt) - time));
}));
element('#drop').addEventListener('click', () => action(drop));
element('#view').addEventListener('change', () => action(() => api.view(Number(element<HTMLSelectElement>('#view').value) === 0 ? 0 : 1)));
element('#assist').addEventListener('change', () => action(() => api.assist(element<HTMLInputElement>('#assist').checked)));
canvas.addEventListener('pointerdown', () => canvas.focus());
window.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLButtonElement) return;
  event.preventDefault();
  if (key.down(event.repeat) && !paused && !busy && !failure && config.scenario === 'manual') action(drop);
});
window.addEventListener('keyup', event => { if (event.code === 'Space') key.up(); });
window.addEventListener('blur', () => { if (scheduler && !busy) action(() => pause(true)); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && scheduler && !busy) action(() => pause(true));
});
window.addEventListener('resize', () => {
  if (world && scheduler && !busy) action(() => { world!.engine.resize(); checkViewport(); present(); });
});
function loop(now: number): void {
  const dt = lastWallTime ? Math.min(0.05, (now - lastWallTime) / 1000) : 0;
  lastWallTime = now;
  if (!disposed && scheduler && !busy && !paused && !failure) action(() => { advanceTo(time + dt); present(); });
  if (!disposed) animation = requestAnimationFrame(loop);
}
const initialized = configure({});
void initialized.catch(fail);
animation = requestAnimationFrame(loop);
