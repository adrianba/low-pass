import { ClientAddresses } from './client-address.js';
import { hashSecret } from './room-store.js';
import { readPrivateSecret, RoomConfigurationError } from './private-secret.js';
import { readTurnConfig } from './turn-config.js';
import type { TurnConfig } from './turn-config.js';

export interface RoomConfig { origin: string; trustedProxyCidrs: readonly string[]; hostingDigest: string; turn?: TurnConfig }
export { RoomConfigurationError } from './private-secret.js';

export function readRoomConfig(env: NodeJS.ProcessEnv, staticRoot: string): RoomConfig {
  let origin: URL;
  try { origin = new URL(env.LOW_PASS_PUBLIC_ORIGIN ?? ''); }
  catch { throw new RoomConfigurationError('LOW_PASS_PUBLIC_ORIGIN must be a canonical HTTPS origin.'); }
  if (origin.origin !== env.LOW_PASS_PUBLIC_ORIGIN ||
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new RoomConfigurationError('LOW_PASS_PUBLIC_ORIGIN must be a canonical HTTPS origin (HTTP loopback for local tests only).');
  }
  const trustedProxyCidrs = (env.LOW_PASS_TRUSTED_PROXY_CIDRS ?? '').split(',').map(part => part.trim());
  try { new ClientAddresses(trustedProxyCidrs); }
  catch { throw new RoomConfigurationError('LOW_PASS_TRUSTED_PROXY_CIDRS must contain explicit non-universal proxy CIDRs.'); }
  const secret = readPrivateSecret(env.LOW_PASS_HOSTING_CODE_FILE, staticRoot, 'LOW_PASS_HOSTING_CODE_FILE', 256);
  try {
    return { origin: origin.origin, trustedProxyCidrs: Object.freeze(trustedProxyCidrs),
      hostingDigest: hashSecret(secret), turn: readTurnConfig(env, staticRoot) };
  } finally { secret.fill(0); }
}
