import { describe, expect, it } from 'vitest';
import { STEP } from '../../src/config/game';
import { planFormation } from '../../src/game/formation/approved';
import type { FormationPlan } from '../../src/game/formation/approved';
import { FormationScheduler, MAX_SCHEDULE_WORK } from '../../src/game/multiplayer/scheduler';
import type { FormationAuthor } from '../../src/game/multiplayer/scheduler';
import { latestBombSettlement, MIN_SCHEDULE_DURATION } from '../../src/game/multiplayer/schedule-bounds';
import { MAX_SESSION_PLANS } from '../../src/game/multiplayer/session';
import { advanceBomb, contactAccuracy, predictImpact } from '../../src/simulation/ballistics';
import { launchFrom } from '../../src/simulation/pose';
import { surfaceFor } from '../../src/terrain/surface';

const slots = [0, 1] as const;

describe('bounded rolling formation schedule', () => {
  it.each(['green-valley', 'desert', 'river-canyon'] as const)(
    'runs 33 sequential %s passes with shared difficulty and conservative settlement bounds', terrain => {
      const requests: number[] = [];
      const author: FormationAuthor = request => { requests.push(request.count); return planFormation(request); };
      const scheduler = new FormationScheduler(terrain, 7, author), surface = surfaceFor(terrain);
      let minimumDuration = Infinity, maximumHistory = 0;
      for (let sequence = 0; sequence < 33; sequence++) {
        expect(scheduler.sequence).toBe(sequence);
        const plan = scheduler.plan();
        minimumDuration = Math.min(minimumDuration, plan.handoffAt - plan.startAt);
        for (const slot of slots) {
          const attempt = plan.attempts[slot];
          const deadline = scheduler.plan(sequence + 1).attempts[slot];
          expect(latestBombSettlement(plan, slot)).toBeLessThan(deadline.releaseAt + deadline.acquisition.deadline);
          for (const fraction of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
            const time = attempt.acquireAt + fraction * (attempt.cutoffAt - attempt.acquireAt);
            const bomb = launchFrom(attempt.track.at(time - attempt.releaseAt));
            let steps = 0;
            while (!advanceBomb(bomb, STEP, surface)) {
              if (++steps >= 2400) throw new Error('Unbounded test bomb.');
            }
            expect(time + (steps + 1) * STEP).toBeLessThanOrEqual(latestBombSettlement(plan, slot));
          }
          const miss = slot === 0 ? sequence === 3 || sequence === 7 : sequence === 5 || sequence === 11;
          if (miss) continue;
          const releaseAt = attempt.releaseAt + ((sequence + slot) % 3 - 1) * STEP / 2;
          const prediction = predictImpact(launchFrom(attempt.track.at(releaseAt - attempt.releaseAt)), surface);
          expect(contactAccuracy(prediction, plan.target, surface)).toBeGreaterThan(0);
          scheduler.advanceTo(releaseAt);
          expect(scheduler.session.release(slot, sequence)).toEqual({ ok: true });
        }
        const incoming = scheduler.plan(sequence + 1);
        const pose = incoming.attempts[0].track.at(incoming.startAt - incoming.attempts[0].releaseAt);
        scheduler.advanceTo(plan.handoffAt);
        expect(scheduler.session.pose(0)).toEqual(pose);
        expect(scheduler.session.status).toBe('running');
        expect(scheduler.sequence).toBe(sequence + 1);
        expect(scheduler.retainedSequences).toEqual(scheduler.session.snapshot().encounters.map(e => e.sequence));
        maximumHistory = Math.max(maximumHistory, scheduler.retainedSequences.length);
        expect(maximumHistory).toBeLessThanOrEqual(MAX_SESSION_PLANS);
        expect(requests).toEqual(Array.from({ length: sequence + 3 }, (_, i) => i));
        expect(scheduler.session.snapshot().players.every(p => p.misses <= 2 && !p.completion)).toBe(true);
        scheduler.session.drainEvents();
      }
      expect(minimumDuration).toBeGreaterThanOrEqual(MIN_SCHEDULE_DURATION);
      expect(scheduler.session.snapshot().players.map(p => p.misses)).toEqual([2, 2]);
      console.info('Schedule envelope', { terrain, minimumDuration, maximumHistory, authored: requests.length });
    }, 120_000,
  );

  it.each(slots)('authors both motion anchors after player %i dies without reviving or waiting for them', dead => {
    const survivor = dead === 0 ? 1 : 0, scheduler = new FormationScheduler('river-canyon', 7);
    let frozen = null;
    for (let sequence = 0; sequence < 7; sequence++) {
      const plan = scheduler.plan();
      scheduler.advanceTo(plan.attempts[survivor].releaseAt);
      expect(scheduler.session.release(survivor, sequence).ok).toBe(true);
      scheduler.advanceTo(plan.handoffAt);
      if (sequence === 2) frozen = scheduler.session.pose(dead);
      if (sequence >= 2) {
        expect(scheduler.session.pose(dead)).toEqual(frozen);
        expect(scheduler.session.snapshot().players[dead]!.misses).toBe(3);
        expect(scheduler.session.snapshot().encounters.at(-1)!.attempts[dead]!.skipped).toBe(true);
        expect(scheduler.plan().attempts[dead].track.at(scheduler.session.time - scheduler.plan().attempts[dead].releaseAt).position)
          .not.toEqual(frozen!.position);
      }
      scheduler.session.drainEvents();
    }
    expect(scheduler.session.status).toBe('running');
    expect(scheduler.session.snapshot().players[survivor]!.score).toBe(700);
    for (let i = 0; i < 3; i++) {
      const plan = scheduler.plan();
      scheduler.advanceTo(plan.handoffAt);
      scheduler.session.drainEvents();
    }
    expect(scheduler.session.status).toBe('over');
    expect(scheduler.session.winner).toBe(survivor);
  }, 120_000);

  it('retains a late follower bomb and its old target while the next shared encounter is active', () => {
    const scheduler = new FormationScheduler('green-valley', 7), old = scheduler.plan();
    scheduler.advanceTo(old.attempts[1].cutoffAt);
    expect(scheduler.session.release(1, 0).ok).toBe(true);
    const prediction = predictImpact(launchFrom(old.attempts[1].track.at(old.attempts[1].cutoffAt - old.attempts[1].releaseAt)));
    scheduler.advanceTo(old.handoffAt);
    expect(scheduler.sequence).toBe(1);
    expect(scheduler.session.snapshot().players[1]!.bomb!.sequence).toBe(0);
    expect(scheduler.retainedSequences).toContain(0);
    scheduler.advanceTo(latestBombSettlement(old, 1));
    const event = scheduler.session.drainEvents().find(e => e.type === 'resolved' && e.result.slot === 1);
    expect(event).toMatchObject({ type: 'resolved', result: { sequence: 0, slot: 1, impact: prediction } });
    const current = scheduler.plan();
    scheduler.advanceTo(current.attempts[1].releaseAt);
    expect(scheduler.session.release(1, 1)).toEqual({ ok: true });
  });

  it('freezes the scheduler on pause and stops authoring when both players are eliminated', () => {
    let authored = 0;
    const scheduler = new FormationScheduler('green-valley', 7, request => { authored++; return planFormation(request); });
    scheduler.session.pause();
    const snapshot = scheduler.session.snapshot();
    expect(scheduler.advanceTo(60)).toEqual({ ok: false, reason: 'paused' });
    expect(scheduler.session.snapshot()).toEqual(snapshot);
    expect(authored).toBe(2);
    scheduler.session.resume();
    scheduler.advanceTo(60);
    expect(scheduler.session.status).toBe('over');
    expect(scheduler.session.winner).toBe('draw');
    expect(authored - 2).toBeLessThanOrEqual(MAX_SCHEDULE_WORK);
    const count = authored, time = scheduler.session.time;
    expect(scheduler.advanceTo(time + 1)).toEqual({ ok: false, reason: 'over' });
    expect(authored).toBe(count);
    expect(scheduler.session.time).toBe(time);
    expect(() => scheduler.advanceTo(time - 1)).toThrow('advance');
  });

  it('fails and freezes explicitly when bounded lookahead authoring exhausts its candidates', () => {
    const scheduler = new FormationScheduler('green-valley', 7, request => request.count === 2
      ? { ok: false, failures: [{ candidate: 0, reason: 'intercept', detail: 'Injected bounded authoring failure.' }] }
      : planFormation(request));
    const next = scheduler.plan(1);
    expect(() => scheduler.advanceTo(scheduler.plan().handoffAt)).toThrow('Injected bounded authoring failure');
    expect(scheduler.session.time).toBe(next.startAt);
    expect(scheduler.session.status).toBe('paused');
    expect(scheduler.failure).toContain('encounter 2');
    expect(scheduler.session.pose(0)).toEqual(next.attempts[0].track.at(next.startAt - next.attempts[0].releaseAt));
    expect(scheduler.advanceTo(next.startAt + STEP)).toEqual({ ok: false, reason: 'blocked' });
  });

  it('rejects a plan outside the proven retention envelope before publishing or advancing it', () => {
    let invalid: FormationPlan | null = null;
    const scheduler = new FormationScheduler('green-valley', 7, request => {
      const result = planFormation(request);
      if (request.count !== 2 || !result.ok) return result;
      if (result.plan.terrain === 'river-canyon') throw new Error('Expected valley fixture.');
      const changed = { ...result.plan, handoffAt: result.plan.startAt + MIN_SCHEDULE_DURATION - STEP };
      invalid = changed;
      return { ok: true, plan: changed };
    });
    expect(() => scheduler.advanceTo(scheduler.plan().handoffAt)).toThrow('history budget');
    expect(invalid).not.toBeNull();
    expect(scheduler.session.status).toBe('paused');
    expect(scheduler.retainedSequences).toEqual([0, 1]);
    expect(scheduler.failure).toContain('incomplete');
    expect(scheduler.advanceTo(scheduler.session.time + STEP)).toEqual({ ok: false, reason: 'blocked' });
  });
});
