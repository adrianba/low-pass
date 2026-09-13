import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';

test.use({ viewport: { width: 960, height: 540 } });

test('River Canyon previews, scores a bank target, and preserves selection on restart', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => localStorage.setItem('low-pass.records.v1', JSON.stringify({
    version: 1, scores: [{ id: 'legacy', score: 42, date: '2026-09-01', assisted: false }],
    settings: { quality: 'low', assist: true, muted: true, volume: 0.3, terrain: 'green-valley' },
  })));
  await page.goto('/');
  await page.locator('#settings summary').click();
  await page.locator('#terrain').selectOption('river-canyon');
  await expect(page.locator('#app')).toHaveAttribute('data-terrain', 'river-canyon');
  await page.screenshot({ path: 'test-results/canyon-menu.png' });
  await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await page.waitForFunction(() => Number(document.querySelector('#aim-readout')?.getAttribute('data-accuracy')) >= 40,
    undefined, { polling: 'raf', timeout: 30_000 });
  await page.keyboard.press('Space');
  await expect(page.locator('#result')).toContainText(/ON TARGET|PRECISION HIT/, { timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#terrain')).toBeDisabled();
  await page.getByRole('button', { name: 'END RUN' }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('low-pass.records.v1')!));
  expect(saved.scores).toHaveLength(1);
  expect(saved.settings.terrain).toBe('river-canyon');
  await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
  await expect(page.locator('#misses')).toHaveText('0 / 3');
  expect(errors).toEqual([]);
});

test('a river miss splashes, pauses, damages the aircraft, and preserves the final score', async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    const random = crypto.getRandomValues.bind(crypto);
    Object.defineProperty(crypto, 'getRandomValues', { value: (array: ArrayBufferView<ArrayBuffer>) => {
      random(array);
      if (array instanceof Uint32Array && array.length === 1) array[0] = 7;
      return array;
    } });
    if (!localStorage.getItem('low-pass.records.v1')) localStorage.setItem('low-pass.records.v1', JSON.stringify({
      version: 1, scores: [],
      settings: { quality: 'low', assist: true, muted: true, volume: 0.3, terrain: 'river-canyon' },
    }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
  const app = page.locator('#app');
  await page.waitForFunction(() => Number(document.querySelector('#aim-readout')?.getAttribute('data-accuracy')) >= 40,
    undefined, { timeout: 90_000, polling: 'raf' });
  await page.waitForFunction(() => {
    if (document.querySelector('#app')?.getAttribute('data-prediction-kind') !== 'water') return false;
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
    return true;
  }, undefined, { timeout: 15_000, polling: 'raf' });
  await expect(app).toHaveAttribute('data-impact-kind', 'water', { timeout: 20_000 });
  await expect(page.locator('#misses')).toHaveText('1 / 3');
  await page.keyboard.press('Escape');
  await expect(app).toHaveAttribute('data-screen', 'paused');
  await page.waitForTimeout(300);
  await expect(page.locator('#misses')).toHaveText('1 / 3');
  await page.screenshot({ path: 'test-results/canyon-water-miss.png' });
  await page.getByRole('button', { name: 'RESUME FLIGHT' }).click();
  await expect(app).toHaveAttribute('data-damage', '1', { timeout: 15_000 });
  await expect(app).toHaveAttribute('data-damage', '2', { timeout: 160_000 });
  await expect(app).toHaveAttribute('data-screen', 'ending', { timeout: 180_000 });
  await page.keyboard.press('Escape');
  await expect(app).toHaveAttribute('data-screen', 'paused');
  await page.locator('#settings summary').click();
  await expect(page.locator('#terrain')).toBeDisabled();
  const phase = await app.getAttribute('data-finale');
  await page.waitForTimeout(300);
  await expect(app).toHaveAttribute('data-finale', phase!);
  const scores = await page.evaluate(() => JSON.parse(localStorage.getItem('low-pass.records.v1')!).scores);
  expect(scores).toHaveLength(1);
  expect(scores[0].score).toBe(0);
  await page.getByRole('button', { name: 'RESUME FLIGHT' }).click();
  await expect(app).toHaveAttribute('data-screen', 'over', { timeout: 20_000 });
  await page.getByRole('button', { name: 'FLY AGAIN' }).click();
  await expect(app).toHaveAttribute('data-damage', '0');
  await expect(page.locator('#misses')).toHaveText('0 / 3');
  await page.reload();
  await expect(app).toHaveAttribute('data-terrain', 'river-canyon');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('low-pass.records.v1')!).scores)).toEqual(scores);
  expect(errors).toEqual([]);
});

test.describe('canyon World', () => {
  let script: string;
  test.beforeAll(async () => {
    const result = await build({ configFile: false, logLevel: 'error',
      build: { write: false, lib: { entry: resolve('tests/fixtures/canyon.ts'), name: 'CanyonFixture', formats: ['iife'] } } });
    const outputs = Array.isArray(result) ? result : [result];
    const chunk = outputs.flatMap(output => 'output' in output ? output.output : []).find(o => o.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('Could not build canyon fixture.');
    script = chunk.code;
  });
  test('camera acquires every tier and river renders with pause-safe splashes', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/canyon.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
    await page.route('**/canyon-fixture', route => route.fulfill({ contentType: 'text/html',
      body: '<style>body{margin:0}canvas{width:100vw;height:100vh}</style><canvas></canvas><script src="/canyon.js"></script>' }));
    await page.goto('/canyon-fixture');
    const reports = await page.evaluate(() => window.canyonProbe());
    console.info('Canyon acquisition', reports);
    for (const report of reports) {
      expect(report.visible, `pass ${report.pass}`).not.toBeNull();
      expect(report.score, `pass ${report.pass}`).toBe(100);
      expect(report.cameraClearance).toBeGreaterThanOrEqual(16);
      expect(report.projectionError).toBeLessThan(0.00001);
    }
    for (const pass of [1, 7, 13]) for (const closeup of [false, true]) {
      await page.evaluate(({ pass, closeup }) => window.canyonFrame(pass, closeup), { pass, closeup });
      await page.screenshot({ path: `test-results/canyon-${pass}-${closeup ? 'bank' : 'chase'}.png` });
    }
    const splash = await page.evaluate(() => window.canyonSplash());
    expect(splash.frozen).toBe(true);
    expect(splash.reset).toBe(true);
    expect(splash.waterMeshes).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.canyonLifecycle())).toBe(true);
    expect(errors).toEqual([]);
  });
});
