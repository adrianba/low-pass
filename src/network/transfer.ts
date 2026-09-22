import { decodePayload, encodePayload } from '../../shared/protocol/codec.js';
import type { Payload } from '../../shared/protocol/game.js';
import { MAX_TRANSFER_BYTES, TRANSFER_CHUNK_BYTES } from '../../shared/protocol/limits.js';
import { transfer, transferChunk } from '../../shared/protocol/messages.js';
import type { TransferOffer, TransferChunk } from '../../shared/protocol/messages.js';

export class TransferError extends Error {
  constructor(readonly code: 'invalid' | 'capacity' | 'unknown' | 'conflict' | 'expired' | 'checksum' | 'cancelled' | 'kind') {
    super(`Multiplayer transfer rejected: ${code}.`);
  }
}
export interface CompletedTransfer { reference: { id: string; digest: string }; payload: Payload }
export async function sha256(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

export async function createTransfer(value: Payload, id: string) {
  const text = encodePayload(value), bytes = new TextEncoder().encode(text);
  const offer = transfer.parse({ id, kind: value.kind, digest: await sha256(bytes),
    bytes: bytes.length, chunks: Math.ceil(bytes.length / TRANSFER_CHUNK_BYTES) });
  const chunks: TransferChunk[] = [];
  for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_BYTES) {
    chunks.push({ transferId: id, index: chunks.length, data: base64(bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES)) });
  }
  return { offer, chunks };
}

interface Incoming {
  offer: TransferOffer; parts: Array<Uint8Array | null>; count: number; expires: number; hashing: boolean;
}
export interface TransferBudget { maxTransfers: number; maxBytes: number; ttlMs: number }
export class TransferReceiver {
  private readonly records = new Map<string, Incoming>();
  private readonly reserved = new Set<Incoming>();
  private lastTime = -Infinity;
  constructor(private readonly clock: () => number, private readonly budget: Readonly<TransferBudget>,
    private readonly hash: (bytes: Uint8Array) => Promise<string> = sha256) {
    if (!Number.isInteger(budget.maxTransfers) || budget.maxTransfers < 1 || budget.maxTransfers > 8 ||
      !Number.isInteger(budget.maxBytes) || budget.maxBytes < 1 || budget.maxBytes > 2 * MAX_TRANSFER_BYTES ||
      !Number.isFinite(budget.ttlMs) || budget.ttlMs < 1 || budget.ttlMs > 60_000) throw new TransferError('invalid');
    this.budget = Object.freeze({ ...budget });
  }
  get pendingCount(): number { return this.reserved.size; }
  get pendingBytes(): number { return [...this.reserved].reduce((sum, record) => sum + record.offer.bytes, 0); }
  private now(): number {
    const time = this.clock();
    if (!Number.isFinite(time) || Math.abs(time) > 1e12 || time < this.lastTime) throw new TransferError('invalid');
    this.lastTime = time;
    return time;
  }
  offer(value: TransferOffer): void {
    const parsed = transfer.safeParse(value);
    if (!parsed.success) throw new TransferError('invalid');
    const offer = parsed.data, now = this.now(), old = this.records.get(offer.id);
    if (old) {
      if (now >= old.expires) throw new TransferError('expired');
      if (JSON.stringify(old.offer) !== JSON.stringify(offer)) throw new TransferError('conflict');
      return;
    }
    if (this.pendingCount >= this.budget.maxTransfers || this.pendingBytes + offer.bytes > this.budget.maxBytes) throw new TransferError('capacity');
    const record: Incoming = { offer, parts: Array.from({ length: offer.chunks }, () => null),
      count: 0, expires: now + this.budget.ttlMs, hashing: false };
    this.records.set(offer.id, record); this.reserved.add(record);
  }
  async accept(value: TransferChunk): Promise<CompletedTransfer | null> {
    const parsed = transferChunk.safeParse(value);
    if (!parsed.success) throw new TransferError('invalid');
    const chunk = parsed.data, record = this.records.get(chunk.transferId);
    if (!record) throw new TransferError('unknown');
    if (this.now() >= record.expires) throw new TransferError('expired');
    const bytes = Uint8Array.from(atob(chunk.data), char => char.charCodeAt(0));
    if (chunk.index >= record.offer.chunks || bytes.length !== Math.min(TRANSFER_CHUNK_BYTES,
      record.offer.bytes - chunk.index * TRANSFER_CHUNK_BYTES) || base64(bytes) !== chunk.data) throw new TransferError('invalid');
    const previous = record.parts[chunk.index];
    if (previous) {
      if (previous.some((byte, i) => byte !== bytes[i])) throw new TransferError('conflict');
      return null;
    }
    record.parts[chunk.index] = bytes; record.count++;
    if (record.count !== record.parts.length) return null;
    record.hashing = true;
    try {
      const assembled = new Uint8Array(record.offer.bytes);
      for (const [index, part] of record.parts.entries()) assembled.set(part!, index * TRANSFER_CHUNK_BYTES);
      const digest = await this.hash(assembled);
      if (this.records.get(chunk.transferId) !== record) throw new TransferError('cancelled');
      if (this.now() >= record.expires) throw new TransferError('expired');
      if (digest !== record.offer.digest) throw new TransferError('checksum');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(assembled); }
      catch { throw new TransferError('invalid'); }
      const payload = decodePayload(text);
      if (payload.kind !== record.offer.kind) throw new TransferError('kind');
      return { reference: { id: record.offer.id, digest }, payload };
    } finally {
      if (this.records.get(chunk.transferId) === record) this.records.delete(chunk.transferId);
      this.reserved.delete(record);
    }
  }
  expire(): string[] {
    const now = this.now(), expired: string[] = [];
    for (const [id, record] of this.records) if (now >= record.expires) {
      expired.push(id); this.records.delete(id);
      if (!record.hashing) this.reserved.delete(record);
    }
    return expired;
  }
  reset(): void {
    // WebCrypto cannot be cancelled: retain its reservation until the promise settles.
    for (const record of this.records.values()) if (!record.hashing) this.reserved.delete(record);
    this.records.clear();
  }
}
