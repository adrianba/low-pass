import { MatchController } from '../network/match-controller.js';
import { LobbyConnection, LobbyViewportError } from '../network/lobby-connection.js';
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
import { matchParticipationStatus, matchPlayerStatus, matchPrediction, matchReleaseStatus, matchViewStatus } from '../ui/match-hud.js';
import { TERRAIN_THEMES } from '../config/terrain.js';
import { speedOf } from '../simulation/flight-track.js';
import { FORMATION_PROFILE } from '../config/multiplayer.js';
import { connectPeer } from '../network/connect-peer.js';
import { MultiplayerRecordStore } from '../storage/multiplayer-records.js';
import { MultiplayerRecordsPanel, MultiplayerResultsPanel } from '../ui/multiplayer-results.js';
import type { FlightAudio } from '../audio/audio.js';
import { MultiplayerAudio } from '../audio/multiplayer.js';

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
  private viewportWarning = false;
  private busy = false;
  private admitted = false;
  private lastPaint = -Infinity;
  private lastPaintPhase = '';
  private lastReport = -Infinity;
  private redraw = false;
  private renderedDisplay: MatchDisplay | null = null;
  private readonly records: MultiplayerRecordStore;
  private readonly results: MultiplayerResultsPanel;
  private readonly setupRecords: MultiplayerRecordsPanel;
  private mode: IceMode = 'auto';
  private readonly sound: MultiplayerAudio;
  private preferredAssistance: boolean | null = null;
  private lastInputRevision = -1;
  private prewarming: Promise<void> | null = null;
  private animation = 0;
  private readonly prewarmAbort = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly app: HTMLElement;
  private readonly sessionName: HTMLElement;
  constructor(private readonly world: World, private readonly settings: Settings, private readonly leave: () => void,
    warn: (message: string) => void, private readonly audio: FlightAudio,
    invitation: InvitationLink | null = null, private readonly clearInput: () => void = () => {}) {
    const app = document.querySelector<HTMLElement>('#app');
    const sessionName = app?.querySelector<HTMLElement>('#session-name');
    if (!app || !sessionName) throw new Error('Missing application UI.');
    this.app = app; this.sessionName = sessionName;
    this.sound = new MultiplayerAudio(audio);
    this.records = new MultiplayerRecordStore(() => localStorage, warn);
    app.dataset.multiplayer = 'true'; sessionName.textContent = 'PRIVATE TWO-PLAYER FLIGHT';
    for (const element of app.querySelectorAll<HTMLElement>('#panel, #hud')) element.hidden = true;
    this.root.id = 'multiplayer-app';
    this.root.innerHTML = `
      <div class="multiplayer-setup panel">
        <p class="eyebrow">PRIVATE FLIGHT / DEVELOPMENT PREVIEW</p>
        <p>Private host-authoritative play with shared pause, 15-second connection recovery and completed-match rematches. Scores are saved separately from solo. A toggles your impact assistance during flight; any use marks your score assisted. Sound follows the viewed aircraft. Local graphics and sound settings are available while paused.</p>
        <div id="match-setup-records"></div>
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
          <span id="match-participation" role="status"></span>
          <span id="match-input" role="status"></span><span id="match-assistance"></span><span id="match-phase" role="status"></span></div>
        <button id="match-assistance-toggle" class="pause-button">TOGGLE ASSIST / A</button>
        <button id="match-pause" class="pause-button">PAUSE MATCH / ESC</button>
      </div>
      <div id="match-pause-card" class="panel" aria-label="Shared pause" hidden>
        <h2>SHARED PAUSE</h2>
        <p id="match-pause-reason" role="status"></p>
        <p id="match-pause-readiness" role="status"></p>
        <p id="match-pause-input" role="status" hidden></p>
        <button id="match-ready" class="primary" disabled>I AM READY</button>
        <details id="match-local-settings"><summary>MY GRAPHICS AND SOUND</summary>
          <label>My flight graphics quality <select id="match-local-quality"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          <label>Mute my flight sound <input id="match-local-muted" type="checkbox"></label>
          <label>My flight volume <input id="match-local-volume" type="range" min="0" max="100"></label>
        </details>
      </div>
      <div id="match-loading" role="status" hidden>Preparing both aircraft, terrain and effects...</div>
      <section id="match-results" class="panel" hidden></section>
      <div id="match-network" role="status" hidden></div>
      <div id="match-message" role="alert" hidden></div>
      <button id="match-exit" class="secondary">LEAVE PRIVATE FLIGHT</button>`;
    app.append(this.root);
    this.setupRecords = new MultiplayerRecordsPanel(this.get('#match-setup-records'), this.records);
    this.results = new MultiplayerResultsPanel(this.get('#match-results'), this.records, ready => {
      try { this.clearInput(); this.match!.setRematchReady(ready); }
      catch (error) { this.fail(error); }
    });
    this.panel = invitation ? new GuestRoomPanel(this.get('#match-room'), invitation) : new HostRoomPanel(this.get('#match-room'));
    this.get<HTMLSelectElement>('#match-role').value = invitation ? 'guest' : 'host';
    this.get('#match-role').onchange = () => { void this.changeRole(); };
    this.get('#match-connect-button').onclick = () => { void this.connect(); };
    this.get('#match-exit').onclick = () => { void this.close(); };
    this.get('#match-pause').onclick = () => this.pause();
    this.get('#match-assistance-toggle').onclick = () => this.toggleAssistance();
    this.get('#match-ready').onclick = () => {
      void this.audio.unlock();
      try { this.clearInput(); this.match!.setReady(!this.match!.pauseState!.selectedReady); }
      catch (error) { this.fail(error); }
    };
    for (const id of ['quality', 'muted', 'volume']) this.get(`#match-local-${id}`).addEventListener(id === 'volume' ? 'input' : 'change', () => {
      try {
        const quality = this.get<HTMLSelectElement>('#match-local-quality').value;
        if (quality !== 'low' && quality !== 'medium' && quality !== 'high') throw new Error('Invalid local graphics setting.');
        const model = this.lobby!.lobby, previous = model.settings;
        model.setLocal({ quality, muted: this.get<HTMLInputElement>('#match-local-muted').checked,
          volume: Number(this.get<HTMLInputElement>('#match-local-volume').value) / 100 });
        this.audio.configure(model.settings); void this.audio.unlock();
        if (quality !== previous.quality) { this.world.configure(quality); this.resized(); }
      } catch (error) { this.fail(error); }
    });
    this.timer = setInterval(() => {
      const match = this.match;
      if (match) void match.update().then(() => {
        if (this.active && this.match === match) {
          this.recordMatch();
          const next = match.takeRematch();
          if (next) this.returnToLobby(match.prepared, next);
        }
      }).catch(error => { if (this.active) this.fail(error); });
    }, 10);
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
      if (mode !== 'auto' && mode !== 'direct' && mode !== 'udp' && mode !== 'tcp' && mode !== 'tls') throw new Error('Invalid connection mode.');
      this.mode = mode;
      const seed = crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff;
      const connection = await LobbyConnection.connect(this.panel.session.admittedMember(), this.settings, mode, seed,
        undefined, prepared => this.acceptPrepared(prepared));
      if (!this.active || this.failed) { connection.close(); return; }
      this.showLobby(connection);
    } catch (error) {
      if (this.active) {
        this.error(error instanceof Error ? error.message : 'Could not connect the private flight.');
        this.viewportWarning = error instanceof LobbyViewportError;
      }
    } finally { this.connecting = false; }
  }
  private showLobby(connection: LobbyConnection): void {
    this.lobby = connection;
    this.lobbyPanel = new LobbyPanel(this.get('#match-lobby'), connection.lobby, () => {
      this.world.configure(connection.lobby.settings.quality);
      this.audio.configure(connection.lobby.settings); void this.audio.unlock();
      this.resized();
    }, () => connection.preparationStatus);
    this.get('#match-lobby h2').focus();
  }
  private acceptPrepared(prepared: PreparedConnection): void {
    if (!this.active || this.failed) { prepared.link.close(); return; }
    this.world.setTerrain(prepared.course.manifest.terrain);
    this.app.dataset.terrain = prepared.course.manifest.terrain;
    this.world.configure(prepared.lobby.settings.quality);
    this.audio.configure(prepared.lobby.settings);
    this.preferredAssistance = prepared.lobby.settings.assist;
    this.world.reset();
    // Author for the narrowest supported viewport, not the host's window on behalf of the guest.
    this.match = new MatchController(prepared, (_slot, view, range) =>
      this.world.captureMissileView(view, range, FORMATION_PROFILE.viewport.minAspect), undefined,
    signal => connectPeer(this.panel.session.admittedMember(), prepared.course.manifest.compatibility,
      FORMATION_PROFILE.viewport.minAspect, this.mode, 0, signal));
    this.records.begin({ matchId: `${prepared.link.sessionId}:${prepared.epoch + 1}`,
      localSlot: prepared.role === 'host' ? 0 : 1, terrain: prepared.course.manifest.terrain,
      compatibility: prepared.course.manifest.compatibility, startedAt: new Date().toISOString() });
    this.availability();
    this.effects = new SharedCombat(this.world.combat, this.match.timeline!);
    this.lobbyPanel?.dispose(); this.lobbyPanel = null;
    this.get('#match-loading').hidden = false;
    this.prewarming = this.prewarm(prepared).catch(error => {
      if (!this.active || this.failed) return;
      const message = error instanceof Error ? error.message : 'The shared scene could not finish loading.';
      this.match?.hold(message);
      this.error(message);
    }).finally(() => { this.get('#match-loading').hidden = true; });
  }
  private returnToLobby(previous: PreparedConnection, next: NonNullable<ReturnType<MatchController['takeRematch']>>): void {
    this.clearInput(); this.match = null;
    this.sound.reset();
    this.effects?.dispose(); this.effects = null;
    this.lobbyPanel?.dispose(); this.lobbyPanel = null; this.lobby?.close();
    this.renderedDisplay = null; this.lastPaint = -Infinity; this.lastPaintPhase = ''; this.lastInputRevision = -1;
    this.results.reset(); this.setupRecords.render();
    this.world.reset(); this.redraw = true;
    this.get('.multiplayer-setup').hidden = false; this.get('#match-connect').hidden = true;
    for (const id of ['match-instruments', 'match-pause-card', 'match-message', 'match-network']) this.get(`#${id}`).hidden = true;
    this.text('#match-exit', 'LEAVE PRIVATE FLIGHT');
    this.root.dataset.phase = 'lobby'; delete this.root.dataset.time;
    const settings = { ...previous.lobby.settings, terrain: previous.course.manifest.terrain,
      assist: this.preferredAssistance ?? previous.lobby.settings.assist };
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff;
    try {
      this.showLobby(new LobbyConnection(next.link, settings, previous.course.manifest.compatibility, seed, previous.role,
        undefined, prepared => this.acceptPrepared(prepared), next.inbox));
    } catch (error) { next.link.close(); throw error; }
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
      this.sound.setActive((match.phase === 'playing' || match.phase === 'ending') && !document.hidden && document.hasFocus());
      if (this.root.dataset.phase !== match.phase) this.clearInput();
      this.root.dataset.phase = match.phase;
      this.get('#match-network').hidden = !match.serviceWarning;
      this.text('#match-network', match.serviceWarning ?? '');
      const pause = match.pauseState, recovery = match.recoveryState;
      this.get('#match-pause-card').hidden = !pause && !recovery || match.phase === 'held';
      this.get('.release-panel').hidden = (!!pause || !!recovery) && match.phase !== 'held';
      this.get('#match-ready').hidden = !!recovery;
      this.text('#match-pause-card h2', recovery ? 'RECONNECTING' : 'SHARED PAUSE');
      if (pause || recovery) {
        const settings = this.lobby!.lobby.settings;
        this.get<HTMLSelectElement>('#match-local-quality').value = settings.quality;
        this.get<HTMLInputElement>('#match-local-muted').checked = settings.muted;
        this.get<HTMLInputElement>('#match-local-volume').value = String(settings.volume * 100);
      }
      if (recovery) {
        this.text('#match-pause-reason', `Up to ${Math.ceil(recovery.remainingMs / 1000)} seconds remaining. Flight is frozen.`);
        this.text('#match-pause-readiness', `Attempt ${recovery.attempt} / ${recovery.stage.toUpperCase()}. Both players must confirm when restored.`);
        this.get('#match-pause-input').hidden = true;
      } else if (pause) {
        this.text('#match-pause-reason', `Player ${pause.by + 1} / ${pause.reason.toUpperCase()} / ${pause.stage.toUpperCase()}`);
        if (!this.viewportValid()) this.text('#match-pause-reason', 'Resize to an aspect ratio between 0.75 and 2 before confirming readiness.');
        this.text('#match-pause-readiness', pause.remainingMs !== null ? `Both ready. Resuming in ${Math.ceil(pause.remainingMs / 1000)}...`
          : `Player 1: ${pause.ready[0] ? 'ready' : 'not ready'} / Player 2: ${pause.ready[1] ? 'ready' : 'not ready'}`);
        this.get<HTMLButtonElement>('#match-ready').disabled = !pause.canReady;
        this.text('#match-ready', pause.selectedReady ? 'CANCEL MY READINESS' : 'I AM READY');
        this.get('#match-pause-input').hidden = !match.inputIssue;
        this.text('#match-pause-input', match.inputIssue ?? '');
      }
      if (next && this.effects && (this.redraw || match.inputRevision !== this.lastInputRevision ||
        next.epoch !== this.renderedDisplay?.epoch || next.frame.time > this.lastPaint || match.phase !== this.lastPaintPhase)) {
        if (this.renderedDisplay && next.epoch !== this.renderedDisplay.epoch) {
          this.effects.reset(); this.world.reset();
        }
        const frame = snapshotSharedFrame({ ...next.frame, effectPositions: this.effects.effectPositions(),
          prediction: match.phase === 'playing' ? matchPrediction(next) : null });
        this.world.updateSharedFrame(frame);
        this.effects.render(this.world.renderOrigin);
        this.world.renderOnce();
        this.lastPaint = frame.time;
        this.lastPaintPhase = match.phase;
        this.renderedDisplay = { ...next, frame };
        this.sound.update(this.renderedDisplay, match.timeline!.effects.map(effect => effect.data));
        this.preferredAssistance = next.players[next.localSlot].assistance;
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
      this.text('#match-view', display ? matchViewStatus(display) : '');
      this.text('#match-participation', display ? matchParticipationStatus(display) : '');
      this.text('#match-phase', match.phase === 'countdown' ? `Starting in ${Math.ceil((pause?.remainingMs ?? match.startup.remainingMs ?? 0) / 1000)}`
        : match.phase === 'over' ? 'MATCH COMPLETE / SEPARATE MULTIPLAYER RECORDS' : match.phase.toUpperCase());
      this.text('#match-release', match.phase === 'over' && display
        ? display.winner === 'draw' ? 'MATCH DRAW' : `PLAYER ${Number(display.winner) + 1} WINS`
        : ['held', 'pausing', 'paused', 'countdown'].includes(match.phase) ? 'MATCH PAUSED' : display ? matchReleaseStatus(display) : 'STAND BY');
      this.text('#match-assistance', display ? display.players[display.localSlot].assistance ? 'YOUR IMPACT ASSIST: ON' : 'YOUR IMPACT ASSIST: OFF' : '');
      this.get<HTMLButtonElement>('#match-assistance-toggle').disabled = !match.assistanceState.canChange;
      this.text('#match-assistance-toggle', match.assistanceState.pending ? 'ASSIST CHANGE PENDING' : 'TOGGLE ASSIST / A');
      this.get('#match-assistance-toggle').hidden = match.phase !== 'playing' || !!display?.players[display.localSlot].eliminated;
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
      if (match.phase === 'over' || match.phase === 'held') {
        this.recordMatch();
        if (!this.showResults() && match.issue) this.error(match.issue + ' Leave this preview and create a new room to continue.');
      } else if (match.issue) this.error(match.issue);
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
      if (this.active && report.error) {
        if (this.get('#match-message').hidden) console.error('Private connection diagnostics:', JSON.stringify({
          connection: report.connection, phase: report.failurePhase, progress: report.progress,
        }));
        this.error(`Connection failed: ${report.error}. Leave and create a new room.`);
      }
    }
  }
  release(): void { if (this.renderedDisplay) this.match?.release(this.renderedDisplay.frame, this.renderedDisplay.epoch); }
  toggleAssistance(): void {
    if (this.match?.assistanceState.canChange) this.match.setAssistance(!this.match.assistanceState.enabled);
  }
  private recordMatch(): void {
    if (!this.match || !this.records.active) return;
    try {
      const totals = this.match.host?.scheduler.session.playerTotals ?? this.match.guest?.replica.playerTotals;
      if (totals) this.records.observe(totals);
      if (this.match.terminalReason) this.records.finish(this.match.terminalReason);
    } catch (error) {
      this.records.finish('error');
      throw error;
    }
  }
  private showResults(): boolean {
    const result = this.records.current;
    if (!result || result.status === 'active') return false;
    this.results.render(result, this.match?.issue ?? null);
    this.results.renderRematch(this.match?.rematchState ?? null);
    this.get('#match-instruments').hidden = true;
    this.get('#match-pause-card').hidden = true;
    this.get('#match-message').hidden = true;
    this.text('#match-exit', 'RETURN TO MENU');
    return true;
  }
  availability(): void {
    const valid = this.viewportValid(), available = valid && !document.hidden && document.hasFocus();
    if (!available) this.clearInput();
    if (!available) this.sound.setActive(false);
    this.match?.setAvailable(available, valid ? 'focus' : 'viewport');
    if (!available && this.lobby?.lobby.selectedReady && !this.match) this.lobby.lobby.setReady(false);
  }
  private viewportValid(): boolean {
    const aspect = this.world.engine.getRenderWidth() / this.world.engine.getRenderHeight();
    return Number.isFinite(aspect) && aspect >= FORMATION_PROFILE.viewport.minAspect && aspect <= FORMATION_PROFILE.viewport.maxAspect;
  }
  resized(): void {
    this.redraw = true;
    const aspect = innerWidth / innerHeight;
    if (this.viewportWarning && Number.isFinite(aspect) &&
      aspect >= FORMATION_PROFILE.viewport.minAspect && aspect <= FORMATION_PROFILE.viewport.maxAspect) {
      this.viewportWarning = false;
      this.get('#match-message').hidden = true;
      this.text('#match-message', '');
    }
    this.match?.pause('viewport');
    this.availability();
  }
  fail(error: unknown): void {
    if (!this.active || this.failed) return;
    this.failed = true;
    this.sound.reset();
    clearInterval(this.timer); cancelAnimationFrame(this.animation); this.prewarmAbort.abort();
    const message = error instanceof Error ? error.message : 'The multiplayer scene could not continue.';
    this.match?.hold(message);
    this.recordMatch();
    this.get<HTMLButtonElement>('#match-connect-button').disabled = true;
    if (!this.showResults()) this.error(message);
    this.get('#match-reticle').hidden = true;
    console.error('Multiplayer application failed:', error);
  }
  pause(): void {
    this.clearInput();
    if (this.match) this.match.pause();
    else if (this.lobby?.lobby.selectedReady) this.lobby.lobby.setReady(false);
  }
  private error(message: string) {
    this.viewportWarning = false;
    this.get('#match-message').hidden = false; this.text('#match-message', message);
  }
  async close(): Promise<void> {
    if (!this.active) return;
    try { this.recordMatch(); }
    catch (error) { this.fail(error); }
    this.records.finish('left');
    this.sound.reset(); this.audio.configure(this.settings);
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
