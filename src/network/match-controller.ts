import { compareStamps, secondsAt, stampAt } from '../../shared/protocol/game.js';
import type { Stamp } from '../../shared/protocol/game.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import { FINALE_DURATION } from '../game/combat-timing.js';
import type { CombatViewProvider } from '../game/multiplayer/host-combat.js';
import type { SharedWorldFrame } from '../rendering/shared-frame.js';
import { GuestGame } from './guest-game.js';
import { HostGame, GAME_STREAM_LIMITS } from './host-game.js';
import type { MatchLink, PreparedConnection } from './lobby-connection.js';
import { RoomClientError } from './room-client.js';
import { ClockError, PeerClock } from './peer-clock.js';
import { ReplicaClock, REPLICA_CLOCK_LIMITS } from './replica-clock.js';
import { SessionClock } from './session-clock.js';
import { StartHandshake } from './start-handshake.js';
import type { StartedSession } from './start-handshake.js';
import type { SendResult, TransportEvent } from './transport.js';
import { FormationWorker } from './formation-worker-client.js';
import { snapshotMatchDisplay } from './match-display.js';
import type { MatchDisplay } from './match-display.js';
import { LocalDrop } from '../rendering/local-drop.js';

export type MatchPhase = 'loading' | 'countdown' | 'playing' | 'ending' | 'over' | 'pausing' | 'paused' | 'recovering' | 'held' | 'closed';
export const MATCH_RECOVERY_MS = 15_000;
const RECOVERABLE = new Set(['connection', 'channel', 'timeout', 'candidate', 'negotiation', 'signaling',
  'signaling_closed', 'connection_closed', 'peer_disconnected', 'generation', 'peer_unavailable', 'already_connected']);
interface Recovery {
  deadline: number; stage: 'connecting' | 'barrier' | 'cache' | 'checkpoint'; attempt: number;
  retryAt: number; attemptUntil: number; pending: boolean; prepared: boolean; restored: boolean; at: Stamp;
  abort: AbortController | null; timer: ReturnType<typeof setTimeout>;
  drop: LocalDrop | null;
}
type PauseNotice = Extract<MessageBody, { type: 'pause-state' }>;
export type PauseReason = PauseNotice['reason'];
type StartupMessage = Extract<WireMessage, { type: 'loading-ready' | 'start-offer' | 'start-ready' | 'start-commit' | 'start-cancel' | 'barrier' }>;
function startupMessage(value: WireMessage): value is StartupMessage {
  return ['loading-ready', 'start-offer', 'start-ready', 'start-commit', 'start-cancel', 'barrier'].includes(value.type);
}

/** Exclusive owner after lobby handoff. The application supplies asset readiness and real camera views. */
export class MatchController {
  readonly startup: StartHandshake;
  readonly peerClock = new PeerClock();
  private replicaClock = new ReplicaClock(this.peerClock);
  private readonly clock: SessionClock;
  private hostValue: HostGame | null = null;
  private guestValue: GuestGame | null = null;
  private phaseValue: MatchPhase = 'loading';
  private issueValue: string | null = null;
  private loaded = false;
  private started = false;
  private active = true;
  private busy = false;
  private lastProbe = -Infinity;
  private lastFrameWall: number;
  private initialDeadline = Infinity;
  private frameValue: SharedWorldFrame | null = null;
  private displayValue: MatchDisplay | null = null;
  private captured: MatchDisplay | null = null;
  private localDrop: { flight: LocalDrop; input: number | null } | null = null;
  private inputIssueValue: string | null = null;
  private inputRevisionValue = 0;
  private anchorWall = -Infinity;
  private pendingRelease: { time: number; sequence: number; receivedAt: number } | null = null;
  private pauseNotice: PauseNotice | null = null;
  private pauseRequested = false;
  private pauseDirty = false;
  private settleAt = Infinity;
  private pauseSealed = false;
  private pauseRestored = false;
  private pauseTimeout = Infinity;
  private selectedReady = false;
  private available = true;
  private preflightPause: PauseReason | null = null;
  private resumeHandshake: StartHandshake | null = null;
  private peerPauseInput = 0;
  private recovery: Recovery | null = null;
  private lastPeerAt: number;
  private startedAt = 0;
  private inbox: TransportEvent[];
  constructor(readonly prepared: PreparedConnection, view: CombatViewProvider,
    private readonly now: () => number = () => performance.now(),
    private readonly reconnect?: (signal: AbortSignal) => Promise<MatchLink>) {
    this.inbox = [...prepared.inbox]; prepared.inbox.length = 0;
    this.clock = new SessionClock(now, 0, prepared.epoch);
    this.lastFrameWall = this.lastPeerAt = now();
    this.startup = this.handshake(prepared.epoch, stampAt(0));
    if (prepared.role === 'host') {
      const author = new FormationWorker();
      try {
        this.hostValue = new HostGame(prepared.authored, prepared.link.sessionId, prepared.epoch + 1, now, this.send, view,
          prepared.lobby.state!.assistance, prepared.course.manifest, author, time => this.startedAt + time * 1000);
      } catch (error) { author.close(); throw error; }
    } else this.guestValue = new GuestGame(prepared, prepared.link.sessionId, prepared.epoch + 1, now, this.send);
  }
  private handshake(epoch: number, at: Stamp): StartHandshake {
    return new StartHandshake(this.prepared.role, this.prepared.link.sessionId, epoch, at, this.now, () => {
      try {
        const estimate = this.peerClock.estimate(this.now());
        return { lower: estimate.remoteLower, upper: estimate.remoteUpper };
      } catch (error) {
        if (!(error instanceof ClockError)) throw error;
        return null;
      }
    });
  }
  get phase(): MatchPhase { return this.phaseValue; }
  private get stopped(): boolean { return !this.active || this.phaseValue === 'held'; }
  get issue(): string | null { return this.issueValue; }
  get serviceWarning(): string | null {
    return this.prepared.link.signalingState === 'recovering'
      ? 'Signaling reconnecting (up to 15s). The peer flight remains connected.' : null;
  }
  get frame(): SharedWorldFrame | null { return this.frameValue; }
  get display(): MatchDisplay | null { return this.displayValue; }
  get inputIssue(): string | null { return this.inputIssueValue; }
  get inputRevision(): number { return this.inputRevisionValue; }
  get recoveryState() {
    return this.recovery ? { remainingMs: Math.max(0, this.recovery.deadline - this.now()),
      attempt: this.recovery.attempt, stage: this.recovery.stage } : null;
  }
  get host(): HostGame | null { return this.hostValue; }
  get guest(): GuestGame | null { return this.guestValue; }
  get timeline() { return this.hostValue?.timeline ?? this.guestValue?.combat ?? null; }
  get pauseState() {
    const notice: PauseNotice | null = this.pauseNotice ?? (!this.started && this.preflightPause ? {
      type: 'pause-state', barrier: this.prepared.epoch + 1, update: 0, at: stampAt(0),
      by: this.prepared.role === 'host' ? 0 : 1, reason: this.preflightPause,
      stage: this.loaded ? 'ready' : 'restoring', ready: [...this.prepared.lobby.state!.ready],
    } : null);
    return notice ? { ...structuredClone(notice),
      selectedReady: this.started ? this.selectedReady : this.prepared.lobby.selectedReady,
      canReady: !this.recovery && this.available && this.loaded && (!this.started || this.pauseRestored) && notice.stage === 'ready' && !this.stopped,
      remainingMs: (this.started ? this.resumeHandshake : this.startup)?.remainingMs ?? null } : null;
  }
  setAvailable(available: boolean, reason: PauseReason = 'focus'): void {
    this.available = available;
    if (!available) this.pause(reason);
  }
  setReady(ready: boolean): void {
    if (this.stopped || ready && !this.pauseState?.canReady) throw new Error('The shared flight is not ready to resume.');
    if (!this.started) { this.prepared.lobby.setReady(ready); return; }
    if (!this.resumeHandshake || !this.pauseNotice) throw new Error('No paused readiness barrier.');
    this.selectedReady = ready;
    this.resumeHandshake.setReady(ready, this.pauseNotice.barrier);
    this.updatePauseReadiness();
  }
  assetsLoaded(): void { this.loaded = true; }
  private send = (body: MessageBody): SendResult => {
    if (!this.active) return { ok: false, reason: 'not_open' };
    if (this.recovery && this.recovery.stage !== 'checkpoint' &&
      !['barrier', 'recovery-cache', 'ping', 'pong', 'match-abort'].includes(body.type)) return { ok: false, reason: 'not_open' };
    return this.prepared.link.send(body);
  };
  async update(): Promise<void> {
    if (!this.active || this.busy || this.phaseValue === 'held') return;
    this.busy = true;
    try {
      if (this.recovery) { await this.updateRecovery(); return; }
      this.inbox.push(...this.prepared.link.drain());
      for (let remaining = this.inbox.length; remaining > 0; remaining--) {
        const event = this.inbox.shift()!;
        if (event.type === 'message') await this.receive(event.message, event.receivedAt);
        else if (event.type === 'failed' && RECOVERABLE.has(event.code) && this.reconnect) { this.beginRecovery(); return; }
        else if (event.type === 'rejected' || event.type === 'failed') throw new Error(`Match transport failed: ${event.code}.`);
        if (this.stopped) return;
      }
      if (this.stopped) return;
      if (this.prepared.link.status !== 'open') {
        if (this.reconnect && RECOVERABLE.has(this.prepared.link.failure ?? 'connection_closed')) { this.beginRecovery(); return; }
        throw new Error(`The peer connection is unavailable: ${this.prepared.link.failure ?? 'closed'}.`);
      }
      const now = this.now();
      if (this.started && (this.phaseValue === 'playing' || this.phaseValue === 'ending') &&
        now - this.lastPeerAt > REPLICA_CLOCK_LIMITS.freshnessMs && this.reconnect) {
        this.beginRecovery(); return;
      }
      this.probe();
      if (!this.started) {
        const lobby = this.prepared.lobby, state = lobby.state;
        if (!state || state.terrain !== this.prepared.course.manifest.terrain) throw new Error('The prepared course changed. Return to the lobby.');
        if (!lobby.flush(this.send)) return;
        if (!lobby.bothReady) this.preflightPause ??= 'manual';
        this.startup.setReady(this.available && this.loaded && lobby.bothReady, state.update);
        this.startup.pump(this.send);
        const started = this.startup.takeStart();
        if (started) this.start(started);
        else this.phaseValue = this.startup.phase === 'countdown' ? 'countdown' : 'loading';
      }
      if (!this.started) return;
      if (this.pauseRequested) { await this.updatePause(); return; }
      if (this.hostValue) await this.updateHost();
      else if (this.guestValue) this.updateGuest();
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof ClockError && this.started && !this.pauseRequested) {
        console.warn('Private match paused:', error.message);
        this.pause('clock'); return;
      }
      this.hold(error instanceof Error ? error.message : 'The private match could not continue.');
      console.error('Private match held:', this.issueValue);
    } finally { this.busy = false; }
  }
  private async receive(message: WireMessage, receivedAt: number): Promise<void> {
    if (!Number.isFinite(receivedAt) || receivedAt > this.now()) throw new Error('Invalid peer receipt time.');
    this.lastPeerAt = Math.max(this.lastPeerAt, receivedAt);
    if (message.type === 'match-abort') {
      this.hold(message.reason === 'left' ? 'The other player left the private flight.' : 'The other player could not continue the private flight.', false);
      return;
    }
    if (message.type === 'ping') {
      // Probes are unordered and disposable; never put a stale response in the reliable queue.
      this.send({ type: 'pong', id: message.id, sentAt: message.sentAt, receivedAt: this.now() }); return;
    }
    await this.receiveGameplay(message, receivedAt);
  }
  private probe() {
    const now = this.now();
    const interval = this.phaseValue === 'playing' || this.phaseValue === 'ending' ? 100 : 500;
    if (now - this.lastProbe < interval) return;
    const probe = this.peerClock.probe(now);
    if (!this.send(probe).ok) this.peerClock.cancelProbe(probe.id);
    this.lastProbe = now;
  }
  private beginRecovery(): void {
    if (this.recovery || this.stopped) return;
    if (!this.reconnect) { this.hold('The peer connection could not be recovered.'); return; }
    this.startup.close(); this.resumeHandshake?.close(); this.resumeHandshake = null;
    this.selectedReady = false; this.pauseRequested = true; this.pauseRestored = false;
    const host = this.hostValue, session = host?.scheduler.session;
    if (host && session) {
      if (host.journal.authority.pauseState === 'running') this.settleAt = host.journal.authority.beginPause();
      this.clock.freezeAt(session.time, host.epoch);
    }
    this.started = true; this.phaseValue = 'recovering';
    const at = host && session ? stampAt(session.status === 'over'
      ? Math.max(session.time, this.frameValue?.time ?? session.time) : session.time) : stampAt(this.frameValue?.time ?? 0);
    const deadline = this.now() + MATCH_RECOVERY_MS;
    const timer = setTimeout(() => {
      if (this.recovery && this.now() >= this.recovery.deadline) this.hold('Connection recovery exceeded 15 seconds.');
    }, MATCH_RECOVERY_MS);
    this.recovery = {
      deadline, stage: 'connecting', attempt: 0,
      retryAt: this.now(), attemptUntil: Infinity, pending: false, prepared: false, restored: false, at, abort: null, timer,
      drop: this.localDrop?.flight ?? null
    };
    this.prepared.link.close(); this.inbox.length = 0;
  }
  private retryRecovery(state: Recovery): void {
    this.prepared.link.close(); state.abort?.abort(); state.abort = null;
    state.pending = false; state.prepared = false; state.restored = false; state.stage = 'connecting';
    state.retryAt = this.now() + Math.min(2000, 500 * 2 ** Math.min(2, state.attempt - 1));
  }
  private attemptRecovery(state: Recovery): void {
    state.attempt++; state.pending = true;
    const attempt = state.attempt, abort = state.abort = new AbortController();
    void this.reconnect!(abort.signal).then(link => {
      if (this.recovery !== state || state.attempt !== attempt || abort.signal.aborted || this.now() >= state.deadline) {
        link.close(); return;
      }
      if (link.sessionId !== this.prepared.link.sessionId || link.epoch !== 0) {
        link.close(); this.hold('The replacement connection did not preserve the private session.'); return;
      }
      this.prepared.link = link; this.inbox.length = 0; state.pending = false;
      state.stage = 'barrier'; state.attemptUntil = this.now() + 5000;
      this.peerClock.reset(); this.resetReplicaClock(); this.lastProbe = -Infinity; this.lastPeerAt = this.now();
    }, error => {
      if (this.recovery !== state || state.attempt !== attempt || abort.signal.aborted) return;
      if (error instanceof RoomClientError && ['network', 'timeout', 'service_error'].includes(error.code)) this.retryRecovery(state);
      else this.hold(error instanceof Error ? error.message : 'Replacement connection setup failed.');
    });
  }
  private async updateRecovery(): Promise<void> {
    const state = this.recovery!;
    if (this.now() >= state.deadline) { this.hold('Connection recovery exceeded 15 seconds.'); return; }
    const host = this.hostValue;
    if (host?.journal.authority.pauseState === 'settling') {
      this.settleLocalRelease();
      await host.pump();
      if (this.stopped || this.recovery !== state) return;
      if (this.now() > this.settleAt) host.journal.authority.sealPause();
    }
    if (state.stage === 'connecting') {
      if (!state.pending && this.now() >= state.retryAt) this.attemptRecovery(state);
      return;
    }
    this.inbox.push(...this.prepared.link.drain());
    for (let remaining = this.inbox.length; remaining > 0; remaining--) {
      const event = this.inbox.shift()!;
      if (event.type === 'failed' || event.type === 'rejected') {
        if (event.type === 'failed' && RECOVERABLE.has(event.code)) { this.retryRecovery(state); return; }
        throw new Error(`Replacement connection failed: ${event.code}.`);
      }
      if (event.type === 'message') await this.receiveRecovery(event.message, event.receivedAt, state);
      if (this.stopped || this.recovery !== state) return;
    }
    if (this.prepared.link.status === 'closed') {
      if (RECOVERABLE.has(this.prepared.link.failure ?? 'connection_closed')) this.retryRecovery(state);
      else this.hold(`Replacement connection failed: ${this.prepared.link.failure ?? 'closed'}.`);
      return;
    }
    if (state.stage !== 'checkpoint' && this.now() >= state.attemptUntil) { this.retryRecovery(state); return; }
    if (this.prepared.link.status !== 'open') return;
    if (host && state.stage === 'barrier') {
      if (host.journal.authority.pauseState !== 'paused') return;
      if (!state.prepared) {
        host.beginRecoveryEpoch(host.epoch + 1); this.clock.freezeAt(host.scheduler.session.time, host.epoch);
        state.prepared = true;
        this.prepareRecoveredPause(host.epoch, state.at);
      }
      if (this.send({ type: 'barrier', reason: 'recovery', nextEpoch: host.epoch, at: state.at }).ok) state.stage = 'cache';
      return;
    }
    if (this.guestValue && state.stage === 'cache') {
      if (this.send({ type: 'recovery-cache', references: this.guestValue.replica.plans.inventory() }).ok) state.stage = 'checkpoint';
      return;
    }
    if (state.stage !== 'checkpoint') return;
    this.probe();
    await this.updatePause();
    if (this.stopped || this.recovery !== state) return;
    if (this.now() >= state.deadline) { this.hold('Connection recovery exceeded 15 seconds.'); return; }
    if (this.pauseRestored && this.pauseNotice?.stage === 'ready') {
      if (state.drop && this.displayValue) {
        const { slot, releasedAt } = state.drop, player = this.displayValue.players[slot], aircraft = this.displayValue.frame.aircraft[slot];
        const bombMatches = aircraft.bomb && Math.abs(this.displayValue.frame.time - aircraft.bomb.age - releasedAt) < 1e-6;
        if (!aircraft.released && !bombMatches && !(player.result && player.result.time >= releasedAt)) {
          this.rejectDrop('unconfirmed_after_connection_loss');
        }
      }
      clearTimeout(state.timer); this.recovery = null; state.abort = null;
      this.phaseValue = 'paused'; this.lastPeerAt = this.now();
    } else this.phaseValue = 'recovering';
  }
  private prepareRecoveredPause(epoch: number, at: Stamp) {
    this.localDrop = null; this.pauseRestored = false; this.pauseTimeout = Infinity;
    this.pauseNotice = {
      type: 'pause-state', barrier: epoch, update: 0, at: structuredClone(at),
      by: 0, reason: 'recovery', stage: 'restoring', ready: [false, false]
    };
    this.pauseDirty = !!this.hostValue;
    this.resumeHandshake?.close(); this.resumeHandshake = this.handshake(epoch, at);
  }
  private async receiveRecovery(message: WireMessage, receivedAt: number, state: Recovery) {
    if (message.type === 'hello') return;
    if (message.type === 'barrier' && message.reason === 'recovery' && this.guestValue && state.stage === 'barrier') {
      this.guestValue.recoverEpoch(message.nextEpoch);
      this.prepareRecoveredPause(message.nextEpoch, message.at); state.stage = 'cache';
      return;
    }
    if (message.type === 'recovery-cache' && this.hostValue && state.stage === 'cache') {
      this.hostValue.acceptRecoveryCache(message.references); state.stage = 'checkpoint';
      return;
    }
    if (message.type === 'recovery-restored' && this.hostValue && state.stage === 'checkpoint') {
      if (!this.hostValue.ready || message.epoch !== this.hostValue.epoch) throw new Error('Premature recovery acknowledgement.');
      state.restored = true; return;
    }
    if (state.stage === 'checkpoint' || message.type === 'match-abort' ||
      (message.type === 'ping' || message.type === 'pong') && message.epoch === (this.hostValue?.epoch ?? this.guestValue!.epoch)) {
      await this.receive(message, receivedAt); return;
    }
    throw new Error('Unexpected recovery handshake message.');
  }
  private async receiveGameplay(message: WireMessage, receivedAt: number): Promise<void> {
    if (message.type === 'pong') { this.peerClock.receive(message, this.now()); return; }
    if (!this.started) {
      if (message.type === 'lobby-state') this.prepared.lobby.receiveState(message.state);
      else if (message.type === 'lobby-input') this.prepared.lobby.receiveInput(message.input);
      else if (startupMessage(message)) {
        this.startup.receive(message);
        const started = this.startup.takeStart();
        if (started) this.start(started);
      } else if (message.type !== 'hello') throw new Error('Unexpected match loading message.');
      return;
    }
    const epoch = this.hostValue?.epoch ?? this.guestValue!.epoch;
    if (message.epoch < epoch) return;
    if (message.type === 'pause-state' && this.guestValue) {
      this.receivePause(message); return;
    }
    if (message.type === 'barrier' && message.reason === 'pause' && this.guestValue) {
      const notice = this.pauseNotice;
      if (!notice || notice.stage !== 'settling' || message.nextEpoch !== notice.barrier ||
        compareStamps(message.at, notice.at) !== 0) throw new Error('Unannounced shared pause boundary.');
      this.guestValue.advanceEpoch(message.nextEpoch);
      this.resetReplicaClock();
      this.localDrop = null;
      this.pauseRestored = false;
      this.pauseNotice = { ...notice, stage: 'restoring' };
      this.resumeHandshake = this.handshake(message.nextEpoch, notice.at);
      this.pauseTimeout = this.now() + 15_000;
      return;
    }
    if (this.resumeHandshake && startupMessage(message)) {
      this.resumeHandshake.receive(message);
      this.updatePauseReadiness();
      const start = this.resumeHandshake.takeStart();
      if (start) this.resume(start);
      return;
    }
    if (this.hostValue) {
      if (message.type === 'resync') { this.pause('clock', 1); return; }
      if (message.type !== 'command' && message.type !== 'transfer-ready') throw new Error('Unexpected host gameplay message.');
      if (message.type === 'command' && message.command.action === 'pause') {
        if (message.inputSequence <= this.peerPauseInput) return;
        this.peerPauseInput = message.inputSequence;
        this.pause(message.command.reason ?? 'manual', 1); return;
      }
      this.hostValue.receive(message, receivedAt);
    } else {
      await this.guestValue!.receive(message);
      if (message.type === 'ack' && message.slot === 1 && message.inputSequence === this.localDrop?.input &&
        !message.decision.accepted) this.rejectDrop(message.decision.reason);
      const anchor = this.guestValue!.replica.clockAnchor;
      if (!this.pauseRequested && anchor && anchor.monotonicMs > this.anchorWall) {
        this.replicaClock.observe(anchor, this.now()); this.anchorWall = anchor.monotonicMs;
      }
    }
  }
  private start(started: StartedSession) {
    const prepared = this.prepared;
    this.startedAt = started.hostStartsAt;
    if (prepared.role === 'host') {
      for (const slot of [0, 1] as const) this.hostValue!.scheduler.session.setAssistance(slot, prepared.lobby.state!.assistance[slot]);
      this.clock.start(started.epoch, started.hostStartsAt);
    }
    this.started = true;
    this.initialDeadline = this.now() + 5000;
    this.lastFrameWall = this.now(); this.phaseValue = 'loading';
    if (started.requiresPause || !this.available) this.pause('clock');
  }
  pause(reason: PauseReason = 'manual', by: 0 | 1 = this.hostValue ? 0 : 1): void {
    if (this.stopped || this.phaseValue === 'over') return;
    if (!this.started) {
      this.preflightPause = reason;
      this.prepared.lobby.setReady(false);
      this.startup.setReady(false, this.prepared.lobby.state!.update);
      return;
    }
    if (this.pauseRequested) {
      if (this.resumeHandshake) {
        if (this.hostValue && by === 1) this.resumeHandshake.peerUnavailable();
        else { this.selectedReady = false; this.resumeHandshake.setReady(false, this.pauseNotice!.barrier); }
        this.updatePauseReadiness();
      }
      return;
    }
    this.pauseRequested = true; this.phaseValue = 'pausing'; this.selectedReady = false;
    this.pauseRestored = false; this.pauseSealed = false; this.pauseTimeout = this.now() + 15_000;
    if (this.hostValue) {
      const host = this.hostValue, session = host.scheduler.session;
      this.settleAt = host.journal.authority.beginPause();
      this.clock.freezeAt(session.time, host.epoch);
      this.pauseNotice = { type: 'pause-state', barrier: host.epoch + 1, update: 0,
        at: stampAt(session.status === 'over' ? Math.max(session.time, this.frameValue?.time ?? session.time) : session.time),
        by, reason, stage: 'settling', ready: [false, false] };
      this.pauseDirty = true;
    } else this.guestValue!.requestPause(reason);
  }
  private receivePause(message: Extract<WireMessage, { type: 'pause-state' }>) {
    const previous = this.pauseNotice;
    if (previous && (message.barrier !== previous.barrier || compareStamps(message.at, previous.at) !== 0 ||
      message.update < previous.update)) throw new Error('Shared pause state regressed.');
    if (!previous && message.stage !== 'settling') throw new Error('Missing pause settlement notice.');
    if (!previous) { this.selectedReady = false; this.pauseTimeout = this.now() + 15_000; }
    this.pauseRequested = true; this.phaseValue = message.stage === 'ready' && this.pauseRestored ? 'paused' : 'pausing';
    this.pauseNotice = { type: 'pause-state', barrier: message.barrier, update: message.update, at: message.at,
      by: message.by, reason: message.reason, stage: message.stage, ready: [...message.ready] };
  }
  private updatePauseReadiness() {
    if (!this.hostValue || !this.pauseNotice || !this.resumeHandshake || !this.pauseRestored) return;
    const { local, peer } = this.resumeHandshake.readiness, previous = this.pauseNotice;
    if (previous.stage === 'ready' && previous.ready[0] === local && previous.ready[1] === peer) return;
    this.pauseNotice = { ...previous, stage: 'ready', update: previous.update + 1, ready: [local, peer] };
    this.pauseDirty = true;
  }
  private flushPause(): boolean {
    if (!this.pauseDirty) return true;
    if (!this.send(this.pauseNotice!).ok) return false;
    this.pauseDirty = false; return true;
  }
  private async updatePause() {
    if (this.now() > this.pauseTimeout) throw new Error('The shared pause checkpoint could not be synchronized.');
    if (this.hostValue) {
      if (!this.flushPause()) return;
      const host = this.hostValue;
      this.settleLocalRelease();
      await host.pump();
      if (this.stopped) return;
      if (this.pauseNotice!.stage === 'settling') {
        // Drain receipts collected during hashing before closing their old-epoch settlement window.
        this.inbox.push(...this.prepared.link.drain());
        if (this.inbox.length || this.now() <= this.settleAt || !host.ready || !host.journal.canSnapshot) return;
        if (!this.pauseSealed) { host.journal.authority.sealPause(); this.pauseSealed = true; }
        const notice = this.pauseNotice!;
        if (!this.send({ type: 'barrier', nextEpoch: notice.barrier, reason: 'pause', at: notice.at }).ok) return;
        host.advanceEpoch(notice.barrier, false);
        this.clock.freezeAt(host.scheduler.session.time, notice.barrier);
        this.pauseNotice = { ...notice, update: notice.update + 1, stage: 'restoring' };
        this.pauseDirty = true; this.localDrop = null;
        this.resumeHandshake = this.handshake(notice.barrier, notice.at);
        return;
      }
      if (!host.ready || this.recovery && !this.recovery.restored) return;
      if (!this.pauseRestored) {
        this.captureHost(secondsAt(this.pauseNotice!.at)); this.pauseRestored = true;
        this.pauseTimeout = Infinity; this.phaseValue = 'paused';
        this.updatePauseReadiness();
      }
      if (!this.flushPause()) return;
    } else {
      if (!this.guestValue!.pump().ok) return;
      if (!this.resumeHandshake || !this.guestValue!.replica.presentationState) return;
      if (!this.pauseRestored) {
        this.captureGuest(secondsAt(this.pauseNotice!.at)); this.pauseRestored = true;
        this.pauseTimeout = Infinity;
      }
      if (this.recovery && !this.recovery.restored) {
        if (!this.send({ type: 'recovery-restored' }).ok) return;
        this.recovery.restored = true;
      }
      if (this.pauseNotice!.stage !== 'ready') return;
      this.phaseValue = 'paused';
    }
    this.phaseValue = 'paused';
    this.resumeHandshake!.pump(this.send);
    const started = this.resumeHandshake!.takeStart();
    if (started) this.resume(started);
    else if (this.resumeHandshake!.phase === 'countdown') this.phaseValue = 'countdown';
  }
  private resetReplicaClock() {
    this.replicaClock = new ReplicaClock(this.peerClock); this.anchorWall = -Infinity;
  }
  private resume(started: StartedSession) {
    const time = this.hostValue?.scheduler.session.time ?? secondsAt(this.guestValue!.replica.state!.at);
    this.startedAt = started.hostStartsAt - time * 1000;
    if (this.hostValue) {
      this.hostValue.advanceEpoch(started.epoch, true);
      this.clock.start(started.epoch, started.hostStartsAt);
    } else { this.guestValue!.advanceEpoch(started.epoch); this.resetReplicaClock(); }
    this.resumeHandshake!.close(); this.resumeHandshake = null;
    this.pauseNotice = null; this.pauseRequested = false; this.pauseDirty = false;
    this.localDrop = null; this.selectedReady = false;
    this.lastFrameWall = this.now(); this.initialDeadline = this.now() + 5000; this.phaseValue = 'loading';
    if (started.requiresPause || !this.available) this.pause('clock');
  }
  private settleLocalRelease() {
    if (!this.pendingRelease || !this.hostValue!.ready) return;
    const input = this.pendingRelease; this.pendingRelease = null;
    const decision = this.hostValue!.release(input.time, input.sequence, input.receivedAt);
    if (!decision.accepted) this.rejectDrop(decision.reason);
  }
  private async updateHost() {
    const host = this.hostValue!;
    if (!host.ready) {
      await host.pump();
      if (this.now() >= this.initialDeadline) throw new Error('The initial game checkpoint was not acknowledged.');
      return;
    }
    const session = host.scheduler.session;
    if (session.status !== 'over') {
      const target = secondsAt(this.clock.sample().at);
      if (target - session.time > REPLICA_CLOCK_LIMITS.futureSeconds) {
        this.pause('clock'); return;
      }
      const work = Math.max(1, Math.ceil((target - session.time) / GAME_STREAM_LIMITS.advanceSeconds));
      for (let index = 0; index < work; index++) {
        if (host.scheduler.session.status === 'over') break;
        const held = await host.pump(Math.max(session.time, Math.min(target, session.time + GAME_STREAM_LIMITS.advanceSeconds)));
        if (this.stopped || this.pauseRequested) return;
        if (held) { this.pause('publication'); return; }
      }
    } else await host.pump();
    if (this.stopped || this.pauseRequested) return;
    if (this.pendingRelease) {
      const input = this.pendingRelease; this.pendingRelease = null;
      const decision = host.release(input.time, input.sequence, input.receivedAt);
      if (!decision.accepted) this.rejectDrop(decision.reason);
      await host.pump();
      if (this.stopped || this.pauseRequested) return;
    }
    const now = this.now(), elapsed = Math.max(0, (now - this.lastFrameWall) / 1000);
    const time = session.status === 'over'
      ? Math.min(session.time + FINALE_DURATION, Math.max(session.time, this.frameValue?.time ?? session.time) + elapsed) : session.time;
    this.captureHost(time);
    this.phaseValue = session.status === 'over' ? time >= session.time + FINALE_DURATION ? 'over' : 'ending' : 'playing';
    this.lastFrameWall = now;
  }
  private captureHost(time: number) {
    const host = this.hostValue!, session = host.scheduler.session, frame = host.frame(time);
    const state = session.snapshot();
    const player = (slot: 0 | 1) => {
      const value = state.players[slot]!;
      const result = state.encounters.flatMap(encounter => {
        const result = encounter.attempts[slot]!.result;
        return result ? [result] : [];
      }).sort((a, b) => b.time - a.time)[0];
      return { score: value.score, misses: value.misses, assistance: value.assistance, assisted: value.assisted,
        eliminated: value.completion !== null, result: result ? { points: result.points, time: result.time } : null };
    };
    this.present(snapshotMatchDisplay(frame, 0, [player(0), player(1)], state.winner, host.epoch));
  }
  private updateGuest() {
    const guest = this.guestValue!;
    if (!guest.pump().ok) throw new Error('The guest control channel is unavailable.');
    const state = guest.replica.presentationState;
    if (!state || !guest.replica.clockAnchor) {
      if (this.now() >= this.initialDeadline) throw new Error('Waiting for the initial host game state.');
      return;
    }
    const now = this.now(), end = secondsAt(state.at);
    const flights = state.plans.map(ref => guest.replica.plans.formation(ref));
    const time = state.status === 'over'
      ? Math.min(end + FINALE_DURATION, Math.max(end, this.frameValue?.time ?? end) + Math.max(0, (now - this.lastFrameWall) / 1000))
      : this.replicaClock.frame(now, { startAt: flights[0]!.startAt, endAt: flights.at(-1)!.handoffAt });
    this.captureGuest(time);
    this.phaseValue = state.status === 'over' ? time >= end + FINALE_DURATION ? 'over' : 'ending' : 'playing';
    this.lastFrameWall = now;
  }
  private captureGuest(time: number) {
    const guest = this.guestValue!, frame = guest.frame(time, this.prepared.course.manifest.seed);
    const displayed = guest.replica.presentationAt(time);
    const player = (slot: 0 | 1) => {
      const result = displayed.results.filter(result => result.slot === slot).sort((a, b) => b.time - a.time)[0];
      return { ...displayed.players[slot], result: result ? { points: result.points, time: result.time } : null };
    };
    this.present(snapshotMatchDisplay(frame, 1, [player(0), player(1)], displayed.winner, guest.epoch));
  }
  release(displayed = this.frameValue, epoch = this.displayValue?.epoch): boolean {
    if (this.phaseValue !== 'playing' || !this.available || epoch !== (this.hostValue?.epoch ?? this.guestValue!.epoch) ||
      !displayed?.ready || this.localDrop) return false;
    if (this.hostValue) {
      if (this.pendingRelease || this.hostValue.player(0).completion) return false;
      const sequence = [...this.hostValue.scheduler.retainedSequences].reverse().find(sequence => {
        const plan = this.hostValue!.scheduler.plan(sequence);
        return plan.startAt <= displayed.time && displayed.time <= plan.handoffAt;
      });
      if (sequence === undefined) return false;
      if (this.busy) {
        this.pendingRelease = { time: displayed.time, sequence, receivedAt: this.now() };
      } else {
        const decision = this.hostValue.release(displayed.time, sequence);
        if (!decision.accepted) { this.rejectDrop(decision.reason); return false; }
      }
      this.startDrop(displayed, null);
      return true;
    }
    if (!this.guestValue!.release(displayed)) return false;
    this.startDrop(displayed, this.guestValue!.lastInputSequence);
    return true;
  }
  private startDrop(frame: SharedWorldFrame, input: number | null) {
    if (!this.captured) throw new Error('Local release has no captured presentation.');
    this.inputIssueValue = null;
    this.inputRevisionValue++;
    this.localDrop = { flight: new LocalDrop(frame, this.captured.localSlot), input };
    this.present(this.captured);
  }
  private rejectDrop(reason: string) {
    this.inputIssueValue = `Release not accepted: ${reason.replaceAll('_', ' ')}.`;
    this.inputRevisionValue++;
    this.localDrop = null;
    if (this.captured) this.present(this.captured);
  }
  private present(source: MatchDisplay) {
    this.captured = source;
    if (this.localDrop) {
      const { slot, releasedAt } = this.localDrop.flight, player = source.players[slot];
      if (source.frame.aircraft[slot].released || player.eliminated ||
        player.result && player.result.time >= releasedAt) this.localDrop = null;
    }
    this.frameValue = this.localDrop ? this.localDrop.flight.frame(source.frame) : source.frame;
    this.displayValue = this.frameValue === source.frame ? source : Object.freeze({ ...source, frame: this.frameValue });
  }
  hold(reason: string, notify = true): void {
    if (!this.active || this.phaseValue === 'held') return;
    this.issueValue = reason; this.phaseValue = 'held';
    if (this.recovery) {
      clearTimeout(this.recovery.timer); this.recovery.abort?.abort(); this.recovery = null;
    }
    this.hostValue?.scheduler.session.pause();
    this.pendingRelease = null;
    this.localDrop = null;
    if (this.captured) this.present(this.captured);
    if (notify && this.started) this.send({ type: 'match-abort', reason: 'error' });
    this.prepared.link.close();
  }
  close(): void {
    if (!this.active) return;
    this.active = false; this.phaseValue = 'closed';
    if (this.recovery) {
      clearTimeout(this.recovery.timer); this.recovery.abort?.abort(); this.recovery = null;
    }
    this.pendingRelease = null;
    this.localDrop = null; this.captured = null; this.displayValue = null; this.frameValue = null;
    this.startup.close(); this.resumeHandshake?.close();
    this.hostValue?.close(); this.guestValue?.close(); this.prepared.link.close(); this.inbox.length = 0;
  }
}
