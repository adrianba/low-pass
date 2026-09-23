import type { RoomMembership } from '../../shared/protocol/rooms.js';
import type { Compatibility } from '../../shared/protocol/game.js';
import { RoomClient } from './room-client.js';
import { PeerLink } from './peer-link.js';
import { icePolicy } from './ice-policy.js';
import type { IceMode } from './ice-policy.js';

export async function connectPeer(member: RoomMembership, compatibility: Compatibility, aspect: number,
  mode: IceMode, epoch?: number, signal?: AbortSignal): Promise<PeerLink> {
  signal?.throwIfAborted();
  const config = mode === 'direct' ? null : await new RoomClient().ice(member.capability, signal);
  signal?.throwIfAborted();
  return new PeerLink({ member, compatibility, aspect, epoch, ...icePolicy(mode, config) });
}
