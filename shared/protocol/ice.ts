import { z } from 'zod';

export const iceUrl = z.string().max(300).refine(value => {
  const match = /^(stun|turn|turns):(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+):([1-9][0-9]{0,4})(?:\?transport=(udp|tcp))?$/.exec(value);
  if (!match || Number(match[3]) > 65535) return false;
  if (match[1] === 'stun' ? match[4] !== undefined : match[1] === 'turns' ? match[4] !== 'tcp' : !match[4]) return false;
  const host = match[2]!;
  if (!host.startsWith('[') && (host.length > 253 || host.split('.').some(label =>
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))) return false;
  try {
    const url = new URL(`http://${host}:${match[3]}`);
    return !/^[0-9.]+$/.test(host) || url.hostname === host;
  } catch { return false; }
});
export const iceUrls = z.array(iceUrl).min(1).max(8).refine(urls =>
  new Set(urls).size === urls.length && urls.some(url => url.startsWith('turn:') || url.startsWith('turns:')));
export const iceConfiguration = z.strictObject({
  iceServers: z.array(z.union([
    z.strictObject({ urls: z.array(iceUrl.refine(url => url.startsWith('stun:'))).min(1).max(8) }),
    z.strictObject({
      urls: z.array(iceUrl.refine(url => url.startsWith('turn:') || url.startsWith('turns:'))).min(1).max(8),
      username: z.string().min(1).max(128), credential: z.string().regex(/^[A-Za-z0-9+/]{27}=$/),
      credentialType: z.literal('password'),
    }),
  ])).min(1).max(2),
  serverTimeMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
  refreshAfterMs: z.number().int().positive().max(600_000),
}).refine(value => value.expiresAtMs > value.serverTimeMs &&
  value.refreshAfterMs < value.expiresAtMs - value.serverTimeMs &&
  value.iceServers.some(server => 'credential' in server));
export type IceConfiguration = z.infer<typeof iceConfiguration>;
