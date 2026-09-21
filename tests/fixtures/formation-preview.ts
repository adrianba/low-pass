import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { STEP } from '../../src/config/game';
import { isTerrainTheme, TERRAIN_THEMES } from '../../src/config/terrain';
import type { TerrainTheme } from '../../src/config/terrain';
import { planValleyFormation } from '../../src/game/formation/valley';
import type { ValleyFormation } from '../../src/game/formation/valley';
import { planCanyonFormation } from '../../src/game/formation/canyon';
import type { CanyonFormation } from '../../src/game/formation/canyon';
import { advanceBomb, contactAccuracy, predictImpact } from '../../src/simulation/ballistics';
import type { Bomb } from '../../src/simulation/ballistics';
import { CHASE_VIEW_TOLERANCE } from '../../src/simulation/chase-timeline';
import type { ChaseView } from '../../src/simulation/chase-camera';
import { distance, hash } from '../../src/simulation/math';
import { initialPose, launchFrom } from '../../src/simulation/pose';
import type { Pose } from '../../src/simulation/pose';
import { routePoint } from '../../src/terrain/canyon-route';
import { surfaceFor } from '../../src/terrain/surface';
import type { Contact } from '../../src/terrain/surface';
import { World } from '../../src/rendering/world';
import type { AircraftView } from '../../src/rendering/aircraft-view';
import { snapshotWorldFrame } from '../../src/rendering/world-frame';
import type { WorldEffectHooks, WorldFrame } from '../../src/rendering/world-frame';

type Plan = ValleyFormation | CanyonFormation;
type Slot = 0 | 1;
export interface PreviewConfig { terrain: TerrainTheme; seed: number; tier: number; scripted: boolean }
interface Pilot {
  releasedAt: number | null; bomb: Bomb | null; steps: number; score: number | null;
  result: { id: number; points: number; impact: Contact | null; time: number } | null;
}
interface PixelBounds { width: number; height: number; visible: boolean; center: { x: number; y: number } }
export interface PreviewSnapshot {
  config: PreviewConfig; generation: number; time: number; startAt: number; endAt: number; handoffAt: number;
  releaseAt: number[]; acquireAt: number[]; cutoffAt: number[]; view: Slot; paused: boolean; aspect: number;
  viewportSupported: boolean; reason: string; poses: Pose[]; releasedAt: Array<number | null>;
  bombs: Array<Bomb | null>; scores: Array<number | null>; ready: boolean[]; results: Pilot['result'][];
  renderedResults: number[]; targetEnabled: boolean; targetDestroyed: boolean; targetId: number;
  targetAppearance: Array<{ name: string; paint: number[] | null; rotation: number[] }>;
  origin: number; cameraError: number; cameraMatches: boolean; counts: number[]; aircraftEnabled: boolean[];
  sharedGeometry: boolean; sharedMaterials: boolean; aircraftPixels: Array<PixelBounds | null>;
  bombPixels: Array<PixelBounds | null>; prediction: { points: number; projected: { x: number; y: number } | null } | null;
  effects: Array<{ position: number[]; visibility: number }>;
}
export interface FormationPreviewAPI {
  ready(): Promise<PreviewSnapshot>;
  configure(config: Partial<PreviewConfig>): Promise<PreviewSnapshot>;
  seek(time: number): Promise<PreviewSnapshot>;
  advance(seconds: number): Promise<PreviewSnapshot>;
  pause(value?: boolean): PreviewSnapshot;
  view(slot: Slot): PreviewSnapshot;
  drop(slot?: Slot): PreviewSnapshot;
  snapshot(): PreviewSnapshot;
  dispose(): void;
}
declare global { interface Window { formationPreview: FormationPreviewAPI } }

function element<T extends HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing preview element: ${selector}`);
  return value;
}
const canvas = element<HTMLCanvasElement>('canvas'), stage = element('#stage');
const status = element('#status'), hud = element('#hud'), reticle = element('#reticle');
const terrainInput = element<HTMLSelectElement>('#terrain'), seedInput = element<HTMLInputElement>('#seed');
const tierInput = element<HTMLInputElement>('#tier'), scriptedInput = element<HTMLInputElement>('#scripted');
const viewInput = element<HTMLSelectElement>('#view'), playButton = element<HTMLButtonElement>('#play');
const dropButton = element<HTMLButtonElement>('#drop');
const configuration = element<HTMLFieldSetElement>('#configuration');
const viewport = Object.freeze({ minAspect: 0.75, maxAspect: 2 });
const noCombat: WorldEffectHooks = {
  finale: () => { throw new Error('The geometry preview cannot start a finale.'); },
  flyby: () => {}, damage: () => {},
};
let config: PreviewConfig = { terrain: 'green-valley', seed: 7, tier: 1, scripted: true };
let world: World | null = null, other: AircraftView | null = null, plan: Plan | null = null;
let pilots: [Pilot, Pilot] = [emptyPilot(), emptyPilot()];
let time = 0, worldTime = 0, viewed: Slot = 0, paused = true, busy = false, disposed = false, heldSpace = false;
let generation = 0, resultSequence = 0, latestResult: WorldFrame['result'] = null, renderedResults: number[] = [];
let viewportReason = '', failure = '', prediction: PreviewSnapshot['prediction'] = null;
let cameraError = 0, origin = 0, animation = 0;

function emptyPilot(): Pilot { return { releasedAt: null, bomb: null, steps: 0, score: null, result: null }; }
function current(): { world: World; plan: Plan; other: AircraftView } {
  if (!world || !plan || !other || disposed) throw new Error('The preview is not ready.');
  return { world, plan, other };
}
function poseAt(slot: Slot, shared = time): Pose {
  const attempt = current().plan.attempts[slot], local = shared - attempt.releaseAt;
  if (local < attempt.track.startTime || local > attempt.track.endTime) throw new Error('Preview exceeds authored track coverage.');
  return attempt.track.at(local);
}
function ready(slot: Slot): boolean {
  const attempt = current().plan.attempts[slot], pilot = pilots[slot];
  return pilot.releasedAt === null && pilot.score === null && time >= attempt.acquireAt && time <= attempt.cutoffAt;
}
function checkViewport(): boolean {
  if (!world) return false;
  const aspect = world.engine.getRenderWidth() / world.engine.getRenderHeight();
  const supported = Number.isFinite(aspect) && aspect >= viewport.minAspect && aspect <= viewport.maxAspect;
  viewportReason = supported ? '' : `Paused: canvas aspect ${aspect.toFixed(3)} is outside the unapproved 0.75–2 envelope. Resize the window; no flight or release is permitted.`;
  if (!supported) paused = true;
  return supported;
}
function release(slot: Slot, at: number): void {
  if (pilots[slot].releasedAt !== null) return;
  const attempt = current().plan.attempts[slot];
  if (at < attempt.acquireAt || at > attempt.cutoffAt) throw new Error('Release is outside the authored attempt window.');
  pilots[slot].releasedAt = at;
  pilots[slot].bomb = launchFrom(poseAt(slot, at));
}
function settle(slot: Slot, impact: Contact | null): void {
  const pilot = pilots[slot], active = current().plan;
  const points = impact ? contactAccuracy(impact, active.target, surfaceFor(config.terrain)) : 0;
  pilot.score = points;
  pilot.bomb = null;
  pilot.result = { id: ++resultSequence, points, impact, time };
  latestResult = { id: resultSequence, points, impact, flyby: false };
  present(false);
}
function displayedBomb(slot: Slot): Bomb | null {
  const pilot = pilots[slot];
  if (!pilot.bomb || pilot.releasedAt === null) return null;
  const fraction = Math.max(0, Math.min(1, (time - pilot.releasedAt - pilot.steps * STEP) / STEP));
  const next = structuredClone(pilot.bomb);
  advanceBomb(next, STEP, surfaceFor(config.terrain));
  const result = structuredClone(pilot.bomb);
  for (const axis of ['x', 'y', 'z'] as const) {
    result.position[axis] += (next.position[axis] - result.position[axis]) * fraction;
    result.velocity[axis] += (next.velocity[axis] - result.velocity[axis]) * fraction;
  }
  return result;
}

function present(draw: boolean): void {
  const active = current(), attempt = active.plan.attempts[viewed];
  const pose = poseAt(viewed), view = attempt.camera.at(time - attempt.releaseAt);
  const impact = draw && ready(viewed) ? predictImpact(launchFrom(pose), surfaceFor(config.terrain)) : null;
  const points = impact ? contactAccuracy(impact, active.plan.target, surfaceFor(config.terrain)) : 0;
  const frame = snapshotWorldFrame({
    aircraft: { pose, bomb: displayedBomb(viewed), released: pilots[viewed].releasedAt !== null },
    target: {
      id: generation, position: active.plan.target, kind: active.plan.targetKind,
      heading: hash(config.tier, 7, config.seed) * Math.PI * 2,
      sightDistance: Math.max(...active.plan.attempts.map(a => a.acquisition.range)), canyon: config.terrain === 'river-canyon',
    },
    prediction: impact ? { position: impact, hit: points > 0 } : null,
    ready: ready(viewed), over: false, result: latestResult,
  });
  active.world.updateFrame(frame, Math.max(0, time - worldTime), noCombat, view);
  worldTime = time;
  origin = view.position.z - active.world.camera.position.z;
  const remote: Slot = viewed === 0 ? 1 : 0;
  active.other.update({ pose: poseAt(remote), bomb: displayedBomb(remote), released: pilots[remote].releasedAt !== null,
    destroyed: false, canyon: config.terrain === 'river-canyon' }, origin);
  if (latestResult && renderedResults.at(-1) !== latestResult.id) renderedResults.push(latestResult.id);
  if (!draw) return;
  active.world.camera.getViewMatrix(true);
  const actual = active.world.chaseSnapshot();
  cameraError = Math.max(distance(actual.position, view.position), distance(actual.target, view.target));
  if (cameraError > CHASE_VIEW_TOLERANCE) {
    paused = true;
    failure = `Authored camera mismatch (${cameraError.toPrecision(4)} world units). Preview paused.`;
  }
  const aspect = active.world.engine.getRenderWidth() / active.world.engine.getRenderHeight();
  if (time >= attempt.acquireAt && time <= attempt.acquireAt + attempt.acquisition.margin && !viewportReason) {
    const check = attempt.camera.verify(time - attempt.releaseAt, actual, aspect, attempt.acquisition);
    if (!check.ok) { paused = true; failure = `Acquisition fairness check failed: ${check.reason}.`; }
  }
  prediction = impact ? { points, projected: active.world.projectPoint(impact) } : null;
  reticle.hidden = !prediction?.projected || !checkViewport();
  if (prediction?.projected) {
    reticle.style.left = `${prediction.projected.x * 100}%`;
    reticle.style.top = `${prediction.projected.y * 100}%`;
    reticle.classList.toggle('miss', prediction.points === 0);
  }
  active.world.render();
  hud.textContent = `${viewed === 0 ? 'LEAD' : 'FOLLOWER'} · ${TERRAIN_THEMES[config.terrain].label} · pass ${config.tier}\n`
    + `3D speed ${Math.hypot(pose.velocity.x, pose.velocity.y, pose.velocity.z).toFixed(0)} · Ground clearance ${(pose.position.y - surfaceFor(config.terrain).height(pose.position.x, pose.position.z)).toFixed(0)}\n`
    + `Release clock ${(time - attempt.releaseAt).toFixed(2)}s · ${prediction ? `Projected ${prediction.points} points` : pilots[viewed].releasedAt !== null ? 'Bomb released' : 'Acquiring target'}`;
  refreshControls();
}
function refreshControls(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('button:not(#configure)')) button.disabled = busy || !world || !plan;
  viewInput.disabled = scriptedInput.disabled = busy;
  playButton.textContent = paused ? 'Play' : 'Pause';
  dropButton.disabled = busy || !plan || !world || !!viewportReason || !ready(viewed);
  for (const slot of [0, 1] as const) element(`#score-${slot}`).textContent = pilots[slot].score?.toString() ?? '—';
  status.textContent = failure || viewportReason || (plan
    ? `${paused ? 'Paused' : 'Playing'} · shared clock ${(time - plan.startAt).toFixed(2)}s · independent release lag ${plan.releaseLag.toFixed(3)}s · camera ${cameraError <= CHASE_VIEW_TOLERANCE ? 'matches authored view' : 'MISMATCH'}`
    : 'Build a course to begin.');
  status.classList.toggle('error', !!failure || !!viewportReason);
}

function advanceTo(target: number): void {
  const active = current().plan;
  if (!Number.isFinite(target) || target < time || target > active.coverageEndAt) throw new Error('Advance exceeds authored preview coverage; use seek to rewind.');
  if (!checkViewport()) { refreshControls(); throw new Error(viewportReason); }
  if (failure) throw new Error(failure);
  let work = 0;
  while (time < target) {
    if (++work > 12_000) throw new Error('Preview exceeded bounded fixed-step work.');
    const tick = active.startAt + (Math.floor((time - active.startAt) / STEP + 1e-7) + 1) * STEP;
    let next = Math.min(target, tick);
    for (const slot of [0, 1] as const) {
      const pilot = pilots[slot], attempt = active.attempts[slot];
      if (pilot.releasedAt === null && pilot.score === null) {
        if (config.scripted && attempt.releaseAt > time) next = Math.min(next, attempt.releaseAt);
        next = Math.min(next, attempt.cutoffAt + STEP);
      }
      if (pilot.bomb && pilot.releasedAt !== null) next = Math.min(next, pilot.releasedAt + (pilot.steps + 1) * STEP);
    }
    if (next <= time) throw new Error('Preview event clock failed to advance.');
    time = next;
    for (const slot of [0, 1] as const) {
      const pilot = pilots[slot], attempt = active.attempts[slot];
      if (config.scripted && pilot.releasedAt === null && pilot.score === null && time === attempt.releaseAt) release(slot, attempt.releaseAt);
      if (pilot.bomb && pilot.releasedAt !== null && pilot.releasedAt + (pilot.steps + 1) * STEP <= time + 1e-10) {
        const impact = advanceBomb(pilot.bomb, STEP, surfaceFor(config.terrain));
        pilot.steps++;
        if (impact) settle(slot, impact);
      }
      if (pilot.releasedAt === null && pilot.score === null && time >= attempt.cutoffAt + STEP) settle(slot, null);
    }
    present(false);
  }
  if (time >= active.coverageEndAt) paused = true;
  present(true);
}

function reset(): void {
  const active = current();
  paused = true; heldSpace = false; failure = '';
  active.world.reset(); active.other.reset();
  pilots = [emptyPilot(), emptyPilot()]; latestResult = null; renderedResults = []; resultSequence = 0;
  time = worldTime = active.plan.startAt;
  present(true);
}
function disposeWorld(): void {
  other?.dispose(); other = null;
  world?.dispose(); world = null;
}
async function author(request: PreviewConfig): Promise<Plan> {
  const canyon = request.terrain === 'river-canyon';
  let previous: [Pose, Pose] = canyon
    ? [initialPose({ ...routePoint(600, 0), y: 167 }), initialPose({ ...routePoint(600 - 76 * 1.2, 0), y: 167 })]
    : [initialPose(), initialPose({ x: -8, y: 167, z: -114 })];
  let previousViews: [ChaseView | null, ChaseView | null] = [null, null], startAt = 0, authored: Plan | null = null;
  for (let count = 0; count < request.tier; count++) {
    status.textContent = `Authoring sequential pass ${count + 1}/${request.tier}…`;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (disposed) throw new Error('Preview was disposed.');
    const common = { encounterId: `preview-${request.terrain}-${request.seed}-${count}`, count, seed: request.seed,
      startAt, previous, previousViews, viewport, acquisitionMargin: 0.1 };
    const result = canyon ? planCanyonFormation({ ...common,
      candidates: [0.12, -0.12].map(phaseDelta => ({ lag: 1.2, phaseDelta, entryPadding: 0, maxEntryExtension: 3 })),
      departure: { before: 0.1, after: 0.2, screenMargin: 0.02 },
    }) : planValleyFormation({ ...common, terrain: request.terrain as 'green-valley' | 'desert',
      candidates: [{ lag: 1.5, maxLagAdjustment: 0.1, phaseDelta: 0.35, maxLateralCorrection: 80, maxForwardCorrection: 20 }],
    });
    if (!result.ok) throw new Error(`Pass ${count + 1} rejected: ${JSON.stringify(result.failures)}`);
    authored = result.plan;
    startAt = authored.handoffAt;
    previous = authored.attempts.map(a => a.track.at(startAt - a.releaseAt)) as [Pose, Pose];
    previousViews = authored.attempts.map(a => a.camera.at(startAt - a.releaseAt)) as [ChaseView, ChaseView];
  }
  if (!authored) throw new Error('No encounter was authored.');
  return authored;
}
async function configure(values: Partial<PreviewConfig>): Promise<PreviewSnapshot> {
  if (busy || disposed) throw new Error('Preview configuration is unavailable.');
  const request = { ...config, ...values };
  if (!isTerrainTheme(request.terrain) || !Number.isInteger(request.seed) || request.seed < 0 || request.seed > 2147483647 ||
    !Number.isInteger(request.tier) || request.tier < 1 || request.tier > 30 || typeof request.scripted !== 'boolean') {
    throw new Error('Choose a valid terrain, integer seed and sequential pass 1–30.');
  }
  busy = true; paused = true; failure = ''; configuration.disabled = true; refreshControls();
  try {
    const authored = await author(request);
    disposeWorld();
    plan = authored; config = request; generation++;
    world = new World(canvas, 'low', config.terrain);
    await world.load(message => { status.textContent = message; });
    other = world.createAircraftView('Formation other ');
    world.engine.resize();
    checkViewport();
    reset();
    await world.scene.whenReadyAsync();
    present(true);
    terrainInput.value = config.terrain; seedInput.value = String(config.seed); tierInput.value = String(config.tier);
    scriptedInput.checked = config.scripted;
    element('#parameters').textContent = config.terrain === 'river-canyon'
      ? 'UNAPPROVED inputs: lag 1.2s, phase ±0.12, entry-extension allowance 3s. Lead-departure check: −0.1…+0.2s.'
      : 'UNAPPROVED inputs: lag 1.5s + allowance 0.1s, phase 0.35, lateral correction ≤80, forward correction ≤20.';
    return snapshot();
  } catch (error) {
    if (!other) disposeWorld();
    failure = `Configuration rejected; preview paused. ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  } finally {
    busy = false; configuration.disabled = false; refreshControls();
  }
}

function pixels(root: TransformNode): PixelBounds | null {
  const active = current().world, width = active.engine.getRenderWidth(), height = active.engine.getRenderHeight();
  if (!root.isEnabled()) return null;
  const points = root.getChildMeshes().filter(mesh => mesh.isEnabled() && mesh.getTotalVertices() > 0).flatMap(mesh => {
    mesh.computeWorldMatrix(true);
    return mesh.getBoundingInfo().boundingBox.vectorsWorld.map(point =>
      Vector3.Project(point, Matrix.Identity(), active.scene.getTransformMatrix(), active.camera.viewport.toGlobal(width, height)));
  });
  if (!points.length) return null;
  const xs = points.map(p => p.x / width), ys = points.map(p => p.y / height);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  return { width: (right - left) * stage.clientWidth, height: (bottom - top) * stage.clientHeight,
    visible: points.every(p => p.z >= 0 && p.z <= 1) && left >= 0 && right <= 1 && top >= 0 && bottom <= 1,
    center: { x: (left + right) / 2, y: (top + bottom) / 2 } };
}
function snapshot(): PreviewSnapshot {
  const active = current(), primary = active.world.scene.getTransformNodeByName('Aircraft pose');
  const primaryBomb = active.world.scene.getTransformNodeByName('Bomb pose');
  if (!primary || !primaryBomb) throw new Error('Missing loaded aircraft roots.');
  const roots = viewed === 0 ? [primary, active.other.root] : [active.other.root, primary];
  const bombs = viewed === 0 ? [primaryBomb, active.other.bombRoot] : [active.other.bombRoot, primaryBomb];
  const meshes = roots.map(root => root.getChildMeshes().find(mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0));
  const a = meshes[0], b = meshes[1], scene = active.world.scene;
  return {
    config: { ...config }, generation, time, startAt: active.plan.startAt, endAt: active.plan.coverageEndAt,
    handoffAt: active.plan.handoffAt, releaseAt: active.plan.attempts.map(a => a.releaseAt),
    acquireAt: active.plan.attempts.map(a => a.acquireAt), cutoffAt: active.plan.attempts.map(a => a.cutoffAt),
    view: viewed, paused, aspect: active.world.engine.getRenderWidth() / active.world.engine.getRenderHeight(),
    viewportSupported: !viewportReason, reason: failure || viewportReason,
    poses: [poseAt(0), poseAt(1)], releasedAt: pilots.map(p => p.releasedAt), bombs: pilots.map(p => structuredClone(p.bomb)),
    scores: pilots.map(p => p.score), ready: [ready(0), ready(1)], results: pilots.map(p => structuredClone(p.result)),
    renderedResults: [...renderedResults], targetEnabled: scene.getMeshByName('Target')?.isEnabled() ?? false,
    targetDestroyed: pilots.some(p => p.score !== null && p.score > 0), targetId: generation, origin,
    targetAppearance: scene.getTransformNodeByName('Encounter target')!.getChildMeshes().filter(mesh => mesh.isEnabled()).map(mesh => ({
      name: mesh.name, paint: mesh.material instanceof PBRMaterial ? mesh.material.albedoColor.asArray() : null,
      rotation: mesh.rotation.asArray(),
    })),
    cameraError, cameraMatches: cameraError <= CHASE_VIEW_TOLERANCE,
    counts: [scene.meshes.length, scene.materials.length, scene.geometries.length, scene.textures.length, scene.transformNodes.length],
    aircraftEnabled: roots.map(root => root.isEnabled()),
    sharedGeometry: a instanceof Mesh && b instanceof Mesh && a.geometry === b.geometry,
    sharedMaterials: a instanceof Mesh && b instanceof Mesh && a.material === b.material,
    aircraftPixels: roots.map(pixels), bombPixels: bombs.map(pixels), prediction,
    effects: scene.meshes.filter(mesh => mesh.name === 'Impact dust').map(mesh => ({
      position: mesh.position.asArray(), visibility: mesh.visibility,
    })),
  };
}

async function settleRender(): Promise<PreviewSnapshot> {
  await current().world.scene.whenReadyAsync();
  present(true);
  return snapshot();
}
const api: FormationPreviewAPI = {
  ready: async () => { await initial; return snapshot(); },
  configure,
  seek: async target => {
    if (busy) throw new Error('Preview is authoring a plan.');
    const active = current().plan;
    if (!Number.isFinite(target) || target < active.startAt || target > active.coverageEndAt) throw new Error('Seek exceeds authored preview coverage.');
    if (!checkViewport()) throw new Error(viewportReason);
    reset(); advanceTo(target); return settleRender();
  },
  advance: async seconds => {
    if (busy || !Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid preview advance.');
    advanceTo(time + seconds); return settleRender();
  },
  pause: (value = true) => {
    if (busy) throw new Error('Preview is authoring a plan.');
    paused = value || !checkViewport() || !!failure;
    if (!paused && time >= current().plan.coverageEndAt) { reset(); paused = false; }
    refreshControls(); return snapshot();
  },
  view: slot => {
    if (busy) throw new Error('Preview is authoring a plan.');
    if (slot !== 0 && slot !== 1) throw new Error('Invalid viewed pilot.');
    viewed = slot; viewInput.value = String(slot);
    present(true); return snapshot();
  },
  drop: (slot = viewed) => {
    if (busy) throw new Error('Preview is authoring a plan.');
    if (slot !== 0 && slot !== 1) throw new Error('Invalid drop pilot.');
    if (checkViewport() && !failure && ready(slot)) release(slot, time);
    present(true); return snapshot();
  },
  snapshot,
  dispose: () => { disposed = true; paused = true; cancelAnimationFrame(animation); resize.disconnect(); disposeWorld(); },
};
window.formationPreview = api;
function userAction(action: () => unknown | Promise<unknown>): void {
  Promise.resolve().then(action).catch(error => {
    paused = true; failure = error instanceof Error ? error.message : String(error); refreshControls();
  });
}
element('#configure').addEventListener('click', () => userAction(() => api.configure({
  terrain: terrainInput.value as TerrainTheme, seed: Number(seedInput.value), tier: Number(tierInput.value),
  scripted: scriptedInput.checked,
})));
playButton.addEventListener('click', () => userAction(() => api.pause(!paused)));
element('#replay').addEventListener('click', () => userAction(() => api.seek(current().plan.startAt)));
dropButton.addEventListener('click', () => userAction(() => api.drop()));
viewInput.addEventListener('change', () => userAction(() => api.view(Number(viewInput.value) as Slot)));
scriptedInput.addEventListener('change', () => { config = { ...config, scripted: scriptedInput.checked }; });
element('#lead-mark').addEventListener('click', () => userAction(() => api.seek(current().plan.attempts[0].releaseAt - 0.001)));
element('#follower-mark').addEventListener('click', () => userAction(() => api.seek(current().plan.attempts[1].releaseAt - 0.001)));
element('#results').addEventListener('click', () => userAction(() => api.seek(current().plan.handoffAt)));
canvas.addEventListener('pointerdown', () => canvas.focus());
window.addEventListener('keydown', event => {
  if (event.code !== 'Space' || (event.target instanceof HTMLElement && event.target.matches('input,select,textarea,button'))) return;
  event.preventDefault();
  if (event.repeat || heldSpace) return;
  heldSpace = true;
  userAction(() => api.drop());
});
window.addEventListener('keyup', event => { if (event.code === 'Space') heldSpace = false; });
window.addEventListener('blur', () => { heldSpace = false; paused = true; if (plan && other) refreshControls(); });
window.addEventListener('beforeunload', () => api.dispose());
const resize = new ResizeObserver(() => {
  if (!world || !other || busy) return;
  world.engine.resize(); checkViewport(); present(true);
});
resize.observe(stage);
let lastFrame = performance.now();
function frame(now: number): void {
  if (disposed) return;
  const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  if (!paused && !busy && plan && other) {
    try { advanceTo(Math.min(plan.coverageEndAt, time + dt)); }
    catch (error) { failure = error instanceof Error ? error.message : String(error); paused = true; refreshControls(); }
  }
  animation = requestAnimationFrame(frame);
}
animation = requestAnimationFrame(frame);
const initial = configure({});
void initial.catch(() => {});
