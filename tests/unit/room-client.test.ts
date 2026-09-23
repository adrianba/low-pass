import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomClient, ROOM_REQUEST_TIMEOUT_MS } from '../../src/network/room-client.js';
import type { RoomView } from '../../shared/protocol/rooms.js';

const credential = 'a'.repeat(43);
const room: RoomView = { roomId: 'r'.repeat(22), participantId: 'h'.repeat(22), role: 'host', state: 'waiting',
  guestId: null, invitationExpiresInMs: 300000, expiresInMs: 900000 };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('typed private room client', () => {
  it('uses same-origin no-store requests without cookie credentials, redirects or credential URLs', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ capability: credential, expiresInMs: 60000 }))
      .mockResolvedValueOnce(Response.json({ capability: credential, room, invitation: 'ABCD-EFGH' }))
      .mockResolvedValueOnce(Response.json({ capability: credential, room: { ...room, role: 'guest' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RoomClient(request);
    await client.authorize('test-hosting-access-code');
    expect((await client.create(credential)).room).toEqual(room);
    await client.join(' abcd-efgh ');
    await client.leave(credential);
    expect(request.mock.calls.map(call => call[0])).toEqual(['/api/multiplayer/host-authorizations',
      '/api/multiplayer/rooms', '/api/multiplayer/join', '/api/multiplayer/room/leave']);
    expect(request.mock.calls[0]![1]).toMatchObject({ body: '{"accessCode":"test-hosting-access-code"}',
      credentials: 'omit', redirect: 'error', cache: 'no-store' });
    expect(request.mock.calls[1]![1]?.headers).toHaveProperty('Authorization', `Bearer ${credential}`);
    expect(request.mock.calls[2]![1]?.body).toBe('{"invitation":"ABCDEFGH"}');
    expect(request.mock.calls[3]![1]?.keepalive).toBe(true);
  });
  it('validates responses and inputs, and never echoes an arbitrary server error or body', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: 'invalid_hosting_code' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ error: 'private-value-from-server' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ capability: credential, room, extra: 'private-value' }))
      .mockResolvedValueOnce(new Response('private-value', { headers: { 'Content-Type': 'text/html' } }));
    const client = new RoomClient(request);
    await expect(client.authorize('wrong')).rejects.toMatchObject({ code: 'invalid_hosting_code' });
    await expect(client.authorize('wrong')).rejects.toMatchObject({ code: 'service_error' });
    await expect(client.status(credential)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(client.status(credential)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(client.join('not-a-code')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.status('private-value')).rejects.toMatchObject({ code: 'invalid_capability' });
    expect(request).toHaveBeenCalledTimes(4);
  });
  it('bounds streamed response bytes and cancels an oversized response', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(16 * 1024 + 1)); }, cancel,
    }), { headers: { 'Content-Type': 'application/json' } });
    const client = new RoomClient(vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(client.capabilities()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('reports uncertain creation without retrying a lost response', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('private request details'));
    await expect(new RoomClient(request).create(credential)).rejects.toMatchObject({ code: 'creation_unknown' });
    expect(request).toHaveBeenCalledOnce();
  });
  it('bounds a stalled response with a timeout and distinguishes deliberate cancellation', async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    const client = new RoomClient(request);
    const timed = expect(client.capabilities()).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(ROOM_REQUEST_TIMEOUT_MS); await timed;
    for (const action of ['status', 'ice'] as const) {
      const abort = new AbortController();
      const cancelled = expect(client[action](credential, abort.signal)).rejects.toMatchObject({ code: 'cancelled' });
      abort.abort(); await cancelled;
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
