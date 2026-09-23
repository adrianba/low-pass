import { TERRAIN_THEMES } from '../config/terrain.js';
import type { MultiplayerRecordStore, MultiplayerSummary } from '../storage/multiplayer-records.js';

const reasons = {
  left: 'A player left the private flight.',
  connection_lost: 'The connection could not be recovered.',
  error: 'The private flight could not continue.',
  interrupted: 'This browser closed before the match was completed.',
};
function playerName(slot: 0 | 1, localSlot: 0 | 1): string {
  return `PLAYER ${slot + 1} / ${slot === localSlot ? 'YOU' : slot === 0 ? 'HOST' : 'GUEST'}`;
}
export function multiplayerOutcome(match: MultiplayerSummary): { title: string; description: string } {
  if (match.status === 'active') return { title: 'MATCH IN PROGRESS', description: 'The other flight has not finished.' };
  if (match.status === 'incomplete') {
    if (!match.reason) throw new Error('Incomplete multiplayer results require a reason.');
    return { title: 'MATCH INCOMPLETE',
      description: `${reasons[match.reason]} No winner. Only completed individual flights enter the leaderboard.` };
  }
  if (match.winner === null) throw new Error('Completed multiplayer results require a winner or draw.');
  return { title: match.winner === 'draw' ? 'MATCH DRAW' : `PLAYER ${match.winner + 1} WINS`,
    description: 'Both player scores are final. Multiplayer records are separate from solo records.' };
}

export class MultiplayerRecordsPanel {
  constructor(private readonly root: HTMLElement, private readonly store: MultiplayerRecordStore) {
    root.innerHTML = `<details class="multiplayer-records"><summary>MULTIPLAYER RECORDS</summary>
      <p class="fine-print">Local to this browser. Only finalized player scores are ranked; unfinished scores never count.</p>
      <h3>COMPLETED PLAYERS / TOP 10</h3><ol data-records="scores"></ol>
      <h3>RECENT MATCHES / LAST 10</h3><ol data-records="matches"></ol></details>`;
    root.querySelector('details')!.ontoggle = () => this.render();
  }
  private list(name: 'scores' | 'matches', rows: string[], empty: string) {
    const list = this.root.querySelector<HTMLOListElement>(`[data-records="${name}"]`)!;
    list.replaceChildren(...(rows.length ? rows : [empty]).map(text => {
      const item = document.createElement('li'); item.textContent = text; return item;
    }));
  }
  render(): void {
    this.list('scores', this.store.scores.map(score =>
      `${score.score} / ${playerName(score.slot, score.localSlot)} / ${score.assisted ? 'ASSISTED' : 'UNASSISTED'} / ` +
      `${TERRAIN_THEMES[score.terrain].label} / ${new Date(score.date).toLocaleString()} / ${score.matchStatus.toUpperCase()} MATCH`),
    'No completed multiplayer scores yet.');
    this.list('matches', this.store.matches.map(match => {
      const outcome = multiplayerOutcome(match);
      return `${outcome.title} / ${TERRAIN_THEMES[match.terrain].label} / ${new Date(match.startedAt).toLocaleString()} / ` +
        match.players.map((player, slot) => `Player ${slot + 1}: ${player.score}${player.eliminated ? ' final' : ' unfinished'}`).join(' / ') +
        (match.reason ? ` / ${reasons[match.reason]}` : '');
    }), 'No multiplayer matches yet.');
  }
}

export class MultiplayerResultsPanel {
  private readonly history: MultiplayerRecordsPanel;
  private shown = '';
  constructor(private readonly root: HTMLElement, store: MultiplayerRecordStore) {
    root.innerHTML = `<h2 id="match-result-title" tabindex="-1"></h2>
      <p id="match-result-description" role="status"></p>
      <p id="match-result-error" role="alert" hidden></p>
      <table aria-label="Private match player results"><thead><tr>
        <th scope="col">Player</th><th scope="col">Score</th><th scope="col">Flight</th><th scope="col">Assistance</th>
      </tr></thead><tbody id="match-result-players"></tbody></table>
      <div id="match-result-records"></div>`;
    root.setAttribute('aria-labelledby', 'match-result-title');
    this.history = new MultiplayerRecordsPanel(this.get('#match-result-records'), store);
  }
  private get<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error('Missing multiplayer results control.');
    return element;
  }
  render(match: MultiplayerSummary, issue: string | null): void {
    if (match.status === 'active') throw new Error('An active match cannot show terminal results.');
    const key = `${match.matchId}:${match.status}:${issue ?? ''}`;
    if (this.shown === key) return;
    const outcome = multiplayerOutcome(match);
    this.get('#match-result-title').textContent = outcome.title;
    this.get('#match-result-description').textContent = outcome.description;
    this.get('#match-result-error').hidden = !issue;
    this.get('#match-result-error').textContent = issue ?? '';
    this.get('#match-result-players').replaceChildren(...match.players.map((player, index) => {
      const row = document.createElement('tr'), slot = index === 0 ? 0 : 1;
      row.dataset.slot = String(slot);
      const name = document.createElement('th'); name.scope = 'row'; name.textContent = playerName(slot, match.localSlot);
      row.append(name);
      for (const text of [String(player.score), player.eliminated ? 'COMPLETED' : 'UNFINISHED',
        player.assisted ? 'ASSISTED' : 'UNASSISTED']) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      return row;
    }));
    this.history.render();
    this.root.hidden = false;
    if (!this.shown) { this.root.scrollTop = 0; this.get('#match-result-title').focus({ preventScroll: true }); }
    this.shown = key;
  }
}
