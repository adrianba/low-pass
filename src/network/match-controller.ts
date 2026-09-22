import { secondsAt, stampAt } from '../../shared/protocol/game.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import { FINALE_DURATION } from '../game/combat-timing.js';
import type { CombatViewProvider } from '../game/multiplayer/host-combat.js';
import type { SharedWorldFrame } from '../rendering/shared-frame.js';
import { GuestGame } from './guest-game.js';
import { HostGame, GAME_STREAM_LIMITS } from './host-game.js';
import type { PreparedConnection } from './lobby-connection.js';
import { ClockError, PeerClock } from './peer-clock.js';
import { ReplicaClock } from './replica-clock.js';
import { SessionClock } from './session-clock.js';
import { StartHandshake } from './start-handshake.js';
import type { StartedSession } from './start-handshake.js';
import type { SendResult, TransportEvent } from './transport.js';
import { FormationWorker } from './formation-worker-client.js';

export type MatchPhase = 'loading' | 'countdown' | 'playing' | 'ending' | 'over' | 'held' | 'closed';

/** Exclusive owner after lobby handoff. The application supplies asset readiness and real camera views. */
export class MatchController {
  readonly startup: StartHandshake;
  readonly peerClock = new PeerClock();
  private readonly replicaClock = new ReplicaClock(this.peerClock);
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
  private anchorWall = -Infinity;
  private displayedSequence = 0;
  private pendingRelease: { time: number; sequence: number } | null = null;
  private inbox: TransportEvent[];
  constructor(readonly prepared: PreparedConnection, view: CombatViewProvider,
    private readonly now: () => number = () => performance.now()) {
    this.inbox = [...prepared.inbox]; prepared.inbox.length = 0;
    this.clock = new SessionClock(now, 0, prepared.epoch);
    this.lastFrameWall = now();
    this.startup = new StartHandshake(prepared.role, prepared.link.sessionId, prepared.epoch, stampAt(0), now, () => {
      try {
        const estimate = this.peerClock.estimate(now());
        return { lower: estimate.remoteLower, upper: estimate.remoteUpper };
      } catch (error) {
        if (!(error instanceof ClockError)) throw error;
        return null;
      }
    });
    if (prepared.role === 'host') {
      const author = new FormationWorker();
      try {
        this.hostValue = new HostGame(prepared.authored, prepared.link.sessionId, prepared.epoch + 1, now, this.send, view,
          prepared.lobby.state!.assistance, prepared.course.manifest, author);
      } catch (error) { author.close(); throw error; }
    } else this.guestValue = new GuestGame(prepared, prepared.link.sessionId, prepared.epoch + 1, now, this.send);
  }
  get phase(): MatchPhase { return this.phaseValue; }
  get issue(): string | null { return this.issueValue; }
  get frame(): SharedWorldFrame | null { return this.frameValue; }
  get host(): HostGame | null { return this.hostValue; }
  get guest(): GuestGame | null { return this.guestValue; }
  get timeline() { return this.hostValue?.timeline ?? this.guestValue?.combat ?? null; }
  assetsLoaded(): void { this.loaded = true; }
  private send = (body: MessageBody): SendResult => {
    if (!this.active) return { ok: false, reason: 'not_open' };
    return this.prepared.link.send(body);
  };
  async update(): Promise<void> {
    if (!this.active || this.busy || this.phaseValue === 'held') return;
    this.busy = true;
    try {
      this.inbox.push(...this.prepared.link.drain());
      for (const event of this.inbox.splice(0)) {
        if (event.type === 'message') await this.receive(event.message);
        else if (event.type === 'rejected' || event.type === 'failed') throw new Error(`Match transport failed: ${event.code}.`);
      }
      if (!this.active) return;
      if (this.prepared.link.status !== 'open') throw new Error('The peer connection is unavailable.');
      const now = this.now();
      if (now - this.lastProbe >= 500) {
        const probe = this.peerClock.probe(now);
        if (!this.send(probe).ok) this.peerClock.cancelProbe(probe.id);
        this.lastProbe = now;
      }
      if (!this.started) {
        const lobby = this.prepared.lobby, state = lobby.state;
        if (!state || state.terrain !== this.prepared.course.manifest.terrain) throw new Error('The prepared course changed. Return to the lobby.');
        if (!lobby.flush(this.send)) return;
        this.startup.setReady(this.loaded && lobby.bothReady, state.update);
        this.startup.pump(this.send);
        const started = this.startup.takeStart();
        if (started) this.start(started);
        else this.phaseValue = this.startup.phase === 'countdown' ? 'countdown' : 'loading';
      }
      if (!this.started) return;
      if (this.hostValue) await this.updateHost();
      else if (this.guestValue) this.updateGuest();
    } catch (error) {
      if (!this.active) return;
      this.hold(error instanceof Error ? error.message : 'The private match could not continue.');
      console.error('Private match held:', this.issueValue);
    } finally { this.busy = false; }
  }
  private async receive(message: WireMessage): Promise<void> {
    if (message.type === 'ping') {
      // Probes are unordered and disposable; never put a stale response in the reliable queue.
      this.send({ type: 'pong', id: message.id, sentAt: message.sentAt, receivedAt: this.now() }); return;
    }
    if (message.type === 'pong') { this.peerClock.receive(message, this.now()); return; }
    if (!this.started) {
      if (message.type === 'lobby-state') this.prepared.lobby.receiveState(message.state);
      else if (message.type === 'lobby-input') this.prepared.lobby.receiveInput(message.input);
      else if (message.type === 'loading-ready' || message.type === 'start-offer' || message.type === 'start-ready' ||
        message.type === 'start-commit' || message.type === 'start-cancel' || message.type === 'barrier') {
        this.startup.receive(message);
        const started = this.startup.takeStart();
        if (started) this.start(started);
      } else if (message.type !== 'hello') throw new Error('Unexpected match loading message.');
      return;
    }
    if (this.hostValue) {
      if (message.type === 'resync') throw new Error('The guest needs the shared match to stop and resynchronize.');
      if (message.type !== 'command' && message.type !== 'transfer-ready') throw new Error('Unexpected host gameplay message.');
      this.hostValue.receive(message);
    } else {
      if (message.type === 'barrier' && message.reason === 'pause') throw new Error('The host paused the shared match.');
      await this.guestValue!.receive(message);
      const anchor = this.guestValue!.replica.clockAnchor;
      if (anchor && anchor.monotonicMs > this.anchorWall) {
        this.replicaClock.observe(anchor, this.now()); this.anchorWall = anchor.monotonicMs;
      }
    }
  }
  private start(started: StartedSession) {
    if (started.requiresPause) throw new Error('Readiness or clock synchronization changed during the countdown.');
    const prepared = this.prepared;
    if (prepared.role === 'host') {
      for (const slot of [0, 1] as const) this.hostValue!.scheduler.session.setAssistance(slot, prepared.lobby.state!.assistance[slot]);
      this.clock.start(started.epoch, started.hostStartsAt);
    }
    this.started = true;
    this.initialDeadline = this.now() + 5000;
    this.lastFrameWall = this.now(); this.phaseValue = 'loading';
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
      if (target - session.time > GAME_STREAM_LIMITS.advanceSeconds) {
        throw new Error('The host could not keep up with the shared flight clock.');
      }
      const held = await host.pump(Math.max(session.time, target));
      if (!this.active) return;
      if (held) throw new Error(`Waiting for gameplay publication: ${held}.`);
    } else await host.pump();
    if (!this.active) return;
    if (this.pendingRelease) {
      const input = this.pendingRelease; this.pendingRelease = null;
      host.release(input.time, input.sequence);
      await host.pump();
      if (!this.active) return;
    }
    const now = this.now(), elapsed = Math.max(0, (now - this.lastFrameWall) / 1000);
    const time = session.status === 'over'
      ? Math.min(session.time + FINALE_DURATION, Math.max(session.time, this.frameValue?.time ?? session.time) + elapsed) : session.time;
    this.frameValue = host.frame(time);
    this.displayedSequence = host.scheduler.sequence;
    this.phaseValue = session.status === 'over' ? time >= session.time + FINALE_DURATION ? 'over' : 'ending' : 'playing';
    this.lastFrameWall = now;
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
    this.frameValue = guest.frame(time, this.prepared.course.manifest.seed);
    this.phaseValue = state.status === 'over' ? time >= end + FINALE_DURATION ? 'over' : 'ending' : 'playing';
    this.lastFrameWall = now;
  }
  release(): boolean {
    if (this.phaseValue !== 'playing' || !this.frameValue?.ready) return false;
    if (this.hostValue) {
      if (this.pendingRelease || this.hostValue.player(0).completion) return false;
      if (this.busy) {
        this.pendingRelease = { time: this.frameValue.time, sequence: this.displayedSequence }; return true;
      }
      return this.hostValue.release(this.frameValue.time, this.displayedSequence).accepted;
    }
    return this.guestValue!.release();
  }
  hold(reason: string): void {
    if (!this.active || this.phaseValue === 'held') return;
    this.issueValue = reason; this.phaseValue = 'held';
    this.hostValue?.scheduler.session.pause();
    this.pendingRelease = null;
    if (this.started) {
      this.send(this.hostValue ? { type: 'barrier', reason: 'pause', nextEpoch: this.prepared.link.epoch + 1,
        at: stampAt(this.hostValue.scheduler.session.time) } : { type: 'resync', reason: 'drift' });
    }
  }
  close(): void {
    if (!this.active) return;
    this.active = false; this.phaseValue = 'closed';
    this.pendingRelease = null;
    this.startup.close(); this.hostValue?.close(); this.guestValue?.close(); this.prepared.link.close(); this.inbox.length = 0;
  }
}
