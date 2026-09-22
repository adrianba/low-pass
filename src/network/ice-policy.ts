import type { IceConfiguration } from '../../shared/protocol/ice.js';
export type IceMode = 'direct' | 'auto' | 'udp' | 'tcp' | 'tls';
export class IcePolicyError extends Error {}
export function icePolicy(mode: IceMode, configuration: IceConfiguration | null): { iceServers: RTCIceServer[]; relayOnly: boolean } {
  if (!['direct', 'auto', 'udp', 'tcp', 'tls'].includes(mode)) throw new IcePolicyError('Invalid connection test mode.');
  if (mode === 'direct') return { iceServers: [], relayOnly: false };
  if (!configuration) throw new IcePolicyError('Relay configuration is unavailable.');
  const iceServers = configuration.iceServers.map(server => ({ ...server, urls: server.urls.filter(url => mode === 'auto' ||
    (mode === 'tls' ? url.startsWith('turns:') : url.startsWith('turn:') && url.endsWith(`?transport=${mode}`))) }))
    .filter(server => server.urls.length > 0);
  if (!iceServers.length) throw new IcePolicyError('The requested relay transport is not configured.');
  return { iceServers, relayOnly: mode !== 'auto' };
}
