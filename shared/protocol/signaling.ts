import { z } from 'zod';
import { PROTOCOL_VERSION } from './limits.js';
import { capability, roomView } from './rooms.js';

const generation = z.number().int().min(1).max(1_000_000);
const sdp = z.string().min(1).max(12 * 1024);
export const iceCandidate = z.strictObject({
  candidate: z.string().max(2048), sdpMid: z.string().max(64).nullable(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullable(),
  usernameFragment: z.string().max(256).nullable().optional(),
});
export const clientSignal = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('auth'), version: z.literal(PROTOCOL_VERSION), capability }),
  z.strictObject({ type: z.literal('offer'), generation, sdp }),
  z.strictObject({ type: z.literal('answer'), generation, sdp }),
  z.strictObject({ type: z.literal('ice'), generation, candidate: iceCandidate.nullable() }),
]);
const role = z.enum(['host', 'guest']);
export const serverSignal = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('authenticated'), version: z.literal(PROTOCOL_VERSION), room: roomView }),
  z.strictObject({ type: z.literal('room'), room: roomView }),
  z.strictObject({ type: z.literal('peer'), connected: z.boolean(), generation: generation.or(z.literal(0)) }),
  z.strictObject({ type: z.literal('offer'), from: z.literal('host'), generation, sdp }),
  z.strictObject({ type: z.literal('answer'), from: z.literal('guest'), generation, sdp }),
  z.strictObject({ type: z.literal('ice'), from: role, generation, candidate: iceCandidate.nullable() }),
  z.strictObject({ type: z.literal('error'), code: z.enum([
    'invalid_message', 'unauthorized', 'already_connected', 'not_admitted', 'peer_unavailable',
    'generation', 'role', 'rate_limited', 'capacity', 'backpressure', 'auth_timeout', 'heartbeat_timeout',
  ]) }),
  z.strictObject({ type: z.literal('closed'), reason: z.enum(['room_closed', 'service_stopped', 'recovery_expired']) }),
]);
export type ClientSignal = z.infer<typeof clientSignal>;
export type ServerSignal = z.infer<typeof serverSignal>;
