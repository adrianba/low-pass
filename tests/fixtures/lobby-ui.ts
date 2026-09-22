import { LobbyPanel } from '../../src/ui/lobby.js';
import { lobbyPair } from '../helpers/lobby-pair.js';
const hostRoot = document.getElementById('host-lobby'), guestRoot = document.getElementById('guest-lobby');
const verified = document.querySelector<HTMLInputElement>('#fixture-verified');
if (!hostRoot || !guestRoot || !verified) throw new Error('Missing lobby fixture controls.');
const pair = lobbyPair();
pair.network.setFaults('control', { latencyMs: 80, jitterMs: 20, loss: 0.1, duplicate: 0.2, retryMs: 50 });
let terrain = pair.models.host.state!.terrain;
const panels = [new LobbyPanel(hostRoot, pair.models.host, changed), new LobbyPanel(guestRoot, pair.models.guest, changed)];
function changed() {
  if (pair.models.host.state!.terrain !== terrain) {
    terrain = pair.models.host.state!.terrain; verified!.checked = false;
    for (const model of Object.values(pair.models)) model.allowReady(false);
  }
  for (const panel of panels) panel.render();
}
verified.onchange = () => {
  for (const model of Object.values(pair.models)) model.allowReady(verified.checked);
  changed();
};
const timer = setInterval(() => { pair.advance(); changed(); }, 20);
window.addEventListener('pagehide', () => { clearInterval(timer); pair.network.close(); });
declare global { interface Window { lobbyUi: { guestSoloTerrain(): string } } }
window.lobbyUi = { guestSoloTerrain: () => pair.models.guest.settings.terrain };
