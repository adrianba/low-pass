import { lobbyInput, lobbyState } from '../../shared/protocol/lobby.js';
import type { LobbyInput, LobbyOutput, LobbyState } from '../../shared/protocol/lobby.js';
import type { Role } from '../../shared/protocol/limits.js';
import type { TerrainTheme } from '../config/terrain.js';
import { isTerrainTheme } from '../config/terrain.js';
import { validSettings } from '../storage/records.js';
import type { Settings } from '../storage/records.js';
import type { SendResult } from './transport.js';

export class LobbyError extends Error {}
export class Lobby {
  private current: LobbyState | null = null;
  private local: Settings;
  private outgoing: LobbyOutput | null = null;
  private pending: LobbyInput | null = null;
  private inputSequence = 0;
  private readyAllowed = false;
  constructor(readonly role: Role, settings: Settings) {
    if (!validSettings(settings)) throw new LobbyError('Invalid local lobby settings.');
    this.local = { ...settings };
    if (role === 'host') {
      this.current = { update: 1, revision: 0, terrain: settings.terrain, assistance: [settings.assist, false],
        ready: [false, false], guestConfigured: false, guestInputSequence: 0 };
      this.publish();
    }
  }
  get state(): LobbyState | null { return this.current ? structuredClone(this.current) : null; }
  get settings(): Settings { return { ...this.local }; }
  get waiting(): boolean { return this.pending !== null; }
  get canReady(): boolean { return this.readyAllowed && !!this.current?.guestConfigured && !this.pending; }
  get bothReady(): boolean { return this.canReady && !!this.current?.ready.every(Boolean); }
  get selectedAssistance(): boolean { return this.pending?.choice.action === 'assistance' ? this.pending.choice.enabled : this.local.assist; }
  get selectedReady(): boolean {
    return this.pending?.choice.action === 'ready' ? this.pending.choice.enabled : this.current?.ready[this.role === 'host' ? 0 : 1] ?? false;
  }
  private publish() {
    if (!this.current) throw new LobbyError('Missing authoritative lobby state.');
    this.current.update++;
    const parsed = lobbyState.safeParse(this.current);
    if (!parsed.success) throw new LobbyError('Lobby state exceeded its bounds.');
    this.outgoing = { type: 'lobby-state', state: parsed.data };
  }
  private host() {
    if (this.role !== 'host' || !this.current) throw new LobbyError('Only the host can change the shared course.');
    return this.current;
  }
  setTerrain(terrain: TerrainTheme) {
    const state = this.host();
    if (!isTerrainTheme(terrain)) throw new LobbyError('Invalid lobby terrain.');
    if (state.terrain === terrain) return;
    state.terrain = terrain; state.revision++; state.ready = [false, false]; this.readyAllowed = false; this.publish();
  }
  setLocal(settings: Pick<Settings, 'quality' | 'muted' | 'volume'>) {
    const next = { ...this.local, ...settings };
    if (!validSettings(next)) throw new LobbyError('Invalid local lobby settings.');
    this.local = next;
  }
  private request(choice: LobbyInput['choice']) {
    if (!this.current || this.pending) throw new LobbyError('Wait for the host to acknowledge the current choice.');
    const parsed = lobbyInput.safeParse({ sequence: this.inputSequence + 1, revision: this.current.revision, choice });
    if (!parsed.success) throw new LobbyError('Lobby input exceeded its bounds.');
    this.inputSequence++; this.pending = parsed.data; this.outgoing = { type: 'lobby-input', input: parsed.data };
  }
  setAssistance(enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new LobbyError('Invalid assistance choice.');
    if (this.role === 'guest') { this.request({ action: 'assistance', enabled }); return; }
    const state = this.host();
    if (state.assistance[0] === enabled) return;
    this.local.assist = enabled; state.assistance[0] = enabled; state.revision++; state.ready = [false, false]; this.publish();
  }
  setReady(enabled: boolean) {
    if (typeof enabled !== 'boolean' || (enabled && !this.canReady)) throw new LobbyError('Wait for compatible, verified course data before becoming ready.');
    if (this.role === 'guest') { this.request({ action: 'ready', enabled }); return; }
    this.host().ready[0] = enabled; this.publish();
  }
  allowReady(allowed: boolean) {
    this.readyAllowed = allowed;
    if (!allowed && this.role === 'host' && this.current?.ready.some(Boolean)) {
      this.current.ready = [false, false]; this.publish();
    } else if (!allowed && this.role === 'guest' && this.current?.ready[1] && !this.pending) {
      this.request({ action: 'ready', enabled: false });
    }
  }
  receiveInput(value: LobbyInput) {
    const state = this.host(), parsed = lobbyInput.safeParse(value);
    if (!parsed.success) throw new LobbyError('Invalid lobby input.');
    const input = parsed.data;
    if (input.sequence <= state.guestInputSequence) { this.publish(); return; }
    if (input.sequence !== state.guestInputSequence + 1) throw new LobbyError('Lobby input sequence has a gap.');
    if (!state.guestConfigured && input.choice.action !== 'assistance') throw new LobbyError('Guest configuration is not established.');
    state.guestInputSequence = input.sequence;
    if (input.choice.action === 'assistance') {
      if (!state.guestConfigured || state.assistance[1] !== input.choice.enabled) {
        state.assistance[1] = input.choice.enabled; state.guestConfigured = true;
        state.revision++; state.ready = [false, false];
      }
    } else if (state.guestConfigured && input.revision === state.revision) {
      state.ready[1] = input.choice.enabled;
    }
    this.publish();
  }
  receiveState(value: LobbyState) {
    if (this.role !== 'guest') throw new LobbyError('Only a guest can receive authoritative lobby state.');
    const parsed = lobbyState.safeParse(value);
    if (!parsed.success) throw new LobbyError('Invalid lobby state.');
    const state = parsed.data;
    if (this.current && state.update <= this.current.update) return;
    if (state.guestInputSequence > this.inputSequence ||
      (this.current && (state.revision < this.current.revision || state.guestInputSequence < this.current.guestInputSequence))) {
      throw new LobbyError('Inconsistent lobby acknowledgement.');
    }
    const first = this.current === null;
    if (this.current && this.current.terrain !== state.terrain) this.readyAllowed = false;
    this.current = state;
    if (this.pending && state.guestInputSequence >= this.pending.sequence) this.pending = null;
    if (state.guestConfigured) this.local.assist = state.assistance[1];
    if (first) this.request({ action: 'assistance', enabled: this.local.assist });
    else if (!this.readyAllowed && state.ready[1] && !this.pending) this.request({ action: 'ready', enabled: false });
  }
  flush(send: (message: LobbyOutput) => SendResult): boolean {
    const message = this.outgoing;
    if (message && send(structuredClone(message)).ok && this.outgoing === message) this.outgoing = null;
    return this.outgoing === null;
  }
}
