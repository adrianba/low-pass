import { describe, expect, it } from 'vitest';
import { lobbyPair } from '../helpers/lobby-pair.js';
import { encodeMessage, decodeMessage } from '../../shared/protocol/codec.js';
import { Lobby } from '../../src/network/lobby.js';
import { DEFAULT_SETTINGS } from '../../src/storage/records.js';
import type { LobbyOutput } from '../../shared/protocol/lobby.js';

describe('host-authoritative shared lobby', () => {
  it('synchronizes distinct assistance and host terrain without mutating either solo settings object', () => {
    const pair = lobbyPair(), { host, guest } = pair.models; pair.settle();
    expect(host.state?.assistance).toEqual([true, false]); expect(guest.state).toEqual(host.state);
    expect(guest.settings.terrain).toBe('river-canyon');
    host.setTerrain('desert'); pair.settle();
    expect(guest.state?.terrain).toBe('desert'); expect(guest.settings.terrain).toBe('river-canyon');
    expect(() => guest.setTerrain('green-valley')).toThrow('Only the host');
    guest.setLocal({ quality: 'high', muted: true, volume: 0.2 });
    expect(host.settings).toEqual(DEFAULT_SETTINGS);
    const settings = guest.settings; settings.volume = 1; expect(guest.settings.volume).toBe(0.2);
    expect(guest.canReady).toBe(false); expect(() => guest.setReady(true)).toThrow('verified course');
    host.allowReady(true); guest.allowReady(true);
    host.setReady(true); guest.setReady(true); pair.settle();
    expect(host.bothReady).toBe(true); expect(guest.bothReady).toBe(true);
    guest.setAssistance(true);
    expect(guest.selectedAssistance).toBe(true); expect(guest.waiting).toBe(true); expect(guest.bothReady).toBe(false);
    pair.settle();
    expect(host.state?.ready).toEqual([false, false]); expect(host.state?.assistance).toEqual([true, true]);
  });
  it('rejects stale ready choices after course changes and converges through delay, loss and replay', () => {
    const pair = lobbyPair(), { host, guest } = pair.models;
    pair.network.setFaults('control', { latencyMs: 80, jitterMs: 30, loss: 0.2, duplicate: 0.5, retryMs: 50 });
    pair.settle(); host.allowReady(true); guest.allowReady(true);
    guest.setReady(true); host.setTerrain('river-canyon'); pair.settle();
    expect(guest.state).toEqual(host.state); expect(host.state?.ready).toEqual([false, false]);
    expect(guest.waiting).toBe(false); expect(guest.canReady).toBe(false);
    expect(pair.network.stats.retried).toBeGreaterThan(0); expect(pair.network.stats.duplicated).toBeGreaterThan(0);
  });
  it('revokes guest readiness even when the previous ready acknowledgement was in flight', () => {
    const pair = lobbyPair(), { host, guest } = pair.models; pair.settle();
    host.allowReady(true); guest.allowReady(true); host.setReady(true); guest.setReady(true);
    guest.allowReady(false); pair.settle();
    expect(host.state?.ready[1]).toBe(false); expect(guest.state?.ready[1]).toBe(false);
    expect(host.bothReady).toBe(false); expect(guest.waiting).toBe(false);
  });
  it('bounds pending guest intents and coalesces unsent host state during backpressure', () => {
    const pair = lobbyPair(), { host, guest } = pair.models; pair.settle();
    guest.setAssistance(true);
    expect(() => guest.setAssistance(false)).toThrow('acknowledge');
    for (let i = 0; i < 100; i++) host.setTerrain(i % 2 ? 'river-canyon' : 'desert');
    host.flush(() => ({ ok: false, reason: 'backpressure' }));
    let sent: LobbyOutput | null = null;
    host.flush(message => { sent = message; return { ok: true }; });
    expect(sent).toMatchObject({ type: 'lobby-state', state: { terrain: 'river-canyon' } });
    host.flush(() => { throw new Error('An accepted state must not be sent again.'); });
  });
  it('enforces wire authority, strict settings shapes and monotonic acknowledgements', () => {
    const pair = lobbyPair(); pair.settle();
    const state = pair.models.host.state!;
    const message = { version: 1, sessionId: 'lobby', epoch: 0, sender: 'host', sequence: 1, type: 'lobby-state', state };
    const text = encodeMessage(message);
    expect(decodeMessage(text, { sessionId: 'lobby', epoch: 0, peer: 'host', channel: 'control' })).toEqual(message);
    expect(() => encodeMessage({ ...message, sender: 'guest' })).toThrow('role');
    expect(() => encodeMessage({ ...message, state: { ...state, volume: 1 } })).toThrow('invalid_message');
    expect(() => pair.models.guest.receiveState({ ...state, update: state.update + 1, guestInputSequence: 999 })).toThrow('acknowledgement');
    expect(() => new Lobby('host', { ...DEFAULT_SETTINGS, volume: NaN })).toThrow('settings');
  });
});
