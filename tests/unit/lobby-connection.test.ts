import { afterEach, describe, expect, it, vi } from 'vitest';
import { LobbyConnection } from '../../src/network/lobby-connection.js';
import { DEFAULT_SETTINGS } from '../../src/storage/records.js';
import { versions } from './protocol-fixtures.js';
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

describe('connection preparation ownership', () => {
  it('does not report an obsolete asynchronous failure after intentional closure', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let reject!: (reason: Error) => void;
    const author = () => new Promise<[Transfer, Transfer]>((_resolve, fail) => { reject = fail; });
    const link = { status: 'open' as const, failure: null,
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
    const sent: MessageBody[] = [], author = vi.fn(async (_terrain: string, _seed: number, revision: number): Promise<[Transfer, Transfer]> =>
      [transfer(revision, 0), transfer(revision, 1)]);
    const link = { status: 'open' as const, failure: null,
      send(message: MessageBody) { sent.push(message); return { ok: true as const }; },
      drain: (): TransportEvent[] => [], close() {},
      diagnostics: async () => ({ status: 'open' as const, failure: null, peer: null }),
    };
    const connection = new LobbyConnection(link, DEFAULT_SETTINGS, versions, 7, 'host', author); connections.push(connection);
    await vi.advanceTimersByTimeAsync(20);
    expect((await connection.report()).course).toMatchObject({ revision: 0, terrain: 'green-valley' });
    let release!: (value: [Transfer, Transfer]) => void;
    author.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    connection.lobby.setTerrain('river-canyon'); await vi.advanceTimersByTimeAsync(20);
    connection.lobby.setTerrain('green-valley'); release([transfer(1, 0), transfer(1, 1)]);
    await vi.advanceTimersByTimeAsync(40);
    expect(author).toHaveBeenCalledTimes(3);
    expect((await connection.report()).course).toMatchObject({ revision: 2, terrain: 'green-valley', verified: false });
    expect(sent.filter(message => message.type === 'course-manifest').map(message => message.revision)).toEqual([0, 2]);
    connection.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it('never lets a course manifest overtake a backpressured lobby state and expires the blocked setup', async () => {
    vi.useFakeTimers();
    const author = vi.fn(async (): Promise<[Transfer, Transfer]> => [transfer(0, 0), transfer(0, 1)]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const close = vi.fn();
    const link = { status: 'open' as const, failure: null,
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
