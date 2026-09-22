import digests from 'virtual:low-pass-identity';
import { compatibility } from '../../shared/protocol/game.js';
import { PHYSICS_HZ, PROTOCOL_VERSION } from '../../shared/protocol/limits.js';
import { FORMATION_PROFILE } from '../config/multiplayer.js';

export const BUILD_IDENTITY = Object.freeze(compatibility.parse({
  ...digests, protocol: PROTOCOL_VERSION, physicsHz: PHYSICS_HZ, formationProfile: FORMATION_PROFILE.version,
}));
