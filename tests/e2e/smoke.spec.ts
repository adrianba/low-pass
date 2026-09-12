import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';

test('smoke renders transparent corners, soft edges, and gradual fading in WebGL', async ({ page }) => {
  const bundle = await build({
    configFile: false,
    logLevel: 'error',
    build: {
      write: false,
      lib: { entry: resolve('tests/fixtures/smoke.ts'), name: 'SmokeFixture', formats: ['iife'] },
    },
  });
  const outputs = Array.isArray(bundle) ? bundle : [bundle];
  const script = outputs.flatMap(output => 'output' in output ? output.output : [])
    .find(output => output.type === 'chunk');
  if (!script || script.type !== 'chunk') throw new Error('Smoke fixture did not compile');
  await page.route('**/smoke-probe.js', route => route.fulfill({ contentType: 'text/javascript', body: script.code }));
  await page.route('**/smoke-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><canvas width="256" height="256"></canvas><script src="/smoke-probe.js"></script>',
  }));
  await page.goto('/smoke-fixture');
  const result = await page.evaluate(() => window.smokeProbe());
  expect(result.center).toBeLessThan(230);
  for (const corner of result.corners) expect(corner).toBeGreaterThanOrEqual(250);
  expect(result.softPixels).toBeGreaterThan(500);
  expect(result.fadedCenter).toBeGreaterThan(result.center + 10);
  expect(result.fadedCenter).toBeLessThan(250);
});
