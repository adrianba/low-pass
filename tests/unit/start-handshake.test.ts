import { describe, expect, it } from 'vitest';
import { encodeMessage } from '../../shared/protocol/codec.js';
import { secondsAt } from '../../shared/protocol/game.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import { StartHandshake, START_LIMITS } from '../../src/network/start-handshake.js';
import { SessionClock } from '../../src/network/session-clock.js';
import { base } from './protocol-fixtures.js';

type Incoming = Parameters<StartHandshake['receive']>[0];
function setup(purpose: 'resume' | 'rematch' = 'resume') {
  const wall = { time: 0, clock: true };
  const host = new StartHandshake('host', base.sessionId, 7, { tick: 0, fraction: 0 }, () => wall.time, () => null, purpose);
  const guest = new StartHandshake('guest', base.sessionId, 7, { tick: 0, fraction: 0 }, () => wall.time + 80_000,
    () => wall.clock ? { lower: wall.time - 10, upper: wall.time + 10 } : null, purpose);
  const incoming: { host: Incoming[]; guest: Incoming[] } = { host: [], guest: [] };
  const sent: WireMessage[] = [];
  let sequence = 1;
  const sender = (role: 'host' | 'guest') => (body: MessageBody) => {
    const message = { ...base, epoch: 7, sequence: sequence++, sender: role, ...body };
    encodeMessage(message);
    if (message.type !== 'loading-ready' && message.type !== 'start-offer' && message.type !== 'start-ready' &&
      message.type !== 'start-commit' && message.type !== 'start-cancel' && message.type !== 'barrier') throw new Error('Unexpected startup output.');
    sent.push(message); incoming[role === 'host' ? 'guest' : 'host'].push(message); return { ok: true as const };
  };
  const drain = (role: 'host' | 'guest') => {
    for (const message of incoming[role].splice(0)) (role === 'host' ? host : guest).receive(message);
  };
  const pump = (role: 'host' | 'guest') => (role === 'host' ? host : guest).pump(sender(role));
  const round = () => { pump('guest'); drain('host'); pump('host'); drain('guest'); pump('guest'); drain('host'); pump('host'); drain('guest'); };
  return { wall, host, guest, incoming, sent, sender, pump, drain, round };
}

describe('acknowledged match startup', () => {
  it('uses an independently acknowledged rematch barrier and rejects a resume barrier in its place', () => {
    const state = setup('rematch');
    state.host.setReady(true, 7); state.round();
    expect(state.host.phase).toBe('waiting');
    state.guest.setReady(true, 7); state.round();
    state.wall.time = 2000; state.guest.setReady(false, 7); state.round();
    expect(state.host.phase).toBe('waiting');
    state.wall.time = 4000; state.guest.setReady(true, 7); state.round();
    state.wall.time = 7000; state.pump('host');
    const barrier = state.sent.find(message => message.type === 'barrier')!;
    expect(barrier).toMatchObject({ reason: 'rematch', epoch: 7, nextEpoch: 8, at: { tick: 0, fraction: 0 } });
    expect(() => state.guest.receive({ ...barrier, type: 'barrier', nextEpoch: 8, at: { tick: 0, fraction: 0 }, reason: 'resume' }))
      .toThrow('acknowledged countdown');
    state.drain('guest');
    expect(state.host.takeStart()?.epoch).toBe(8); expect(state.guest.takeStart()?.epoch).toBe(8);
    expect(() => encodeMessage({ ...base, sender: 'guest', type: 'rematch-state', update: 0, ready: [false, false] })).toThrow('role');
  });
  it('waits for both loaded revisions and an acknowledged countdown, independent of local clock offsets', () => {
    const state = setup();
    const clock = new SessionClock(() => state.wall.time, 0, 7);
    state.host.setReady(true, 2); state.round();
    expect(state.host.phase).toBe('waiting'); expect(state.host.takeStart()).toBeNull();
    state.guest.setReady(true, 1); state.round();
    expect(state.host.phase).toBe('waiting');
    state.guest.setReady(true, 2); state.round();
    expect(state.host.phase).toBe('countdown'); expect(state.guest.phase).toBe('countdown');
    expect(state.host.remainingMs).toBe(3000); expect(state.guest.remainingMs).toBe(3000);
    state.wall.time = 2999; state.round();
    state.guest.receive(state.sent.find(message => message.type === 'start-offer')!);
    expect(state.guest.phase).toBe('countdown');
    expect(state.host.takeStart()).toBeNull(); expect(state.guest.takeStart()).toBeNull();
    state.wall.time = 3020; state.round();
    const start = state.host.takeStart()!;
    expect(start).toEqual({ epoch: 8, at: { tick: 0, fraction: 0 }, hostStartsAt: 3000, requiresPause: false });
    expect(state.guest.takeStart()).toEqual(start);
    expect(secondsAt(clock.start(start.epoch, start.hostStartsAt).at)).toBeCloseTo(0.02, 12);
    expect(state.host.takeStart()).toBeNull(); expect(state.guest.takeStart()).toBeNull();
    expect(state.sent.filter(message => message.type === 'barrier')).toHaveLength(1);
  });

  it('declines an unsynchronized offer and retries with a fresh countdown after clock readiness', () => {
    const state = setup(); state.wall.clock = false;
    state.host.setReady(true, 0); state.guest.setReady(true, 0); state.round();
    expect(state.host.phase).toBe('waiting'); expect(state.guest.phase).toBe('waiting');
    expect(state.sent).toContainEqual(expect.objectContaining({ type: 'start-ready', ready: false }));
    state.wall.clock = true; state.wall.time = START_LIMITS.retryMs; state.round();
    expect(state.host.phase).toBe('countdown'); expect(state.guest.phase).toBe('countdown');
    const offers = state.sent.filter(message => message.type === 'start-offer');
    expect(offers.map(offer => offer.attempt)).toEqual([1, 2]);
    expect(offers[1]!.startsAt).toBe(4000);
  });

  it('cancels on late readiness or revision changes without starting either clock', () => {
    const state = setup();
    state.host.setReady(true, 0); state.guest.setReady(true, 0); state.round();
    state.wall.time = 2000; state.guest.setReady(false, 1); state.round();
    expect(state.host.phase).toBe('waiting'); expect(state.guest.phase).toBe('waiting');
    state.wall.time = 4000; state.round();
    expect(state.host.takeStart()).toBeNull(); expect(state.guest.takeStart()).toBeNull();
    expect(state.sent.filter(message => message.type === 'barrier')).toHaveLength(0);
    state.host.setReady(true, 1); state.guest.setReady(true, 1); state.round();
    expect(state.guest.phase).toBe('countdown');
  });

  it('requires a fresh offer after delayed confirmation, a stalled send, or an overslept deadline', () => {
    const late = setup();
    late.host.setReady(true, 0); late.guest.setReady(true, 0);
    late.pump('guest'); late.drain('host'); late.pump('host'); late.drain('guest');
    late.wall.time = 2600; late.pump('guest'); late.drain('host');
    expect(late.host.phase).toBe('waiting');
    expect(late.sent).toContainEqual(expect.objectContaining({ type: 'start-ready', ready: false }));

    const blocked = setup();
    blocked.host.setReady(true, 0); blocked.guest.setReady(true, 0); blocked.round();
    blocked.wall.time = 3000;
    expect(blocked.host.pump(() => ({ ok: false, reason: 'backpressure' }))).toEqual({ ok: false, reason: 'backpressure' });
    expect(blocked.host.phase).toBe('waiting'); expect(blocked.host.takeStart()).toBeNull();
    blocked.round(); expect(blocked.guest.phase).toBe('waiting');

    const slept = setup();
    slept.host.setReady(true, 0); slept.guest.setReady(true, 0); slept.round();
    slept.wall.time = 3101; slept.round();
    expect(slept.host.phase).toBe('waiting'); expect(slept.host.takeStart()).toBeNull();
  });

  it('marks a barrier arriving after local readiness loss for immediate shared pause, not active play', () => {
    const state = setup();
    state.host.setReady(true, 0); state.guest.setReady(true, 0);
    state.pump('guest'); state.drain('host'); state.pump('host'); state.drain('guest');
    state.pump('guest'); state.drain('host'); state.pump('host');
    state.guest.setReady(false, 0);
    state.drain('guest');
    state.wall.time = 3000; state.pump('host'); state.drain('guest');
    expect(state.host.takeStart()!.requiresPause).toBe(false);
    expect(state.guest.takeStart()!.requiresPause).toBe(true);
  });

  it('refuses unsolicited commits, conflicting offers, role spoofing and invalid scheduled clock starts', () => {
    const state = setup();
    expect(() => state.guest.receive({ ...base, epoch: 7, type: 'start-commit', attempt: 1 })).toThrow('Unknown');
    expect(() => encodeMessage({ ...base, sender: 'guest', type: 'start-offer', attempt: 1, revision: 0,
      startsAt: 3000, nextEpoch: 1, at: { tick: 0, fraction: 0 } })).toThrow('role');
    state.host.setReady(true, 0); state.guest.setReady(true, 0);
    state.pump('guest'); state.drain('host'); state.pump('host'); state.drain('guest');
    const offer = state.sent.find(message => message.type === 'start-offer')!;
    expect(() => state.guest.receive({ ...offer, startsAt: 4000 })).toThrow('cannot change');
    const clock = new SessionClock(() => state.wall.time);
    expect(() => clock.start(1, 1)).toThrow('acknowledged');
    state.host.close(); state.guest.close();
    expect(state.host.pendingCount).toBe(0); expect(state.guest.pendingCount).toBe(0);
    expect(() => state.guest.setReady(true, 0)).toThrow('Invalid');
  });
});
