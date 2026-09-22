import { z } from 'zod';
import { MAX_CAMERA_SAMPLES, MAX_EFFECTS, MAX_ENCOUNTER_SEQUENCE, MAX_PLANS, MAX_SESSION_SECONDS,
  MAX_TRACK_COMPONENT, MAX_TRACK_DURATION, MAX_TRACK_KNOTS, MIN_TRACK_INTERVAL, PHYSICS_HZ, PROTOCOL_VERSION } from './limits.js';

export const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const sequence = z.number().int().min(0).max(MAX_ENCOUNTER_SEQUENCE);
export const seconds = z.number().min(0).max(MAX_SESSION_SECONDS);
export const component = z.number().min(-MAX_TRACK_COMPONENT).max(MAX_TRACK_COMPONENT);
export const localTime = z.number().min(-MAX_TRACK_DURATION).max(MAX_TRACK_DURATION);
export const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const slot = z.union([z.literal(0), z.literal(1)]);
export const terrain = z.enum(['green-valley', 'desert', 'river-canyon']);
export const vector = z.strictObject({ x: component, y: component, z: component });
export const pose = z.strictObject({
  position: vector, velocity: vector, acceleration: vector,
  bank: z.number().min(-Math.PI).max(Math.PI), pitch: z.number().min(-Math.PI).max(Math.PI),
});
export const view = z.strictObject({ position: vector, target: vector }).refine(v =>
  Math.hypot(v.position.x - v.target.x, v.position.y - v.target.y, v.position.z - v.target.z) >= 1e-6);
export const stamp = z.strictObject({
  tick: z.number().int().min(0).max(MAX_SESSION_SECONDS * PHYSICS_HZ),
  fraction: z.number().min(0).lt(1),
}).refine(v => v.tick < MAX_SESSION_SECONDS * PHYSICS_HZ || v.fraction === 0);
export type Stamp = z.infer<typeof stamp>;

export function stampAt(time: number): Stamp {
  const scaled = seconds.parse(time) * PHYSICS_HZ, tick = Math.floor(scaled);
  return stamp.parse({ tick, fraction: scaled - tick });
}
export function secondsAt(time: Stamp): number { const value = stamp.parse(time); return (value.tick + value.fraction) / PHYSICS_HZ; }

export const compatibility = z.strictObject({
  protocol: z.literal(PROTOCOL_VERSION), build: digest, assets: digest,
  rules: digest, generator: digest, formationProfile: z.literal(1), physicsHz: z.literal(PHYSICS_HZ),
});
export const manifest = z.strictObject({
  compatibility, terrain, seed: z.number().int().min(0).max(2147483647),
  grid: z.union([z.literal(8), z.literal(16)]), triangle: z.literal('shared-diagonal-v1'),
}).refine(v => v.grid === (v.terrain === 'river-canyon' ? 8 : 16));
export const reference = z.strictObject({ id: identifier, digest });
export const track = z.strictObject({
  version: z.literal(1),
  knots: z.array(z.strictObject({ phase: localTime, time: localTime, pose })).min(2).max(MAX_TRACK_KNOTS),
}).refine(v => v.knots.some(k => k.phase === 0 && k.time === 0) &&
  v.knots.at(-1)!.time - v.knots[0]!.time <= MAX_TRACK_DURATION &&
  v.knots.every((k, i) => i === 0 || (k.phase > v.knots[i - 1]!.phase && k.time - v.knots[i - 1]!.time >= MIN_TRACK_INTERVAL)));
export const camera = z.array(z.strictObject({ time: localTime, position: vector, target: vector })
  .refine(v => view.safeParse({ position: v.position, target: v.target }).success)).min(2).max(MAX_CAMERA_SAMPLES)
  .refine(v => v.every((s, i) => i === 0 || s.time > v[i - 1]!.time));
const acquisition = z.strictObject({
  target: vector, range: z.number().positive().max(3500),
  viewport: z.strictObject({ minAspect: z.literal(0.75), maxAspect: z.literal(2) }),
  earliest: localTime, deadline: localTime, margin: z.number().min(1 / PHYSICS_HZ).max(0.5),
}).refine(v => v.deadline - v.earliest >= v.margin);
const attempt = (player: 0 | 1) => z.strictObject({
  slot: z.literal(player), acquireAt: seconds, releaseAt: seconds, cutoffAt: seconds, endAt: seconds,
  track, camera, acquisition,
}).refine(v => v.acquireAt <= v.releaseAt && v.releaseAt < v.cutoffAt && v.cutoffAt < v.endAt);
export const formation = z.strictObject({
  version: z.literal(1), sequence, encounterId: identifier, terrain, target: vector,
  targetKind: z.enum(['tank', 'radar', 'sam']), radius: z.literal(28),
  startAt: seconds, handoffAt: seconds, coverageEndAt: seconds,
  attempts: z.tuple([attempt(0), attempt(1)]),
}).refine(v => v.startAt < v.handoffAt && v.coverageEndAt - v.handoffAt >= 5.5 - 1e-8 &&
  v.attempts.every(a => a.acquireAt >= v.startAt && a.endAt <= v.handoffAt &&
    a.track.knots[0]!.time <= v.startAt - a.releaseAt &&
    a.track.knots.at(-1)!.time >= v.coverageEndAt - a.releaseAt &&
    a.camera[0]!.time <= v.startAt - a.releaseAt && a.camera.at(-1)!.time >= v.coverageEndAt - a.releaseAt &&
    a.acquisition.earliest >= a.camera[0]!.time && a.acquisition.deadline <= a.camera.at(-1)!.time &&
    a.acquisition.target.x === v.target.x && a.acquisition.target.y === v.target.y && a.acquisition.target.z === v.target.z));

const entry = z.strictObject({ start: pose, startAt: localTime, endAt: localTime });
const nextTrack = z.strictObject({ age: z.number().min(0).max(2.8), from: localTime, offset: localTime, track });
const trackedMotion = z.strictObject({
  version: z.literal(1), kind: z.literal('track'), start: pose, style: z.enum(['canyon', 'formation']),
  offset: localTime, track, entry: entry.nullable(), next: nextTrack.nullable().optional(),
}).refine(v => v.offset >= (v.entry?.startAt ?? v.track.knots[0]!.time) &&
  (v.next?.from ?? v.offset + 2.8) <= v.track.knots.at(-1)!.time &&
  (!v.entry || (v.style === 'canyon' && v.entry.endAt - v.entry.startAt >= MIN_TRACK_INTERVAL &&
    v.entry.endAt >= v.track.knots[0]!.time && v.entry.endAt <= v.track.knots.at(-1)!.time)) &&
  (!v.next || (!v.entry && Math.abs(v.offset + v.next.age - v.next.from) <= 1e-7 &&
    v.next.from >= v.track.knots[0]!.time && v.next.offset >= v.next.track.knots[0]!.time &&
    v.next.offset + 2.8 - v.next.age <= v.next.track.knots.at(-1)!.time)));
const motion = z.discriminatedUnion('kind', [
  z.strictObject({ version: z.literal(1), kind: z.literal('tangent'), start: pose }), trackedMotion,
]);
const canyonCurve = z.strictObject({
  version: z.literal(1), launch: vector, intercept: vector, along: component, targetAlong: component,
  lateral: component, targetLateral: component, forward: z.number().min(0).max(MAX_TRACK_COMPONENT),
  power: z.union([z.literal(2), z.literal(3), z.literal(4)]), arrival: z.literal(1.7), duration: z.literal(2.8),
});
export const combat = z.strictObject({
  version: z.literal(1), id: counter, slot, sequence, bornAt: seconds,
  damageLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]), view,
  missile: z.strictObject({
    version: z.literal(1), kind: z.enum(['flyby', 'damage', 'finale']),
    side: z.union([z.literal(-1), z.literal(1)]), motion,
    curve: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('valley'), launch: vector, intercept: vector, control: vector }),
      z.strictObject({ kind: z.literal('canyon'), plan: canyonCurve }),
    ]),
  }),
}).refine(v => v.id === v.sequence * 2 + v.slot + 1 &&
  (v.missile.kind !== 'finale' || v.damageLevel === 2) && (v.missile.kind !== 'damage' || v.damageLevel > 0) &&
  ((v.missile.motion.kind === 'track' && v.missile.motion.style === 'canyon') === (v.missile.curve.kind === 'canyon')));

export const contact = z.strictObject({ x: component, y: component, z: component,
  kind: z.enum(['ground', 'water']), normal: vector });
const score = z.number().int().min(0).max((MAX_ENCOUNTER_SEQUENCE + 1) * 100);
export const result = z.strictObject({
  id: counter, slot, sequence, time: seconds, points: z.number().int().min(0).max(100), impact: contact.nullable(),
  score, misses: z.number().int().min(0).max(3), assisted: z.boolean(),
}).refine(v => v.id === v.sequence * 2 + v.slot + 1 && v.score >= v.points && v.score <= (v.sequence + 1) * 100 &&
  v.misses <= v.sequence + 1 && (v.points === 0 ? v.misses > 0 : v.impact?.kind === 'ground' && v.misses < 3));
const player = (id: 0 | 1) => z.strictObject({
  slot: z.literal(id), score, misses: z.number().int().min(0).max(3),
  assistance: z.boolean(), assisted: z.boolean(), eliminated: z.boolean(),
  bomb: z.strictObject({ sequence, releasedAt: stamp, position: vector, velocity: vector }).nullable(),
}).refine(v => v.eliminated === (v.misses === 3) && (!v.assistance || v.assisted) && (!v.eliminated || v.bomb === null));
export const snapshot = z.strictObject({
  at: stamp, status: z.enum(['running', 'paused', 'blocked', 'over']), planRevision: counter,
  eventSequence: counter, lastInputs: z.tuple([counter, counter]),
  plans: z.array(reference).min(1).max(MAX_PLANS),
  effects: z.array(z.strictObject({ ...reference.shape, bornAt: seconds })).max(MAX_EFFECTS),
  wrecks: z.array(identifier).max(MAX_PLANS),
  players: z.tuple([player(0), player(1)]), winner: z.union([slot, z.literal('draw')]).nullable(),
}).refine(v => new Set(v.plans.map(p => p.id)).size === v.plans.length &&
  new Set(v.effects.map(e => e.id)).size === v.effects.length && new Set(v.wrecks).size === v.wrecks.length &&
  v.wrecks.every(id => v.plans.some(p => p.id === id)) &&
  (v.status === 'over' ? v.players.every(p => p.eliminated) &&
    v.winner === (v.players[0].score === v.players[1].score ? 'draw' : v.players[0].score > v.players[1].score ? 0 : 1) :
    v.winner === null && !v.players.every(p => p.eliminated)));
export const payload = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('formation'), data: formation }),
  z.strictObject({ kind: z.literal('combat'), data: combat }),
  z.strictObject({ kind: z.literal('checkpoint'), data: z.strictObject({
    version: z.literal(1), sessionId: identifier, epoch: counter, snapshotSequence: counter, manifest, state: snapshot,
  }) }),
]);
export type Payload = z.infer<typeof payload>;
export type Snapshot = z.infer<typeof snapshot>;
export type Compatibility = z.infer<typeof compatibility>;
