import type { z } from 'zod';
import { payload } from './game.js';
import type { Compatibility, Payload } from './game.js';
import { MAX_TRANSFER_BYTES, MAX_WIRE_BYTES } from './limits.js';
import type { Channel, Role } from './limits.js';
import { HOST_ONLY, messageChannel, wireMessage } from './messages.js';
import type { WireMessage } from './messages.js';

export type ProtocolErrorCode = 'oversized' | 'invalid_json' | 'invalid_message' | 'channel' | 'role' | 'session' | 'epoch' | 'compatibility';
export class ProtocolError extends Error {
  constructor(readonly code: ProtocolErrorCode) { super(`Multiplayer protocol rejected: ${code}.`); }
}
export interface ReceiveContext { sessionId: string; epoch: number; peer: Role; channel: Channel }
export const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProtocolError('invalid_message');
  return result.data;
}
function stringify<T>(schema: z.ZodType<T>, value: unknown, maximum: number): string {
  const text = JSON.stringify(parse(schema, value));
  if (byteLength(text) > maximum) throw new ProtocolError('oversized');
  return text;
}
function read<T>(schema: z.ZodType<T>, text: string, maximum: number): T {
  if (typeof text !== 'string') throw new ProtocolError('invalid_json');
  if (text.length > maximum || byteLength(text) > maximum) throw new ProtocolError('oversized');
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new ProtocolError('invalid_json'); }
  return parse(schema, data);
}
function authority(message: WireMessage): void {
  if (HOST_ONLY.has(message.type) && message.sender !== 'host') throw new ProtocolError('role');
}
export function encodeMessage(value: unknown): string {
  const message = parse(wireMessage, value);
  authority(message);
  return stringify(wireMessage, message, MAX_WIRE_BYTES);
}
export function decodeMessage(text: string, context: ReceiveContext): WireMessage {
  const message = read(wireMessage, text, MAX_WIRE_BYTES);
  if (message.sessionId !== context.sessionId) throw new ProtocolError('session');
  if (message.epoch !== context.epoch) throw new ProtocolError('epoch');
  if (message.sender !== context.peer) throw new ProtocolError('role');
  authority(message);
  if (messageChannel(message) !== context.channel) throw new ProtocolError('channel');
  return message;
}
export function encodePayload(value: unknown): string { return stringify(payload, value, MAX_TRANSFER_BYTES); }
export function decodePayload(text: string): Payload { return read(payload, text, MAX_TRANSFER_BYTES); }
export function assertCompatible(local: Compatibility, remote: Compatibility): void {
  for (const key of ['protocol', 'build', 'assets', 'rules', 'generator', 'formationProfile', 'physicsHz'] as const) {
    if (local[key] !== remote[key]) throw new ProtocolError('compatibility');
  }
}
