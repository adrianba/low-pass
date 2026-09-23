import { MultiplayerRecordStore } from '../../src/storage/multiplayer-records.js';
import { MultiplayerRecordsPanel, MultiplayerResultsPanel } from '../../src/ui/multiplayer-results.js';
import { versions } from '../unit/protocol-fixtures.js';

const root = document.querySelector<HTMLElement>('#match-results')!;
const select = document.querySelector<HTMLSelectElement>('#fixture-outcome')!;
function render() {
  const store = new MultiplayerRecordStore(() => ({ getItem: () => null, setItem: () => {} }), () => {});
  if (select.value === 'empty') {
    new MultiplayerRecordsPanel(root, store);
    root.removeAttribute('aria-labelledby'); root.hidden = false;
    return;
  }
  store.begin({ matchId: 'fixture:1', localSlot: 0, terrain: 'river-canyon', compatibility: versions,
    startedAt: '2026-09-22T00:00:00.000Z' });
  const incomplete = select.value === 'incomplete';
  store.observe([{ score: 100, misses: 3, eliminated: true, assisted: false },
    { score: select.value === 'draw' ? 100 : 200, misses: incomplete ? 2 : 3, eliminated: !incomplete, assisted: true }]);
  if (incomplete) store.finish('connection_lost');
  const panel = new MultiplayerResultsPanel(root, store, ready => panel.renderRematch({
    ready: [ready, false], selectedReady: ready, canReady: true, remainingMs: null,
  }));
  panel.render(store.current!, incomplete ? '<b>Connection unavailable.</b>' : null);
  panel.renderRematch(incomplete ? null : { ready: [false, false], selectedReady: false, canReady: true, remainingMs: null });
}
select.onchange = render;
render();
