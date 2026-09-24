import './ui/style.css';
import { Run } from './game/run';
import { interpolatePose } from './simulation/pose';
import { STEP } from './config/game';
import type { Vec3 } from './simulation/math';
import { World } from './rendering/world';
import { RecordStore } from './storage/records';
import type { Settings } from './storage/records';
import { FlightAudio } from './audio/audio';
import { UI } from './ui/ui';
import type { Screen } from './ui/ui';
import { ReleaseKey } from './input/keyboard';
import { speedOf } from './simulation/flight-track';
import type { MultiplayerApp } from './app/multiplayer';
import { takeInvitationLink } from './network/invitation-link';
import { RoomClient } from './network/room-client';

let ui: UI | null = null;
const warnings: string[] = [];
const warn = (message: string) => { if (ui) ui.warn(message); else warnings.push(message); };
const store = new RecordStore(() => localStorage, warn);
let settings = store.settings;
const audio = new FlightAudio(settings, warn);
let world: World | null = null;
let run = new Run(7, settings.terrain);
let preview: Run | null = run;
let screen: Screen = 'loading';
let accumulator = 0;
let last = performance.now();
let previous = run.pose;
let prediction: Vec3 | null = null;
let predictionClock = 0;
let runId = '';
let pausedFrom: 'playing' | 'ending' = 'playing';
const key = new ReleaseKey();
let multiplayer: MultiplayerApp | null = null;
let openingMultiplayer = false;
const multiplayerPreview = location.pathname === '/multiplayer.html';
let invitation = takeInvitationLink(location.href, url => history.replaceState(history.state, '', url));
let resumeSoloRendering: (() => void) | null = null;

function setScreen(next: Screen): void {
  screen = next;
  ui?.show(next, run);
  accumulator = 0;
  last = performance.now();
}

function changeSettings(next: Settings): boolean {
  if (next.terrain !== settings.terrain && screen !== 'menu' && screen !== 'over') {
    warn('Terrain is fixed for this flight. Choose again before your next flight.');
    return false;
  }
  try {
    if (next.quality !== settings.quality) world?.configure(next.quality);
    if (next.terrain !== settings.terrain) {
      const nextPreview = new Run(7, next.terrain);
      world?.setTerrain(next.terrain);
      world?.reset();
      preview = nextPreview;
      prediction = null;
    }
  } catch (error) { fail(error); return false; }
  settings = next;
  store.update(next);
  audio.configure(next);
  if (screen === 'playing') run.assisted ||= next.assist;
  return true;
}

function pause(): void {
  if (multiplayer) { key.up(); multiplayer.availability(); return; }
  if (screen !== 'playing' && screen !== 'ending') return;
  pausedFrom = screen;
  if (screen === 'playing') run.status = 'paused';
  key.up();
  setScreen('paused');
  void audio.pause();
}

function fail(error: unknown): void {
  if (multiplayer) { multiplayer.fail(error); void audio.pause(); return; }
  console.error(error);
  screen = 'error';
  run.status = 'paused';
  ui?.error(error instanceof Error ? error.message : String(error));
  void audio.pause();
}

ui = new UI(settings, {
  multiplayer() {
    if (!world || multiplayer || openingMultiplayer || screen !== 'menu' && screen !== 'over') return;
    openingMultiplayer = true; key.up();
    void audio.pause(); audio.reset(); void audio.unlock();
    void import('./app/multiplayer').then(({ MultiplayerApp }) => {
      multiplayer = new MultiplayerApp(world!, settings, () => {
        multiplayer = null; key.up(); prediction = null; preview = new Run(7, settings.terrain); setScreen('menu');
        resumeSoloRendering?.();
      }, warn, audio, invitation, () => key.up());
      world!.engine.stopRenderLoop();
      invitation = null;
    }).catch(fail).finally(() => { openingMultiplayer = false; });
  },
  start() {
    if (!world || multiplayer || openingMultiplayer || (screen !== 'menu' && screen !== 'over')) return;
    try { run = new Run(crypto.getRandomValues(new Uint32Array(1))[0]!, settings.terrain); }
    catch (error) { fail(error); return; }
    preview = null;
    runId = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('');
    prediction = null;
    predictionClock = 0;
    previous = run.pose;
    world.reset();
    key.up();
    setScreen('playing');
    void audio.start();
  },
  pause,
  resume() {
    if (screen !== 'paused') return;
    if (pausedFrom === 'playing') run.status = 'running';
    setScreen(pausedFrom);
    void audio.start();
  },
  menu() {
    run.status = 'paused';
    try { preview = new Run(7, settings.terrain); world?.reset(); }
    catch (error) { fail(error); return; }
    setScreen('menu');
    void audio.pause();
  },
  settings: changeSettings,
});
ui.show('loading');
ui.multiplayerAvailable(multiplayerPreview, multiplayerPreview);
if (!multiplayerPreview) {
  void new RoomClient().capabilities().then(status => {
    ui?.multiplayerAvailable(status.multiplayer && status.rooms === true && status.signaling === true && status.turn === true);
    if (!status.multiplayer && invitation) warn('Private flights are unavailable on this server. Solo play is unaffected.');
  }).catch(() => warn('Private flight availability could not be checked. Solo play is unaffected.'));
}
ui.scores(store.scores);
for (const message of warnings) ui.warn(message);

document.addEventListener('keydown', event => {
  const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
  if (multiplayer) {
    const control = event.target instanceof Element && event.target.closest('button, summary, a, textarea, [contenteditable="true"]');
    if (event.code === 'Space' && !editing && !control) {
      event.preventDefault();
      if (key.down(event.repeat)) multiplayer.release();
    }
    if (event.code === 'Escape' && !event.repeat) { event.preventDefault(); key.up(); multiplayer.pause(); }
    if (event.code === 'KeyA' && !event.repeat && !editing && !control) multiplayer.toggleAssistance();
    return;
  }
  if (event.code === 'Space') {
    const pressed = key.down(event.repeat);
    if (screen === 'playing' || screen === 'ending') {
      event.preventDefault();
      if (pressed && !editing && screen === 'playing') run.release();
    }
  }
  if (event.code === 'Escape' && !event.repeat) {
    if (screen === 'playing' || screen === 'ending') pause();
    else if (screen === 'paused') document.querySelector<HTMLButtonElement>('#resume')?.click();
  }
  if (event.code === 'KeyA' && !event.repeat && !editing && screen === 'playing') ui?.toggleAssist();
});
document.addEventListener('keyup', event => { if (event.code === 'Space') key.up(); });
window.addEventListener('blur', pause);
window.addEventListener('focus', () => multiplayer?.availability());
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else multiplayer?.availability(); });
window.addEventListener('resize', () => { world?.engine.resize(); multiplayer?.resized(); });
window.addEventListener('pagehide', () => { void audio.pause(); void multiplayer?.close(); });

async function bootstrap(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene');
  if (!canvas) throw new Error('Missing scene canvas.');
  const view = new World(canvas, settings.quality, settings.terrain);
  world = view;
  view.engine.onContextLostObservable.add(() => fail(new Error('Graphics context lost. Reload to restore the game. Your completed scores are retained.')));
  await view.load(message => ui?.loading(message));
  view.update(run, run.pose, null, 1 / 60);
  view.render();
  setScreen('menu');
  const renderSolo = () => {
    if (screen === 'error') return;
    try {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (screen === 'playing') {
        if (run.encounter.visibleAt === null && view.targetVisible(run)) run.seeTarget();
        accumulator += dt;
        while (accumulator >= STEP) {
          previous = run.pose;
          run.tick(settings.assist);
          accumulator -= STEP;
        }
        predictionClock -= dt;
        if (settings.assist && run.ready && predictionClock <= 0) {
          prediction = run.prediction;
          predictionClock = 1 / 60;
        }
        if (!settings.assist || !run.ready) prediction = null;
        for (const event of run.events.splice(0)) audio.cue(event);
        if (run.status === 'over') {
          store.complete({ id: runId, score: run.score, date: new Date().toISOString(), assisted: run.assisted });
          ui?.scores(store.scores);
          prediction = null;
          setScreen('ending');
        }
      }
      const current = run.pose;
      const alpha = screen === 'playing' ? accumulator / STEP : 1;
      const interpolated = interpolatePose(previous, current, alpha);
      const displayed = preview ?? run;
      view.update(displayed, preview ? preview.pose : interpolated, preview ? null : prediction, screen === 'paused' ? 0 : dt);
      for (const event of view.combat.events.splice(0)) audio.cue(event);
      audio.update(run.surface.canyon ? speedOf(current) : current.velocity.z, run.bomb?.age ?? null, !view.combat.aircraftDestroyed);
      if (screen === 'ending' && view.combat.finalePhase === 'complete') {
        setScreen('over');
        void audio.pause();
      }
      ui?.update(run, prediction, prediction ? view.projectPoint(prediction) : null,
        view.combat.finalePhase, view.combat.missileActive, view.combat.damageLevel);
      view.render();
    } catch (error) { fail(error); }
  };
  resumeSoloRendering = () => view.engine.runRenderLoop(renderSolo);
  resumeSoloRendering();
}

void bootstrap().catch(fail);
