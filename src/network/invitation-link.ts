import { invitationRequest } from '../../shared/protocol/rooms.js';

function normalize(value: string): string | null {
  const parsed = invitationRequest.safeParse({ invitation: value });
  if (!parsed.success) return null;
  const code = parsed.data.invitation;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
export interface InvitationLink { invitation: string | null; error: string | null }
export function takeInvitationLink(href: string, replace: (url: string) => void): InvitationLink | null {
  const url = new URL(href);
  if (url.hash !== '#join' && !url.hash.startsWith('#join=')) return null;
  const fragment = url.hash.slice(1);
  url.hash = '';
  replace(url.pathname + url.search);
  const params = new URLSearchParams(fragment.length <= 64 ? fragment : '');
  const invitation = params.size === 1 && params.has('join') ? normalize(params.get('join')!) : null;
  return { invitation, error: invitation ? null : 'This join link is invalid. Ask the host for a new invitation.' };
}
export function invitationLink(invitation: string, href: string): string {
  const code = normalize(invitation);
  if (!code) throw new Error('Invalid invitation for a join link.');
  const url = new URL(href);
  url.username = ''; url.password = ''; url.search = ''; url.hash = `join=${code}`;
  return url.href;
}
