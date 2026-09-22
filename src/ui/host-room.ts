import { RoomSession } from '../network/room-session.js';
import type { RoomSessionState } from '../network/room-session.js';
import { invitationLink } from '../network/invitation-link.js';

export class HostRoomPanel {
  readonly session: RoomSession;
  private disposed = false;
  constructor(private readonly root: HTMLElement) {
    root.classList.add('room-controls');
    root.innerHTML = `
      <h1>Host a private room</h1>
      <p>Share only the room invitation with your friend. Keep the hosting access code private.</p>
      <form id="host-create">
        <label for="host-code">Hosting access code</label>
        <input id="host-code" type="password" autocomplete="off" maxlength="256" required aria-describedby="host-code-note">
        <p id="host-code-note">Use the separate hosting code, not a room invitation or the TURN secret.</p>
        <button id="host-submit" type="submit" class="primary">CREATE ROOM</button>
      </form>
      <section id="host-room" hidden aria-label="Private room">
        <label for="host-invitation">Room invitation</label>
        <input id="host-invitation" readonly autocomplete="off" spellcheck="false">
        <button id="host-copy" type="button" class="secondary">COPY INVITATION</button>
        <label for="host-link">Room join link</label>
        <input id="host-link" readonly autocomplete="off" spellcheck="false">
        <button id="host-copy-link" type="button" class="secondary">COPY JOIN LINK</button>
        <p id="host-expiry"></p>
        <button id="host-renew" type="button" class="secondary">NEW INVITATION</button>
        <div id="host-admission" hidden>
          <p>Player 2 is asking to join. Confirm with your friend before admitting them.</p>
          <button id="host-admit" type="button" class="primary">ADMIT PLAYER 2</button>
          <button id="host-deny" type="button" class="secondary">DECLINE</button>
        </div>
        <button id="host-refresh" type="button" class="secondary">REFRESH ROOM</button>
      </section>
      <p id="host-status" role="status"></p>
      <p id="host-error" role="alert"></p>
      <p id="host-copy-status" role="status"></p>
      <button id="host-recheck" type="button" class="secondary">CHECK SERVICE AGAIN</button>
      <button id="host-cancel" type="button" class="secondary">CANCEL / CLOSE ROOM</button>
    `;
    this.session = new RoomSession('host', () => this.render());
    this.get<HTMLFormElement>('#host-create').onsubmit = event => {
      event.preventDefault();
      const input = this.get<HTMLInputElement>('#host-code'), code = input.value;
      input.value = '';
      void this.session.create(code).then(() => {
        if (!this.disposed) this.get(this.session.state.invitation ? '#host-invitation' : '#host-code').focus();
      });
    };
    this.get('#host-copy').onclick = () => { void this.copy(); };
    this.get('#host-copy-link').onclick = () => { void this.copy(true); };
    this.get('#host-admit').onclick = () => { void this.session.admit(true); };
    this.get('#host-deny').onclick = () => { void this.session.admit(false); };
    this.get('#host-renew').onclick = () => { void this.session.renew(); };
    this.get('#host-refresh').onclick = () => { void this.session.refresh(); };
    this.get('#host-recheck').onclick = () => { void this.check(); };
    this.get('#host-cancel').onclick = () => { void this.cancel(); };
    this.root.ownerDocument.addEventListener('keydown', this.keydown);
    this.render(); void this.check();
  }
  private get<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error('Missing private-room control.');
    return element;
  }
  private text(selector: string, value: string) {
    const element = this.get(selector);
    if (element.textContent !== value) element.textContent = value;
  }
  private async check() {
    await this.session.check();
    if (!this.disposed && this.session.state.availability === 'available') this.get('#host-code').focus();
  }
  private readonly keydown = (event: KeyboardEvent) => {
    if (event.code === 'Escape' && !event.repeat && !event.defaultPrevented &&
      this.root.isConnected && this.root.getClientRects().length) { event.preventDefault(); void this.cancel(); }
  };
  private async cancel() {
    this.get<HTMLInputElement>('#host-code').value = '';
    this.text('#host-copy-status', '');
    await this.session.leave();
    if (!this.disposed) this.get('#host-code').focus();
  }
  private async copy(link = false) {
    const invitation = this.session.state.invitation;
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(link ? invitationLink(invitation, location.href) : invitation);
      if (!this.disposed && this.session.state.invitation === invitation) this.text('#host-copy-status', link ? 'Join link copied.' : 'Invitation copied.');
    } catch {
      if (!this.disposed && this.session.state.invitation === invitation) {
        const input = this.get<HTMLInputElement>(link ? '#host-link' : '#host-invitation');
        input.focus(); input.select();
        this.text('#host-copy-status', `Clipboard unavailable. The ${link ? 'join link' : 'invitation'} is selected; copy it manually.`);
      }
    }
  }
  private render() {
    if (this.disposed) return;
    const state = this.session.state, room = state.room;
    this.root.dataset.roomState = state.closing ? 'closing' : room?.state ?? 'empty';
    this.get('#host-create').hidden = room !== null || state.closing;
    this.get('#host-room').hidden = room === null;
    this.get<HTMLInputElement>('#host-code').disabled = state.busy || state.availability !== 'available';
    this.get<HTMLButtonElement>('#host-submit').disabled = state.busy || state.availability !== 'available';
    const input = this.get<HTMLInputElement>('#host-invitation');
    if (input.value !== (state.invitation ?? '')) { input.value = state.invitation ?? ''; this.text('#host-copy-status', ''); }
    this.get<HTMLButtonElement>('#host-copy').disabled = state.busy || !state.invitation;
    const link = state.invitation ? invitationLink(state.invitation, location.href) : '';
    if (this.get<HTMLInputElement>('#host-link').value !== link) this.get<HTMLInputElement>('#host-link').value = link;
    this.get<HTMLButtonElement>('#host-copy-link').disabled = state.busy || !state.invitation;
    this.get<HTMLButtonElement>('#host-renew').disabled = state.busy || !room || room.state === 'admitted';
    this.get('#host-admission').hidden = room?.state !== 'pending';
    for (const selector of ['#host-admit', '#host-deny', '#host-refresh']) this.get<HTMLButtonElement>(selector).disabled = state.busy;
    this.get('#host-recheck').hidden = !!room || state.availability === 'available';
    this.get<HTMLButtonElement>('#host-recheck').disabled = state.busy;
    this.get<HTMLButtonElement>('#host-cancel').disabled = state.closing;
    this.text('#host-expiry', state.invitation && room
      ? `Invitation expires in about ${Math.ceil(room.invitationExpiresInMs / 1000)} seconds.`
      : room?.state === 'admitted' ? 'Invitations are disabled after admission.' : 'Create a new invitation to invite a friend.');
    this.text('#host-status', this.status(state));
    this.text('#host-error', state.error ?? '');
  }
  private status(state: RoomSessionState): string {
    if (state.closing) return 'Closing the room. Waiting for any outstanding request to finish.';
    if (state.busy) return 'Contacting the private-room service...';
    if (state.room?.state === 'admitted') return 'Both players admitted. Room controls are ready; network gameplay is not yet wired.';
    if (state.room?.state === 'pending') return 'Player 2 is waiting for your admission.';
    if (state.room) return state.invitation ? 'Waiting for your friend to enter the invitation.' : 'Create a new invitation for your friend.';
    return state.availability === 'available' ? 'Ready to create a private room.' : 'Private-room service unavailable. Solo play is unaffected.';
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; this.root.ownerDocument.removeEventListener('keydown', this.keydown);
    this.get<HTMLInputElement>('#host-code').value = '';
    this.root.replaceChildren(); await this.session.dispose();
  }
}
