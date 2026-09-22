import type { Compatibility, Snapshot } from '../../shared/protocol/game.js';
import type { WireMessage } from '../../shared/protocol/messages.js';

export const hash = 'a'.repeat(64);
export const versions: Compatibility = {
  protocol: 1, build: hash, assets: hash, rules: hash, generator: hash, formationProfile: 1, physicsHz: 120,
};
export const base = { version: 1 as const, sessionId: 'test-session', epoch: 0, sender: 'host' as const, sequence: 1 };
export const reference = { id: 'encounter-0', digest: hash };
export const snapshot = (): Snapshot => ({
  at: { tick: 0, fraction: 0 }, status: 'running', planRevision: 0, eventSequence: 0, lastInputs: [0, 0],
  plans: [reference], effects: [], wrecks: [], winner: null,
  players: [
    { slot: 0, score: 0, misses: 0, assistance: false, assisted: false, eliminated: false, bomb: null },
    { slot: 1, score: 0, misses: 0, assistance: false, assisted: false, eliminated: false, bomb: null },
  ],
});
export const hello = (): WireMessage => ({ ...base, type: 'hello', compatibility: { ...versions }, viewport: { aspect: 1.15 } });
export const release = (sender: 'host' | 'guest' = 'guest'): WireMessage => ({
  ...base, sender, type: 'command', slot: sender === 'host' ? 0 : 1, inputSequence: 1,
  command: { action: 'release', sequence: 0, plan: reference, displayedAt: { tick: 120, fraction: 0.314159 } },
});
