import type { RoomMembership } from '../../shared/protocol/rooms.js';
import type { Compatibility } from '../../shared/protocol/game.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import { assertCompatible, ProtocolError } from '../../shared/protocol/codec.js';
import type { Settings } from '../storage/records.js';
import { TransferReceiver, TransferError } from './transfer.js';
import type { CompletedTransfer } from './transfer.js';
import { BUILD_IDENTITY } from './build-identity.js';
import type { PeerLink } from './peer-link.js';
import { connectPeer } from './connect-peer.js';
import { Lobby } from './lobby.js';
import type { IceMode } from './ice-policy.js';
import { prepareHostCourse } from './prepared-course.js';
import type { PreparedHostCourse, OutgoingTransfer } from './prepared-course.js';
import type { TransportEvent } from './transport.js';

type ManifestMessage = Extract<MessageBody, { type: 'course-manifest' }>;
class CourseError extends Error {
  constructor(readonly code: string) { super(`Course setup failed: ${code}.`); }
}
export type MatchLink = Pick<PeerLink, 'status' | 'failure' | 'send' | 'drain' | 'diagnostics' | 'close' | 'epoch' | 'sessionId'>
  & Partial<Pick<PeerLink, 'signalingState'>>;
type CourseAuthor = typeof prepareHostCourse;
interface PreparedBase {
  link: MatchLink; lobby: Lobby; course: ManifestMessage; epoch: number; inbox: TransportEvent[];
}
export type PreparedConnection = PreparedBase & (
  { role: 'host'; authored: PreparedHostCourse } |
  { role: 'guest'; formations: [CompletedTransfer, CompletedTransfer] }
);

/** Connection/course readiness only. No match clock, scores or gameplay inputs. */
export class LobbyConnection {
  readonly lobby: Lobby;
  private readonly receiver = new TransferReceiver(() => performance.now(), { maxTransfers: 2, maxBytes: 32 * 1024 * 1024, ttlMs: 30_000 });
  private readonly received = new Map<string, CompletedTransfer>();
  private current: ManifestMessage | null = null;
  private courseEpoch = 0;
  private authored: PreparedHostCourse | null = null;
  private outgoing: Array<{ transfer: OutgoingTransfer; index: number }> = [];
  private urgent: MessageBody[] = [];
  private busy = false;
  private disposed = false;
  private failure: string | null = null;
  private failurePhase: string | null = null;
  private stoppedProgress: ReturnType<LobbyConnection['progress']> | null = null;
  private nextRevision = 0;
  private deadline = Infinity;
  private complete = false;
  private needsPreparation = true;
  private lastPing = 0;
  private pingId = 0;
  private rtts: number[] = [];
  private readonly identity: Compatibility;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly inbox: TransportEvent[];
  constructor(private readonly link: MatchLink, settings: Settings,
    identity: Compatibility, private readonly seed: number, role: RoomMembership['room']['role'],
    private readonly author: CourseAuthor = prepareHostCourse,
    private readonly onPrepared?: (connection: PreparedConnection) => void, inbox: TransportEvent[] = []) {
    this.identity = Object.freeze({ ...identity });
    this.lobby = new Lobby(role, settings);
    this.inbox = [...inbox];
    this.timer = setInterval(() => { void this.pump(); }, 20);
  }
  static async connect(member: RoomMembership, settings: Settings, mode: IceMode, seed = 7,
    identity: Compatibility = BUILD_IDENTITY, onPrepared?: (connection: PreparedConnection) => void): Promise<LobbyConnection> {
    const aspect = innerWidth / innerHeight;
    if (aspect < 0.75 || aspect > 2) throw new Error('Resize this window to an aspect ratio between 0.75 and 2 before connecting.');
    if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) throw new Error('Invalid course seed.');
    const link = await connectPeer(member, identity, aspect, mode);
    return new LobbyConnection(link, settings, identity, seed, member.room.role, undefined, onPrepared);
  }
  private queue(message: MessageBody) {
    if (this.urgent.length >= 32) throw new CourseError('control_capacity');
    this.urgent.push(message);
  }
  private async prepare() {
    const terrain = this.lobby.state!.terrain, revision = this.nextRevision++;
    this.needsPreparation = true; this.complete = false; this.lobby.allowReady(false); this.outgoing = []; this.authored = null;
    this.urgent = this.urgent.filter(message => message.type !== 'course-ready' && message.type !== 'course-manifest');
    const authored = await this.author(terrain, this.seed, revision);
    if (this.disposed || this.lobby.state!.terrain !== terrain) return;
    if (authored.scheduler.terrain !== terrain || authored.scheduler.seed !== this.seed ||
      authored.scheduler.session.time !== 0 || authored.scheduler.session.lastEventId !== 0) throw new CourseError('authored_course_state');
    this.authored = authored; this.courseEpoch = this.link.epoch;
    const transfers = authored.transfers;
    const a = transfers[0]!, b = transfers[1]!;
    this.current = { type: 'course-manifest', revision,
      manifest: { compatibility: this.identity, terrain, seed: this.seed, grid: terrain === 'river-canyon' ? 8 : 16, triangle: 'shared-diagonal-v1' },
      plans: [{ id: a.offer.id, digest: a.offer.digest }, { id: b.offer.id, digest: b.offer.digest }] };
    this.queue(this.current);
    this.needsPreparation = false;
    this.outgoing = transfers.map(transfer => ({ transfer, index: -1 }));
    this.deadline = performance.now() + 45_000;
  }
  private async receive(message: WireMessage) {
    if (message.type === 'hello') return;
    if (message.type === 'lobby-state') { this.lobby.receiveState(message.state); return; }
    if (message.type === 'lobby-input') { this.lobby.receiveInput(message.input); return; }
    if (message.type === 'ping') { this.queue({ type: 'pong', id: message.id, sentAt: message.sentAt, receivedAt: performance.now() }); return; }
    if (message.type === 'pong') {
      if (this.rtts.length >= 60) this.rtts.shift();
      this.rtts.push(performance.now() - message.sentAt); return;
    }
    if (message.type === 'course-manifest') {
      assertCompatible(this.identity, message.manifest.compatibility);
      if (this.current && message.revision < this.current.revision) return;
      if (this.current && message.revision === this.current.revision) {
        if (JSON.stringify({ type: message.type, revision: message.revision, manifest: message.manifest, plans: message.plans }) !== JSON.stringify(this.current)) {
          throw new CourseError('revision_conflict');
        }
        return;
      }
      if (message.manifest.terrain !== this.lobby.state?.terrain) throw new CourseError('manifest_terrain');
      this.current = { type: message.type, revision: message.revision, manifest: message.manifest, plans: message.plans };
      this.courseEpoch = message.epoch;
      this.complete = false; this.lobby.allowReady(false); this.receiver.reset(); this.received.clear();
      this.deadline = performance.now() + 45_000; return;
    }
    if (!this.current) throw new CourseError('manifest_order');
    if (message.type === 'transfer-offer') {
      if (message.transfer.kind !== 'formation' || !this.current.plans.some(p => p.id === message.transfer.id && p.digest === message.transfer.digest)) {
        throw new CourseError('unexpected_payload');
      }
      if (this.received.has(message.transfer.id)) return;
      this.receiver.offer(message.transfer); return;
    }
    if (message.type === 'transfer-chunk') {
      if (this.received.has(message.transferId)) return;
      const completed = await this.receiver.accept({ transferId: message.transferId, index: message.index, data: message.data });
      if (!completed || this.disposed) return;
      const index = this.current.plans.findIndex(p => p.id === completed.reference.id && p.digest === completed.reference.digest);
      if (index < 0 || completed.payload.kind !== 'formation' || completed.payload.data.sequence !== index ||
        completed.payload.data.terrain !== this.current.manifest.terrain) throw new CourseError('payload_reference');
      this.received.set(completed.reference.id, completed);
      if (this.received.size === 2) this.queue({ type: 'course-ready', revision: this.current.revision, plans: this.current.plans });
      return;
    }
    if (message.type === 'course-ready') {
      if (message.revision < this.current.revision) return;
      if (this.lobby.role === 'host' && this.needsPreparation) return;
      if (this.current.manifest.terrain !== this.lobby.state?.terrain) return;
      if (message.revision !== this.current.revision || JSON.stringify(message.plans) !== JSON.stringify(this.current.plans)) {
        throw new CourseError('acknowledgement');
      }
      if (this.lobby.role === 'host') {
        if (this.outgoing.length) throw new CourseError('early_acknowledgement');
        this.queue({ type: 'course-ready', revision: this.current.revision, plans: this.current.plans });
      }
      else if (this.received.size !== 2) throw new CourseError('verification_order');
      this.complete = true; this.lobby.allowReady(true); this.deadline = Infinity; return;
    }
    throw new CourseError('unexpected_message');
  }
  private async pump() {
    if (this.busy || this.disposed) return;
    this.busy = true;
    let phase = 'receiving';
    try {
      const incoming = [...this.inbox.splice(0), ...this.link.drain()];
      for (let index = 0; index < incoming.length; index++) {
        const event = incoming[index]!;
        if (event.type === 'message') {
          phase = `receiving:${event.message.type}`; await this.receive(event.message);
          if (this.handoff(incoming.slice(index + 1))) return;
        }
      }
      if (this.link.status === 'closed') throw new Error('Peer connection closed.');
      if (this.link.status !== 'open') return;
      if (!Number.isFinite(this.deadline) && (!this.current || this.current.manifest.terrain !== this.lobby.state?.terrain)) {
        this.deadline = performance.now() + 45_000;
      }
      phase = 'expiry';
      if (this.receiver.expire().length || performance.now() >= this.deadline) throw new TransferError('expired');
      phase = 'lobby';
      if (!this.lobby.flush(message => this.link.send(message))) return;
      phase = 'preparing';
      if (this.lobby.role === 'host' && (this.needsPreparation || this.current?.manifest.terrain !== this.lobby.state!.terrain)) await this.prepare();
      if (this.disposed) return;
      phase = 'expiry';
      if (this.receiver.expire().length || performance.now() >= this.deadline) throw new TransferError('expired');
      if (performance.now() - this.lastPing >= 1000) {
        this.lastPing = performance.now(); this.queue({ type: 'ping', id: this.pingId++, sentAt: 0 });
      }
      for (let sent = 0; sent < 16; sent++) {
        phase = 'sending';
        const priority = this.urgent[0], pending = this.outgoing[0];
        const body: MessageBody | undefined = priority ?? (pending ? pending.index < 0
          ? { type: 'transfer-offer', transfer: pending.transfer.offer }
          : { type: 'transfer-chunk', ...pending.transfer.chunks[pending.index]! } : undefined);
        if (!body) break;
        const result = this.link.send(body.type === 'ping' ? { ...body, sentAt: performance.now() } : body);
        if (!result.ok) break;
        if (priority) this.urgent.shift();
        else if (pending && ++pending.index >= pending.transfer.chunks.length) this.outgoing.shift();
      }
      this.handoff([]);
    } catch (error) {
      if (this.disposed) return;
      this.failure = this.link.failure ?? (error instanceof TransferError || error instanceof CourseError ? `course_${error.code}`
        : error instanceof ProtocolError ? error.code : 'course_setup_failed');
      this.failurePhase = phase;
      this.stoppedProgress = this.progress();
      console.error(`Private connection check failed: ${this.failure}.`);
      this.close();
    } finally { this.busy = false; }
  }
  private handoff(inbox: TransportEvent[]): boolean {
    if (!this.onPrepared || this.disposed || this.link.status !== 'open' || !this.current || !this.complete ||
      !this.lobby.state?.ready.every(Boolean) || this.outgoing.length ||
      this.urgent.some(message => message.type !== 'ping' && message.type !== 'pong') ||
      !this.lobby.flush(message => this.link.send(message))) return false;
    const common: PreparedBase = { link: this.link, lobby: this.lobby, course: structuredClone(this.current),
      epoch: this.courseEpoch, inbox };
    let prepared: PreparedConnection;
    if (this.lobby.role === 'host') {
      if (!this.authored) throw new CourseError('missing_authored_course');
      prepared = { ...common, role: 'host', authored: this.authored };
    } else {
      const [first, next] = this.current.plans.map(ref => this.received.get(ref.id));
      if (!first || !next) throw new CourseError('missing_verified_course');
      prepared = { ...common, role: 'guest', formations: [first, next] };
    }
    // The controller owns readiness revalidation/countdown, including late lobby intents.
    clearInterval(this.timer); this.disposed = true; this.receiver.reset();
    this.authored = null; this.received.clear(); this.outgoing = []; this.urgent = [];
    try { this.onPrepared(prepared); }
    catch {
      this.failure = 'controller_handoff_failed'; this.failurePhase = 'handoff';
      this.link.close(); console.error('Private match controller handoff failed.');
    }
    return true;
  }
  private progress() { return { outgoingPlans: this.outgoing.length, receivedVerifiedPlans: this.received.size, pendingTransfers: this.receiver.pendingCount }; }
  async report() {
    return { connection: await this.link.diagnostics(), error: this.failure,
      failurePhase: this.failurePhase,
      progress: { ...(this.stoppedProgress ?? this.progress()) },
      course: this.current ? { revision: this.current.revision, terrain: this.current.manifest.terrain,
        plans: structuredClone(this.current.plans), verified: this.complete && this.current.manifest.terrain === this.lobby.state?.terrain } : null,
      compatibility: { ...this.identity }, rttSamples: this.rtts.length, maximumRttMs: this.rtts.length ? Math.max(...this.rtts) : null };
  }
  close() {
    if (this.disposed) return;
    this.disposed = true; this.complete = false; clearInterval(this.timer); this.lobby.allowReady(false);
    this.link.close(); this.receiver.reset(); this.authored = null; this.received.clear(); this.outgoing = []; this.urgent = [];
    this.inbox.length = 0;
  }
}
