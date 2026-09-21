export const MISSILE_INTERCEPT_TIME = 1.7;
export const FLYBY_DURATION = 2.8;
export const FINALE_DURATION = 5.5;
export const FLYBY_CLEARANCE = 18;
export type MissileKind = 'flyby' | 'damage' | 'finale';
export type CombatCue = 'missile' | 'flyby' | 'damaged' | 'destroyed';
export type FinalePhase = 'incoming' | 'destroyed' | 'complete';
