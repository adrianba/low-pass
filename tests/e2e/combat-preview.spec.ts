import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {} from '../fixtures/combat-preview';

test.setTimeout(240_000);
let script: string, html: string;
test.beforeAll(async () => {
  html = await readFile('tests/fixtures/combat-preview.html', 'utf8');
  const result = await build({ configFile: false, logLevel: 'error',
    build: { write: false, lib: { entry: resolve('tests/fixtures/combat-preview.ts'), name: 'CombatPreview', formats: ['iife'] } } });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs.flatMap(o => 'output' in o ? o.output : []).find(o => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Could not build combat preview.');
  script = chunk.code;
});
async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 1100, height: 800 });
  if (!process.env.COMBAT_PREVIEW_MOUNTED) {
    await page.route('**/combat-preview.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
    await page.route('**/combat-preview.html', route => route.fulfill({ contentType: 'text/html', body: html }));
  }
  await page.goto('/combat-preview.html');
  await page.evaluate(() => window.combatPreview.ready());
  return errors;
}
for (const terrain of ['green-valley', 'desert', 'river-canyon'] as const) {
  test(`${terrain}: independent combat, either death order and survivor spectating`, async ({ page }) => {
    const errors = await open(page);
    for (const scenario of ['lead-first', 'follower-first'] as const) {
      const losing: 0 | 1 = scenario === 'lead-first' ? 0 : 1, survivor = losing === 0 ? 1 : 0;
      await page.evaluate(({ terrain, scenario, losing }) => {
        window.combatPreview.view(losing);
        return window.combatPreview.configure({ terrain, scenario });
      }, { terrain, scenario, losing });
      const damaged = await page.evaluate(() => {
        const state = window.combatPreview.snapshot();
        return window.combatPreview.advance(state.handoffAt - state.time);
      });
      expect(damaged.players[losing]).toMatchObject({ misses: 1, damage: 1, visible: true, eliminated: false });
      expect(damaged.players[survivor]).toMatchObject({ score: 100, misses: 0, damage: 0 });
      expect(damaged.smoke[losing]).toBeGreaterThan(0); expect(damaged.smoke[survivor]).toBe(0);
      const spectating = await page.evaluate(losing => {
        for (let i = 0; i < 2; i++) {
          const state = window.combatPreview.snapshot();
          window.combatPreview.advance(state.handoffAt - state.time);
        }
        const state = window.combatPreview.snapshot();
        const finale = state.effects.find(effect => effect.slot === losing && effect.kind === 'finale');
        if (!finale) throw new Error('Missing loser finale.');
        return window.combatPreview.advance(Math.max(0, 1.71 - finale.age));
      }, losing);
      expect(spectating.players[losing]).toMatchObject({ misses: 3, eliminated: true, visible: false });
      expect(spectating.players[survivor]!.eliminated).toBe(false);
      expect(spectating.viewed).toBe(survivor); expect(spectating.status).toBe('paused');
      expect(spectating.cameraError).toBeLessThan(0.001);
      await page.screenshot({ path: `test-results/combat-${terrain}-${scenario}.png` });
      const end = await page.evaluate(() => {
        for (let i = 0; i < 3; i++) {
          const state = window.combatPreview.advance(60);
          if (state.finished) return state;
        }
        throw new Error('Match did not finish within the bounded scenario.');
      });
      expect(end.finished).toBe(true); expect(end.status).toBe('over'); expect(end.winner).toBe(survivor);
      expect(end.players.map(p => p.score)).toEqual(losing === 0 ? [0, 300] : [300, 0]);
      expect(end.players.every(p => p.eliminated && !p.visible && p.misses === 3)).toBe(true);
      const repeated = await page.evaluate(() => {
        window.combatPreview.pause(false);
        return window.combatPreview.advance(1);
      });
      expect(repeated.time).toBe(end.time); expect(repeated.status).toBe('over');
    }
    expect(errors).toEqual([]);
    await page.evaluate(() => window.combatPreview.dispose());
  });
}

test('early explosion, simultaneous finales, pause and cap-speed course resets', async ({ page }) => {
  const errors = await open(page);
  for (const terrain of ['green-valley', 'desert', 'river-canyon'] as const) {
    await page.evaluate(terrain => window.combatPreview.configure({ terrain, scenario: 'early-lead' }), terrain);
    const early = await page.evaluate(() => {
      window.combatPreview.advance(36);
      for (let i = 0; i < 120; i++) {
        const state = window.combatPreview.advance(0.25);
        if (state.players[0]!.eliminated) return window.combatPreview.advance(2.1);
      }
      throw new Error('Early finale was not reached.');
    });
    expect(early.players[0]!.misses).toBe(3);
    expect(early.players[1]!.eliminated).toBe(false);
    await page.screenshot({ path: `test-results/combat-${terrain}-early-explosion.png` });
    await page.evaluate(() => {
      const state = window.combatPreview.snapshot();
      window.combatPreview.advance(Math.max(0, state.releaseAt[1]! - state.time));
    });
    await page.screenshot({ path: `test-results/combat-${terrain}-survivor-release.png` });
    await page.evaluate(terrain => window.combatPreview.configure({ terrain, scenario: 'draw', pass: 14 }), terrain);
    const ending = await page.evaluate(() => {
      for (let i = 0; i < 2; i++) {
        const state = window.combatPreview.snapshot();
        window.combatPreview.advance(state.handoffAt - state.time);
      }
      const state = window.combatPreview.snapshot();
      return window.combatPreview.advance(Math.max(...state.cutoffAt) + 0.01 - state.time);
    });
    expect(ending.status).toBe('over'); expect(ending.finished).toBe(false); expect(ending.winner).toBe('draw');
    await page.waitForTimeout(150);
    expect((await page.evaluate(() => window.combatPreview.snapshot())).time).toBe(ending.time);
    const playing = await page.evaluate(() => window.combatPreview.pause(false));
    expect(playing.status).toBe('over');
    await expect.poll(() => page.evaluate(() => window.combatPreview.snapshot().time)).toBeGreaterThan(ending.time);
    const paused = await page.evaluate(() => window.combatPreview.pause(true));
    await page.waitForTimeout(150);
    expect((await page.evaluate(() => window.combatPreview.snapshot())).time).toBe(paused.time);
    const end = await page.evaluate(() => window.combatPreview.advance(6));
    expect(end.finished).toBe(true); expect(end.winner).toBe('draw');
    expect(end.players.map(p => p.score)).toEqual([1300, 1300]);
    const reset = await page.evaluate(() => window.combatPreview.configure({ pass: 1, scenario: 'hits' }));
    expect(reset.players.every(p => p.damage === 0 && p.visible && p.misses === 0)).toBe(true);
    expect(reset.smoke).toEqual([0, 0]); expect(reset.effects).toEqual([]);
    const hits = await page.evaluate(() => {
      for (let i = 0; i < 3; i++) {
        const state = window.combatPreview.snapshot();
        window.combatPreview.advance(state.handoffAt - state.time);
      }
      return window.combatPreview.snapshot();
    });
    expect(hits.players.map(p => p.score)).toEqual([300, 300]);
    expect(hits.players.every(p => p.misses === 0)).toBe(true);
  }
  expect(errors).toEqual([]);
  await page.evaluate(() => window.combatPreview.dispose());
});

test('manual independent assistance, Space repeat/carryover and focus pause', async ({ page }) => {
  const errors = await open(page);
  const loadingDisabled = await page.evaluate(async () => {
    window.combatPreview.view(0);
    const pending = window.combatPreview.configure({ scenario: 'manual' });
    const disabled = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')]
      .every(control => control.disabled);
    await pending;
    return disabled;
  });
  expect(loadingDisabled).toBe(true);
  const assisted = await page.evaluate(() => window.combatPreview.assist(true));
  expect(assisted.players.map(p => p.assisted)).toEqual([true, false]);
  await page.locator('canvas').focus();
  await page.evaluate(() => {
    window.combatPreview.pause(false);
    const state = window.combatPreview.snapshot();
    window.combatPreview.advance(state.releaseAt[0]! - state.time);
  });
  await page.keyboard.down('Space');
  await page.keyboard.down('Space');
  const settled = await page.evaluate(() => {
    window.combatPreview.advance(18 - window.combatPreview.snapshot().time);
    return window.combatPreview.pause(true);
  });
  expect(settled.players[0]!.score).toBeGreaterThan(0);
  await page.evaluate(() => window.combatPreview.configure({ scenario: 'manual' }));
  await page.evaluate(() => window.combatPreview.pause(false));
  await page.keyboard.down('Space');
  const held = await page.evaluate(() => {
    window.combatPreview.advance(4);
    return window.combatPreview.pause(true);
  });
  expect(held.players[0]!.misses).toBe(0);
  await page.keyboard.up('Space');
  await page.evaluate(() => window.combatPreview.pause(false));
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  const dropped = await page.evaluate(() => {
    window.combatPreview.advance(4);
    return window.combatPreview.pause(true);
  });
  expect(dropped.players[0]!.misses).toBe(1);
  const blurred = await page.evaluate(() => {
    window.combatPreview.pause(false);
    window.dispatchEvent(new Event('blur'));
    return window.combatPreview.snapshot();
  });
  expect(blurred.paused).toBe(true);
  await page.waitForTimeout(150);
  expect((await page.evaluate(() => window.combatPreview.snapshot())).time).toBe(blurred.time);
  await page.setViewportSize({ width: 1100, height: 350 });
  await expect(page.locator('#step')).toBeDisabled();
  await expect(page.locator('#next-pass')).toBeDisabled();
  expect((await page.evaluate(() => window.combatPreview.snapshot())).failure).toBe('');
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.locator('#step')).toBeEnabled();
  expect(errors).toEqual([]);
  await page.evaluate(() => window.combatPreview.dispose());
});
