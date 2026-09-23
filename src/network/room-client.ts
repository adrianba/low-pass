import { z } from 'zod';
import { admissionRequest, capability, createdRoom, hostAuthorization, hostRequest, invitationRequest,
  roomCapabilities, roomInvitation, roomMembership, roomStatus } from '../../shared/protocol/rooms.js';
import { iceConfiguration } from '../../shared/protocol/ice.js';

export const ROOM_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const messages = {
  invalid_hosting_code: 'The hosting access code was not accepted. It is separate from a room invitation.',
  invalid_invitation: 'That invitation is invalid or no longer available. Ask the host for a new one.',
  invitation_expired: 'That invitation has expired. Ask the host for a new one.',
  room_full: 'This room already has its second player.',
  admission_denied: 'The host declined this join request.',
  admission_expired: 'The host did not admit you in time. Ask for a new invitation.',
  invitation_revoked: 'The host replaced the invitation. Ask for the new one.',
  invalid_capability: 'This room session is no longer valid. Create or join a new room.',
  room_closed: 'The other player left or the host closed this room.',
  room_expired: 'This room has expired. Create or join a new room.',
  room_expiring: 'This room is about to expire. Create or join a new room.',
  service_stopped: 'The room service stopped. Create or join again when it is available.',
  stale_admission: 'That join request is no longer pending. Refresh the room.',
  rate_limited: 'Too many requests. Wait a minute before trying again.',
  capacity: 'The room service is at capacity. Try again later.',
  rate_limit_capacity: 'The room service is busy. Try again later.',
  rooms_unavailable: 'Private rooms are unavailable. Solo play is unaffected.',
  origin_rejected: 'The service rejected this game origin. The operator must check its configuration.',
  invalid_proxy_chain: 'The service could not verify its proxy configuration. Contact the operator.',
  host_required: 'Only the host can perform that action.',
  admission_required: 'Both players must be admitted before connecting.',
  turn_unavailable: 'Relay credentials are unavailable. Contact the operator.',
  turn_clock_error: 'The relay credential service detected a clock problem. Contact the operator.',
  invalid_request: 'Check the entered code and try again.',
  invalid_response: 'The room service returned an invalid response. No connection was established.',
  network: 'The room service could not be reached. Check your connection and try again.',
  timeout: 'The room request timed out. Its outcome may be unknown; do not repeatedly create rooms.',
  creation_unknown: 'Room creation could not be confirmed. A room may remain open until it expires; wait before trying again.',
  join_unknown: 'Joining could not be confirmed. Ask the host to cancel the pending invitation or close the room before trying again.',
  cancelled: 'The room request was canceled.',
  service_error: 'The room service could not complete the request. Try again later.',
  busy: 'Another room operation is still running.',
  unexpected: 'Room controls failed unexpectedly. Return to the menu and try again.',
} as const;
export type RoomClientErrorCode = keyof typeof messages;
export class RoomClientError extends Error {
  constructor(readonly code: RoomClientErrorCode) { super(messages[code]); }
}
export function roomClientError(error: unknown): RoomClientError {
  if (error instanceof RoomClientError) return error;
  console.error('Room controls failed unexpectedly; request details withheld.');
  return new RoomClientError('unexpected');
}
export function roomEnded(error: unknown): boolean {
  return error instanceof RoomClientError && ['invalid_capability', 'room_closed', 'room_expired', 'service_stopped',
    'admission_denied', 'admission_expired', 'invitation_revoked'].includes(error.code);
}

async function json(response: Response): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
    throw new RoomClientError('invalid_response');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel(); throw new RoomClientError('invalid_response');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RoomClientError('invalid_response'); }
}

/** Same-origin, memory-only credentials; no automatic retries of mutating requests. */
export class RoomClient {
  constructor(private readonly request: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  private async send<T>(path: string, schema: z.ZodType<T>, body?: unknown, credential?: string, signal?: AbortSignal): Promise<T> {
    if (credential !== undefined && !capability.safeParse(credential).success) throw new RoomClientError('invalid_capability');
    const controller = new AbortController();
    const abort = () => controller.abort(new RoomClientError('cancelled'));
    const timeout = setTimeout(() => controller.abort(new RoomClientError('timeout')), ROOM_REQUEST_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      controller.signal.throwIfAborted();
      const response = await this.request('/api/multiplayer/' + path, {
        method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
        keepalive: path === 'room/leave',
      });
      const value: unknown = response.status === 204 ? null : await json(response);
      if (!response.ok) {
        const parsed = z.strictObject({ error: z.string().max(64) }).safeParse(value);
        const code = parsed.success && Object.hasOwn(messages, parsed.data.error)
          ? parsed.data.error as RoomClientErrorCode : 'service_error';
        throw new RoomClientError(code);
      }
      const result = schema.safeParse(value);
      if (!result.success) throw new RoomClientError('invalid_response');
      return result.data;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof RoomClientError) throw error;
      throw new RoomClientError('network');
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort); controller.abort();
    }
  }
  capabilities(signal?: AbortSignal) { return this.send('capabilities', roomCapabilities, undefined, undefined, signal); }
  authorize(accessCode: string) {
    const parsed = hostRequest.safeParse({ accessCode });
    if (!parsed.success) return Promise.reject(new RoomClientError('invalid_request'));
    return this.send('host-authorizations', hostAuthorization, parsed.data);
  }
  async create(credential: string) {
    try { return await this.send('rooms', createdRoom, {}, credential); }
    catch (error) {
      if (error instanceof RoomClientError && ['network', 'timeout', 'invalid_response', 'service_error'].includes(error.code)) {
        throw new RoomClientError('creation_unknown');
      }
      throw error;
    }
  }
  async join(invitation: string) {
    const parsed = invitationRequest.safeParse({ invitation });
    if (!parsed.success) throw new RoomClientError('invalid_request');
    try { return await this.send('join', roomMembership, parsed.data); }
    catch (error) {
      if (error instanceof RoomClientError && ['network', 'timeout', 'invalid_response', 'service_error'].includes(error.code)) {
        throw new RoomClientError('join_unknown');
      }
      throw error;
    }
  }
  status(credential: string, signal?: AbortSignal) { return this.send('room/status', roomStatus, {}, credential, signal); }
  admit(credential: string, participantId: string, admit: boolean) {
    const parsed = admissionRequest.safeParse({ participantId, admit });
    if (!parsed.success) return Promise.reject(new RoomClientError('invalid_request'));
    return this.send('room/admission', roomStatus, parsed.data, credential);
  }
  invitation(credential: string) { return this.send('room/invitation', roomInvitation, {}, credential); }
  leave(credential: string) { return this.send('room/leave', z.null(), {}, credential); }
  ice(credential: string, signal?: AbortSignal) { return this.send('room/ice', iceConfiguration, {}, credential, signal); }
}
