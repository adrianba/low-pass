import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { TARGET_KINDS, selectTargetKind } from '../../src/game/targets';

test.use({ viewport: { width: 960, height: 540 } });

for (const kind of TARGET_KINDS) {
  test(`a seeded ${kind} encounter survives pause, scores normally, and restarts`, async ({ page }) => {
    test.setTimeout(90_000);
    const seed = Array.from({ length: 100 }, (_, n) => n).find(n => selectTargetKind(0, n) === kind);
    if (seed === undefined) throw new Error(`Missing test seed for ${kind}`);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(seed => {
      const original = crypto.getRandomValues.bind(crypto);
      Object.defineProperty(crypto, 'getRandomValues', {
        value: (array: ArrayBufferView<ArrayBuffer>) => {
          original(array);
          if (array instanceof Uint32Array && array.length === 1) array[0] = seed;
          return array;
        },
      });
      localStorage.setItem('low-pass.records.v1', JSON.stringify({
        version: 1, scores: [],
        settings: { quality: 'low', assist: true, muted: true, volume: 0.3, terrain: 'desert' },
      }));
    }, seed);
    await page.goto('/');
    await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
    const app = page.locator('#app');
    await expect(app).toHaveAttribute('data-target-kind', kind);
    await page.keyboard.press('Escape');
    await page.locator('#settings summary').click();
    await page.locator('#quality').selectOption('medium');
    await expect(app).toHaveAttribute('data-target-kind', kind);
    await page.locator('#quality').selectOption('low');
    await page.getByRole('button', { name: 'RESUME FLIGHT' }).click();
    await expect(app).toHaveAttribute('data-ready', 'true');
    await page.waitForFunction(() => Number(document.querySelector('#aim-readout')?.getAttribute('data-accuracy')) >= 40,
      undefined, { timeout: 30_000, polling: 'raf' });
    await page.keyboard.press('Space');
    await expect(page.locator('#result')).toContainText(/ON TARGET|PRECISION HIT/, { timeout: 15_000 });
    await expect(app).toHaveAttribute('data-target-kind', kind);
    await expect(page.locator('#misses')).toHaveText('0 / 3');
    await expect(app).toHaveAttribute('data-encounter', '2', { timeout: 30_000 });
    await expect(app).toHaveAttribute('data-target-kind', selectTargetKind(1, seed));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'END RUN' }).click();
    await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
    await expect(app).toHaveAttribute('data-target-kind', kind);
    await expect(app).toHaveAttribute('data-encounter', '1');
    await expect(page.locator('#score')).toHaveText('0000');
    expect(errors).toEqual([]);
  });
}

test.describe('target models in WebGL', () => {
  let script: string;
  test.beforeAll(async () => {
    const bundle = await build({
      configFile: false, logLevel: 'error',
      build: { write: false, lib: { entry: resolve('tests/fixtures/targets.ts'), name: 'TargetFixture', formats: ['iife'] } },
    });
    const outputs = Array.isArray(bundle) ? bundle : [bundle];
    const chunk = outputs.flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('Target fixture did not compile');
    script = chunk.code;
  });
  test.beforeEach(async ({ page }) => {
    await page.route('**/target-probe.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
    await page.route('**/target-fixture', route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><style>body{margin:0}canvas{width:100vw;height:100vh;display:block}</style><canvas></canvas><script src="/target-probe.js"></script>',
    }));
    await page.goto('/target-fixture');
  });
  for (const kind of TARGET_KINDS) {
    test(`${kind} resets, rebases, and renders intact and damaged in both terrains`, async ({ page }) => {
      test.setTimeout(90_000);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const result = await page.evaluate(kind => window.targetProbe(kind), kind);
      expect(result.enabled).toEqual([{ tank: 'Target tank', radar: 'Target radar station', sam: 'Target SAM launcher' }[kind]]);
      expect(result.stableDamage).toBe(true);
      expect(result.sameKindReset).toBe(true);
      expect(result.restartReset).toBe(true);
      expect(result.rebaseError).toBeLessThan(0.001);
      expect(new Set(result.shadowCounts).size).toBe(1);
      for (const count of result.resourceCounts) expect(count).toEqual(result.resourceCounts[0]);
      for (const terrain of ['green-valley', 'desert'] as const) {
        for (const damaged of [false, true]) {
          await page.evaluate(args => window.targetFrame(args.kind, args.terrain, args.damaged, true), { kind, terrain, damaged });
          await page.screenshot({ path: `test-results/target-${kind}-${terrain}-${damaged ? 'damaged' : 'intact'}.png` });
        }
        await page.evaluate(args => window.targetFrame(args.kind, args.terrain, false, false), { kind, terrain });
        await page.screenshot({ path: `test-results/target-${kind}-${terrain}-chase.png` });
        await page.evaluate(args => window.targetFrame(args.kind, args.terrain, false, false, 12), { kind, terrain });
        await page.screenshot({ path: `test-results/target-${kind}-${terrain}-fast.png` });
      }
      expect(errors).toEqual([]);
    });
  }
});
