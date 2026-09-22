import { describe, expect, it } from 'vitest';
import { assertCompatible, byteLength, decodeMessage, decodePayload, encodeMessage, encodePayload, ProtocolError } from '../../shared/protocol/codec.js';
import { MAX_TRANSFER_BYTES, MAX_WIRE_BYTES, CHANNELS, PHYSICS_HZ } from '../../shared/protocol/limits.js';
import { payload, secondsAt, stampAt } from '../../shared/protocol/game.js';
import { messageChannel } from '../../shared/protocol/messages.js';
import type { WireMessage } from '../../shared/protocol/messages.js';
import { base, hash, hello, reference, release, snapshot, versions } from './protocol-fixtures';
import { formationData } from '../../src/network/formation-data';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler';
import { authorCombatPlan } from '../../src/game/multiplayer/combat-plan';
import { MissileFlight } from '../../src/game/missile';
import { FlightTrack } from '../../src/simulation/flight-track';
import { FormationTrack } from '../../src/game/formation/track';
import { STEP } from '../../src/config/game';

const context = { sessionId: base.sessionId, epoch: 0, peer: 'host' as const, channel: 'control' as const };
function rejected(callback: () => unknown, code: ProtocolError['code']) {
  try { callback(); throw new Error('Expected rejection.'); }
  catch (error) { expect(error).toBeInstanceOf(ProtocolError); expect(error).toMatchObject({ code }); }
}

describe('bounded shared multiplayer protocol', () => {
  it('round-trips all message variants with independent owned data and the intended channel', () => {
    const messages: WireMessage[] = [
      hello(), release('host'), release(),
      { ...base, type: 'ack', slot: 1, inputSequence: 1, decision: { accepted: true, eventSequence: 1 } },
      { ...base, type: 'ack', slot: 1, inputSequence: 1, decision: { accepted: false, reason: 'too_old' } },
      { ...base, type: 'event', eventSequence: 1, planRevision: 0, event: {
        action: 'released', slot: 1, sequence: 0, plan: reference, at: { tick: 120, fraction: 0.4 }, inputSequence: 1 } },
      { ...base, type: 'snapshot', state: snapshot() },
      { ...base, type: 'transfer-offer', transfer: { id: 'plan', kind: 'formation', digest: hash, bytes: 5, chunks: 1 } },
      { ...base, type: 'transfer-chunk', transferId: 'plan', index: 0, data: 'aGVsbG8=' },
      { ...base, type: 'transfer-ready', transfer: reference },
      { ...base, type: 'plan-commit', planRevision: 0, plans: [reference] },
      { ...base, type: 'checkpoint-commit', checkpoint: reference, planRevision: 0, eventSequence: 0, snapshotSequence: 0 },
      { ...base, type: 'barrier', nextEpoch: 1, reason: 'pause', at: { tick: 0, fraction: 0 } },
      { ...base, type: 'resync', reason: 'gap' },
      { ...base, type: 'ping', id: 1, sentAt: 1000.125 },
      { ...base, type: 'pong', id: 1, sentAt: 1000.125, receivedAt: -220.4 },
    ];
    for (const message of messages) {
      const text = encodeMessage(message);
      expect(byteLength(text)).toBeLessThanOrEqual(MAX_WIRE_BYTES);
      const decoded = decodeMessage(text, { ...context, peer: message.sender, channel: messageChannel(message) });
      expect(decoded).toEqual(message); expect(decoded).not.toBe(message);
    }
    expect(CHANNELS).toEqual({ control: { ordered: true }, state: { ordered: false, maxRetransmits: 0 } });
    expect(PHYSICS_HZ).toBe(1 / STEP);
  });

  it('rejects malformed, non-finite, oversized and authority-confused messages without echoing input', () => {
    for (const value of [null, [], {}, { ...hello(), version: 2 }, { ...hello(), extra: 'private-value' },
      { ...hello(), epoch: Infinity }, { ...release(), slot: 0 }, { ...release(), inputSequence: 0 },
      { ...release(), command: { action: 'release', score: 100 } }]) {
      rejected(() => encodeMessage(value), 'invalid_message');
    }
    rejected(() => decodeMessage('{secret', context), 'invalid_json');
    rejected(() => decodeMessage(' '.repeat(MAX_WIRE_BYTES + 1), context), 'oversized');
    rejected(() => decodeMessage(`"${'\u00e9'.repeat(MAX_WIRE_BYTES / 2)}"`, context), 'oversized');
    const encoded = encodeMessage(hello());
    rejected(() => decodeMessage(encoded, { ...context, sessionId: 'other' }), 'session');
    rejected(() => decodeMessage(encoded, { ...context, epoch: 1 }), 'epoch');
    rejected(() => decodeMessage(encoded, { ...context, peer: 'guest' }), 'role');
    rejected(() => decodeMessage(encoded, { ...context, channel: 'state' }), 'channel');
    rejected(() => encodeMessage({ ...base, sender: 'guest', type: 'snapshot', state: snapshot() }), 'role');
    rejected(() => decodeMessage(JSON.stringify({ ...base, sender: 'guest', type: 'snapshot', state: snapshot() }),
      { ...context, peer: 'guest', channel: 'state' }), 'role');
    expect(() => assertCompatible(versions, { ...versions, generator: 'b'.repeat(64) })).toThrow('compatibility');
    expect(() => assertCompatible(versions, { ...versions })).not.toThrow();
    rejected(() => decodePayload(' '.repeat(MAX_TRANSFER_BYTES + 1)), 'oversized');
  });

  it('bounds transfer metadata, checks snapshot consistency and carries full fractional release time', () => {
    for (const transfer of [{ id: 'plan', kind: 'formation', digest: hash, bytes: MAX_TRANSFER_BYTES + 1, chunks: 1 },
      { id: 'plan', kind: 'formation', digest: hash, bytes: 8193, chunks: 1 }]) {
      rejected(() => encodeMessage({ ...base, type: 'transfer-offer', transfer }), 'invalid_message');
    }
    for (const data of ['', 'not_base64!', 'a'.repeat(11000), 'a'.repeat(10924)]) {
      rejected(() => encodeMessage({ ...base, type: 'transfer-chunk', transferId: 'plan', index: 0, data }), 'invalid_message');
    }
    const state = snapshot();
    state.players[0].misses = 3;
    rejected(() => encodeMessage({ ...base, type: 'snapshot', state }), 'invalid_message');
    state.players[0].eliminated = true;
    state.status = 'over';
    rejected(() => encodeMessage({ ...base, type: 'snapshot', state }), 'invalid_message');
    for (const time of [0, 0.000001, 1 / 120, 8.314159265358, 450.00501, 1e8]) {
      expect(secondsAt(stampAt(time))).toBeCloseTo(time, 12);
    }
    expect(stampAt(8.314159265358).fraction).not.toBe(0);
  });

  it.each(['green-valley', 'desert', 'river-canyon'] as const)('fits sequential %s plans through the speed cap without reducing numeric precision', terrain => {
    const scheduler = new FormationScheduler(terrain, 7);
    let largest = 0;
    for (let sequence = 0; sequence < 15; sequence++) {
      const plan = scheduler.plan();
      const text = encodePayload({ kind: 'formation', data: formationData(plan, sequence) });
      largest = Math.max(largest, byteLength(text));
      const decoded = decodePayload(text);
      if (decoded.kind !== 'formation') throw new Error('Wrong payload.');
      for (const slot of [0, 1] as const) {
        const data = decoded.data.attempts[slot];
        const imported = terrain === 'river-canyon' ? FlightTrack.fromData(data.track) : FormationTrack.fromData(data.track);
        expect(imported.at(0)).toEqual(plan.attempts[slot].track.at(0));
        expect(scheduler.advanceTo(data.releaseAt).ok).toBe(true);
        expect(scheduler.session.release(slot, sequence).ok).toBe(true);
      }
      scheduler.advanceTo(plan.handoffAt); scheduler.session.drainEvents();
    }
    expect(largest).toBeLessThan(MAX_TRANSFER_BYTES);
    expect(scheduler.session.snapshot().players.map(p => p.score)).toEqual([1500, 1500]);
    console.info(`${terrain}: largest complete numeric plan ${largest} UTF-8 bytes`);
  });

  it.each(['green-valley', 'desert', 'river-canyon'] as const)('round-trips real %s plans, combat and checkpoint references without reauthoring', terrain => {
    const scheduler = new FormationScheduler(terrain, 7);
    for (let i = 0; i < 3; i++) {
      const plan = scheduler.plan();
      const data = formationData(plan, i), text = encodePayload({ kind: 'formation', data });
      const decoded = decodePayload(text);
      if (decoded.kind !== 'formation') throw new Error('Wrong payload.');
      for (const slot of [0, 1] as const) {
        const wire = decoded.data.attempts[slot], original = plan.attempts[slot];
        const track = terrain === 'river-canyon' ? FlightTrack.fromData(wire.track) : FormationTrack.fromData(wire.track);
        for (const at of [plan.startAt, original.releaseAt, plan.handoffAt]) {
          expect(track.at(at - wire.releaseAt)).toEqual(original.track.at(at - original.releaseAt));
        }
        expect(wire.camera).toEqual(original.camera.samples);
      }
      expect(byteLength(text)).toBeGreaterThan(MAX_WIRE_BYTES);
      expect(byteLength(text)).toBeLessThan(MAX_TRANSFER_BYTES);
      scheduler.advanceTo(plan.handoffAt);
      for (const event of scheduler.session.drainEvents()) if (event.type === 'resolved') {
        const a = plan.attempts[event.result.slot], view = { ...a.camera.at(event.result.time - a.releaseAt), aspect: 1.15, range: 2500 };
        const data = authorCombatPlan(event.result, plan, 7, view)!;
        const restored = decodePayload(encodePayload({ kind: 'combat', data }));
        if (restored.kind !== 'combat') throw new Error('Wrong combat payload.');
        expect(MissileFlight.fromData(restored.data.missile).toData()).toEqual(data.missile);
      }
      const broken = structuredClone(data);
      broken.attempts[0].track.knots[1]!.time = broken.attempts[0].track.knots[0]!.time;
      expect(payload.safeParse({ kind: 'formation', data: broken }).success).toBe(false);
    }
    const checkpoint = { kind: 'checkpoint', data: { version: 1, sessionId: base.sessionId, epoch: 0, snapshotSequence: 0,
      manifest: { compatibility: versions, terrain, seed: 7, grid: terrain === 'river-canyon' ? 8 : 16, triangle: 'shared-diagonal-v1' },
      state: snapshot() } };
    expect(decodePayload(encodePayload(checkpoint))).toEqual(checkpoint);
  });
});
