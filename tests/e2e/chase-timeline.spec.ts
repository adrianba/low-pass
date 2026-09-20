import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';

test.describe('authored multiplayer cameras in the real renderer', () => {
  let script: string;
  test.beforeAll(async () => {
    const bundle = await build({
      configFile: false, logLevel: 'error',
      build: { write: false, lib: { entry: resolve('tests/fixtures/chase-timeline.ts'), name: 'ChaseFixture', formats: ['iife'] } },
    });
    const outputs = Array.isArray(bundle) ? bundle : [bundle];
    const chunk = outputs.flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('Authored chase fixture did not compile.');
    script = chunk.code;
  });
  for (const terrain of ['green-valley', 'desert', 'river-canyon'] as const) {
    test(`${terrain} uses the authored camera across frame rates, resizes and origin rebases`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/authored-chase.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
      await page.route('**/authored-chase-fixture', route => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><style>body{margin:0}canvas{width:100vw;height:100vh}</style><canvas></canvas><script src="/authored-chase.js"></script>',
      }));
      await page.goto('/authored-chase-fixture');
      const result = await page.evaluate(terrain => window.authoredChaseProbe(terrain), terrain);
      console.info('Authored camera report', terrain, result);
      expect(result.checked).toBe(36);
      expect(result.verified).toBe(true);
      expect(result.projectionError).toBeLessThan(0.00001);
      expect(result.cameraClearance).toBeGreaterThanOrEqual(15.999);
      expect(result.rebased).toBe(true);
      expect(result.paused).toBe(true);
      expect(result.pauseError).toBeLessThan(1e-9);
      expect(result.resizeReason).toBe('viewport_changed');
      expect(errors).toEqual([]);
    });
  }
});
