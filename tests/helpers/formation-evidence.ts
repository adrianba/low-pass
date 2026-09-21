import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function formationEvidence(name: string, data: unknown): void {
  const directory = process.env.FORMATION_EVIDENCE_DIR;
  if (!directory) return;
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid formation evidence name.');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), JSON.stringify({
    status: 'formation measurements; G1 presentation accepted, not networking or performance acceptance',
    runtime: process.version, data,
  }, null, 2) + '\n');
}
