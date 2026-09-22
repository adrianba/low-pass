import { afterEach, describe, expect, it, vi } from 'vitest';
import { LobbyConnection } from '../../src/network/lobby-connection.js';
import type { MatchLink, PreparedConnection } from '../../src/network/lobby-connection.js';
import { prepareHostCourse } from '../../src/network/prepared-course.js';
import type { PreparedHostCourse } from '../../src/network/prepared-course.js';
import { formationData } from '../../src/network/formation-data.js';
import { DEFAULT_SETTINGS } from '../../src/storage/records.js';
import { RELEASE_GRACE_SECONDS } from '../../src/network/release-authority.js';
import type { TransportEvent } from '../../src/network/transport.js';
import { messageChannel } from '../../shared/protocol/messages.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import { base, versions } from './protocol-fixtures.js';

class Link implements MatchLink {
  status: 'open' | 'closed' = 'open';
  readonly sessionId = base.sessionId;
  readonly failure = null;
  epoch = 0;
  private sequence = 1;
  private inbox: TransportEvent[] = [];
  other!: Link;
  beforeSend?: (body: MessageBody) => void;
  constructor(private readonly role: 'host' | 'guest') {}
  send(body: MessageBody) {
    if (this.status !== 'open') return { ok: false as const, reason: 'not_open' as const };
    this.beforeSend?.(body);
    const message: WireMessage = { ...base, sender: this.role, epoch: this.epoch, sequence: this.sequence++, ...structuredClone(body) };
    this.other.inbox.push({ type: 'message', channel: messageChannel(message), message, receivedAt: performance.now() });
    if (body.type === 'barrier') this.epoch = this.other.epoch = body.nextEpoch;
    return { ok: true as const };
  }
  drain() { return this.inbox.splice(0); }
  async diagnostics() { return { status: this.status, failure: null, peer: null }; }
  close = vi.fn(() => { this.status = 'closed'; });
}
const connections: LobbyConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  vi.useRealTimers(); vi.restoreAllMocks();
});
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 200; index++) {
    if (await predicate()) return;
    await vi.advanceTimersByTimeAsync(50);
  }
  throw new Error('Prepared connection did not reach the expected state.');
}
async function pair(onHost?: (prepared: PreparedConnection) => void) {
  vi.useFakeTimers();
  const hostLink = new Link('host'), guestLink = new Link('guest');
  hostLink.other = guestLink; guestLink.other = hostLink;
  const owners: PreparedConnection[] = [];
  let authored: PreparedHostCourse | null = null;
  const author = vi.fn(async (...args: Parameters<typeof prepareHostCourse>) => {
    authored = await prepareHostCourse(...args); return authored;
  });
  const host = new LobbyConnection(hostLink, DEFAULT_SETTINGS, versions, 7, 'host', author,
    prepared => { owners.push(prepared); onHost?.(prepared); });
  const guest = new LobbyConnection(guestLink, DEFAULT_SETTINGS, versions, 7, 'guest', undefined,
    prepared => { owners.push(prepared); });
  connections.push(host, guest);
  await until(() => host.lobby.canReady && guest.lobby.canReady);
  return { host, guest, hostLink, guestLink, owners, author, authored: () => authored };
}

describe('prepared course ownership', () => {
  it('transfers the original scheduler, verified guest bytes, and unread startup messages exactly once', async () => {
    const state = await pair(prepared => {
      prepared.link.send({ type: 'barrier', nextEpoch: 1, reason: 'resume', at: { tick: 0, fraction: 0 } });
      prepared.link.send({ type: 'ping', id: 7, sentAt: performance.now() });
    });
    state.host.lobby.setReady(true); state.guest.lobby.setReady(true);
    await until(() => state.owners.length === 2);
    const host = state.owners.find(owner => owner.role === 'host')!, guest = state.owners.find(owner => owner.role === 'guest')!;
    expect(host.authored).toBe(state.authored());
    expect(host.authored.scheduler.session.releaseGraceSeconds).toBe(RELEASE_GRACE_SECONDS);
    expect(host.authored.scheduler.session.time).toBe(0);
    expect(state.author).toHaveBeenCalledOnce();
    expect(guest.course).toEqual(host.course);
    expect(guest.epoch).toBe(0); expect(guest.link.epoch).toBe(1);
    expect(guest.inbox.filter(event => event.type === 'message').map(event => event.message.type)).toEqual(['barrier', 'ping']);
    for (let index = 0; index < 2; index++) {
      expect(guest.formations[index]!.reference).toEqual(host.course.plans[index]);
      expect(guest.formations[index]!.payload).toEqual({ kind: 'formation',
        data: JSON.parse(JSON.stringify(formationData(host.authored.scheduler.plan(index), index))) });
    }
    state.host.close(); state.guest.close();
    await vi.advanceTimersByTimeAsync(200);
    expect(state.owners).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
    expect(state.hostLink.close).not.toHaveBeenCalled(); expect(state.guestLink.close).not.toHaveBeenCalled();
    host.link.close(); guest.link.close();
  });

  it('preserves a late unready intent for controller revalidation instead of treating handoff as permission to start', async () => {
    const state = await pair();
    state.guest.lobby.setReady(true);
    await until(() => state.host.lobby.state!.ready[1] && !state.guest.lobby.waiting);
    state.hostLink.beforeSend = body => {
      if (body.type === 'lobby-state' && body.state.ready.every(Boolean)) {
        state.hostLink.beforeSend = undefined;
        state.guest.lobby.setReady(false);
      }
    };
    state.host.lobby.setReady(true);
    await until(() => state.owners.length === 2);
    const guest = state.owners.find(owner => owner.role === 'guest')!;
    expect(guest.lobby.bothReady).toBe(false);
    expect(guest.lobby.waiting).toBe(true);
    expect(state.hostLink.drain()).toContainEqual(expect.objectContaining({
      type: 'message', message: expect.objectContaining({ type: 'lobby-input',
        input: expect.objectContaining({ choice: { action: 'ready', enabled: false } }) }),
    }));
    expect(state.hostLink.close).not.toHaveBeenCalled(); expect(state.guestLink.close).not.toHaveBeenCalled();
  });

  it('closes and reports a failed new owner without logging arbitrary callback contents', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = await pair(() => { throw new Error('private callback contents'); });
    state.host.lobby.setReady(true); state.guest.lobby.setReady(true);
    await until(async () => (await state.host.report()).error !== null);
    expect((await state.host.report()).error).toBe('controller_handoff_failed');
    expect(state.hostLink.close).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith('Private match controller handoff failed.');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('private callback contents');
  });
});
