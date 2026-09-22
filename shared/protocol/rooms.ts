import { z } from 'zod';

export const capability = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const participantId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const hostRequest = z.strictObject({ accessCode: z.string().min(1).max(256) });
export const invitationRequest = z.strictObject({
  invitation: z.string().trim().toUpperCase().regex(/^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/)
    .transform(value => value.replace('-', '')),
});
export const admissionRequest = z.strictObject({ participantId, admit: z.boolean() });
export const emptyRequest = z.strictObject({});
export const roomView = z.strictObject({
  roomId: participantId, role: z.enum(['host', 'guest']), participantId,
  state: z.enum(['waiting', 'pending', 'admitted']),
  guestId: participantId.nullable(),
  invitationExpiresInMs: z.number().min(0), expiresInMs: z.number().min(0),
});
export type RoomView = z.infer<typeof roomView>;

export const roomCapabilities = z.strictObject({
  multiplayer: z.boolean(), reason: z.enum(['not_implemented', 'configuration_error', 'service_error']),
  rooms: z.boolean().optional(), signaling: z.boolean().optional(), turn: z.boolean().optional(),
});
export const hostAuthorization = z.strictObject({ capability, expiresInMs: z.number().positive() });
export const roomMembership = z.strictObject({ capability, room: roomView });
export const invitationCode = z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
export const createdRoom = roomMembership.extend({ invitation: invitationCode });
export const roomStatus = z.strictObject({ room: roomView });
export const roomInvitation = z.strictObject({ invitation: invitationCode, room: roomView });
export type RoomMembership = z.infer<typeof roomMembership>;
