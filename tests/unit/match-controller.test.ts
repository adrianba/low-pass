import { afterEach, describe, expect, it, vi } from 'vitest';
import { stampAt, secondsAt } from '../../shared/protocol/game.js';
import { messageChannel } from '../../shared/protocol/messages.js';
import type { MessageBody, WireMessage } from '../../shared/protocol/messages.js';
import { MatchController } from '../../src/network/match-controller.js';
import { Lobby } from '../../src/network/lobby.js';
import { prepareHostCourse } from '../../src/network/prepared-course.js';
import { DEFAULT_SETTINGS } from '../../src/storage/records.js';
import type { TransportEvent } from '../../src/network/transport.js';
import { TransferReceiver } from '../../src/network/transfer.js';
import type { CompletedTransfer } from '../../src/network/transfer.js';
import { base, versions } from './protocol-fixtures.js';

vi.mock('../../src/network/formation-worker-client.js', () => ({
  FormationWorker: class {
    author() { return new Promise<never>(() => {}); }
    close() {}
  },
}));

afterEach(() => vi.restoreAllMocks());

async function host() {
  const authored = await prepareHostCourse('green-valley', 7, 0);
  const ref = (index: 0 | 1) => ({ id: authored.transfers[index].offer.id, digest: authored.transfers[index].offer.digest });
  let wall = 1000;
  const sent: MessageBody[] = [], incoming: TransportEvent[] = [];
  const link = {
    status: 'open' as const, failure: null, epoch: 1, sessionId: base.sessionId,
    send(body: MessageBody) { sent.push(body); return { ok: true as const }; },
    drain: () => incoming.splice(0), close: vi.fn(),
    diagnostics: async () => ({ status: 'open' as const, failure: null, peer: null }),
  };
  const match = new MatchController({
    role: 'host', link, authored, epoch: 0, inbox: [], lobby: new Lobby('host', { ...DEFAULT_SETTINGS, assist: false }),
    course: { type: 'course-manifest', revision: 0,
      manifest: { compatibility: versions, terrain: 'green-valley', seed: 7, grid: 16, triangle: 'shared-diagonal-v1' },
      plans: [ref(0), ref(1)],
    },
  }, (_slot, view, range) => ({ ...view, range, aspect: 1.15 }), () => wall);
  vi.spyOn(match.startup, 'pump').mockReturnValue({ ok: true });
  vi.spyOn(match.startup, 'takeStart').mockReturnValueOnce({ epoch: 1, at: stampAt(0), hostStartsAt: wall, requiresPause: false });
  match.assetsLoaded();
  await match.update();
  const offer = sent.find(message => message.type === 'transfer-offer' && message.transfer.kind === 'checkpoint');
  if (!offer || offer.type !== 'transfer-offer') throw new Error('Missing initial checkpoint.');
  incoming.push({ type: 'message', channel: 'control', receivedAt: wall, message: { ...base, epoch: 1, sender: 'guest', type: 'transfer-ready',
    transfer: { id: offer.transfer.id, digest: offer.transfer.digest } } });
  await match.update();
  await match.update();
  return { match, sent, now: () => wall, elapsed(ms: number) { wall += ms; } };
}

async function paired() {
  const state = await host(), prepared = state.match.prepared;
  if (prepared.role !== 'host') throw new Error('Expected host fixture.');
  const receiver = new TransferReceiver(state.now, { maxTransfers: 2, maxBytes: 32 * 1024 * 1024, ttlMs: 30_000 });
  const formations: CompletedTransfer[] = [];
  for (const transfer of prepared.authored.transfers) {
    receiver.offer(transfer.offer);
    for (const chunk of transfer.chunks) {
      const complete = await receiver.accept(chunk);
      if (complete) formations.push(complete);
    }
  }
  const incoming: TransportEvent[] = [], commands: Array<Extract<WireMessage, { type: 'command' }>> = [];
  let wire = 0, read = 0;
  const deliver = (body: MessageBody) => {
    const message = { ...base, epoch: 1, sequence: ++wire, ...body };
    incoming.push({ type: 'message', channel: messageChannel(message), receivedAt: state.now(), message });
  };
  const lobby = new Lobby('guest', { ...DEFAULT_SETTINGS, assist: false });
  lobby.receiveState(prepared.lobby.state!);
  const guest = new MatchController({ role: 'guest', epoch: 0, inbox: [], lobby, course: prepared.course,
    formations: [formations[0]!, formations[1]!], link: { ...prepared.link,
      send(body) {
        const message = { ...base, epoch: 1, sender: 'guest' as const, sequence: ++wire, ...body };
        if (message.type === 'ping') deliver({ type: 'pong', id: message.id, sentAt: message.sentAt, receivedAt: state.now() });
        else if (message.type === 'transfer-ready') state.match.host!.receive(message);
        else if (message.type === 'command') commands.push(message);
        return { ok: true };
      },
      drain: () => incoming.splice(0),
    },
  }, (_slot, view, range) => ({ ...view, range, aspect: 1.15 }), state.now);
  vi.spyOn(guest.startup, 'pump').mockReturnValue({ ok: true });
  vi.spyOn(guest.startup, 'takeStart').mockReturnValueOnce({
    epoch: 1, at: stampAt(0), hostStartsAt: state.now(), requiresPause: false,
  });
  guest.assetsLoaded(); await guest.update();
  const advance = async (ms = 0) => {
    state.elapsed(ms); await state.match.update();
    for (const body of state.sent.slice(read)) if (body.type !== 'lobby-state') deliver(body);
    read = state.sent.length;
    await guest.update();
    if (guest.phase === 'held' || state.match.phase === 'held') throw new Error(guest.issue ?? state.match.issue ?? 'Unexpected hold.');
  };
  await advance();
  return { ...state, guest, commands, advance, close() { guest.close(); state.match.close(); } };
}

describe('match clock and lifecycle ownership', () => {
  it.each([150, 900])('reconciles a guest drop delayed %ims without adding outcomes or blocking a valid retry', async delay => {
    const state = await paired();
    try {
      for (let work = 0; work < 400 && !state.guest.frame?.ready; work++) await state.advance(50);
      const drawn = state.guest.frame!;
      expect(drawn.ready).toBe(true);
      expect(state.guest.release(drawn)).toBe(true);
      expect(state.guest.frame!.time).toBe(drawn.time);
      expect(state.guest.frame!.aircraft[1].bomb?.age).toBe(0);
      expect(state.guest.frame!.aircraft[0]).toEqual(drawn.aircraft[0]);
      for (let elapsed = 0; elapsed < delay; elapsed += 50) await state.advance(50);
      expect(state.commands).toHaveLength(1);
      expect(state.match.host!.player(1).bomb).toBeNull();
      const predicted = state.guest.frame!;
      state.match.host!.receive(state.commands.shift()!);
      await state.advance();
      expect(state.guest.frame!.time).toBeCloseTo(predicted.time, 10);
      if (delay < 750) {
        expect(state.guest.inputIssue).toBeNull();
        expect(state.guest.frame!.aircraft[1].bomb!.position).toEqual(predicted.aircraft[1].bomb!.position);
      } else {
        expect(state.guest.inputIssue).toContain('too old');
        expect(state.guest.frame!.aircraft[1].bomb).toBeNull();
        expect(state.guest.frame!.aircraft[1].released).toBe(false);
        expect(state.guest.frame!.ready).toBe(true);
        expect(state.guest.release()).toBe(true);
        await state.advance();
        state.match.host!.receive(state.commands.shift()!);
        await state.advance();
        expect(state.guest.inputIssue).toBeNull();
        expect(state.match.host!.player(1).bomb).not.toBeNull();
      }
      expect(state.guest.display!.players[1].score).toBe(0);
      expect(state.guest.frame!.impacts).toEqual([]);
    } finally { state.close(); }
  });
  it.each([false, true])('draws a queued local release and reconciles it when held=%s', async held => {
    const state = await host();
    try {
      const acquire = state.match.host!.scheduler.plan().attempts[0].acquireAt;
      for (let work = 0; work < 400 && state.match.frame!.time < acquire; work++) {
        state.elapsed(50);
        await state.match.update();
      }
      const drawn = state.match.frame!;
      expect(drawn.ready).toBe(true);
      state.elapsed(20);
      const updating = state.match.update();
      expect(state.match.release(drawn)).toBe(true);
      expect(state.match.release(drawn)).toBe(false);
      const predicted = state.match.frame!;
      expect(predicted.time).toBe(drawn.time);
      expect(predicted.aircraft[0].released).toBe(true);
      expect(predicted.aircraft[0].bomb?.age).toBe(0);
      expect(predicted.ready).toBe(false);
      expect(state.match.host!.scheduler.session.snapshot().players[0]!.bomb).toBeNull();
      expect(state.match.display!.players[0].score).toBe(0);
      if (held) state.match.hold('Focus lost.');
      await updating;
      expect(state.match.inputIssue).toBeNull();
      if (held) {
        expect(state.match.phase).toBe('held');
        expect(state.match.frame!.aircraft[0].released).toBe(false);
        expect(state.match.frame!.aircraft[0].bomb).toBeNull();
        expect(state.match.host!.scheduler.session.snapshot().players[0]!.bomb).toBeNull();
      } else expect(state.match.frame!.aircraft[0].bomb).toEqual(state.match.host!.scheduler.session.snapshot().players[0]!.bomb!.value);
      expect(predicted.aircraft[0].bomb!.age).toBe(0);
    } finally { state.match.close(); }
  });
  it('keeps elapsed time across bounded pump steps and stops beyond the freshness bound', async () => {
    const state = await host();
    try {
      state.elapsed(370);
      await state.match.update();
      expect(state.match.phase).toBe('playing');
      expect(state.match.frame!.time).toBeCloseTo(0.37, 10);
      for (const message of state.sent) if (message.type === 'snapshot') {
        expect(message.sampledAt).toBeCloseTo(1000 + secondsAt(message.state.at) * 1000, 9);
      }
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      state.elapsed(501);
      await state.match.update();
      expect(state.match.phase).toBe('held');
      expect(state.match.frame!.time).toBeCloseTo(0.37, 10);
      expect(state.match.issue).toContain('501ms');
      expect(error).toHaveBeenCalledOnce();
    } finally { state.match.close(); }
  });

  it('cannot resume presentation when held during asynchronous publication', async () => {
    const state = await host();
    try {
      state.elapsed(20);
      const update = state.match.update();
      const displayed = state.match.display;
      state.match.hold('Focus lost.');
      await update;
      expect(state.match.phase).toBe('held');
      expect(state.match.issue).toBe('Focus lost.');
      expect(state.match.frame!.time).toBe(0);
      expect(state.match.display).toBe(displayed);
    } finally { state.match.close(); }
  });

  it('keeps instruments with the drawn frame while authoritative state advances asynchronously', async () => {
    const state = await host();
    try {
      const displayed = state.match.display!;
      expect(displayed.frame).toBe(state.match.frame);
      expect(displayed.players[0].assisted).toBe(false);
      state.match.host!.scheduler.session.setAssistance(0, true);
      expect(state.match.display).toBe(displayed);
      expect(displayed.players[0].assisted).toBe(false);
      state.elapsed(20);
      await state.match.update();
      expect(state.match.display!.players[0].assisted).toBe(true);
      expect(state.match.display!.frame.time).toBeCloseTo(0.02);
      expect(displayed.players[0].assisted).toBe(false);
    } finally { state.match.close(); }
  });
});
