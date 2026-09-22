import type { RoomMembership, RoomView } from '../../shared/protocol/rooms.js';
import type { Role } from '../../shared/protocol/limits.js';
import { RoomClient, RoomClientError, roomClientError, roomEnded } from './room-client.js';

type RoomApi = Pick<RoomClient, 'capabilities' | 'authorize' | 'create' | 'join' | 'status' | 'admit' | 'invitation' | 'leave'>;
export interface RoomSessionState {
  availability: 'checking' | 'available' | 'unavailable';
  busy: boolean; closing: boolean; room: RoomView | null; invitation: string | null; error: string | null;
}

export class RoomSession {
  private availability: RoomSessionState['availability'] = 'checking';
  private member: RoomMembership | null = null;
  private invitationCode: string | null = null;
  private error: string | null = null;
  private work: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private disposed = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollAbort: AbortController | null = null;
  private revision = 0;
  constructor(readonly role: Role, private readonly changed: () => void, private readonly api: RoomApi = new RoomClient()) {}
  get state(): RoomSessionState {
    return { availability: this.availability, busy: !!this.work || !!this.closing, closing: !!this.closing,
      room: this.closing || !this.member ? null : { ...this.member.room },
      invitation: this.closing ? null : this.invitationCode, error: this.error };
  }
  private notify() { if (!this.disposed) this.changed(); }
  private stopPolling() {
    this.revision++;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null; this.pollAbort?.abort(); this.pollAbort = null;
  }
  private update(room: RoomView) {
    if (!this.member || room.roomId !== this.member.room.roomId || room.participantId !== this.member.room.participantId ||
      room.role !== this.role) throw new RoomClientError('invalid_response');
    this.member = { ...this.member, room: { ...room } };
    if (room.state === 'admitted' || room.invitationExpiresInMs === 0) this.invitationCode = null;
  }
  private fail(error: unknown) {
    if (roomEnded(error)) { this.member = null; this.invitationCode = null; }
    this.error = roomClientError(error).message;
  }
  private action(work: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.work || this.closing) { this.error = new RoomClientError('busy').message; this.notify(); return Promise.resolve(); }
    this.stopPolling(); this.error = null;
    this.work = Promise.resolve().then(() => this.closing || this.disposed ? undefined : work()).catch(error => this.fail(error)).finally(() => {
      this.work = null; this.notify();
      if (!this.error) this.schedulePoll();
    });
    this.notify(); return this.work;
  }
  check(): Promise<void> {
    return this.action(async () => {
      const status = await this.api.capabilities();
      this.availability = status.rooms === true ? 'available' : 'unavailable';
      if (this.availability === 'unavailable') throw new RoomClientError('rooms_unavailable');
    });
  }
  create(accessCode: string): Promise<void> {
    return this.action(async () => {
      if (this.role !== 'host') throw new RoomClientError('host_required');
      if (this.availability !== 'available') throw new RoomClientError('rooms_unavailable');
      if (this.member) throw new RoomClientError('busy');
      const grant = await this.api.authorize(accessCode);
      if (this.closing || this.disposed) return;
      const created = await this.api.create(grant.capability);
      if (created.room.role !== 'host' || created.room.state !== 'waiting') throw new RoomClientError('invalid_response');
      this.member = { capability: created.capability, room: { ...created.room } };
      this.invitationCode = created.invitation;
    });
  }
  join(invitation: string): Promise<void> {
    return this.action(async () => {
      if (this.role !== 'guest') throw new RoomClientError('invalid_request');
      if (this.availability !== 'available') throw new RoomClientError('rooms_unavailable');
      if (this.member) throw new RoomClientError('busy');
      const joined = await this.api.join(invitation);
      if (joined.room.role !== 'guest' || joined.room.state !== 'pending' ||
        joined.room.guestId !== joined.room.participantId) throw new RoomClientError('invalid_response');
      this.member = { capability: joined.capability, room: { ...joined.room } };
    });
  }
  admit(admit: boolean): Promise<void> {
    return this.action(async () => {
      if (this.role !== 'host') throw new RoomClientError('host_required');
      if (!this.member?.room.guestId || this.member.room.state !== 'pending') throw new RoomClientError('stale_admission');
      this.update((await this.api.admit(this.member.capability, this.member.room.guestId, admit)).room);
    });
  }
  renew(): Promise<void> {
    return this.action(async () => {
      if (this.role !== 'host') throw new RoomClientError('host_required');
      if (!this.member) throw new RoomClientError('invalid_capability');
      const result = await this.api.invitation(this.member.capability);
      this.update(result.room); this.invitationCode = result.invitation;
    });
  }
  refresh(): Promise<void> {
    return this.action(async () => {
      if (!this.member) throw new RoomClientError('invalid_capability');
      this.update((await this.api.status(this.member.capability)).room);
    });
  }
  private schedulePoll() {
    if (!this.member || this.closing || this.disposed) return;
    this.pollTimer = setTimeout(() => { this.pollTimer = null; void this.poll(); }, 2000);
  }
  private async poll() {
    if (!this.member || this.work || this.closing || this.disposed) return;
    const revision = this.revision, member = this.member, controller = this.pollAbort = new AbortController();
    try {
      const result = await this.api.status(member.capability, controller.signal);
      if (revision !== this.revision || this.disposed) return;
      this.update(result.room); this.error = null; this.schedulePoll();
    } catch (error) {
      if (revision === this.revision && !this.disposed) this.fail(error);
    } finally {
      if (this.pollAbort === controller) this.pollAbort = null;
      this.notify();
    }
  }
  leave(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopPolling();
    // Finish an in-flight creation so a returned room can be closed, not orphaned.
    this.closing = Promise.resolve(this.work).then(async () => {
      const member = this.member;
      this.member = null; this.invitationCode = null;
      if (member) await this.api.leave(member.capability);
    }).catch(error => {
      if (!roomEnded(error)) {
        this.error = `${roomClientError(error).message} Room closure could not be confirmed; it will expire automatically.`;
        if (this.disposed) console.warn(this.error);
      }
    }).finally(() => { this.closing = null; this.notify(); });
    this.notify(); return this.closing;
  }
  async dispose(): Promise<void> { this.disposed = true; await this.leave(); }
}
