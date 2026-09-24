import { Lobby, LobbyError } from '../network/lobby.js';
import { TERRAIN_THEMES, isTerrainTheme } from '../config/terrain.js';

export class LobbyPanel {
  constructor(private readonly root: HTMLElement, readonly model: Lobby, private readonly changed: () => void,
    private readonly preparationStatus: () => string | null = () => null) {
    root.innerHTML = `
      <h2 tabindex="-1">${model.role === 'host' ? 'Player 1 / Host' : 'Player 2 / Guest'}</h2>
      <label>Shared terrain <select data-control="terrain">${Object.entries(TERRAIN_THEMES)
        .map(([id, theme]) => `<option value="${id}">${theme.label}</option>`).join('')}</select></label>
      <p data-control="course-note">The host chooses the course. Changing shared choices clears both ready flags.</p>
      <label>My impact assistance <input data-control="assistance" type="checkbox"></label>
      <label>My graphics quality <select data-control="quality"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      <label>Mute my sound <input data-control="muted" type="checkbox"></label>
      <label>My volume <input data-control="volume" type="range" min="0" max="100"></label>
      <p data-control="players" role="status"></p>
      <p data-control="status" role="status"></p>
      <label>I am ready <input data-control="ready" type="checkbox"></label>
      <p data-control="error" role="alert"></p>
    `;
    this.get<HTMLSelectElement>('terrain').onchange = () => this.action(() => {
      const terrain = this.get<HTMLSelectElement>('terrain').value;
      if (!isTerrainTheme(terrain)) throw new LobbyError('Invalid lobby terrain.');
      model.setTerrain(terrain);
    });
    this.get<HTMLInputElement>('assistance').onchange = () => this.action(() => model.setAssistance(this.get<HTMLInputElement>('assistance').checked));
    this.get<HTMLInputElement>('ready').onchange = () => this.action(() => model.setReady(this.get<HTMLInputElement>('ready').checked));
    for (const control of ['quality', 'muted', 'volume']) this.get(control).onchange = () => this.action(() => {
      const quality = this.get<HTMLSelectElement>('quality').value;
      if (quality !== 'low' && quality !== 'medium' && quality !== 'high') throw new LobbyError('Invalid graphics choice.');
      model.setLocal({ quality, muted: this.get<HTMLInputElement>('muted').checked,
        volume: Number(this.get<HTMLInputElement>('volume').value) / 100 });
    });
    this.render();
  }
  private get<T extends HTMLElement = HTMLElement>(name: string): T {
    const element = this.root.querySelector<T>(`[data-control="${name}"]`);
    if (!element) throw new Error('Missing lobby control.');
    return element;
  }
  private text(name: string, text: string) {
    const element = this.get(name); if (element.textContent !== text) element.textContent = text;
  }
  private action(work: () => void) {
    try { work(); this.text('error', ''); this.changed(); }
    catch (error) {
      if (!(error instanceof LobbyError)) throw error;
      this.text('error', error.message);
    } finally { this.render(); }
  }
  render() {
    const state = this.model.state, settings = this.model.settings;
    this.get<HTMLSelectElement>('terrain').disabled = this.model.role !== 'host';
    this.get<HTMLSelectElement>('terrain').value = state?.terrain ?? settings.terrain;
    this.get<HTMLInputElement>('assistance').disabled = !state || this.model.waiting;
    this.get<HTMLInputElement>('assistance').checked = this.model.selectedAssistance;
    this.get<HTMLSelectElement>('quality').value = settings.quality;
    this.get<HTMLInputElement>('muted').checked = settings.muted;
    this.get<HTMLInputElement>('volume').value = String(settings.volume * 100);
    this.get<HTMLInputElement>('ready').checked = this.model.selectedReady;
    this.get<HTMLInputElement>('ready').disabled = !this.model.canReady;
    this.text('players', state ? `Player 1: ${state.ready[0] ? 'ready' : 'not ready'}, assistance ${state.assistance[0] ? 'on' : 'off'}. ` +
      `Player 2: ${state.ready[1] ? 'ready' : 'not ready'}, assistance ${state.guestConfigured ? state.assistance[1] ? 'on' : 'off' : 'pending'}.` : 'Waiting for the host configuration.');
    this.text('status', this.preparationStatus() ?? (this.model.waiting ? 'Waiting for host acknowledgement.'
      : this.model.bothReady ? 'Both players are ready for this configuration.'
        : this.model.selectedReady ? 'You are ready. Waiting for the other player to choose ready.'
        : this.model.canReady ? 'Choose ready when you are prepared.'
          : !state?.guestConfigured ? 'Waiting for Player 2 to confirm their lobby settings.'
            : 'Waiting for compatible, verified course data.'));
  }
  dispose() { this.root.replaceChildren(); }
}
