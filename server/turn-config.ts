import { createSecretKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { iceUrls } from '../shared/protocol/ice.js';
import { readPrivateSecret, RoomConfigurationError } from './private-secret.js';

export interface TurnConfig { urls: readonly string[]; key: KeyObject }
export function readTurnConfig(env: NodeJS.ProcessEnv, staticRoot: string): TurnConfig | undefined {
  if (env.LOW_PASS_TURN_URLS === undefined && env.LOW_PASS_TURN_SECRET_FILE === undefined) return undefined;
  const raw = env.LOW_PASS_TURN_URLS ?? '';
  const urls = iceUrls.safeParse(raw.length <= 2400 ? raw.split(',').map(url => url.trim()) : []);
  if (!urls.success) throw new RoomConfigurationError('LOW_PASS_TURN_URLS requires explicit supported ICE URLs, including at least one TURN URL.');
  const secret = readPrivateSecret(env.LOW_PASS_TURN_SECRET_FILE, staticRoot, 'LOW_PASS_TURN_SECRET_FILE', 4096);
  try { return { urls: Object.freeze(urls.data), key: createSecretKey(secret) }; }
  finally { secret.fill(0); }
}
