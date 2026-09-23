import { afterEach, describe, expect, it, vi } from 'vitest';
import { LobbyConnection } from '../../src/network/lobby-connection.js';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler.js';
import type { PreparedHostCourse } from '../../src/network/prepared-course.js';
import { DEFAULT_SETTINGS } from '../../src/storage/records.js';
import { base, versions } from './protocol-fixtures.js';
import type { MessageBody } from '../../shared/protocol/messages.js';
import type { TransportEvent } from '../../src/network/transport.js';
import type { createTransfer } from '../../src/network/transfer.js';

type Transfer = Awaited<ReturnType<typeof createTransfer>>;
const connections: LobbyConnection[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); vi.useRealTimers(); vi.restoreAllMocks(); });
const transfer = (revision: number, index: number): Transfer => ({
  offer: { id: `course-${revision}-${index}`, digest: 'a'.repeat(64), kind: 'formation', bytes: 1, chunks: 1 },
  chunks: [{ transferId: `course-${revision}-${index}`, index: 0, data: 'QQ==' }],
});
const authored = (revision = 0): PreparedHostCourse => ({
  scheduler: new FormationScheduler('green-valley', 7),
  transfers: [transfer(revision, 0), transfer(revision, 1)],
});

describe('connection preparation ownership', () => {
  it('adopts the unread new-epoch inbox and requires fresh lobby readiness after a rematch', async () => {
    vi.useFakeTimers();
    const host = new LobbyConnection({
      status: 'open', failure: null, epoch: 8, sessionId: base.sessionId,
      send: () => ({ ok: true }), drain: () => [], close() {},
      diagnostics: async () => ({ status: 'open' as const, failure: null, peer: null }),
    }, DEFAULT_SETTINGS, versions, 7, 'host', async () => authored());
    connections.push(host);
    const state = host.lobby.state!;
    const received: TransportEvent[] = [{ type: 'message', receivedAt: performance.now(), channel: 'control',
      message: { ...base, epoch: 8, type: 'lobby-state', state } }];
    const connection = new LobbyConnection({
      status: 'open', failure: null, epoch: 8, sessionId: base.sessionId,
      send: () => ({ ok: true }), drain: () => [], close() {},
      diagnostics: async () => ({ status: 'open' as const, failure: null, peer: null }),
    }, DEFAULT_SETTINGS, versions, 7, 'guest', undefined, undefined, received);
    connections.push(connection);
    await vi.advanceTimersByTimeAsync(20);
    expect(connection.lobby.state?.ready).toEqual([false, false]);
    expect(connection.lobby.state?.terrain).toBe('green-valley');
    expect(connection.lobby.canReady).toBe(false);
    expect((await connection.report()).error).toBeNull();
  });
  it('does not report an obsolete asynchronous failure after intentional closure', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let reject!: (reason: Error) => void;
    const author = () => new Promise<PreparedHostCourse>((_resolve, fail) => { reject = fail; });
    const link = { status: 'open' as const, failure: null, epoch: 0, sessionId: base.sessionId,
      send: () => ({ ok: true as const }), drain: (): TransportEvent[] => [], close() {},
      diagnostics: async () => ({ status: 'open' as const, failure: null, peer: null }),
    };
    const connection = new LobbyConnection(link, DEFAULT_SETTINGS, versions, 7, 'host', author); connections.push(connection);
    await vi.advanceTimersByTimeAsync(20);
    connection.close(); reject(new Error('Canceled work'));
    await vi.advanceTimersByTimeAsync(20);
    expect((await connection.report()).error).toBeNull();
    expect(error).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('reauthors the original terrain when an intervening asynchronous preparation was canceled', async () => {
    vi.useFakeTimers();
    const sent: MessageBody[] = [], author = vi.fn(async (_terrain: string, _seed: number, revision: number) => authored(revision));
    const link = { status: 'open' as const, failure: null, epoch: 0, sessionId: base.sessionId,
      send(message: MessageBody) { sent.push(message); return { ok: true as const }; },
      drain: (): TransportEvent[] => [], close() {},
      diagnostics: async () => ({ status: 'open' as const, failure: null, peer: null }),
    };
    const connection = new LobbyConnection(link, DEFAULT_SETTINGS, versions, 7, 'host', author); connections.push(connection);
    await vi.advanceTimersByTimeAsync(20);
    expect((await connection.report()).course).toMatchObject({ revision: 0, terrain: 'green-valley' });
    let release!: (value: PreparedHostCourse) => void;
    author.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    connection.lobby.setTerrain('river-canyon'); await vi.advanceTimersByTimeAsync(20);
    connection.lobby.setTerrain('green-valley'); release(authored(1));
    await vi.advanceTimersByTimeAsync(40);
    expect(author).toHaveBeenCalledTimes(3);
    expect((await connection.report()).course).toMatchObject({ revision: 2, terrain: 'green-valley', verified: false });
    expect(sent.filter(message => message.type === 'course-manifest').map(message => message.revision)).toEqual([0, 2]);
    connection.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it('never lets a course manifest overtake a backpressured lobby state and expires the blocked setup', async () => {
    vi.useFakeTimers();
    const author = vi.fn(async () => authored());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const close = vi.fn();
    const link = { status: 'open' as const, failure: null, epoch: 0, sessionId: base.sessionId,
      send: () => ({ ok: false as const, reason: 'backpressure' as const }),
      drain: (): TransportEvent[] => [], close,
      diagnostics: async () => ({ status: 'open' as const, failure: null, peer: null }),
    };
    const connection = new LobbyConnection(link, DEFAULT_SETTINGS, versions, 7, 'host', author); connections.push(connection);
    await vi.advanceTimersByTimeAsync(40);
    expect(author).not.toHaveBeenCalled(); expect((await connection.report()).course).toBeNull();
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await connection.report()).error).toBe('course_expired');
    expect(close).toHaveBeenCalledOnce(); expect(error).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
