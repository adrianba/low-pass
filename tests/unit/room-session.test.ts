import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomSession } from '../../src/network/room-session.js';
import { RoomClientError } from '../../src/network/room-client.js';
import type { RoomView } from '../../shared/protocol/rooms.js';

const credential = 'a'.repeat(43);
const initial: RoomView = { roomId: 'r'.repeat(22), participantId: 'h'.repeat(22), role: 'host', state: 'waiting',
  guestId: null, invitationExpiresInMs: 300000, expiresInMs: 900000 };
const rooms: RoomSession[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { for (const room of rooms.splice(0)) await room.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });
function setup(role: 'host' | 'guest' = 'host') {
  const api = {
    capabilities: vi.fn(async () => ({ multiplayer: false, reason: 'not_implemented' as const, rooms: true })),
    authorize: vi.fn(async () => ({ capability: 'b'.repeat(43), expiresInMs: 60000 })),
    create: vi.fn(async () => ({ capability: credential, room: { ...initial }, invitation: 'ABCD-EFGH' })),
    join: vi.fn(async () => ({ capability: credential, room: { ...initial, role: 'guest' as const, state: 'pending' as const,
      participantId: 'g'.repeat(22), guestId: 'g'.repeat(22) } })),
    status: vi.fn(async () => ({ room: { ...initial } })),
    admit: vi.fn(async () => ({ room: { ...initial, state: 'admitted' as const, guestId: 'g'.repeat(22) } })),
    invitation: vi.fn(async () => ({ room: { ...initial }, invitation: 'JKLM-NPQR' })),
    leave: vi.fn(async () => null),
  };
  const changed = vi.fn(), room = new RoomSession(role, changed, api);
  rooms.push(room); return { api, room, changed };
}

describe('private room membership lifecycle', () => {
  it('gates hosting, admits only the current pending participant and exposes no bearer credentials', async () => {
    const { room, api } = setup();
    await room.create('dummy-hosting-code'); expect(api.authorize).not.toHaveBeenCalled();
    await room.check(); await room.create('dummy-hosting-code');
    expect(room.state.invitation).toBe('ABCD-EFGH');
    expect(JSON.stringify(room.state)).not.toContain(credential);
    room.state.room!.roomId = 'mutated';
    expect(room.state.room!.roomId).toBe(initial.roomId);
    api.status.mockResolvedValueOnce({ room: { ...initial, state: 'pending', guestId: 'g'.repeat(22) } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(room.state.room?.state).toBe('pending');
    await room.admit(true);
    expect(api.admit).toHaveBeenCalledWith(credential, 'g'.repeat(22), true);
    expect(room.state.room?.state).toBe('admitted'); expect(room.state.invitation).toBeNull();
    await room.leave(); expect(api.leave).toHaveBeenCalledWith(credential);
    expect(room.state.room).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it('closes a room returned after canceling an in-flight creation', async () => {
    const { room, api } = setup(); await room.check();
    let release!: (value: Awaited<ReturnType<typeof api.create>>) => void;
    api.create.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const creating = room.create('dummy-hosting-code');
    await vi.advanceTimersByTimeAsync(0);
    const closing = room.leave();
    expect(room.state.closing).toBe(true); expect(room.state.invitation).toBeNull();
    release({ capability: credential, invitation: 'ABCD-EFGH', room: { ...initial } });
    await Promise.all([creating, closing]);
    expect(api.leave).toHaveBeenCalledOnce(); expect(room.state.room).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not create a room if cancellation arrives while authorization is outstanding', async () => {
    const { room, api } = setup(); await room.check();
    let release!: (value: Awaited<ReturnType<typeof api.authorize>>) => void;
    api.authorize.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const creating = room.create('dummy-hosting-code'); await vi.advanceTimersByTimeAsync(0);
    const closing = room.leave(); release({ capability: credential, expiresInMs: 60000 });
    await Promise.all([creating, closing]);
    expect(api.create).not.toHaveBeenCalled(); expect(api.leave).not.toHaveBeenCalled();
  });
  it('ignores a stale poll after admission and stops retrying failed polls automatically', async () => {
    const { room, api } = setup(); await room.check(); await room.create('dummy-hosting-code');
    api.status.mockResolvedValueOnce({ room: { ...initial, state: 'pending', guestId: 'g'.repeat(22) } });
    await room.refresh();
    let release!: (value: { room: RoomView }) => void;
    api.status.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(2000);
    await room.admit(true); release({ room: { ...initial } });
    await vi.advanceTimersByTimeAsync(0);
    expect(room.state.room?.state).toBe('admitted');
    api.status.mockRejectedValueOnce(new RoomClientError('network'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(room.state.error).toContain('could not be reached');
    const count = api.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000); expect(api.status).toHaveBeenCalledTimes(count);
  });
  it('drops expired membership and reports unconfirmed cleanup instead of pretending success', async () => {
    const { room, api } = setup(); await room.check(); await room.create('dummy-hosting-code');
    api.status.mockRejectedValueOnce(new RoomClientError('room_expired'));
    await room.refresh(); expect(room.state.room).toBeNull(); expect(room.state.error).toContain('expired');
    await room.create('dummy-hosting-code');
    api.leave.mockRejectedValueOnce(new RoomClientError('network'));
    await room.leave();
    expect(room.state.room).toBeNull(); expect(room.state.invitation).toBeNull();
    expect(room.state.error).toContain('closure could not be confirmed');
  });

  it('joins as a guest without hosting privileges and follows admission', async () => {
    const { room, api } = setup('guest'); await room.check();
    await room.create('not-a-host'); expect(api.authorize).not.toHaveBeenCalled();
    await room.join('ABCD-EFGH');
    expect(room.state.room?.state).toBe('pending'); expect(room.state.room?.role).toBe('guest');
    await room.renew(); await room.admit(true);
    expect(api.invitation).not.toHaveBeenCalled(); expect(api.admit).not.toHaveBeenCalled();
    api.status.mockResolvedValueOnce({ room: { ...initial, role: 'guest', state: 'admitted',
      participantId: 'g'.repeat(22), guestId: 'g'.repeat(22) } });
    await room.refresh(); expect(room.state.room?.state).toBe('admitted');
    expect(room.state.error).toBeNull(); expect(room.state.invitation).toBeNull();
  });
  it.each(['admission_denied', 'admission_expired', 'invitation_revoked', 'room_closed'] as const)(
    'clears guest membership after %s', async code => {
      const { room, api } = setup('guest'); await room.check(); await room.join('ABCD-EFGH');
      api.status.mockRejectedValueOnce(new RoomClientError(code));
      await room.refresh(); expect(room.state.room).toBeNull();
      expect(room.state.error).toBe(new RoomClientError(code).message);
      expect(vi.getTimerCount()).toBe(0);
    });
  it('cleans up a successful late join after cancellation', async () => {
    const { room, api } = setup('guest'); await room.check();
    let release!: (value: Awaited<ReturnType<typeof api.join>>) => void;
    api.join.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const joining = room.join('ABCD-EFGH'); await vi.advanceTimersByTimeAsync(0);
    const closing = room.leave();
    release({ capability: credential, room: { ...initial, role: 'guest', state: 'pending',
      participantId: 'g'.repeat(22), guestId: 'g'.repeat(22) } });
    await Promise.all([joining, closing]);
    expect(api.leave).toHaveBeenCalledExactlyOnceWith(credential);
    expect(room.state.room).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
});
