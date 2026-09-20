import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';

test('real aircraft share cached assets but keep drop, destruction and restart independent', async ({ page }) => {
  const bundle = await build({
    configFile: false, logLevel: 'error',
    build: { write: false, lib: { entry: resolve('tests/fixtures/aircraft-views.ts'), name: 'AircraftFixture', formats: ['iife'] } },
  });
  const outputs = Array.isArray(bundle) ? bundle : [bundle];
  const chunk = outputs.flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Aircraft fixture did not compile.');
  const errors: string[] = [], assets: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('.glb')) assets.push(request.url()); });
  await page.route('**/aircraft-views.js', route => route.fulfill({ contentType: 'text/javascript', body: chunk.code }));
  await page.route('**/aircraft-views-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><style>body{margin:0}canvas{width:100vw;height:100vh}</style><canvas></canvas><script src="/aircraft-views.js"></script>',
  }));
  await page.goto('/aircraft-views-fixture');
  const ready = await page.evaluate(() => window.aircraftViews('ready'));
  expect(ready.sharedGeometry).toBe(true);
  expect(ready.sharedMaterials).toBe(true);
  expect(ready.carried).toEqual([true, true]);
  expect(ready.falling).toEqual([false, false]);
  expect(ready.casterCount).toBeGreaterThan(2);
  await page.screenshot({ path: 'test-results/independent-aircraft.png' });
  for (let repeat = 0; repeat < 3; repeat++) {
    const drop = await page.evaluate(() => window.aircraftViews('drop'));
    expect(drop.carried).toEqual([false, true]);
    expect(drop.falling).toEqual([true, false]);
    const destroyed = await page.evaluate(() => window.aircraftViews('destroy'));
    expect(destroyed.lead).toBe(false);
    expect(destroyed.follower).toBe(true);
    expect(destroyed.carried).toEqual([false, true]);
    const reset = await page.evaluate(() => window.aircraftViews('reset'));
    expect(reset).toEqual(ready);
    const rebased = await page.evaluate(() => window.aircraftViews('rebase'));
    expect(rebased).toEqual(ready);
  }
  expect(assets.filter(url => url.endsWith('/kestrel.glb'))).toHaveLength(1);
  expect(assets.filter(url => url.endsWith('/practice-bomb.glb'))).toHaveLength(1);
  expect(errors).toEqual([]);
});
