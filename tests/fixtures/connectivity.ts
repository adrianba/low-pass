import type { RoomView, RoomMembership } from '../../shared/protocol/rooms.js';
import { RoomClient, RoomClientError } from '../../src/network/room-client.js';
import { RtcFixture } from './rtc.js';

type Mode = 'direct' | 'auto' | 'udp' | 'tcp' | 'tls';
class DiagnosticError extends Error {}
export class ConnectivityDiagnostic {
  private readonly api = new RoomClient();
  private member: RoomMembership | null = null;
  private invitation: string | null = null;
  private fixture: RtcFixture | null = null;
  private timer: ReturnType<typeof setInterval>;
  private polling = false;
  private busy = false;
  private starting = false;
  private closing = false;
  private lastRoomPoll = 0;
  private lastProbe = 0;
  private generation = 1;
  private sentPlan: { digest: string; bytes: number } | null = null;
  private error: string | null = null;
  private selectedMode: Mode = 'direct';
  constructor(private readonly changed: () => void) {
    this.timer = setInterval(() => { void this.poll(); }, 250);
  }
  private async action(work: () => Promise<void>) {
    if (this.busy) { this.error = 'Another diagnostic operation is running.'; this.changed(); return; }
    this.busy = true;
    this.error = null;
    this.changed();
    try { await work(); }
    catch (error) { this.error = error instanceof DiagnosticError || error instanceof RoomClientError ? error.message : 'Diagnostic operation failed (details withheld).'; }
    finally { this.busy = false; this.changed(); }
  }
  host(accessCode: string) { return this.action(async () => {
    if (this.member) throw new DiagnosticError('Leave the current room first.');
    const grant = await this.api.authorize(accessCode);
    const created = await this.api.create(grant.capability);
    this.member = { capability: created.capability, room: created.room }; this.invitation = created.invitation;
  }); }
  join(invitation: string) { return this.action(async () => {
    if (this.member) throw new DiagnosticError('Leave the current room first.');
    this.member = await this.api.join(invitation);
  }); }
  admit() { return this.action(async () => {
    if (!this.member?.room.guestId) throw new DiagnosticError('No guest awaiting admission.');
    const response = await this.api.admit(this.member.capability, this.member.room.guestId, true);
    this.member.room = response.room;
  }); }
  connect(mode: Mode) { return this.action(async () => {
    if (!['direct', 'auto', 'udp', 'tcp', 'tls'].includes(mode)) throw new DiagnosticError('Unknown transport.');
    if (!this.member || this.member.room.state !== 'admitted' || this.fixture) throw new DiagnosticError('Admit both players before connecting once.');
    this.selectedMode = mode;
    let iceServers: RTCIceServer[] = [];
    if (mode !== 'direct') {
      const config = await this.api.ice(this.member.capability);
      iceServers = config.iceServers.map(server => ({ ...server, urls: server.urls.filter(url => mode === 'auto' ||
        (mode === 'tls' ? url.startsWith('turns:') : url.startsWith('turn:') && url.endsWith(`?transport=${mode}`))) }))
        .filter(server => server.urls.length > 0);
      if (!iceServers.length) throw new DiagnosticError('Requested transport is not configured.');
    }
    const room = this.member.room;
    this.fixture = new RtcFixture({ role: room.role, roomId: room.roomId, capability: this.member.capability,
      generation: this.generation, epoch: 0, iceServers, relayOnly: mode !== 'direct' && mode !== 'auto' });
    await this.fixture.ready;
  }); }
  probe() { return this.action(async () => {
    if (this.fixture?.peer?.status !== 'open') throw new DiagnosticError('Connection is not open.');
    this.fixture.command();
  }); }
  plan() { return this.action(async () => {
    if (this.member?.room.role !== 'host' || this.fixture?.peer?.status !== 'open' || this.sentPlan) {
      throw new DiagnosticError('An open host connection can send one plan per test.');
    }
    this.sentPlan = await this.fixture.plan();
  }); }
  private async poll() {
    if (this.polling || this.closing || !this.member) return;
    this.polling = true;
    const member = this.member;
    try {
      if (performance.now() - this.lastRoomPoll >= 2000) {
        this.lastRoomPoll = performance.now();
        const current = await this.api.status(member.capability);
        if (this.member !== member || this.closing) return;
        this.member.room = current.room;
      }
      if (this.member.room.role === 'host' && this.fixture?.peerPresent && this.fixture.peer && !this.starting) {
        this.starting = true; await this.fixture.peer.start();
      }
      if (this.fixture?.peer?.status === 'open' && performance.now() - this.lastProbe >= 1000) {
        this.lastProbe = performance.now(); this.fixture.probe();
      }
    } catch (error) { this.error = error instanceof DiagnosticError || error instanceof RoomClientError ? error.message : 'Connection setup failed (details withheld).'; }
    finally { this.polling = false; this.changed(); }
  }
  async report() {
    return { role: this.member?.room.role ?? null, roomState: this.member?.room.state ?? null, mode: this.selectedMode,
      connection: await this.fixture?.peer?.diagnostics() ?? null,
      commandReceived: this.fixture?.messages.some(m => m.type === 'command') ?? false,
      rttSamples: this.fixture?.rttMs.length ?? 0,
      maximumRttMs: this.fixture?.rttMs.length ? Math.max(...this.fixture.rttMs) : null,
      transferReceiveMs: this.fixture?.transferReceiveMs ?? null,
      sentPlan: this.sentPlan, receivedPlan: this.fixture?.received ?? null,
      backpressure: this.fixture?.backpressure ?? 0, errors: [...new Set(this.fixture?.errors ?? [])], error: this.error };
  }
  view(): { room: RoomView | null; invitation: string | null; prepared: boolean; busy: boolean } {
    return { room: this.member?.room ?? null, invitation: this.invitation, prepared: this.fixture !== null, busy: this.busy };
  }
  leave() { return this.action(async () => {
    this.closing = true;
    try {
      await this.fixture?.close();
      if (this.member) await this.api.leave(this.member.capability);
    } finally {
      this.member = null; this.fixture = null; this.invitation = null; this.starting = false;
      this.sentPlan = null; this.closing = false; this.generation = 1;
    }
  }); }
  dispose() { clearInterval(this.timer); return this.leave(); }
}

declare global { interface Window { connectivity: ConnectivityDiagnostic } }
const element = <T extends HTMLElement>(id: string) => {
  const value = document.getElementById(id);
  if (!value) throw new Error('Missing diagnostic control.');
  return value as T;
};
let painting = false;
let repaint = false;
const diagnostic = window.connectivity = new ConnectivityDiagnostic(() => { void render(); });
async function render() {
  if (painting) { repaint = true; return; }
  painting = true;
  try {
    const { room, invitation, prepared, busy } = diagnostic.view(), report = await diagnostic.report();
    element('room').textContent = room ? `${room.role}: ${room.state}${invitation ? ` - Invitation: ${invitation}` : ''}` : 'No room.';
    element('report').textContent = JSON.stringify(report, null, 2);
    element('error').textContent = report.error ?? '';
    element<HTMLButtonElement>('admit').disabled = busy || room?.role !== 'host' || room.state !== 'pending';
    element<HTMLButtonElement>('connect').disabled = busy || room?.state !== 'admitted' || prepared;
    element<HTMLButtonElement>('host').disabled = element<HTMLButtonElement>('join').disabled = busy || room !== null;
    element<HTMLSelectElement>('mode').disabled = prepared;
    element<HTMLButtonElement>('probe').disabled = busy || report.connection?.status !== 'open';
    element<HTMLButtonElement>('plan').disabled = busy || report.connection?.status !== 'open' || room?.role !== 'host' || report.sentPlan !== null;
    element<HTMLButtonElement>('leave').disabled = busy || room === null;
  } finally { painting = false; if (repaint) { repaint = false; void render(); } }
}
element('host').onclick = () => {
  const input = element<HTMLInputElement>('access'), value = input.value; input.value = '';
  void diagnostic.host(value);
};
element('join').onclick = () => { void diagnostic.join(element<HTMLInputElement>('invitation').value); };
element('admit').onclick = () => { void diagnostic.admit(); };
element('connect').onclick = () => { void diagnostic.connect(element<HTMLSelectElement>('mode').value as Mode); };
element('probe').onclick = () => { void diagnostic.probe(); };
element('plan').onclick = () => { void diagnostic.plan(); };
element('leave').onclick = () => { void diagnostic.leave(); };
void render();
