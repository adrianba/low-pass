import { describe, expect, it } from 'vitest';
import { byteLength, encodeMessage } from '../../shared/protocol/codec.js';
import type { WireMessage } from '../../shared/protocol/messages.js';
import { FaultNetwork, HarnessError } from '../helpers/fault-transport';
import type { HarnessOptions } from '../helpers/fault-transport';
import { base, hello, reference, release, snapshot } from './protocol-fixtures';
import { DeliveryBarrier } from '../../src/network/delivery-barrier';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler';
import { secondsAt, stampAt } from '../../shared/protocol/game.js';

const options = (patch: Partial<HarnessOptions> = {}): HarnessOptions => ({
  seed: 42, sessionId: base.sessionId, epoch: 0, maxPackets: 128, maxBufferedBytes: 128 * 1024, maxInbox: 256, ...patch,
});
const ping = (sequence: number): WireMessage => ({ ...base, sequence, type: 'ping', id: sequence, sentAt: sequence });

describe('deterministic fault transport', () => {
  it('reorders disposable state while preserving reliable control head-of-line order', () => {
    const network = new FaultNetwork(options()), host = network.peers.host, guest = network.peers.guest;
    network.setFaults('state', { latencyMs: 100 }); network.setFaults('control', { latencyMs: 100 });
    host.send(ping(1)); host.send({ ...hello(), sequence: 1 });
    network.setFaults('state', { latencyMs: 10 }); network.setFaults('control', { latencyMs: 10 });
    host.send(ping(2)); host.send({ ...hello(), sequence: 2 });
    network.advanceTo(10);
    expect(guest.drain().map(e => e.type === 'message' ? [e.channel, e.message.sequence] : e.type)).toEqual([['state', 2]]);
    network.advanceTo(100);
    expect(guest.drain().map(e => e.type === 'message' ? [e.channel, e.message.sequence] : e.type))
      .toEqual([['state', 1], ['control', 1], ['control', 2]]);
  });

  it('drops unreliable traffic, retries reliable loss and explicitly bounds partitions/backpressure', () => {
    const network = new FaultNetwork(options({ maxPackets: 2 })), host = network.peers.host;
    network.setFaults('control', { loss: 1 }); network.setFaults('state', { loss: 1 });
    expect(host.send(hello()).ok).toBe(true); expect(host.send(ping(1)).ok).toBe(true);
    expect(host.send(hello())).toEqual({ ok: false, reason: 'backpressure' });
    const before = host.bufferedAmount('control');
    network.advanceTo(0);
    expect(network.pendingPackets).toBe(1); expect(network.peers.guest.drain()).toEqual([]);
    expect(host.bufferedAmount('state')).toBe(0); expect(host.bufferedAmount('control')).toBe(before);
    network.setFaults('control', { loss: 0 }); network.partition(true); network.advanceTo(1000);
    expect(network.pendingPackets).toBe(1);
    network.partition(false); network.advanceTo(1100);
    expect(network.peers.guest.drain()).toHaveLength(1); expect(host.bufferedAmount('control')).toBe(0);
    expect(network.stats.retried).toBe(11);
    const bytes = byteLength(encodeMessage(hello()));
    const capped = new FaultNetwork(options({ maxBufferedBytes: bytes }));
    expect(capped.peers.host.send(hello()).ok).toBe(true);
    expect(capped.peers.host.send(hello())).toEqual({ ok: false, reason: 'backpressure' });
  });

  it('reproduces seeded jitter, loss, replay, clock skew and drift exactly without real sleeps', () => {
    function exercise() {
      const network = new FaultNetwork(options({ seed: 73, clocks: {
        host: { offsetMs: 230, driftPpm: 100 }, guest: { offsetMs: -600, driftPpm: -200 },
      } }));
      network.setFaults('state', { latencyMs: 80, jitterMs: 70, loss: 0.3, duplicate: 0.4 });
      network.setFaults('control', { latencyMs: 80, jitterMs: 70, loss: 0.3, duplicate: 0.4 });
      for (let i = 1; i <= 20; i++) { network.peers.host.send(ping(i)); network.peers.host.send({ ...hello(), sequence: i }); }
      network.advanceTo(2000);
      return { received: network.peers.guest.drain(), stats: network.stats, host: network.peers.host.now(), guest: network.peers.guest.now() };
    }
    const a = exercise();
    expect(exercise()).toEqual(a);
    expect(a.host).toBeCloseTo(2230.2, 10); expect(a.guest).toBeCloseTo(1399.6, 10);
    expect(a.stats.lost).toBeGreaterThan(0); expect(a.stats.duplicated).toBeGreaterThan(0);
    const control = a.received.filter(e => e.type === 'message' && e.channel === 'control')
      .map(e => e.type === 'message' ? e.message.sequence : -1);
    expect([...new Set(control)]).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('surfaces malformed peer input and inbox exhaustion and clears disconnected epochs', () => {
    const network = new FaultNetwork(options({ maxInbox: 2 }));
    network.enqueue('host', 'control', '{broken'); network.enqueue('host', 'control', encodeMessage({ ...hello(), epoch: 1 }));
    network.peers.host.send(hello());
    expect(() => network.advanceTo(0)).toThrow(HarnessError);
    expect(network.peers.guest.drain()).toEqual([
      { type: 'rejected', channel: 'control', code: 'invalid_json' }, { type: 'rejected', channel: 'control', code: 'epoch' },
    ]);
    expect(network.pendingPackets).toBe(1);
    network.advanceTo(0); expect(network.peers.guest.drain()).toHaveLength(1);
    network.setFaults('control', { latencyMs: 100 }); network.peers.host.send(hello());
    network.disconnect();
    expect(network.pendingPackets).toBe(0);
    expect(network.peers.host.send(hello())).toEqual({ ok: false, reason: 'not_open' });
    network.reconnect(1);
    expect(() => network.peers.host.send(hello())).toThrow('epoch');
    network.peers.host.send({ ...hello(), epoch: 1 }); network.advanceTo(100);
    expect(network.peers.guest.drain().map(e => e.type)).toEqual(['status', 'message']);
    network.peers.host.close(); network.disconnect();
    expect(network.peers.guest.status).toBe('closed');
    expect(() => network.reconnect(2)).toThrow('Closed');
    expect(() => new FaultNetwork(options({ maxPackets: 0 }))).toThrow();
    expect(() => network.advanceTo(-1)).toThrow();
    expect(() => network.setFaults('state', { retryMs: 0 })).toThrow();
  });

  it('prevents cross-channel snapshots overtaking outcomes or applying plans before their data is ready', () => {
    const network = new FaultNetwork(options()), gate = new DeliveryBarrier(base.sessionId, 0);
    let ready = false;
    const has = () => ready;
    const plan: Extract<WireMessage, { type: 'plan-commit' }> = { ...base, type: 'plan-commit', planRevision: 0, plans: [reference] };
    expect(gate.consider(plan, has)).toEqual({ ok: false, reason: 'missing_plan' });
    ready = true; expect(gate.consider(plan, has).ok).toBe(true);
    network.setFaults('control', { latencyMs: 100, duplicate: 1 });
    const event: WireMessage = { ...base, type: 'event', eventSequence: 1, planRevision: 0,
      event: { action: 'resolved', result: { id: 1, slot: 0, sequence: 0, time: 1, points: 0, score: 0, misses: 1, assisted: false, impact: null } } };
    const state = snapshot(); state.eventSequence = 1; state.players[0].misses = 1;
    network.peers.host.send(event); network.peers.host.send({ ...base, sequence: 2, type: 'snapshot', sampledAt: 0, state });
    network.advanceTo(0);
    const incoming = network.peers.guest.drain()[0]!;
    if (incoming.type !== 'message' || incoming.message.type !== 'snapshot') throw new Error('Missing snapshot.');
    expect(gate.consider(incoming.message, has)).toEqual({ ok: false, reason: 'missing_event' });
    network.advanceTo(100);
    const decisions = network.peers.guest.drain().map(e => {
      if (e.type !== 'message' || e.message.type !== 'event') throw new Error('Missing event.');
      return gate.consider(e.message, has);
    });
    expect(decisions).toEqual([{ ok: true }, { ok: false, reason: 'stale' }]);
    expect(gate.consider(incoming.message, has)).toEqual({ ok: true });
    expect(gate.consider({ ...base, sequence: 3, type: 'snapshot', sampledAt: 0, state: snapshot() }, has)).toEqual({ ok: false, reason: 'stale' });
    expect(gate.watermarks).toEqual({ planRevision: 0, eventSequence: 1, snapshotSequence: 2 });
  });

  it('drives the real local session through a duplicate guest command without a second bomb or result', () => {
    const scheduler = new FormationScheduler('green-valley', 7), plan = scheduler.plan();
    const network = new FaultNetwork(options());
    network.setFaults('control', { latencyMs: 100, duplicate: 1 });
    scheduler.advanceTo(plan.attempts[1].releaseAt);
    const intent = release();
    if (intent.type !== 'command' || intent.command.action !== 'release') throw new Error('Missing intent.');
    intent.command.displayedAt = stampAt(scheduler.session.time);
    network.peers.guest.send(intent); network.advanceTo(100);
    const decisions = network.peers.host.drain().map(event => {
      if (event.type !== 'message' || event.message.type !== 'command' || event.message.command.action !== 'release') throw new Error('Missing release.');
      expect(secondsAt(event.message.command.displayedAt)).toBeCloseTo(scheduler.session.time, 12);
      return scheduler.session.release(event.message.slot, event.message.command.sequence);
    });
    expect(decisions).toEqual([{ ok: true }, { ok: false, reason: 'already_released' }]);
    scheduler.advanceTo(plan.handoffAt);
    const outcomes = scheduler.session.drainEvents().filter(e => e.type === 'resolved').filter(e => e.result.slot === 1);
    expect(outcomes).toHaveLength(1); expect(outcomes[0]!.result.score).toBe(100);
    // The simulation was deliberately held at release time: latency settlement is a later milestone.
  });

  it('bounds pathological retry work and leaves a recoverable queue rather than looping forever', () => {
    const network = new FaultNetwork(options());
    network.setFaults('control', { loss: 1, retryMs: 1 });
    network.peers.host.send(hello());
    network.peers.guest.send({ ...hello(), sender: 'guest' });
    expect(() => network.advanceTo(60_000)).toThrow('work budget');
    expect(network.pendingPackets).toBe(2);
    network.setFaults('control', { loss: 0 });
    network.advanceTo(network.time + 1);
    expect(network.pendingPackets).toBe(0);
  });
});
