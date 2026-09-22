import type { FormationPlan, FormationRequest } from '../game/formation/approved.js';
import { restoreFormation } from '../game/formation/serialized.js';
import type { SerializedFormation } from '../game/formation/serialized.js';
import type { FormationData } from './replica-plans.js';
import type { OutgoingTransfer } from './prepared-course.js';
import WorkerConstructor from './formation-worker?worker';

export interface AuthoredFlight { plan: FormationPlan; data: FormationData; transfer: OutgoingTransfer }
export interface FormationAuthoring {
  author(request: FormationRequest): Promise<AuthoredFlight>;
  close(): void;
}
export type FormationWorkerReply = { ok: true; sequence: number; plan: SerializedFormation; data: FormationData; transfer: OutgoingTransfer } |
  { ok: false; sequence: number; reason: string };

export class FormationWorker implements FormationAuthoring {
  private readonly worker = new WorkerConstructor();
  private pending: { sequence: number; resolve: (flight: AuthoredFlight) => void; reject: (error: Error) => void } | null = null;
  private closed = false;
  constructor() {
    this.worker.onmessage = (event: MessageEvent<FormationWorkerReply>) => {
      const pending = this.pending, response = event.data;
      if (!pending || response.sequence !== pending.sequence) { this.fail(new Error('Unexpected course worker reply.')); return; }
      this.pending = null;
      if (!response.ok) { pending.reject(new Error(response.reason)); return; }
      try { pending.resolve({ plan: restoreFormation(response.plan), data: response.data, transfer: response.transfer }); }
      catch (error) {
        pending.reject(error instanceof Error ? error : new Error('Invalid authored course.'));
      }
    };
    this.worker.onerror = () => this.fail(new Error('The course worker could not continue.'));
    this.worker.onmessageerror = () => this.fail(new Error('The course worker reply could not be read.'));
  }
  author(request: FormationRequest): Promise<AuthoredFlight> {
    if (this.closed || this.pending) return Promise.reject(new Error('Course authoring requires exclusive live ownership.'));
    return new Promise((resolve, reject) => {
      this.pending = { sequence: request.count, resolve, reject };
      try { this.worker.postMessage(request); }
      catch { this.fail(new Error('The next course could not be sent to its worker.')); }
    });
  }
  private fail(error: Error): void {
    this.pending?.reject(error); this.pending = null; this.closed = true; this.worker.terminate();
  }
  close(): void { this.fail(new Error('Course authoring cancelled.')); }
}
