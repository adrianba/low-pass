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
  if (players[localSlot].eliminated) return frame.viewedSlot === localSlot ? 'AIRCRAFT LOST' : 'SPECTATING';
  if (frame.aircraft[localSlot].bomb) return 'BOMB IN FLIGHT';
  if (frame.aircraft[localSlot].released) return 'BOMB RELEASED';
  return frame.ready && frame.viewedSlot === localSlot ? 'SPACE TO RELEASE' : 'STAND BY';
}

export function matchPlayerStatus(player: MatchPlayerDisplay, time: number): string {
  if (player.eliminated) return 'FLIGHT ENDED';
  if (player.result && time >= player.result.time && time - player.result.time < 3) {
    return player.result.points > 0 ? `HIT +${player.result.points}` : 'MISS';
  }
  return player.misses === 0 ? 'AIRFRAME OK' : player.misses === 1 ? 'AIRFRAME DAMAGED' : 'CRITICAL DAMAGE';
}
