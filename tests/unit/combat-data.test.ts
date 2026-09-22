import { describe, expect, it } from 'vitest';
import { byteLength, decodePayload, encodeMessage, encodePayload } from '../../shared/protocol/codec.js';
import { combat } from '../../shared/protocol/game.js';
import { MAX_WIRE_BYTES } from '../../shared/protocol/limits.js';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler.js';
import { authorCombatPlan } from '../../src/game/multiplayer/combat-plan.js';
import { MissileFlight } from '../../src/game/missile.js';
import { combatTransferData, expandCombat } from '../../src/network/combat-data.js';
import { formationData } from '../../src/network/formation-data.js';
import { ReplicaPlans } from '../../src/network/replica-plans.js';
import { createTransfer, TransferReceiver } from '../../src/network/transfer.js';
import type { CompletedTransfer } from '../../src/network/transfer.js';
import type { Payload } from '../../shared/protocol/game.js';
import { base } from './protocol-fixtures.js';

async function verified(value: Payload, id: string): Promise<CompletedTransfer> {
  const transfer = await createTransfer(value, id);
  const receiver = new TransferReceiver(() => 0, { maxTransfers: 2, maxBytes: 32 * 1024 * 1024, ttlMs: 30_000 });
  receiver.offer(transfer.offer);
  let result: CompletedTransfer | null = null;
  for (const chunk of transfer.chunks) result = await receiver.accept(chunk);
  if (!result) throw new Error('Missing completed test transfer.');
  return result;
}

describe('referenced combat publication', () => {
  it.each(['green-valley', 'desert', 'river-canyon'] as const)('preserves exact %s damage/finale motion in one small chunk', async terrain => {
    const scheduler = new FormationScheduler(terrain, 7);
    let largestFull = 0, largestReferenced = 0, largestWire = 0;
    for (let sequence = 0; sequence < 3; sequence++) {
      const current = scheduler.plan(), next = scheduler.plan(sequence + 1);
      const plans = [current, next].map((plan, index) => ({
        reference: { id: `flight-${sequence + index}`, digest: 'a'.repeat(64) },
        data: formationData(plan, sequence + index),
      }));
      scheduler.advanceTo(current.handoffAt);
      for (const event of scheduler.session.drainEvents()) if (event.type === 'resolved') {
        const attempt = current.attempts[event.result.slot];
        const full = authorCombatPlan(event.result, current, 7,
          { ...attempt.camera.at(event.result.time - attempt.releaseAt), aspect: 1.15, range: 2500 }, undefined, next)!;
        const compact = combatTransferData(full, plans);
        const encoded = encodePayload({ kind: 'combat', data: compact }), decoded = decodePayload(encoded);
        if (decoded.kind !== 'combat') throw new Error('Expected combat.');
        const expanded = expandCombat(decoded.data, ref => {
          const plan = plans.find(plan => plan.reference.id === ref.id && plan.reference.digest === ref.digest);
          if (!plan) throw new Error('Unknown verified dependency.');
          return plan.data;
        });
        expect(expanded).toEqual(combat.parse(JSON.parse(JSON.stringify(full))));
        const original = MissileFlight.fromData(full.missile), restored = MissileFlight.fromData(expanded.missile);
        for (const age of [0, 0.123, 1.7, 2.799]) expect(restored.positionAt(age)).toEqual(original.positionAt(age));
        const transfer = await createTransfer({ kind: 'combat', data: compact }, `effect-${full.id}`);
        expect(transfer.chunks).toHaveLength(1);
        const wire = encodeMessage({ ...base, sessionId: 's'.repeat(128), sequence: Number.MAX_SAFE_INTEGER,
          epoch: Number.MAX_SAFE_INTEGER, type: 'transfer-chunk', ...transfer.chunks[0]! });
        largestWire = Math.max(largestWire, byteLength(wire));
        largestFull = Math.max(largestFull, byteLength(encodePayload({ kind: 'combat', data: full })));
        largestReferenced = Math.max(largestReferenced, byteLength(encoded));
      }
    }
    expect(largestReferenced).toBeLessThan(4096);
    expect(largestWire).toBeLessThan(MAX_WIRE_BYTES);
    expect(largestFull).toBeGreaterThan(MAX_WIRE_BYTES);
    console.info(`${terrain} combat: full ${largestFull} bytes; referenced ${largestReferenced}; largest chunk envelope ${largestWire}`);
  });

  it('waits for verified dependencies, expands once, and owns frozen combat data after the flight is retired', async () => {
    const scheduler = new FormationScheduler('green-valley', 7), current = scheduler.plan(), next = scheduler.plan(1);
    const flights = await Promise.all([current, next].map((plan, index) =>
      verified({ kind: 'formation', data: formationData(plan, index) }, `flight-${index}`)));
    const plans = flights.map(transfer => {
      if (transfer.payload.kind !== 'formation') throw new Error('Expected formation.');
      return { reference: transfer.reference, data: transfer.payload.data };
    });
    scheduler.advanceTo(current.handoffAt);
    const result = scheduler.session.drainEvents().find(event => event.type === 'resolved');
    if (!result || result.type !== 'resolved') throw new Error('Expected result.');
    const full = authorCombatPlan(result.result, current, 7, undefined, undefined, next)!;
    const compact = combatTransferData(full, plans);
    const effect = await verified({ kind: 'combat', data: compact }, 'effect-1');
    const store = new ReplicaPlans();
    store.installVerified(effect);
    expect(store.has(effect.reference)).toBe(false);
    expect(() => store.combat(effect.reference)).toThrow('Missing');
    for (const flight of flights) store.installVerified(flight);
    expect(store.has(effect.reference)).toBe(true);
    const owned = store.combat(effect.reference);
    expect(owned).toEqual(combat.parse(JSON.parse(JSON.stringify(full))));
    store.commit(flights.map(flight => flight.reference)); store.commit([flights[1]!.reference]);
    expect(store.has(flights[0]!.reference)).toBe(false);
    expect(store.combat(effect.reference)).toEqual(owned);
    owned.view.position.x += 1;
    expect(store.combat(effect.reference).view.position.x).not.toBe(owned.view.position.x);
    const wrong = structuredClone(plans);
    wrong[0]!.data.attempts[full.slot].track.knots[0]!.pose.position.x += 1;
    expect(() => combatTransferData(full, wrong)).toThrow('exact verified');
    const invalid = structuredClone(compact); invalid.missile.motion.offset = 1000;
    expect(() => expandCombat(invalid, () => plans[0]!.data)).toThrow();
  });
});
