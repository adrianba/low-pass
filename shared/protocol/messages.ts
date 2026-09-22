import { z } from 'zod';
import { compatibility, counter, digest, identifier, manifest, reference, result, sequence, slot, snapshot, stamp } from './game.js';
import { MAX_PLANS, MAX_TRANSFER_BYTES, MAX_TRANSFER_CHUNKS, PROTOCOL_VERSION, TRANSFER_CHUNK_BYTES } from './limits.js';
import { lobbyInput, lobbyState } from './lobby.js';

export const command = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('release'), sequence, plan: reference, displayedAt: stamp }),
  z.strictObject({ action: z.literal('assistance'), enabled: z.boolean() }),
  z.strictObject({ action: z.literal('pause') }),
  z.strictObject({ action: z.literal('ready'), barrier: counter }),
  z.strictObject({ action: z.literal('leave') }),
]);
export const transfer = z.strictObject({
  id: identifier, kind: z.enum(['formation', 'combat', 'checkpoint']), digest,
  bytes: z.number().int().min(1).max(MAX_TRANSFER_BYTES),
  chunks: z.number().int().min(1).max(MAX_TRANSFER_CHUNKS),
}).refine(v => v.chunks === Math.ceil(v.bytes / TRANSFER_CHUNK_BYTES));
export const transferChunk = z.strictObject({
  transferId: identifier, index: z.number().int().min(0).lt(MAX_TRANSFER_CHUNKS),
  data: z.string().min(4).max(Math.ceil(TRANSFER_CHUNK_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .refine(v => v.length / 4 * 3 - (v.endsWith('==') ? 2 : v.endsWith('=') ? 1 : 0) <= TRANSFER_CHUNK_BYTES),
});
export type TransferOffer = z.infer<typeof transfer>;
export type TransferChunk = z.infer<typeof transferChunk>;
export const rejection = z.enum(['paused', 'blocked', 'over', 'eliminated', 'stale_encounter', 'unknown_encounter',
  'resolved', 'already_released', 'not_acquired', 'cutoff', 'active_bomb', 'too_old', 'future', 'epoch', 'plan', 'duplicate']);
export const event = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('released'), slot, sequence, plan: reference, at: stamp, inputSequence: counter }),
  z.strictObject({ action: z.literal('resolved'), result }),
  z.strictObject({ action: z.literal('assistance'), slot, enabled: z.boolean(), assisted: z.boolean() })
    .refine(v => !v.enabled || v.assisted),
  z.strictObject({ action: z.literal('combat'), slot, effect: reference, at: stamp }),
  z.strictObject({ action: z.literal('eliminated'), slot, sequence, at: stamp, combat: reference }),
  z.strictObject({ action: z.literal('ended'), at: stamp, winner: z.union([slot, z.literal('draw')]) }),
]);
const envelope = { version: z.literal(PROTOCOL_VERSION), sessionId: identifier, epoch: counter,
  sender: z.enum(['host', 'guest']), sequence: counter };
const initialPlans = z.tuple([reference, reference]).refine(plans => plans[0].id !== plans[1].id);
export const wireMessage = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('course-manifest'), revision: counter, manifest, plans: initialPlans }),
  z.strictObject({ ...envelope, type: z.literal('course-ready'), revision: counter, plans: initialPlans }),
  z.strictObject({ ...envelope, type: z.literal('loading-ready'), revision: counter, ready: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('start-offer'), attempt: counter.min(1), revision: counter,
    startsAt: z.number().min(-1e12).max(1e12), nextEpoch: counter, at: stamp }),
  z.strictObject({ ...envelope, type: z.literal('start-ready'), attempt: counter.min(1), revision: counter, ready: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal('start-commit'), attempt: counter.min(1) }),
  z.strictObject({ ...envelope, type: z.literal('start-cancel'), attempt: counter.min(1) }),
  z.strictObject({ ...envelope, type: z.literal('lobby-state'), state: lobbyState }),
  z.strictObject({ ...envelope, type: z.literal('lobby-input'), input: lobbyInput }),
  z.strictObject({ ...envelope, type: z.literal('hello'), compatibility,
    viewport: z.strictObject({ aspect: z.number().min(0.75).max(2) }) }),
  z.strictObject({ ...envelope, type: z.literal('command'), slot, inputSequence: counter.min(1), command }),
  z.strictObject({ ...envelope, type: z.literal('ack'), slot, inputSequence: counter.min(1),
    decision: z.discriminatedUnion('accepted', [
      z.strictObject({ accepted: z.literal(true), eventSequence: counter }),
      z.strictObject({ accepted: z.literal(false), reason: rejection }),
    ]) }),
  z.strictObject({ ...envelope, type: z.literal('event'), eventSequence: counter.min(1),
    planRevision: counter, event }),
  z.strictObject({ ...envelope, type: z.literal('snapshot'), sampledAt: z.number().min(-1e12).max(1e12), state: snapshot }),
  z.strictObject({ ...envelope, type: z.literal('transfer-offer'), transfer }),
  z.strictObject({ ...envelope, type: z.literal('transfer-chunk'), ...transferChunk.shape }),
  z.strictObject({ ...envelope, type: z.literal('transfer-ready'), transfer: reference }),
  z.strictObject({ ...envelope, type: z.literal('plan-commit'), planRevision: counter,
    plans: z.array(reference).min(1).max(MAX_PLANS) }).refine(v => new Set(v.plans.map(p => p.id)).size === v.plans.length),
  z.strictObject({ ...envelope, type: z.literal('checkpoint-commit'), checkpoint: reference,
    planRevision: counter, eventSequence: counter, snapshotSequence: counter }),
  z.strictObject({ ...envelope, type: z.literal('barrier'), nextEpoch: counter,
    reason: z.enum(['pause', 'resume', 'recovery', 'rematch']), at: stamp }),
  z.strictObject({ ...envelope, type: z.literal('resync'), reason: z.enum(['gap', 'plan', 'checkpoint', 'drift']) }),
  z.strictObject({ ...envelope, type: z.literal('ping'), id: counter, sentAt: z.number().min(-1e12).max(1e12) }),
  z.strictObject({ ...envelope, type: z.literal('pong'), id: counter, sentAt: z.number().min(-1e12).max(1e12),
    receivedAt: z.number().min(-1e12).max(1e12) }),
]).refine(v => (v.type !== 'lobby-input' || v.sender === 'guest') &&
  (v.type !== 'loading-ready' && v.type !== 'start-ready' || v.sender === 'guest') &&
  (v.type !== 'command' || v.slot === (v.sender === 'host' ? 0 : 1)) &&
  (v.type !== 'barrier' && v.type !== 'start-offer' || v.nextEpoch === v.epoch + 1));
export type WireMessage = z.infer<typeof wireMessage>;
export type MessageBody = {
  [K in Exclude<WireMessage['type'], 'hello'>]: Omit<Extract<WireMessage, { type: K }>,
    'version' | 'sessionId' | 'epoch' | 'sender' | 'sequence'>;
}[Exclude<WireMessage['type'], 'hello'>];

export const HOST_ONLY = new Set<WireMessage['type']>([
  'ack', 'event', 'snapshot', 'transfer-offer', 'transfer-chunk', 'plan-commit', 'checkpoint-commit', 'barrier',
  'lobby-state',
  'course-manifest',
  'start-offer', 'start-commit', 'start-cancel',
]);
export function messageChannel(message: WireMessage): 'control' | 'state' {
  return message.type === 'snapshot' || message.type === 'ping' || message.type === 'pong' ? 'state' : 'control';
}
