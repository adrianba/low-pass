import { describe, expect, it } from 'vitest';
import { createTransfer, sha256, TransferReceiver, TransferError } from '../../src/network/transfer';
import type { CompletedTransfer } from '../../src/network/transfer';
import { DeliveryBarrier } from '../../src/network/delivery-barrier';
import { formationData } from '../../src/network/formation-data';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler';
import type { Payload } from '../../shared/protocol/game.js';
import { base, hash, reference, snapshot, versions } from './protocol-fixtures';
import type { WireMessage } from '../../shared/protocol/messages.js';

const budget = { maxTransfers: 2, maxBytes: 32 * 1024 * 1024, ttlMs: 30_000 };
const checkpoint = (): Payload => ({ kind: 'checkpoint', data: {
  version: 1, sessionId: base.sessionId, epoch: 0, snapshotSequence: 3,
  manifest: { compatibility: versions, terrain: 'green-valley', seed: 7, grid: 16, triangle: 'shared-diagonal-v1' },
  state: snapshot(),
} });

describe('bounded and hash-verified payload transfers', () => {
  it('assembles out-of-order real numeric plans and tolerates identical partial chunk replay', async () => {
    const scheduler = new FormationScheduler('river-canyon', 7), data = formationData(scheduler.plan(), 0);
    const outgoing = await createTransfer({ kind: 'formation', data }, 'plan-0');
    const receiver = new TransferReceiver(() => 0, budget);
    receiver.offer(outgoing.offer); receiver.offer(outgoing.offer);
    expect(await receiver.accept(outgoing.chunks[1]!)).toBeNull();
    expect(await receiver.accept(outgoing.chunks[1]!)).toBeNull();
    let completed: CompletedTransfer | null = null;
    for (const chunk of [...outgoing.chunks].reverse().filter(c => c.index !== 1)) completed = await receiver.accept(chunk);
    expect(completed).toEqual({ reference: { id: 'plan-0', digest: outgoing.offer.digest }, payload: { kind: 'formation', data } });
    expect(receiver.pendingCount).toBe(0); expect(receiver.pendingBytes).toBe(0);
  });

  it('rejects corrupt data, conflicting metadata, wrong chunk sizes and wrong payload kinds', async () => {
    const outgoing = await createTransfer(checkpoint(), 'checkpoint'), receiver = new TransferReceiver(() => 0, budget);
    receiver.offer(outgoing.offer);
    expect(() => receiver.offer({ ...outgoing.offer, digest: hash })).toThrow('conflict');
    await expect(receiver.accept({ ...outgoing.chunks[0]!, data: 'YQ==' })).rejects.toThrow('invalid');
    const corrupt = outgoing.chunks.map(c => ({ ...c }));
    corrupt[0]!.data = (corrupt[0]!.data[0] === 'A' ? 'B' : 'A') + corrupt[0]!.data.slice(1);
    await expect(receiver.accept(corrupt[0]!)).rejects.toThrow('checksum');
    expect(receiver.pendingBytes).toBe(0);
    receiver.offer({ ...outgoing.offer, kind: 'combat' });
    await expect(receiver.accept(outgoing.chunks[0]!)).rejects.toThrow('kind');
    expect(receiver.pendingBytes).toBe(0);
  });

  it('bounds declared bytes/counts, expires partial transfers and requires monotonic local time', async () => {
    const outgoing = await createTransfer(checkpoint(), 'checkpoint');
    let time = 0;
    const receiver = new TransferReceiver(() => time, { ...budget, maxTransfers: 1, maxBytes: outgoing.offer.bytes });
    receiver.offer(outgoing.offer);
    expect(() => receiver.offer({ ...outgoing.offer, id: 'other' })).toThrow('capacity');
    expect(receiver.pendingBytes).toBe(outgoing.offer.bytes);
    time = 30_000;
    await expect(receiver.accept(outgoing.chunks[0]!)).rejects.toThrow('expired');
    expect(receiver.expire()).toEqual(['checkpoint']);
    expect(receiver.pendingCount).toBe(0);
    time = 29_999;
    expect(() => receiver.offer(outgoing.offer)).toThrow('invalid');
    expect(() => new TransferReceiver(() => 0, { ...budget, maxTransfers: Infinity })).toThrow(TransferError);
  });

  it('does not publish an old digest after reset and counts uncancellable hashing against capacity', async () => {
    const outgoing = await createTransfer(checkpoint(), 'checkpoint');
    let finish!: (value: string) => void;
    const receiver = new TransferReceiver(() => 0, { ...budget, maxTransfers: 1 },
      () => new Promise(resolve => { finish = resolve; }));
    receiver.offer(outgoing.offer);
    const pending = receiver.accept(outgoing.chunks[0]!);
    receiver.reset();
    expect(receiver.pendingCount).toBe(1);
    expect(() => receiver.offer(outgoing.offer)).toThrow('capacity');
    const rejected = expect(pending).rejects.toThrow('cancelled');
    finish(outgoing.offer.digest); await rejected;
    expect(receiver.pendingCount).toBe(0);
    receiver.offer(outgoing.offer); receiver.reset();
    expect(receiver.pendingBytes).toBe(0);
    expect(await sha256(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('holds checkpoint commits until verified dependencies exist and rejects stale checkpoint races', async () => {
    const outgoing = await createTransfer(checkpoint(), 'checkpoint');
    const receiver = new TransferReceiver(() => 0, budget);
    receiver.offer(outgoing.offer);
    const complete = (await receiver.accept(outgoing.chunks[0]!))!;
    const commit: Extract<WireMessage, { type: 'checkpoint-commit' }> = { ...base, type: 'checkpoint-commit',
      checkpoint: complete.reference, planRevision: 0, eventSequence: 0, snapshotSequence: 3 };
    const gate = new DeliveryBarrier(base.sessionId, 0);
    expect(gate.consider(commit, () => true)).toEqual({ ok: false, reason: 'checkpoint' });
    expect(gate.consider(commit, () => false, complete)).toEqual({ ok: false, reason: 'missing_plan' });
    expect(gate.consider(commit, ref => ref.id === reference.id && ref.digest === reference.digest, complete)).toEqual({ ok: true });
    expect(gate.consider(commit, () => true, complete)).toEqual({ ok: false, reason: 'stale' });
    expect(gate.consider({ ...base, type: 'event', eventSequence: 1, planRevision: 0,
      event: { action: 'assistance', slot: 0, enabled: true, assisted: true } }, () => true)).toEqual({ ok: true });
    expect(gate.consider(commit, () => true, complete)).toEqual({ ok: false, reason: 'stale' });
    const nextEpoch = new DeliveryBarrier(base.sessionId, 1);
    expect(() => nextEpoch.consider({ ...commit, epoch: 1 }, () => true, complete)).toThrow('epoch');
    expect(() => gate.consider({ ...commit, eventSequence: 2 }, () => true, complete)).toThrow('invalid_message');
  });

  it('does not discard a replacement transfer when an older cancelled hash completes', async () => {
    const outgoing = await createTransfer(checkpoint(), 'same-id');
    let finish!: (value: string) => void;
    const receiver = new TransferReceiver(() => 0, budget, () => new Promise(resolve => { finish = resolve; }));
    receiver.offer(outgoing.offer);
    const old = receiver.accept(outgoing.chunks[0]!);
    receiver.reset(); receiver.offer(outgoing.offer);
    expect(receiver.pendingCount).toBe(2);
    const cancelled = expect(old).rejects.toThrow('cancelled');
    finish(outgoing.offer.digest); await cancelled;
    expect(receiver.pendingCount).toBe(1);
    receiver.reset(); expect(receiver.pendingCount).toBe(0);
  });

  it('checks expiry again after asynchronous hashing instead of publishing a late checkpoint', async () => {
    const outgoing = await createTransfer(checkpoint(), 'checkpoint');
    let time = 0, finish!: (value: string) => void;
    const receiver = new TransferReceiver(() => time, budget, () => new Promise(resolve => { finish = resolve; }));
    receiver.offer(outgoing.offer);
    const pending = receiver.accept(outgoing.chunks[0]!);
    time = budget.ttlMs;
    const expired = expect(pending).rejects.toThrow('expired');
    finish(outgoing.offer.digest); await expired;
    expect(receiver.pendingBytes).toBe(0);
  });
});
