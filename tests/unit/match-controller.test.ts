import { afterEach, describe, expect, it, vi } from 'vitest';
import { stampAt, secondsAt } from '../../shared/protocol/game.js';
import type { MessageBody } from '../../shared/protocol/messages.js';
import { MatchController } from '../../src/network/match-controller.js';
import { Lobby } from '../../src/network/lobby.js';
import { prepareHostCourse } from '../../src/network/prepared-course.js';
import { DEFAULT_SETTINGS } from '../../src/storage/records.js';
import type { TransportEvent } from '../../src/network/transport.js';
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
  return { match, sent, elapsed(ms: number) { wall += ms; } };
}

describe('match clock and lifecycle ownership', () => {
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
