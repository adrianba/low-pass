import { HostRoomPanel } from '../../src/ui/host-room.js';
import { GuestRoomPanel } from '../../src/ui/guest-room.js';
import { takeInvitationLink } from '../../src/network/invitation-link.js';
import { BUILD_IDENTITY } from '../../src/network/build-identity.js';
import { LobbyConnection } from '../../src/network/lobby-connection.js';
import { LobbyPanel } from '../../src/ui/lobby.js';
import { DEFAULT_SETTINGS } from '../../src/storage/records.js';
import type { Compatibility } from '../../shared/protocol/game.js';
import type { IceMode } from '../../src/network/ice-policy.js';
import { IcePolicyError } from '../../src/network/ice-policy.js';
import { RoomClientError } from '../../src/network/room-client.js';
const root = document.getElementById('room-controls');
const mode = document.querySelector<HTMLSelectElement>('#room-mode'), error = document.getElementById('preview-error');
if (!root || !mode || !error) throw new Error('Missing room preview root.');
const link = takeInvitationLink(location.href, url => history.replaceState(history.state, '', url));
mode.value = link ? 'guest' : 'host';
let panel: HostRoomPanel | GuestRoomPanel = link ? new GuestRoomPanel(root, link) : new HostRoomPanel(root);
const connectButton = document.querySelector<HTMLButtonElement>('#connection-start');
const connectionMode = document.querySelector<HTMLSelectElement>('#connection-mode');
const connectionError = document.getElementById('connection-error'), lobbyRoot = document.getElementById('lobby');
const reportRoot = document.getElementById('connection-report');
if (!connectButton || !connectionMode || !connectionError || !lobbyRoot || !reportRoot) throw new Error('Missing connection controls.');
let connection: LobbyConnection | null = null, lobby: LobbyPanel | null = null, connecting = false, disposed = false, painting = false;
let wasAdmitted = false;
async function connect(identity = BUILD_IDENTITY) {
  if (connecting || connection || disposed) return;
  connecting = true; connectionError!.textContent = '';
  const session = panel.session;
  try {
    const mode = connectionMode!.value;
    if (!['direct', 'auto', 'udp', 'tcp', 'tls'].includes(mode)) throw new Error('Invalid connection mode.');
    const created = await LobbyConnection.connect(session.admittedMember(), { ...DEFAULT_SETTINGS }, mode as IceMode, 7, identity);
    if (disposed || panel.session !== session || panel.session.state.room?.state !== 'admitted') { created.close(); return; }
    connection = created; lobby = new LobbyPanel(lobbyRoot!, created.lobby, () => {}, () => created.preparationStatus);
  } catch (error) {
    connectionError!.textContent = error instanceof RoomClientError || error instanceof IcePolicyError ? error.message
      : 'Could not start the connection check. Confirm admission, connectivity and a window aspect between 0.75 and 2.';
  }
  finally { connecting = false; }
}
connectButton.onclick = () => { void connect(); };
function closeConnection() { connection?.close(); connection = null; lobby?.dispose(); lobby = null; reportRoot!.textContent = ''; }
mode.onchange = () => {
  mode.disabled = true;
  closeConnection();
  void panel.dispose().then(() => {
    error.textContent = panel.session.state.error ?? '';
    panel = mode.value === 'host' ? new HostRoomPanel(root) : new GuestRoomPanel(root);
    mode.disabled = false;
  });
};
const timer = setInterval(() => { void render(); }, 200);
async function render() {
  if (disposed || painting) return;
  painting = true;
  try {
    const admitted = panel.session.state.room?.state === 'admitted';
    if (!admitted && connection) closeConnection();
    connectButton!.disabled = connecting || !!connection || !admitted;
    connectionMode!.disabled = connecting || !!connection;
    if (admitted && !wasAdmitted && !connectButton!.disabled) connectButton!.focus();
    wasAdmitted = admitted;
    lobby?.render();
    const current = connection;
    const report = await current?.report();
    if (current && current === connection && !disposed) {
      reportRoot!.textContent = JSON.stringify(report, null, 2);
      if (report?.error) connectionError!.textContent = report.error === 'compatibility'
        ? 'The game builds do not match. Reload both browsers before creating a new room.'
        : `Connection check failed: ${report.error}. Close this room and retry.`;
    }
  } finally { painting = false; }
}
declare global {
  interface Window { roomPreview: { identity: Compatibility; connect(identity?: Compatibility): Promise<void>;
    report(): ReturnType<LobbyConnection['report']> | Promise<null>; dispose(): Promise<void> } }
}
async function dispose() {
  if (disposed) return;
  disposed = true; clearInterval(timer); closeConnection(); await panel.dispose();
}
window.roomPreview = { identity: BUILD_IDENTITY, connect, report: () => connection?.report() ?? Promise.resolve(null), dispose };
window.addEventListener('pagehide', () => { void dispose(); });
window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
});
