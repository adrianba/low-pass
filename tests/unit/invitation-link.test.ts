import { describe, expect, it, vi } from 'vitest';
import { invitationLink, takeInvitationLink } from '../../src/network/invitation-link.js';

describe('private invitation links', () => {
  it('normalizes a fragment invitation and removes it without changing unrelated history parameters', () => {
    const replace = vi.fn();
    expect(takeInvitationLink('https://game.example/play?view=room#join=abcd-efgh', replace))
      .toEqual({ invitation: 'ABCD-EFGH', error: null });
    expect(replace).toHaveBeenCalledExactlyOnceWith('/play?view=room');
  });
  it('clears malformed, duplicate and oversized invitations without returning their contents', () => {
    for (const fragment of ['join', 'join=wrong', 'join=ABCD-EFGH&join=JKLM-NPQR', 'join=%E0', 'join=' + 'A'.repeat(10000)]) {
      const replace = vi.fn();
      expect(takeInvitationLink('https://game.example/#' + fragment, replace))
        .toEqual({ invitation: null, error: 'This join link is invalid. Ask the host for a new invitation.' });
      expect(replace).toHaveBeenCalledExactlyOnceWith('/');
    }
    const replace = vi.fn();
    expect(takeInvitationLink('https://game.example/#records', replace)).toBeNull();
    expect(takeInvitationLink('https://game.example/#joining', replace)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
  it('puts only the invitation in a copied link and drops query/user-info credentials', () => {
    expect(invitationLink('abcd-efgh', 'https://user:password@game.example/room-controls.html?credential=private#old'))
      .toBe('https://game.example/room-controls.html#join=ABCD-EFGH');
    expect(() => invitationLink('not-a-code', 'https://game.example/')).toThrow('Invalid invitation');
  });
});
