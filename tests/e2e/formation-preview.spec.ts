import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PreviewSnapshot } from '../fixtures/formation-preview';

test.describe('usable local formation geometry preview', () => {
  test.setTimeout(180_000);
  const mountedURL = process.env.FORMATION_PREVIEW_URL;
  let script: string, html: string;
  test.beforeAll(async () => {
    if (mountedURL) return;
    const bundle = await build({
      configFile: false, logLevel: 'error',
      build: { write: false, lib: { entry: resolve('tests/fixtures/formation-preview.ts'), name: 'FormationPreview', formats: ['iife'] } },
    });
    const outputs = Array.isArray(bundle) ? bundle : [bundle];
    const chunk = outputs.flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('Formation preview fixture did not compile.');
    script = chunk.code;
    html = await readFile(resolve('tests/fixtures/formation-preview.html'), 'utf8');
  });
  async function open(page: Page): Promise<{ errors: string[]; glbs: string[]; state: PreviewSnapshot }> {
    const errors: string[] = [], glbs: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => { if (request.url().endsWith('.glb')) glbs.push(request.url()); });
    await page.setViewportSize({ width: 1100, height: 800 });
    if (!mountedURL) {
      await page.route('**/formation-preview.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
      await page.route('**/formation-preview.html', route => route.fulfill({
        contentType: 'text/html', body: html,
        headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:;" },
      }));
    }
    await page.goto(mountedURL ?? '/formation-preview.html');
    await page.waitForFunction(() => !!window.formationPreview);
    const state = await page.evaluate(() => window.formationPreview.ready());
    await expect(page.getByText('UNAPPROVED prototype · Not networked', { exact: false })).toBeVisible();
    return { errors, glbs, state };
  }
  async function pausedFrames(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }

  for (const terrain of ['green-valley', 'desert', 'river-canyon'] as const) {
    test(`${terrain}: real planes, independent scores, authored views and bounded replay`, async ({ page }) => {
      const { errors, glbs } = await open(page);
      await page.evaluate(() => localStorage.setItem('low-pass.records.v1', 'formation-preview-must-not-touch'));
      const initial = await page.evaluate(terrain =>
        window.formationPreview.configure({ terrain, seed: 7, tier: 14, scripted: true }), terrain);
      expect(initial.config.tier).toBe(14);
      expect(initial.viewportSupported).toBe(true);
      expect(initial.reason).toBe('');
      expect(initial.cameraMatches).toBe(true);
      expect(initial.origin).toBeGreaterThan(4096);
      expect(initial.aircraftEnabled).toEqual([true, true]);
      expect(initial.sharedGeometry).toBe(true);
      expect(initial.sharedMaterials).toBe(true);
      expect(initial.releaseAt[1]!).toBeGreaterThan(initial.releaseAt[0]!);
      const intact = initial.targetAppearance;

      await page.evaluate(time => window.formationPreview.seek(time), initial.releaseAt[0]! - 0.001);
      const lead = await page.evaluate(() => window.formationPreview.view(0));
      expect(lead.prediction?.projected).not.toBeNull();
      expect(lead.prediction?.points).toBeGreaterThanOrEqual(95);
      await expect(page.locator('#reticle')).toBeVisible();
      await page.screenshot({ path: `test-results/formation-${terrain}-lead.png` });
      await page.evaluate(time => window.formationPreview.seek(time), initial.releaseAt[0]! + 0.2);
      const departure = await page.evaluate(() => window.formationPreview.view(1));
      expect(departure.generation).toBe(initial.generation);
      expect(departure.cameraMatches).toBe(true);
      expect(departure.bombs[0]).not.toBeNull();
      expect(departure.aircraftPixels[0]?.visible).toBe(true);
      expect(departure.bombPixels[0]?.visible).toBe(true);
      expect(departure.aircraftPixels[0]!.width).toBeGreaterThan(1);
      expect(departure.bombPixels[0]!.width).toBeGreaterThan(0);
      console.info('Formation departure CSS-pixel bounds (not readability approval)', terrain, {
        aircraft: departure.aircraftPixels[0], bomb: departure.bombPixels[0],
        aspect: departure.aspect, cameraError: departure.cameraError,
      });
      await page.screenshot({ path: `test-results/formation-${terrain}-follower.png` });

      const firstHit = await page.evaluate(time => window.formationPreview.seek(time), initial.releaseAt[0]! + 2.3);
      expect(firstHit.scores).toEqual([100, null]);
      expect(firstHit.bombs[1]).not.toBeNull();
      expect(firstHit.targetDestroyed).toBe(true);
      expect(firstHit.targetEnabled).toBe(true);
      expect(firstHit.targetAppearance).not.toEqual(intact);
      expect(firstHit.effects.length).toBeGreaterThan(0);
      await pausedFrames(page);
      const frozen = await page.evaluate(() => window.formationPreview.snapshot());
      expect(frozen.time).toBe(firstHit.time);
      expect(frozen.poses).toEqual(firstHit.poses);
      expect(frozen.bombs).toEqual(firstHit.bombs);
      expect(frozen.effects).toEqual(firstHit.effects);
      const switched = await page.evaluate(() => window.formationPreview.view(0));
      expect(switched.generation).toBe(firstHit.generation);
      expect(switched.time).toBe(firstHit.time);
      expect(switched.bombs).toEqual(firstHit.bombs);
      expect(switched.scores).toEqual(firstHit.scores);
      expect(switched.targetAppearance).toEqual(firstHit.targetAppearance);
      expect(switched.cameraMatches).toBe(true);
      const scored = await page.evaluate(time => window.formationPreview.seek(time), initial.handoffAt);
      expect(scored.scores).toEqual([100, 100]);
      expect(scored.releasedAt).toEqual(initial.releaseAt);
      expect(scored.renderedResults).toEqual([1, 2]);
      expect(new Set(scored.results.map(result => result!.id)).size).toBe(2);
      const again = await page.evaluate(time => window.formationPreview.seek(time), initial.handoffAt);
      expect(again.results).toEqual(scored.results);
      expect(again.poses).toEqual(scored.poses);
      expect(again.generation).toBe(initial.generation);

      for (let repeat = 0; repeat < 2; repeat++) {
        const rebuilt = await page.evaluate(terrain =>
          window.formationPreview.configure({ terrain, seed: 7, tier: 14, scripted: true }), terrain);
        expect(rebuilt.counts).toEqual(initial.counts);
        expect(rebuilt.sharedGeometry).toBe(true);
        expect(rebuilt.sharedMaterials).toBe(true);
        expect(rebuilt.scores).toEqual([null, null]);
      }
      const final = await page.evaluate(() => window.formationPreview.snapshot());
      expect(glbs.filter(url => url.endsWith('/kestrel.glb'))).toHaveLength(final.generation);
      expect(glbs.filter(url => url.endsWith('/practice-bomb.glb'))).toHaveLength(final.generation);
      expect(await page.evaluate(() => localStorage.getItem('low-pass.records.v1'))).toBe('formation-preview-must-not-touch');
      expect(errors).toEqual([]);
    });
  }

  test('manual releases suppress repeats and unsupported viewports pause explicitly', async ({ page }) => {
    const { errors } = await open(page);
    const initial = await page.evaluate(() =>
      window.formationPreview.configure({ terrain: 'green-valley', tier: 1, seed: 7, scripted: false }));
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.formationPreview.snapshot().time)).toBeGreaterThan(initial.startAt);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const stopped = await page.evaluate(() => window.formationPreview.snapshot());
    await pausedFrames(page);
    expect((await page.evaluate(() => window.formationPreview.snapshot())).time).toBe(stopped.time);
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.formationPreview.snapshot().time)).toBe(initial.startAt);
    expect((await page.evaluate(() => window.formationPreview.snapshot())).generation).toBe(initial.generation);
    await page.evaluate(time => window.formationPreview.seek(time), initial.releaseAt[0]!);
    await page.locator('canvas').focus();
    await page.keyboard.down('Space');
    await expect.poll(() => page.evaluate(() => window.formationPreview.snapshot().releasedAt[0])).toBe(initial.releaseAt[0]);
    await page.evaluate(() => window.formationPreview.view(1));
    await page.keyboard.down('Space');
    expect((await page.evaluate(() => window.formationPreview.snapshot())).releasedAt[1]).toBeNull();
    await page.keyboard.up('Space');
    await page.evaluate(seconds => window.formationPreview.advance(seconds), initial.releaseAt[1]! - initial.releaseAt[0]!);
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.formationPreview.snapshot().releasedAt[1])).toBe(initial.releaseAt[1]);
    const scored = await page.evaluate(seconds => window.formationPreview.advance(seconds), 2.5);
    expect(scored.scores).toEqual([100, 100]);
    await page.setViewportSize({ width: 1500, height: 420 });
    await expect.poll(() => page.evaluate(() => window.formationPreview.snapshot().viewportSupported)).toBe(false);
    const unsupported = await page.evaluate(() => window.formationPreview.pause(false));
    expect(unsupported.paused).toBe(true);
    expect(unsupported.reason).toContain('outside');
    await expect(page.locator('#status')).toContainText('outside');
    const rejection = await page.evaluate(async () => {
      try { await window.formationPreview.advance(0.1); return ''; }
      catch (error) { return (error as Error).message; }
    });
    expect(rejection).toContain('outside');
    expect((await page.evaluate(() => window.formationPreview.snapshot())).time).toBe(unsupported.time);
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect.poll(() => page.evaluate(() => window.formationPreview.snapshot().viewportSupported)).toBe(true);
    expect((await page.evaluate(() => window.formationPreview.snapshot())).paused).toBe(true);
    expect(errors).toEqual([]);
  });

  test('same-tick impacts both render and a later miss does not restore the shared wreck', async ({ page }) => {
    const { errors } = await open(page);
    const initial = await page.evaluate(() => window.formationPreview.configure({
      terrain: 'green-valley', tier: 1, seed: 7, scripted: false,
    }));
    const scored = await page.evaluate(async time => {
      await window.formationPreview.seek(time);
      window.formationPreview.drop(0);
      window.formationPreview.drop(1);
      return window.formationPreview.advance(3);
    }, initial.releaseAt[0]!);
    expect(scored.scores).toEqual([100, 0]);
    expect(scored.results[0]!.time).toBe(scored.results[1]!.time);
    expect(scored.renderedResults).toEqual([1, 2]);
    expect(scored.targetAppearance).not.toEqual(initial.targetAppearance);
    expect(scored.targetEnabled).toBe(true);
    expect(errors).toEqual([]);
  });
});
