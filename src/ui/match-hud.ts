import type { MatchDisplay, MatchPlayerDisplay } from '../network/match-display.js';
import type { SharedWorldFrame } from '../rendering/shared-frame.js';
import { contactAccuracy, predictImpact } from '../simulation/ballistics.js';
import { launchFrom } from '../simulation/pose.js';
import { surfaceFor } from '../terrain/surface.js';

export function matchPrediction(display: MatchDisplay): SharedWorldFrame['prediction'] {
  const { frame, localSlot, players } = display;
  if (!players[localSlot].assistance || players[localSlot].eliminated ||
    frame.viewedSlot !== localSlot || !frame.ready || frame.aircraft[localSlot].destroyed ||
    frame.aircraft[localSlot].released) return null;
  const target = frame.targets.at(-1);
  if (!target) throw new Error('Missing displayed target for impact assistance.');
  const surface = surfaceFor(frame.terrain);
  const contact = predictImpact(launchFrom(frame.aircraft[localSlot].pose), surface);
  return { position: contact, hit: contact.kind === 'ground' && contactAccuracy(contact, target.position, surface) > 0 };
}

export function matchReleaseStatus(display: MatchDisplay): string {
  const { frame, localSlot, players } = display;
  if (players.every(player => player.eliminated)) return 'FINAL FLIGHT';
  if (players[localSlot].eliminated) return frame.viewedSlot === localSlot ? 'AIRCRAFT LOST' : 'SPECTATING';
  if (frame.aircraft[localSlot].bomb) return 'BOMB IN FLIGHT';
  if (frame.aircraft[localSlot].released) return 'BOMB RELEASED';
  return frame.ready && frame.viewedSlot === localSlot ? 'SPACE TO RELEASE' : 'STAND BY';
}

export function matchViewStatus({ frame, localSlot, players }: MatchDisplay): string {
  const label = players[frame.viewedSlot].eliminated ? 'FINAL FLIGHT'
    : frame.viewedSlot === localSlot ? 'YOUR AIRCRAFT' : 'SPECTATING';
  return `${label} / PLAYER ${frame.viewedSlot + 1}`;
}

export function matchParticipationStatus({ frame, localSlot, players }: MatchDisplay): string {
  if (players.every(player => player.eliminated)) return 'Both flights have ended.';
  const other = localSlot === 0 ? 1 : 0;
  if (!players[localSlot].eliminated) return players[other].eliminated
    ? `Player ${other + 1} is out. Your flight continues on the same path.` : '';
  const next = frame.viewedSlot === localSlot ? `Following Player ${other + 1} after your finale.` : `Watch Player ${other + 1} finish their flight.`;
  return `You are out. ${next}${localSlot === 0 ? ' Keep this tab open: it still runs the shared flight.' : ''}`;
}

export function matchPlayerStatus(player: MatchPlayerDisplay, time: number): string {
  if (player.eliminated) return 'FLIGHT ENDED';
  if (player.result && time >= player.result.time && time - player.result.time < 3) {
    return player.result.points > 0 ? `HIT +${player.result.points}` : 'MISS';
  }
  return player.misses === 0 ? 'AIRFRAME OK' : player.misses === 1 ? 'AIRFRAME DAMAGED' : 'CRITICAL DAMAGE';
}
