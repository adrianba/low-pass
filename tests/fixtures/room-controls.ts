import { HostRoomPanel } from '../../src/ui/host-room.js';
import { GuestRoomPanel } from '../../src/ui/guest-room.js';
import { takeInvitationLink } from '../../src/network/invitation-link.js';
const root = document.getElementById('room-controls');
const mode = document.querySelector<HTMLSelectElement>('#room-mode'), error = document.getElementById('preview-error');
if (!root || !mode || !error) throw new Error('Missing room preview root.');
const link = takeInvitationLink(location.href, url => history.replaceState(history.state, '', url));
mode.value = link ? 'guest' : 'host';
let panel: HostRoomPanel | GuestRoomPanel = link ? new GuestRoomPanel(root, link) : new HostRoomPanel(root);
mode.onchange = () => {
  mode.disabled = true;
  void panel.dispose().then(() => {
    error.textContent = panel.session.state.error ?? '';
    panel = mode.value === 'host' ? new HostRoomPanel(root) : new GuestRoomPanel(root);
    mode.disabled = false;
  });
};
window.addEventListener('pagehide', () => { void panel.dispose(); });
window.addEventListener('pageshow', event => {
  if (event.persisted) panel = mode.value === 'host' ? new HostRoomPanel(root) : new GuestRoomPanel(root);
});
