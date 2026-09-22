import { HostRoomPanel } from '../../src/ui/host-room.js';
const root = document.getElementById('room-controls');
if (!root) throw new Error('Missing room preview root.');
let panel = new HostRoomPanel(root);
window.addEventListener('pagehide', () => { void panel.dispose(); });
window.addEventListener('pageshow', event => { if (event.persisted) panel = new HostRoomPanel(root); });
