import type { RoomMembership } from '../../shared/protocol/rooms.js';
import type { TerrainTheme } from '../../src/config/terrain.js';
import { LobbyConnection } from '../../src/network/lobby-connection.js';
import { MatchController } from '../../src/network/match-controller.js';
import { DEFAULT_SETTINGS } from '../../src/storage/records.js';
import { versions } from '../unit/protocol-fixtures.js';
import { connectPeer } from '../../src/network/connect-peer.js';

const sockets: WebSocket[] = [];
let peerConnections = 0;
const peers: RTCPeerConnection[] = [];
const NativeSocket = WebSocket, NativePeer = RTCPeerConnection;
globalThis.WebSocket = class extends NativeSocket {
  constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); }
};
globalThis.RTCPeerConnection = class extends NativePeer {
  constructor(configuration?: RTCConfiguration) { super(configuration); peerConnections++; peers.push(this); }
};
let lobby: LobbyConnection | null = null, match: MatchController | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false, drops = 0;
let firstEliminated: 0 | 1 = 0;
let setupError: string | null = null;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (!match) {
      if (lobby?.lobby.canReady && !lobby.lobby.selectedReady) lobby.lobby.setReady(true);
      return;
    }
    await match.update();
    if (match.phase !== 'playing' || !match.frame) return;
    const slot = match.prepared.role === 'host' ? 0 : 1;
    const flight = match.host?.scheduler.plan() ?? match.guest!.replica.plans.at(match.frame.time).toData();
    if (drops < (slot === firstEliminated ? 2 : 3) && match.frame.time >= flight.attempts[slot].releaseAt && match.frame.ready && match.release()) drops++;
  } finally { busy = false; }
}
const fixture = {
  async connect(member: RoomMembership, terrain: TerrainTheme, first: 0 | 1 = 0) {
    firstEliminated = first;
    lobby = await LobbyConnection.connect(member, { ...DEFAULT_SETTINGS, terrain, assist: false }, 'direct', 7, versions, prepared => {
      try {
        match = new MatchController(prepared, (_slot, view, range) => ({ ...view, range, aspect: 1.15 }), undefined,
          signal => connectPeer(member, versions, 1.15, 'direct', 0, signal));
        match.assetsLoaded();
      } catch (error) {
        setupError = error instanceof Error ? error.message : 'Fixture setup failed.';
        throw error;
      }
    });
    timer = setInterval(() => { void tick(); }, 10);
  },
  async report() {
    const state = match?.host?.scheduler.session.snapshot();
    const replica = match?.guest?.replica.presentationState;
    return { phase: match?.phase ?? 'lobby', issue: setupError ?? match?.issue ?? null, drops, time: match?.frame?.time ?? 0,
      peerConnections, signalingSockets: sockets.length, signaling: match?.prepared.link.signalingState ?? null,
      recovery: match?.recoveryState ?? null, ready: match?.pauseState?.canReady ?? false,
      epoch: match?.host?.epoch ?? match?.guest?.epoch ?? null,
      viewedSlot: match?.frame?.viewedSlot ?? null,
      destroyed: match?.frame?.aircraft.map(aircraft => aircraft.destroyed) ?? [],
      resources: match?.host?.counts ?? { verified: match?.guest?.replica.plans.count ?? 0 },
      players: state?.players.map(p => ({ score: p.score, misses: p.misses, eliminated: p.completion !== null })) ??
        replica?.players.map(p => ({ score: p.score, misses: p.misses, eliminated: p.eliminated })) ?? [],
      sequence: match?.host?.scheduler.sequence ?? null,
      lobby: match ? null : await lobby?.report() ?? null };
  },
  interruptSignaling() {
    const open = sockets.filter(socket => socket.readyState === WebSocket.OPEN);
    if (open.length !== 1) throw new Error('Expected one active fixture signaling socket.');
    open[0]!.close(4000, 'test-only signaling interruption');
  },
  interruptPeer() {
    const latest = peers.at(-1);
    if (!latest) throw new Error('No native fixture peer to interrupt.');
    latest.close();
  },
  ready() { match!.setReady(true); },
  release() { return match!.release(); },
  close() { if (timer) clearInterval(timer); match?.close(); lobby?.close(); },
};
declare global { interface Window { matchFixture: typeof fixture } }
window.matchFixture = fixture;
