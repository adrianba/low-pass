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
