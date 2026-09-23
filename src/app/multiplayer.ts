import { MatchController } from '../network/match-controller.js';
import { LobbyConnection } from '../network/lobby-connection.js';
import type { InvitationLink } from '../network/invitation-link.js';
import { HostRoomPanel } from '../ui/host-room.js';
import { GuestRoomPanel } from '../ui/guest-room.js';
import { LobbyPanel } from '../ui/lobby.js';
import type { Settings } from '../storage/records.js';
import type { World } from '../rendering/world.js';
import { SharedCombat } from '../rendering/shared-combat.js';
import { snapshotSharedFrame } from '../rendering/shared-frame.js';
import type { IceMode } from '../network/ice-policy.js';
import type { PreparedConnection } from '../network/lobby-connection.js';
import { FormationPlayback } from '../network/replica-plans.js';
import { formationData } from '../network/formation-data.js';
import { hash } from '../simulation/math.js';
import type { MatchDisplay } from '../network/match-display.js';
import { matchPlayerStatus, matchPrediction, matchReleaseStatus } from '../ui/match-hud.js';
import { TERRAIN_THEMES } from '../config/terrain.js';
import { speedOf } from '../simulation/flight-track.js';

/** Local opt-in application preview; solo persistence and preferences stay owned by the solo app. */
export class MultiplayerApp {
  private readonly root = document.createElement('section');
  private panel: HostRoomPanel | GuestRoomPanel;
  private lobby: LobbyConnection | null = null;
  private lobbyPanel: LobbyPanel | null = null;
  private match: MatchController | null = null;
  private effects: SharedCombat | null = null;
  private active = true;
  private failed = false;
  private connecting = false;
  private busy = false;
  private admitted = false;
  private lastPaint = -Infinity;
  private lastPaintPhase = '';
  private lastReport = -Infinity;
  private redraw = false;
  private renderedDisplay: MatchDisplay | null = null;
  private lastInputRevision = -1;
  private prewarming: Promise<void> | null = null;
  private animation = 0;
  private readonly prewarmAbort = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly app: HTMLElement;
  private readonly sessionName: HTMLElement;
  constructor(private readonly world: World, private readonly settings: Settings, private readonly leave: () => void,
    invitation: InvitationLink | null = null) {
    const app = document.querySelector<HTMLElement>('#app');
    const sessionName = app?.querySelector<HTMLElement>('#session-name');
    if (!app || !sessionName) throw new Error('Missing application UI.');
    this.app = app; this.sessionName = sessionName;
    app.dataset.multiplayer = 'true'; sessionName.textContent = 'PRIVATE TWO-PLAYER FLIGHT';
    for (const element of app.querySelectorAll<HTMLElement>('#panel, #hud')) element.hidden = true;
    this.root.id = 'multiplayer-app';
    this.root.innerHTML = `
      <div class="multiplayer-setup panel">
        <p class="eyebrow">PRIVATE FLIGHT / DEVELOPMENT PREVIEW</p>
        <p>Network gameplay integration. Assistance is selected in the lobby. Shared resume, reconnect, in-flight assistance changes, audio and saved match records are not available yet.</p>
        <label>My role <select id="match-role"><option value="host">Host / Player 1</option><option value="guest">Join / Player 2</option></select></label>
        <div id="match-room"></div>
        <div id="match-connect">
          <label>Connection <select id="match-route"><option value="auto">Automatic</option><option value="direct">Direct-only diagnostic</option><option value="udp">TURN UDP</option><option value="tcp">TURN TCP</option><option value="tls">TURN TLS</option></select></label>
          <button id="match-connect-button" class="primary" disabled>CONNECT LOBBY</button>
        </div>
        <div id="match-lobby"></div>
      </div>
      <div id="match-instruments" class="hud" aria-label="Two-player flight instruments" hidden>
        ${([0, 1] as const).map(slot => `<div class="${slot === 0 ? 'score-card' : 'miss-card'}" role="group" aria-label="Player ${slot + 1}">
          <span class="eyebrow" id="match-player-${slot}">PLAYER ${slot + 1} / ${slot === 0 ? 'HOST' : 'GUEST'}</span>
          <strong id="match-score-${slot}" aria-label="Score">0</strong>
          <span id="match-misses-${slot}"></span><span id="match-assist-${slot}"></span>
          <span id="match-status-${slot}" role="status"></span>
        </div>`).join('')}
        <div id="match-reticle" class="impact-reticle" role="img" aria-label="Your predicted bomb impact" hidden><span>IMPACT</span></div>
        <div class="flight-tape"><span id="match-speed"></span><span id="match-pass"></span></div>
        <div class="release-panel"><span id="match-view"></span><strong id="match-release"></strong>
          <span id="match-input" role="status"></span><span id="match-assistance"></span><span id="match-phase" role="status"></span></div>
        <button id="match-pause" class="pause-button">HOLD MATCH / ESC</button>
      </div>
      <div id="match-loading" role="status" hidden>Preparing both aircraft, terrain and effects...</div>
      <div id="match-message" role="alert" hidden></div>
      <button id="match-exit" class="secondary">LEAVE PRIVATE FLIGHT</button>`;
    app.append(this.root);
    this.panel = invitation ? new GuestRoomPanel(this.get('#match-room'), invitation) : new HostRoomPanel(this.get('#match-room'));
    this.get<HTMLSelectElement>('#match-role').value = invitation ? 'guest' : 'host';
    this.get('#match-role').onchange = () => { void this.changeRole(); };
    this.get('#match-connect-button').onclick = () => { void this.connect(); };
    this.get('#match-exit').onclick = () => { void this.close(); };
    this.get('#match-pause').onclick = () => this.pause();
    this.timer = setInterval(() => { void this.match?.update(); }, 10);
    this.animation = requestAnimationFrame(this.animate);
  }
  private animate = () => {
    if (!this.active || this.failed) return;
    this.update();
    this.animation = requestAnimationFrame(this.animate);
  };
  private get<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error('Missing multiplayer application control.');
    return element;
  }
  private text(selector: string, value: string) {
    const element = this.get(selector);
    if (element.textContent !== value) element.textContent = value;
  }
  private async changeRole() {
    if (this.connecting || this.lobby || this.match || !this.active || this.failed) return;
    const select = this.get<HTMLSelectElement>('#match-role');
    select.disabled = true;
    await this.panel.dispose();
    if (!this.active || this.failed) return;
    this.panel = select.value === 'host' ? new HostRoomPanel(this.get('#match-room')) : new GuestRoomPanel(this.get('#match-room'));
    select.disabled = false; this.admitted = false;
  }
  private async connect() {
    if (this.connecting || this.lobby || !this.active || this.failed) return;
    this.connecting = true;
    this.get<HTMLSelectElement>('#match-role').disabled = true;
    try {
      const mode = this.get<HTMLSelectElement>('#match-route').value;
      if (!['auto', 'direct', 'udp', 'tcp', 'tls'].includes(mode)) throw new Error('Invalid connection mode.');
      const seed = crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff;
      const connection = await LobbyConnection.connect(this.panel.session.admittedMember(), this.settings, mode as IceMode, seed,
        undefined, prepared => {
          if (!this.active || this.failed) { prepared.link.close(); return; }
          this.world.setTerrain(prepared.course.manifest.terrain);
          this.app.dataset.terrain = prepared.course.manifest.terrain;
          this.world.configure(prepared.lobby.settings.quality);
          this.world.reset();
          this.match = new MatchController(prepared, (_slot, view, range) => this.world.captureMissileView(view, range));
          this.effects = new SharedCombat(this.world.combat, this.match.timeline!);
          this.lobbyPanel?.dispose(); this.lobbyPanel = null;
          this.get('#match-loading').hidden = false;
          this.prewarming = this.prewarm(prepared).catch(error => {
            if (!this.active || this.failed) return;
            const message = error instanceof Error ? error.message : 'The shared scene could not finish loading.';
            this.match?.hold(message);
            this.error(message);
          }).finally(() => { this.get('#match-loading').hidden = true; });
        });
      if (!this.active || this.failed) { connection.close(); return; }
      this.lobby = connection;
      this.lobbyPanel = new LobbyPanel(this.get('#match-lobby'), connection.lobby, () => {
        const next = connection.lobby.settings;
        this.world.configure(next.quality);
        this.resized();
      });
    } catch (error) {
      if (this.active) this.error(error instanceof Error ? error.message : 'Could not connect the private flight.');
    } finally { this.connecting = false; }
  }
  private async prewarm(prepared: PreparedConnection): Promise<void> {
    const payload = prepared.role === 'guest' ? prepared.formations[0].payload : null;
    if (payload && payload.kind !== 'formation') throw new Error('Missing prepared scene formation.');
    const data = prepared.role === 'host' ? formationData(prepared.authored.scheduler.plan(0), 0) : payload!.data;
    if (!('attempts' in data)) throw new Error('Invalid prepared scene formation.');
    const flight = new FormationPlayback(data);
    const aircraft = (slot: 0 | 1) => ({ pose: flight.pose(slot, 0), bomb: null, released: false, destroyed: false });
    this.world.updateSharedFrame(snapshotSharedFrame({ time: 0, terrain: flight.terrain,
      viewedSlot: prepared.role === 'host' ? 0 : 1,
      aircraft: [aircraft(0), aircraft(1)],
      views: [flight.view(0, 0), flight.view(1, 0)],
      targets: [{ id: 1, position: flight.target, kind: flight.targetKind, heading: hash(1, 7, prepared.course.manifest.seed) * Math.PI * 2,
        destroyed: false, sightDistance: flight.sightDistance, canyon: flight.terrain === 'river-canyon' }],
      impacts: [], effectPositions: [], prediction: null, ready: false }));
    this.world.renderOnce();
    await this.world.prepareSharedScene(this.prewarmAbort.signal);
    if (!this.active || this.failed) return;
    this.world.renderOnce();
    this.match!.assetsLoaded();
  }
  update(): void {
    if (!this.active || this.failed || this.busy) return;
    this.busy = true;
    void this.tick().catch(error => { if (this.active) this.fail(error); }).finally(() => { this.busy = false; });
  }
  private async tick() {
    if (this.redraw && !this.match?.display) {
      this.world.renderOnce(); this.redraw = false;
    }
    if (this.match) {
      if (!this.active) return;
      const match = this.match, next = match.display;
      this.root.dataset.phase = match.phase;
      if (next && this.effects && (this.redraw || match.inputRevision !== this.lastInputRevision ||
        next.frame.time > this.lastPaint || match.phase !== this.lastPaintPhase)) {
        const frame = snapshotSharedFrame({ ...next.frame, effectPositions: this.effects.effectPositions(),
          prediction: match.phase === 'playing' ? matchPrediction(next) : null });
        this.world.updateSharedFrame(frame);
        this.effects.render(this.world.renderOrigin);
        this.world.renderOnce();
        this.lastPaint = frame.time;
        this.lastPaintPhase = match.phase;
        this.renderedDisplay = { ...next, frame };
        this.lastInputRevision = match.inputRevision;
        this.redraw = false;
      }
      const display = this.renderedDisplay, frame = display?.frame;
      if (match.phase === 'over' && (!display || display.winner === null)) throw new Error('Completed match lacks its authoritative result.');
      this.root.dataset.time = String(frame?.time ?? 0);
      this.get('.multiplayer-setup').hidden = true;
      this.get('#match-instruments').hidden = false;
      if (display) for (const slot of [0, 1] as const) {
        const player = display.players[slot];
        this.text(`#match-player-${slot}`, `PLAYER ${slot + 1} / ${slot === display.localSlot ? 'YOU' : slot === 0 ? 'HOST' : 'GUEST'}`);
        this.text(`#match-score-${slot}`, String(player.score));
        this.text(`#match-misses-${slot}`, `${player.misses} / 3 MISSES`);
        this.text(`#match-assist-${slot}`, player.assisted ? 'ASSISTED' : 'UNASSISTED');
        this.text(`#match-status-${slot}`, matchPlayerStatus(player, display.frame.time));
      }
      this.text('#match-view', frame && display
        ? `${frame.viewedSlot === display.localSlot ? 'YOUR AIRCRAFT' : 'SPECTATING'} / PLAYER ${frame.viewedSlot + 1}` : '');
      this.text('#match-phase', match.phase === 'countdown' ? `Starting in ${Math.ceil((match.startup.remainingMs ?? 0) / 1000)}`
        : match.phase === 'over' ? 'MATCH COMPLETE / NO RECORDS SAVED IN THIS PREVIEW' : match.phase.toUpperCase());
      this.text('#match-release', match.phase === 'over' && display
        ? display.winner === 'draw' ? 'MATCH DRAW' : `PLAYER ${Number(display.winner) + 1} WINS`
        : match.phase === 'held' ? 'MATCH HELD' : display ? matchReleaseStatus(display) : 'STAND BY');
      this.text('#match-assistance', display ? display.players[display.localSlot].assistance ? 'YOUR IMPACT ASSIST: ON' : 'YOUR IMPACT ASSIST: OFF' : '');
      this.text('#match-input', match.inputIssue ?? '');
      this.text('#match-speed', frame ? `SPD ${Math.round(speedOf(frame.aircraft[frame.viewedSlot].pose))}` : '');
      this.text('#match-pass', frame ? `${TERRAIN_THEMES[frame.terrain].label} / PASS ${frame.targets.at(-1)!.id}` : '');
      const reticle = this.get('#match-reticle');
      const projected = frame?.prediction && match.phase === 'playing' ? this.world.projectPoint(frame.prediction.position) : null;
      reticle.hidden = !projected;
      if (projected && frame?.prediction) {
        reticle.style.left = `${projected.x * 100}%`; reticle.style.top = `${projected.y * 100}%`;
        reticle.classList.toggle('on-target', frame.prediction.hit);
      }
      if (!frame) this.text('#match-lobby', match.phase === 'countdown'
        ? `Both ready. Starting in ${Math.ceil((match.startup.remainingMs ?? 0) / 1000)}...` : 'Preparing the shared flight...');
      if (match.issue) this.error(match.issue + ' Leave this preview and create a new room to continue.');
      return;
    }
    const admitted = this.panel.session.state.room?.state === 'admitted';
    const button = this.get<HTMLButtonElement>('#match-connect-button');
    button.disabled = this.connecting || !!this.lobby || !admitted;
    if (admitted && !this.admitted && !button.disabled) button.focus();
    this.admitted = admitted;
    this.lobbyPanel?.render();
    if (this.lobby && performance.now() - this.lastReport >= 1000) {
      this.lastReport = performance.now();
      const report = await this.lobby.report();
      if (this.active && report.error) this.error(`Connection failed: ${report.error}. Leave and create a new room.`);
    }
  }
  release(): void { if (this.renderedDisplay) this.match?.release(this.renderedDisplay.frame); }
  resized(): void { this.redraw = true; }
  fail(error: unknown): void {
    if (!this.active || this.failed) return;
    this.failed = true;
    clearInterval(this.timer); cancelAnimationFrame(this.animation); this.prewarmAbort.abort();
    const message = error instanceof Error ? error.message : 'The multiplayer scene could not continue.';
    this.match?.hold(message);
    this.get<HTMLButtonElement>('#match-connect-button').disabled = true;
    this.error(message);
    this.get('#match-reticle').hidden = true;
    console.error('Multiplayer application failed:', error);
  }
  pause(): void {
    if (this.match && !['over', 'closed', 'held'].includes(this.match.phase)) {
      this.match.hold('The shared flight was held. Resume is not implemented in this preview.');
    } else if (this.lobby?.lobby.selectedReady) this.lobby.lobby.setReady(false);
  }
  private error(message: string) { this.get('#match-message').hidden = false; this.text('#match-message', message); }
  async close(): Promise<void> {
    if (!this.active) return;
    this.active = false; clearInterval(this.timer); cancelAnimationFrame(this.animation);
    this.prewarmAbort.abort();
    this.match?.close(); this.lobby?.close(); this.lobbyPanel?.dispose();
    await this.prewarming;
    this.effects?.dispose();
    await this.panel.dispose();
    this.root.remove(); this.world.configure(this.settings.quality); this.world.setTerrain(this.settings.terrain); this.world.reset();
    delete this.app.dataset.multiplayer; this.sessionName.textContent = 'SOLO TRAINING RANGE';
    this.leave();
  }
}
