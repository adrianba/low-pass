import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Role } from '../shared/protocol/limits.js';
import type { RoomView } from '../shared/protocol/rooms.js';

export class RoomError extends Error {
  constructor(readonly code: string, readonly status: number) { super(`Room request rejected: ${code}.`); }
}
export const ROOM_LIMITS = Object.freeze({
  rooms: 16, roomsPerSource: 2, grants: 64, grantsPerSource: 2, grantMs: 60_000,
  invitationMs: 5 * 60_000, pendingMs: 60_000, idleMs: 15 * 60_000, lifetimeMs: 8 * 60 * 60_000,
  tombstones: 256, tombstoneMs: 60_000,
});
export const hashSecret = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const id = () => randomBytes(16).toString('base64url');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function invitation(): string { return [...randomBytes(8)].map(byte => alphabet[byte & 31]).join(''); }
interface Grant { source: string; expires: number }
interface Member { id: string; role: Role; hash: string }
interface Room {
  id: string; source: string; host: Member; guest: Member | null; state: RoomView['state'];
  invitation: string | null; invitationUntil: number; pendingUntil: number; idleUntil: number; until: number;
}
export interface Membership { roomId: string; participantId: string; role: Role; admitted: boolean }
export type RoomNotice = { roomId: string; kind: 'changed' | 'closed'; reason?: string };

export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly invitations = new Map<string, string>();
  private readonly grants = new Map<string, Grant>();
  private readonly members = new Map<string, string>();
  private readonly revoked = new Map<string, { reason: string; until: number }>();
  private readonly listeners = new Set<(notice: RoomNotice) => void>();
  private readonly accessDigest: Buffer;
  private lastTime = -Infinity;
  constructor(accessDigest: string, private readonly clock: () => number = () => performance.now()) {
    if (!/^[a-f0-9]{64}$/.test(accessDigest)) throw new Error('Invalid hosting-code digest.');
    this.accessDigest = Buffer.from(accessDigest, 'hex');
  }
  private now(): number {
    const now = this.clock();
    if (!Number.isFinite(now) || now < this.lastTime) throw new Error('Room clock must be monotonic.');
    this.lastTime = now; return now;
  }
  get counts() { return { rooms: this.rooms.size, grants: this.grants.size, members: this.members.size,
    invitations: this.invitations.size, tombstones: this.revoked.size }; }
  subscribe(listener: (notice: RoomNotice) => void): () => void {
    if (this.listeners.size >= 4) throw new Error('Room observer limit exceeded.');
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private notify(room: Room, kind: RoomNotice['kind'], reason?: string): void {
    for (const listener of this.listeners) listener({ roomId: room.id, kind, reason });
  }
  authorize(accessCode: string, source: string) {
    this.sweep();
    const candidate = Buffer.from(hashSecret(accessCode), 'hex');
    if (!timingSafeEqual(candidate, this.accessDigest)) throw new RoomError('invalid_hosting_code', 401);
    if (this.grants.size >= ROOM_LIMITS.grants ||
      [...this.grants.values()].filter(g => g.source === source).length >= ROOM_LIMITS.grantsPerSource) throw new RoomError('capacity', 503);
    const credential = token();
    this.grants.set(hashSecret(credential), { source, expires: this.now() + ROOM_LIMITS.grantMs });
    return { capability: credential, expiresInMs: ROOM_LIMITS.grantMs };
  }
  create(credential: string, source: string) {
    this.sweep();
    const hash = hashSecret(credential), grant = this.grants.get(hash);
    if (!grant || grant.source !== source) throw new RoomError('invalid_capability', 401);
    if (this.rooms.size >= ROOM_LIMITS.rooms ||
      [...this.rooms.values()].filter(r => r.source === source).length >= ROOM_LIMITS.roomsPerSource) throw new RoomError('capacity', 503);
    const now = this.now(), capability = token(), roomId = id();
    const room: Room = { id: roomId, source, host: { id: id(), role: 'host', hash: hashSecret(capability) }, guest: null,
      state: 'waiting', invitation: null, invitationUntil: 0, pendingUntil: 0,
      idleUntil: now + ROOM_LIMITS.idleMs, until: now + ROOM_LIMITS.lifetimeMs };
    if (this.rooms.has(roomId) || this.members.has(room.host.hash)) throw new Error('Room identity collision.');
    const code = this.issueInvitation(room);
    this.grants.delete(hash); this.rooms.set(room.id, room); this.members.set(room.host.hash, room.id);
    return { capability, invitation: code, room: this.view(room, room.host) };
  }
  join(code: string) {
    this.sweep();
    const roomId = this.invitations.get(hashSecret(code)), room = roomId ? this.rooms.get(roomId) : null;
    if (!room) throw new RoomError('invalid_invitation', 404);
    if (this.now() >= room.invitationUntil) throw new RoomError('invitation_expired', 410);
    if (room.guest) throw new RoomError('room_full', 409);
    const capability = token(), guest = { id: id(), role: 'guest' as const, hash: hashSecret(capability) };
    if (this.members.has(guest.hash)) throw new Error('Participant identity collision.');
    room.guest = guest; room.state = 'pending'; room.pendingUntil = this.now() + ROOM_LIMITS.pendingMs;
    this.members.set(guest.hash, room.id);
    this.notify(room, 'changed');
    return { capability, room: this.view(room, guest) };
  }
  admit(credential: string, participantId: string, admit: boolean): RoomView {
    const { room, member } = this.member(credential);
    if (member.role !== 'host') throw new RoomError('host_required', 403);
    if (room.state !== 'pending' || room.guest?.id !== participantId) throw new RoomError('stale_admission', 409);
    if (admit) room.state = 'admitted';
    else this.removeGuest(room, 'admission_denied');
    this.notify(room, 'changed');
    return this.view(room, member);
  }
  rotate(credential: string) {
    const { room, member } = this.member(credential);
    if (member.role !== 'host') throw new RoomError('host_required', 403);
    if (room.state === 'admitted') throw new RoomError('room_full', 409);
    if (room.guest) this.removeGuest(room, 'invitation_revoked');
    const code = this.issueInvitation(room);
    this.notify(room, 'changed');
    return { invitation: code, room: this.view(room, member) };
  }
  status(credential: string): RoomView {
    const { room, member } = this.member(credential);
    return this.view(room, member);
  }
  authenticate(credential: string, requireAdmission = false): Membership {
    return this.authenticateDigest(hashSecret(credential), requireAdmission);
  }
  authenticateDigest(digest: string, requireAdmission = false): Membership {
    const { room, member } = this.memberDigest(digest);
    if (requireAdmission && room.state !== 'admitted') throw new RoomError('admission_required', 403);
    return { roomId: room.id, participantId: member.id, role: member.role, admitted: room.state === 'admitted' };
  }
  leave(credential: string): void {
    this.leaveDigest(hashSecret(credential));
  }
  leaveDigest(digest: string, reason = 'room_closed'): void {
    const { room, member } = this.memberDigest(digest);
    if (member.role === 'host' || room.state === 'admitted') this.closeRoom(room, reason);
    else { this.removeGuest(room, reason); this.notify(room, 'changed', reason); }
  }
  private member(credential: string): { room: Room; member: Member } {
    return this.memberDigest(hashSecret(credential));
  }
  statusDigest(digest: string): RoomView {
    const { room, member } = this.memberDigest(digest);
    return this.view(room, member);
  }
  peekDigest(digest: string): RoomView | null {
    const roomId = this.members.get(digest), room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room) return null;
    const member = room.host.hash === digest ? room.host : room.guest;
    return member?.hash === digest ? this.view(room, member) : null;
  }
  hasDigest(digest: string): boolean { return this.members.has(digest); }
  private memberDigest(hash: string): { room: Room; member: Member } {
    this.sweep();
    const roomId = this.members.get(hash), room = roomId ? this.rooms.get(roomId) : null;
    if (!room) throw new RoomError(this.revoked.get(hash)?.reason ?? 'invalid_capability', 401);
    const member = room.host.hash === hash ? room.host : room.guest;
    if (!member || member.hash !== hash) throw new Error('Invalid room membership index.');
    room.idleUntil = Math.min(room.until, this.now() + ROOM_LIMITS.idleMs);
    return { room, member };
  }
  private view(room: Room, member: Member): RoomView {
    const now = this.now();
    return { roomId: room.id, participantId: member.id, role: member.role, state: room.state,
      guestId: room.guest?.id ?? null, invitationExpiresInMs: Math.max(0, room.invitationUntil - now),
      expiresInMs: Math.max(0, Math.min(room.idleUntil, room.until) - now) };
  }
  private issueInvitation(room: Room): string {
    let code = '';
    for (let i = 0; i < 8; i++) { code = invitation(); if (!this.invitations.has(hashSecret(code))) break; }
    const hash = hashSecret(code);
    if (this.invitations.has(hash)) throw new Error('Invitation identity collision.');
    if (room.invitation) this.invitations.delete(room.invitation);
    room.invitation = hash; room.invitationUntil = this.now() + ROOM_LIMITS.invitationMs;
    this.invitations.set(hash, room.id);
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }
  private revoke(hash: string, reason: string): void {
    this.members.delete(hash);
    // Tombstones are only short-lived error explanations; expired credentials stay invalid.
    if (this.revoked.size >= ROOM_LIMITS.tombstones) this.revoked.delete([...this.revoked.keys()][0]!);
    this.revoked.set(hash, { reason, until: this.now() + ROOM_LIMITS.tombstoneMs });
  }
  private removeGuest(room: Room, reason: string): void {
    if (room.guest) this.revoke(room.guest.hash, reason);
    if (room.invitation) this.invitations.delete(room.invitation);
    room.guest = null; room.invitation = null; room.invitationUntil = 0; room.state = 'waiting';
  }
  private closeRoom(room: Room, reason: string): void {
    this.revoke(room.host.hash, reason);
    if (room.guest) this.revoke(room.guest.hash, reason);
    if (room.invitation) this.invitations.delete(room.invitation);
    this.rooms.delete(room.id); this.notify(room, 'closed', reason);
  }
  sweep(): void {
    const now = this.now();
    for (const [hash, grant] of this.grants) if (now >= grant.expires) this.grants.delete(hash);
    for (const [hash, tombstone] of this.revoked) if (now >= tombstone.until) this.revoked.delete(hash);
    for (const room of this.rooms.values()) {
      if (now >= room.until || now >= room.idleUntil) this.closeRoom(room, 'room_expired');
      else if (room.state === 'pending' && now >= room.pendingUntil) {
        this.removeGuest(room, 'admission_expired'); this.notify(room, 'changed');
      }
    }
  }
  close(): void {
    this.listeners.clear();
    for (const room of [...this.rooms.values()]) this.closeRoom(room, 'service_stopped');
    this.grants.clear(); this.revoked.clear(); this.accessDigest.fill(0);
  }
}
