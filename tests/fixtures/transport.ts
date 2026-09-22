import { FaultNetwork } from '../helpers/fault-transport';
import { FormationScheduler } from '../../src/game/multiplayer/scheduler';
import { formationData } from '../../src/network/formation-data';
import { createTransfer, sha256, TransferReceiver } from '../../src/network/transfer';
import { DeliveryBarrier } from '../../src/network/delivery-barrier';
import { encodeMessage, byteLength } from '../../shared/protocol/codec.js';
import { MAX_WIRE_BYTES } from '../../shared/protocol/limits.js';
import type { WireMessage } from '../../shared/protocol/messages.js';
import { base, snapshot } from '../unit/protocol-fixtures';

async function exercise() {
  const scheduler = new FormationScheduler('river-canyon', 7);
  const data = formationData(scheduler.plan(), 0);
  const outgoing = await createTransfer({ kind: 'formation', data }, data.encounterId);
  const reference = { id: outgoing.offer.id, digest: outgoing.offer.digest };
  const network = new FaultNetwork({ seed: 7, sessionId: base.sessionId, epoch: 0,
    maxPackets: 64, maxBufferedBytes: 64 * 1024, maxInbox: 64 });
  network.setFaults('control', { latencyMs: 20, jitterMs: 10, loss: 0.15, duplicate: 0.2 });
  network.setFaults('state', { latencyMs: 0 });
  const receiver = new TransferReceiver(() => network.time, { maxTransfers: 2, maxBytes: 32 * 1024 * 1024, ttlMs: 30_000 });
  const barrier = new DeliveryBarrier(base.sessionId, 0);
  let ready = false, lastControl = -1, deferred = 0, backpressure = 0, largestMessage = 0, nextSequence = 1;
  const state = snapshot(); state.plans = [reference];
  const commit: Extract<WireMessage, { type: 'plan-commit' }> =
    { ...base, sequence: nextSequence++, type: 'plan-commit', planRevision: 0, plans: [reference] };
  const frame: Extract<WireMessage, { type: 'snapshot' }> = { ...base, sequence: nextSequence++, type: 'snapshot', state };
  const messages: WireMessage[] = [commit, frame,
    { ...base, sequence: nextSequence++, type: 'transfer-offer', transfer: outgoing.offer },
    ...outgoing.chunks.map(chunk => ({ ...base, sequence: nextSequence++, type: 'transfer-chunk' as const, ...chunk })),
  ];
  let sent = 0, completedDigest = '';
  for (let step = 0; step < 1200; step++) {
    while (sent < messages.length) {
      const message = messages[sent]!;
      largestMessage = Math.max(largestMessage, byteLength(encodeMessage(message)));
      const queued = network.peers.host.send(message);
      if (!queued.ok) { if (queued.reason !== 'backpressure') throw new Error('Transport unexpectedly closed.'); backpressure++; break; }
      sent++;
    }
    network.advanceTo(network.time + 25);
    for (const incoming of network.peers.guest.drain()) {
      if (incoming.type !== 'message') throw new Error('Unexpected transport rejection.');
      const message = incoming.message;
      if (incoming.channel === 'control') {
        if (message.sequence <= lastControl) continue;
        lastControl = message.sequence;
      }
      if (message.type === 'plan-commit' || message.type === 'snapshot') {
        if (!barrier.consider(message, () => ready).ok) deferred++;
      } else if (message.type === 'transfer-offer') receiver.offer(message.transfer);
      else if (message.type === 'transfer-chunk') {
        const completed = await receiver.accept({ transferId: message.transferId, index: message.index, data: message.data });
        if (completed) {
          if (completed.payload.kind !== 'formation') throw new Error('Unexpected transfer kind.');
          if (JSON.stringify(completed.payload.data) !== JSON.stringify(data)) throw new Error('Numeric plan changed in transit.');
          ready = true; completedDigest = completed.reference.digest;
        }
      }
    }
    if (sent === messages.length && network.pendingPackets === 0) break;
  }
  if (!ready || receiver.pendingCount !== 0 || largestMessage > MAX_WIRE_BYTES) throw new Error('Incomplete bounded transfer.');
  if (!barrier.consider(commit, () => ready).ok || !barrier.consider(frame, () => ready).ok) throw new Error('Deferred state did not become applicable.');
  return { ready, deferred, backpressure, largestMessage, completedDigest, expectedDigest: outgoing.offer.digest,
    stats: network.stats, watermarks: barrier.watermarks, knownHash: await sha256(new TextEncoder().encode('abc')) };
}
declare global { interface Window { transportReady: ReturnType<typeof exercise> } }
window.transportReady = exercise();
