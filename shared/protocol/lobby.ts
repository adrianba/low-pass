import { z } from 'zod';
import { counter, terrain } from './game.js';

export const lobbyInput = z.strictObject({
  sequence: counter.min(1), revision: counter,
  choice: z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('assistance'), enabled: z.boolean() }),
    z.strictObject({ action: z.literal('ready'), enabled: z.boolean() }),
  ]),
});
export const lobbyState = z.strictObject({
  update: counter.min(1), revision: counter, terrain,
  assistance: z.tuple([z.boolean(), z.boolean()]), ready: z.tuple([z.boolean(), z.boolean()]),
  guestConfigured: z.boolean(), guestInputSequence: counter,
}).refine(value => value.guestConfigured ? value.guestInputSequence > 0 : value.guestInputSequence === 0 && !value.ready.some(Boolean));
export type LobbyInput = z.infer<typeof lobbyInput>;
export type LobbyState = z.infer<typeof lobbyState>;
export type LobbyOutput = { type: 'lobby-state'; state: LobbyState } | { type: 'lobby-input'; input: LobbyInput };
