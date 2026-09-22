import type { ProtocolErrorCode } from '../../shared/protocol/codec.js';
import type { Channel, Role } from '../../shared/protocol/limits.js';
import type { WireMessage } from '../../shared/protocol/messages.js';

export type TransportStatus = 'open' | 'disconnected' | 'closed';
export type SendResult = { ok: true } | { ok: false; reason: 'not_open' | 'backpressure' };
export type TransportEvent =
  | { type: 'message'; channel: Channel; message: WireMessage; receivedAt: number }
  | { type: 'rejected'; channel: Channel; code: ProtocolErrorCode }
  | { type: 'status'; status: TransportStatus; epoch: number };

export interface PeerTransport {
  readonly role: Role;
  readonly status: TransportStatus;
  now(): number;
  bufferedAmount(channel: Channel): number;
  send(message: WireMessage): SendResult;
  drain(): TransportEvent[];
  close(): void;
}
