import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';

test.use({ viewport: { width: 960, height: 540 } });

test('terrain selection previews, persists, protects legacy records, and stays locked during flight', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem('low-pass.records.v1')) localStorage.setItem('low-pass.records.v1', JSON.stringify({
      version: 1,
      scores: [{ id: 'legacy', score: 789, date: '2026-01-01T00:00:00Z', assisted: false }],
      settings: { quality: 'low', assist: true, muted: true, volume: 0.3 },
    }));
  });
  await page.goto('/');
  const app = page.locator('#app');
  const terrain = page.locator('#terrain');
  await expect(app).toHaveAttribute('data-screen', 'menu');
  await expect(app).toHaveAttribute('data-terrain', 'green-valley');
  await page.locator('#settings summary').click();
  await expect(terrain).toBeEnabled();
  await terrain.selectOption('desert');
  await expect(app).toHaveAttribute('data-terrain', 'desert');
  await expect(page.locator('#range-name')).toHaveText('DESERT RANGE');
  await page.reload();
  await expect(app).toHaveAttribute('data-screen', 'menu');
  await expect(app).toHaveAttribute('data-terrain', 'desert');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('low-pass.records.v1')!));
  expect(saved.scores[0].score).toBe(789);
  expect(saved.settings).toMatchObject({ terrain: 'desert', volume: 0.3, muted: true });
  await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
  await page.keyboard.press('Escape');
  await page.locator('#settings summary').click();
  await expect(terrain).toBeDisabled();
  await terrain.evaluate(element => {
    const select = element as HTMLSelectElement;
    select.value = 'green-valley';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#notification')).toContainText('Terrain is fixed');
  await expect(terrain).toHaveValue('desert');
  await expect(app).toHaveAttribute('data-terrain', 'desert');
  await page.locator('#quality').selectOption('medium');
  await page.getByRole('button', { name: 'RESUME FLIGHT' }).click();
  await expect(app).toHaveAttribute('data-screen', 'playing');
  await expect(app).toHaveAttribute('data-terrain', 'desert');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'END RUN' }).click();
  await expect(terrain).toBeEnabled();
  await terrain.selectOption('green-valley');
  await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
  await expect(app).toHaveAttribute('data-terrain', 'green-valley');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('low-pass.records.v1')!).scores.length)).toBe(1);
  expect(errors).toEqual([]);
});

test.describe('terrain WebGL rendering', () => {
  let script: string;
  test.beforeAll(async () => {
    const bundle = await build({
      configFile: false, logLevel: 'error',
      build: { write: false, lib: { entry: resolve('tests/fixtures/terrain.ts'), name: 'TerrainFixture', formats: ['iife'] } },
    });
    const outputs = Array.isArray(bundle) ? bundle : [bundle];
    const chunk = outputs.flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('Terrain fixture did not compile');
    script = chunk.code;
  });
  test.beforeEach(async ({ page }) => {
    await page.route('**/terrain-probe.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
    await page.route('**/terrain-fixture', route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><style>body{margin:0}canvas{width:100vw;height:100vh;display:block}</style><canvas></canvas><script src="/terrain-probe.js"></script>',
    }));
    await page.goto('/terrain-fixture');
  });
  test('sand is shaded, continuous across chunks and stable when the rendering origin shifts', async ({ page }) => {
    const result = await page.evaluate(() => window.sandPixels());
    expect(result.seam).toBeLessThan(1);
    expect(result.rebase).toBeLessThan(1);
    expect(result.warmPixels).toBeGreaterThan(50_000);
    expect(result.variation).toBeGreaterThan(15);
  });
  for (const theme of ['green-valley', 'desert'] as const) {
    for (const quality of ['low', 'high'] as const) {
      test(`${theme} at ${quality} quality preserves terrain geometry and bounded resources`, async ({ page }) => {
        test.setTimeout(90_000);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        const result = await page.evaluate(({ theme, quality }) => window.terrainWorld(theme, quality), { theme, quality });
        expect(result.sameGeometry).toBe(true);
        expect(result.desertTrees).toBe(0);
        expect(result.valleyTrees).toBeGreaterThan(0);
        expect(result.after).toEqual(result.baseline);
        expect(result.highSpeedCovered).toBe(true);
        expect(result.maxStreamedChunks).toBeLessThanOrEqual(200);
        await page.screenshot({ path: `test-results/terrain-${theme}-${quality}.png` });
        expect(errors).toEqual([]);
      });
    }
  }
});
