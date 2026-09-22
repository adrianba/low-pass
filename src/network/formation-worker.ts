import { planFormation } from '../game/formation/approved.js';
import type { FormationRequest } from '../game/formation/approved.js';
import { serializeFormation } from '../game/formation/serialized.js';
import { formationData } from './formation-data.js';
import { createTransfer } from './transfer.js';
import type { FormationWorkerReply } from './formation-worker-client.js';

self.onmessage = async (event: MessageEvent<FormationRequest>) => {
  const request = event.data;
  let response: FormationWorkerReply;
  try {
    const result = planFormation(request);
    if (!result.ok) throw new Error('Could not author the next approved formation.');
    const data = formationData(result.plan, request.count);
    const transfer = await createTransfer({ kind: 'formation', data }, `flight-${request.count}`);
    response = { ok: true, sequence: request.count, plan: serializeFormation(result.plan), data, transfer };
  } catch (error) {
    response = { ok: false, sequence: request.count,
      reason: error instanceof Error ? error.message : 'Course worker failed.' };
  }
  self.postMessage(response);
};
