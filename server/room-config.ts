import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { ClientAddresses } from './client-address.js';
import { hashSecret } from './room-store.js';

export interface RoomConfig { origin: string; trustedProxyCidrs: readonly string[]; hostingDigest: string }
export class RoomConfigurationError extends Error {}

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
  const path = env.LOW_PASS_HOSTING_CODE_FILE;
  if (!path || !isAbsolute(path)) throw new RoomConfigurationError('LOW_PASS_HOSTING_CODE_FILE must reference an absolute private file.');
  let secret: Buffer | undefined;
  try {
    const canonical = realpathSync(path), root = realpathSync(staticRoot), local = relative(root, canonical);
    if (!local || (!local.startsWith(`..${sep}`) && local !== '..' && !isAbsolute(local))) {
      throw new RoomConfigurationError('The hosting-code file must be outside the static asset root.');
    }
    const stat = statSync(canonical);
    if (!stat.isFile() || stat.size < 32 || stat.size > 258) throw new RoomConfigurationError('Hosting code must contain 32-256 printable ASCII characters.');
    secret = readFileSync(canonical);
    if (secret.length > 258) throw new RoomConfigurationError('Hosting code exceeds its size limit.');
    const text = secret.toString('utf8').replace(/\r?\n$/, '');
    if (!/^[\x21-\x7e]{32,256}$/.test(text)) throw new RoomConfigurationError('Hosting code must contain 32-256 printable ASCII characters.');
    return { origin: origin.origin, trustedProxyCidrs: Object.freeze(trustedProxyCidrs), hostingDigest: hashSecret(text) };
  } catch (error) {
    if (error instanceof RoomConfigurationError) throw error;
    throw new RoomConfigurationError('The private hosting-code file is missing or unreadable.');
  } finally { secret?.fill(0); }
}
