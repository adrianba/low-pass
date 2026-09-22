import { reference, sequence as planSequence } from '../../shared/protocol/game.js';
import { MAX_PLANS } from '../../shared/protocol/limits.js';
import type { MessageBody } from '../../shared/protocol/messages.js';

type Reference = { id: string; digest: string };

/** A plan may be committed only after the peer acknowledges its verified bytes. */
export class PlanPublication {
  private readonly staged = new Map<number, { reference: Reference; ready: boolean }>();
  private committed = new Map<number, Reference>();
  private currentRevision = -1;
  get revision(): number { return this.currentRevision; }
  get references(): Map<number, Reference> { return structuredClone(this.committed); }
  stage(sequence: number, value: Reference): void {
    planSequence.parse(sequence);
    const ref = reference.parse(value), previous = this.staged.get(sequence);
    if (previous) {
      if (previous.reference.id !== ref.id || previous.reference.digest !== ref.digest) throw new Error('Cannot replace a staged flight plan.');
      return;
    }
    if (this.staged.size >= MAX_PLANS + 2 || [...this.staged.values()].some(value => value.reference.id === ref.id)) {
      throw new Error('Staged flight plan capacity or identity conflict.');
    }
    this.staged.set(sequence, { reference: ref, ready: false });
  }
  acknowledge(value: Reference): void {
    const ref = reference.parse(value);
    const staged = [...this.staged.values()].find(value => value.reference.id === ref.id);
    if (!staged || staged.reference.digest !== ref.digest) throw new Error('Unexpected flight plan acknowledgement.');
    staged.ready = true;
  }
  ready(sequence: number): boolean { return this.staged.get(sequence)?.ready === true; }
  commit(sequences: readonly number[]): Extract<MessageBody, { type: 'plan-commit' }> {
    if (!sequences.length || sequences.length > MAX_PLANS || new Set(sequences).size !== sequences.length) {
      throw new Error('Invalid committed flight plan set.');
    }
    const sorted = [...sequences].sort((a, b) => a - b);
    const entries = sorted.map((sequence, index): [number, Reference] => {
      const staged = this.staged.get(sequence);
      if (!staged?.ready || index > 0 && sequence !== sorted[index - 1]! + 1) throw new Error('Flight plans are not verified and contiguous.');
      return [sequence, staged.reference];
    });
    if (JSON.stringify(entries) !== JSON.stringify([...this.committed])) {
      if (this.currentRevision === Number.MAX_SAFE_INTEGER) throw new Error('Flight plan revision exhausted.');
      this.currentRevision++;
      for (const old of this.committed.keys()) if (!sorted.includes(old)) this.staged.delete(old);
      this.committed = new Map(entries);
    }
    return { type: 'plan-commit', planRevision: this.currentRevision, plans: structuredClone(entries.map(([, ref]) => ref)) };
  }
}
