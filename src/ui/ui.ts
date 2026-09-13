import type { Run } from '../game/run';
import { difficulty, MAX_MISSES } from '../config/game';
import type { Quality } from '../config/game';
import { accuracy } from '../simulation/ballistics';
import type { Vec3 } from '../simulation/math';
import type { Settings, Score } from '../storage/records';
import type { FinalePhase } from '../game/missile';
import { isTerrainTheme, TERRAIN_THEMES } from '../config/terrain';

export type Screen = 'loading' | 'menu' | 'playing' | 'ending' | 'paused' | 'over' | 'error';
export interface Actions {
  start(): void; pause(): void; resume(): void; menu(): void;
  settings(settings: Settings): boolean;
}

export class UI {
  readonly app: HTMLElement;
  private settings: Settings;
  private screen: Screen = 'loading';
  private panel: HTMLElement;
  private notification: HTMLElement;
  private scoreList: HTMLElement;
  private previousRunLabel = '';

  constructor(settings: Settings, actions: Actions) {
    this.settings = settings;
    const app = document.querySelector<HTMLElement>('#app');
    if (!app) throw new Error('Missing application root.');
    this.app = app;
    app.innerHTML = `
      <header class="masthead"><a class="wordmark" href="./" aria-label="Low Pass home"><span class="wing-icon">///</span> LOW PASS<span class="edition">FLIGHT LAB / 01</span></a>
        <div class="session-label"><span class="live-dot"></span> SOLO TRAINING RANGE</div>
      </header>
      <main id="panel" class="panel">
        <div class="eyebrow">KESTREL / PRECISION FLIGHT</div>
        <h1 id="title">Loading the<br><em>flight line.</em></h1>
        <p id="description" class="description">Preparing aircraft and terrain.</p>
        <div id="start-actions" class="actions" hidden><button id="start" class="primary">BEGIN FLIGHT <span>↗</span></button><span class="key-note">ONE KEY. PERFECT TIMING.</span></div>
        <div id="pause-actions" class="actions" hidden><button id="resume" class="primary">RESUME FLIGHT</button><button id="quit" class="secondary">END RUN</button></div>
        <div id="retry-actions" class="actions" hidden><button id="retry" class="primary">RELOAD GAME</button></div>
        <div id="instructions" class="instructions" hidden>
          <div><span class="instruction-index">01</span><p><strong>The aircraft flies itself.</strong> Follow the target as the pilot dives.</p></div>
          <div><span class="instruction-index">02</span><p><strong><kbd>SPACE</kbd> to release.</strong> Time one bomb to the center of the rings.</p></div>
          <div><span class="instruction-index">03</span><p><strong>Three misses. Flight over.</strong> Each pass gets faster and harder.</p></div>
        </div>
        <details id="settings"><summary>FLIGHT SETTINGS <span>+</span></summary>
          <div class="settings-body">
            <label>Terrain <select id="terrain" aria-describedby="terrain-note"><option value="green-valley">Green Valley</option><option value="desert">Desert</option></select></label>
            <p id="terrain-note">Preview your terrain here. Fixed for each flight; gameplay is identical.</p>
            <label>Graphics quality <select id="quality"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
            <label>Predicted impact marker <input id="assist" type="checkbox"></label>
            <label>Mute sound <input id="mute" type="checkbox"></label>
            <label>Volume <input id="volume" aria-label="Volume" type="range" min="0" max="100"></label>
            <p>Assisted runs are marked in your local flight records.</p>
          </div>
        </details>
        <details id="records"><summary>LOCAL FLIGHT RECORDS <span>+</span></summary><ol id="score-list"></ol><p class="fine-print">Stored in this browser profile only. Clearing site data removes your records.</p></details>
        <details id="credits"><summary>AIRCRAFT & ASSET CREDITS <span>+</span></summary>
          <p class="fine-print">Kestrel aircraft, tank, radar station, SAM launcher, missiles, scenery, procedural sand, and synthesized audio: original Low Pass assets.<br>
          Ground037 and Rock030: ambientCG, CC0 1.0. Babylon.js: Apache-2.0.<br>
          <a href="/assets/credits.txt" target="_blank" rel="noopener">Asset notices</a></p>
        </details>
      </main>
      <section id="hud" class="hud" aria-label="Flight instruments" hidden>
        <div id="impact-reticle" class="impact-reticle" role="img" aria-label="Predicted bomb impact" hidden><span>IMPACT</span></div>
        <div class="score-card"><span class="eyebrow">TOTAL SCORE</span><strong id="score">0000</strong><span id="level">PASS 01 / LEVEL 01</span></div>
        <div class="miss-card"><span class="eyebrow">MISSES</span><strong id="misses">0 / 3</strong><button id="pause" class="pause-button" aria-label="Pause flight">PAUSE <kbd>ESC</kbd></button></div>
        <div class="flight-tape"><span id="altitude">ALT 155</span><span id="speed">SPD 76</span><span id="damage">AIRFRAME OK</span></div>
        <div id="result" class="result" role="status" aria-live="polite"></div>
        <div class="release-panel"><span id="flight-status" role="status">CRUISING / FINDING TARGET</span><strong id="release-hint">STAND BY</strong><span id="aim-readout">IMPACT ASSIST ON</span></div>
        <button id="assist-toggle" class="assist-button">IMPACT ASSIST: ON <kbd>A</kbd></button>
      </section>
      <div id="notification" class="notification" role="alert" hidden></div>
      <footer><span>KESTREL F/B-01 <span class="separator">/</span> <span id="range-name"></span></span><span id="footer-note">BROWSER FLIGHT EXPERIMENT</span></footer>
    `;
    this.panel = this.get('#panel');
    this.notification = this.get('#notification');
    this.scoreList = this.get('#score-list');
    this.get<HTMLSelectElement>('#terrain').value = settings.terrain;
    this.updateTerrainLabel();
    this.get<HTMLSelectElement>('#quality').value = settings.quality;
    this.get<HTMLInputElement>('#assist').checked = settings.assist;
    this.get<HTMLInputElement>('#mute').checked = settings.muted;
    this.get<HTMLInputElement>('#volume').value = String(settings.volume * 100);
    this.get('#start').onclick = actions.start;
    this.get('#pause').onclick = actions.pause;
    this.get('#resume').onclick = actions.resume;
    this.get('#quit').onclick = actions.menu;
    this.get('#retry').onclick = () => location.reload();
    const settingsChanged = () => {
      const quality = this.get<HTMLSelectElement>('#quality').value;
      const terrain = this.get<HTMLSelectElement>('#terrain').value;
      if (quality !== 'low' && quality !== 'medium' && quality !== 'high') throw new Error('Invalid graphics quality.');
      if (!isTerrainTheme(terrain)) throw new Error('Invalid terrain choice.');
      const next: Settings = {
        quality: quality as Quality, assist: this.get<HTMLInputElement>('#assist').checked,
        muted: this.get<HTMLInputElement>('#mute').checked, volume: Number(this.get<HTMLInputElement>('#volume').value) / 100,
        terrain,
      };
      if (actions.settings(next)) {
        this.settings = next;
        this.updateTerrainLabel();
      } else this.get<HTMLSelectElement>('#terrain').value = this.settings.terrain;
    };
    for (const id of ['#terrain', '#quality', '#assist', '#mute', '#volume']) this.get(id).onchange = settingsChanged;
    this.get('#assist-toggle').onclick = () => {
      this.get<HTMLInputElement>('#assist').checked = !this.settings.assist;
      settingsChanged();
    };
  }

  private get<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.app.querySelector<T>(selector);
    if (!element) throw new Error(`Missing UI control: ${selector}`);
    return element;
  }
  toggleAssist(): void { this.get<HTMLButtonElement>('#assist-toggle').click(); }

  private updateTerrainLabel(): void {
    const theme = TERRAIN_THEMES[this.settings.terrain];
    this.app.dataset.terrain = this.settings.terrain;
    this.get('#range-name').textContent = theme.range;
    if (this.screen === 'menu') this.get('#description').textContent =
      `The pilot has the aircraft. You have one moment. Chase the perfect drop through ${theme.landscape}.`;
  }

  show(screen: Screen, run?: Run): void {
    this.screen = screen;
    this.app.dataset.screen = screen;
    const preflight = screen === 'menu' || screen === 'over';
    this.get<HTMLSelectElement>('#terrain').disabled = !preflight;
    this.get('#terrain-note').textContent = preflight
      ? 'Preview your terrain here. Fixed for each flight; gameplay is identical.'
      : 'Terrain is fixed for this flight. Choose again before your next flight.';
    this.panel.hidden = screen === 'playing' || screen === 'ending';
    this.get('#hud').hidden = screen !== 'playing' && screen !== 'ending';
    this.get('#start-actions').hidden = screen !== 'menu' && screen !== 'over';
    this.get('#pause-actions').hidden = screen !== 'paused';
    this.get('#quit').hidden = screen === 'paused' && run?.status === 'over';
    this.get('#retry-actions').hidden = screen !== 'error';
    this.get('#instructions').hidden = screen !== 'menu';
    for (const id of ['#settings', '#records', '#credits']) this.get(id).hidden = screen === 'loading' || screen === 'error';
    const title = this.get('#title'), description = this.get('#description');
    if (screen === 'menu') {
      title.innerHTML = 'Stay low.<br><em>Make it count.</em>';
      this.updateTerrainLabel();
      this.get('#start').innerHTML = 'BEGIN FLIGHT <span>↗</span>';
    } else if (screen === 'paused') {
      title.innerHTML = 'Holding<br><em>position.</em>';
      description.textContent = run?.status === 'over'
        ? 'The final missile sequence is paused. Your completed score has already been saved.'
        : 'Your flight is paused. Resume when you are ready, or end this run without saving a score.';
    } else if (screen === 'over' && run) {
      title.innerHTML = 'Aircraft<br><em>lost.</em>';
      description.textContent = `${run.score.toLocaleString()} points. ${run.resolved} targets. Three misses let a missile through. Your completed run is saved locally when browser storage is available.`;
      this.get('#start').innerHTML = 'FLY AGAIN <span>↗</span>';
    } else if (screen === 'error') title.innerHTML = 'Flight<br><em>interrupted.</em>';
    const focus = screen === 'paused' ? '#resume' : screen === 'menu' || screen === 'over' ? '#start' : screen === 'error' ? '#retry' : null;
    if (focus) this.get(focus).focus({ preventScroll: true });
    if (screen === 'playing') this.previousRunLabel = '';
  }
  loading(message: string): void { this.get('#description').textContent = message; }
  error(message: string): void { this.show('error'); this.get('#description').textContent = message; }
  warn(message: string): void {
    console.warn(message);
    this.notification.hidden = false;
    this.notification.textContent = message;
  }
  scores(scores: readonly Score[]): void {
    this.scoreList.replaceChildren();
    if (!scores.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No completed flights yet. Make your first pass.';
      this.scoreList.append(empty);
    }
    for (const score of scores) {
      const row = document.createElement('li');
      row.textContent = `${score.score.toLocaleString()} pts / ${new Date(score.date).toLocaleDateString()} / ${score.assisted ? 'assisted' : 'unassisted'}`;
      this.scoreList.append(row);
    }
  }
  update(run: Run, prediction: Vec3 | null, projected: { x: number; y: number } | null,
    finale: FinalePhase | null, missileActive: boolean, damageLevel: number): void {
    this.app.dataset.finale = finale ?? 'none';
    this.app.dataset.missile = String(missileActive);
    this.app.dataset.damage = String(damageLevel);
    this.app.dataset.targetKind = run.encounter.targetKind;
    if (this.screen !== 'playing' && this.screen !== 'ending') return;
    const pose = run.pose, d = difficulty(run.encounter.id - 1);
    this.get('#score').textContent = String(run.score).padStart(4, '0');
    this.get('#level').textContent = `PASS ${String(run.encounter.id).padStart(2, '0')} / LEVEL ${String(d.level).padStart(2, '0')}`;
    this.get('#misses').textContent = `${run.misses} / ${MAX_MISSES}`;
    this.get('#altitude').textContent = `ALT ${Math.round(pose.position.y - 12)}`;
    this.get('#speed').textContent = `SPD ${Math.round(pose.velocity.z)}`;
    this.get('#damage').textContent = finale === 'destroyed' || finale === 'complete' ? 'AIRFRAME LOST'
      : damageLevel === 2 ? 'CRITICAL DAMAGE' : damageLevel === 1 ? 'AIRFRAME DAMAGED' : 'AIRFRAME OK';
    let label = 'CRUISING / FINDING TARGET', hint = 'STAND BY';
    if (run.ready) { label = 'TARGET ACQUIRED / BOMB READY'; hint = 'SPACE TO RELEASE'; }
    if (run.bomb) { label = 'BOMB AWAY / TRACKING IMPACT'; hint = 'WATCH YOUR DROP'; }
    if (run.result) { label = 'PASS COMPLETE / CLIMBING'; hint = 'NEXT TARGET AHEAD'; }
    if (this.screen === 'ending') {
      label = finale === 'incoming' ? 'MISSILE LOCK / EVASION FAILED' : 'AIRCRAFT DESTROYED';
      hint = finale === 'incoming' ? 'MISSILE INBOUND' : 'FLIGHT LOST';
    }
    if (label !== this.previousRunLabel) {
      this.get('#flight-status').textContent = label;
      this.get('#release-hint').textContent = hint;
      this.previousRunLabel = label;
    }
    const predictedScore = prediction ? accuracy(prediction, run.encounter.target) : 0;
    const readout = this.get('#aim-readout');
    readout.textContent = this.settings.assist
      ? run.ready ? `PREDICTED ACCURACY ${predictedScore}%` : 'IMPACT ASSIST ON'
      : 'IMPACT ASSIST OFF / VISUAL RELEASE';
    readout.dataset.accuracy = String(predictedScore);
    if (this.screen === 'ending') readout.textContent = 'THREE MISSES / RUN ENDED';
    const reticle = this.get('#impact-reticle');
    reticle.hidden = !this.settings.assist || !run.ready || !projected || this.screen !== 'playing';
    if (projected && !reticle.hidden) {
      reticle.style.left = `${projected.x * 100}%`;
      reticle.style.top = `${projected.y * 100}%`;
      reticle.classList.toggle('on-target', predictedScore > 0);
    }
    this.get('#assist-toggle').hidden = this.screen === 'ending';
    this.get('#assist-toggle').innerHTML = `IMPACT ASSIST: ${this.settings.assist ? 'ON' : 'OFF'} <kbd>A</kbd>`;
    const result = this.get('#result');
    result.textContent = run.result ? run.result.points ? `+${run.result.points} / ${run.result.points >= 95 ? 'PRECISION HIT' : 'ON TARGET'}` : run.result.impact ? 'MISS / OUTSIDE THE RINGS' : 'MISS / NO RELEASE' : '';
    result.classList.toggle('miss', run.result?.points === 0);
    this.app.dataset.encounter = String(run.encounter.id);
    this.app.dataset.ready = String(run.ready);
  }
}
