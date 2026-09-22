import { RoomSession } from '../network/room-session.js';
import type { InvitationLink } from '../network/invitation-link.js';

export class GuestRoomPanel {
  readonly session: RoomSession;
  private disposed = false;
  private linkError: string | null;
  constructor(private readonly root: HTMLElement, link?: InvitationLink | null) {
    this.linkError = link?.error ?? null;
    root.classList.add('room-controls');
    root.innerHTML = `
      <h1>Join a private room</h1>
      <p>Ask your friend for their room invitation. You do not need their hosting access code.</p>
      <form id="guest-join">
        <label for="guest-invitation">Room invitation</label>
        <input id="guest-invitation" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="9" required aria-describedby="guest-invitation-note">
        <p id="guest-invitation-note">Eight letters or numbers, for example ABCD-EFGH. The host must admit you.</p>
        <button id="guest-submit" type="submit" class="primary">ASK TO JOIN</button>
      </form>
      <p id="guest-status" role="status" tabindex="-1"></p>
      <p id="guest-error" role="alert"></p>
      <button id="guest-refresh" type="button" class="secondary" hidden>REFRESH ROOM</button>
      <button id="guest-recheck" type="button" class="secondary">CHECK SERVICE AGAIN</button>
      <button id="guest-cancel" type="button" class="secondary">CANCEL / LEAVE ROOM</button>
    `;
    this.session = new RoomSession('guest', () => this.render());
    this.get<HTMLInputElement>('#guest-invitation').value = link?.invitation ?? '';
    this.get<HTMLFormElement>('#guest-join').onsubmit = event => {
      event.preventDefault();
      const input = this.get<HTMLInputElement>('#guest-invitation'), invitation = input.value;
      input.value = ''; this.linkError = null;
      void this.session.join(invitation).then(() => {
        if (!this.disposed) this.get(this.session.state.room ? '#guest-status' : '#guest-invitation').focus();
      });
    };
    this.get('#guest-refresh').onclick = () => { void this.session.refresh(); };
    this.get('#guest-recheck').onclick = () => { void this.check(); };
    this.get('#guest-cancel').onclick = () => { void this.cancel(); };
    root.addEventListener('keydown', this.keydown);
    this.render(); void this.check();
  }
  private get<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error('Missing private-room control.');
    return element;
  }
  private text(selector: string, text: string) {
    const element = this.get(selector);
    if (element.textContent !== text) element.textContent = text;
  }
  private async check() {
    await this.session.check();
    if (!this.disposed && this.session.state.availability === 'available') this.get('#guest-invitation').focus();
  }
  private readonly keydown = (event: KeyboardEvent) => {
    if (event.code === 'Escape' && !event.repeat) { event.preventDefault(); void this.cancel(); }
  };
  private async cancel() {
    this.get<HTMLInputElement>('#guest-invitation').value = ''; this.linkError = null;
    await this.session.leave();
    if (!this.disposed) this.get('#guest-invitation').focus();
  }
  private render() {
    if (this.disposed) return;
    const state = this.session.state, room = state.room;
    this.root.dataset.roomState = state.closing ? 'closing' : room?.state ?? 'empty';
    this.get('#guest-join').hidden = !!room || state.closing;
    for (const selector of ['#guest-invitation', '#guest-submit']) this.get<HTMLInputElement>(selector).disabled =
      state.busy || state.availability !== 'available';
    this.get('#guest-refresh').hidden = !room;
    this.get<HTMLButtonElement>('#guest-refresh').disabled = state.busy;
    this.get('#guest-recheck').hidden = !!room || state.availability === 'available';
    this.get<HTMLButtonElement>('#guest-recheck').disabled = state.busy;
    this.get<HTMLButtonElement>('#guest-cancel').disabled = state.closing;
    this.text('#guest-error', state.error ?? this.linkError ?? '');
    this.text('#guest-status', state.closing ? 'Leaving the room. Waiting for any outstanding request to finish.'
      : state.busy ? 'Contacting the private-room service...'
        : room?.state === 'admitted' ? 'The host admitted you. Network gameplay is not yet wired.'
          : room ? 'Waiting for the host to admit you. Keep this page open.'
            : state.availability === 'available' ? 'Ready for your friend\'s invitation.'
              : 'Private-room service unavailable. Solo play is unaffected.');
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; this.root.removeEventListener('keydown', this.keydown);
    this.get<HTMLInputElement>('#guest-invitation').value = '';
    this.root.replaceChildren(); await this.session.dispose();
  }
}
