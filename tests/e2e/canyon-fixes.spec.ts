import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';

test.use({ viewport: { width: 960, height: 540 } });
let script: string;
test.beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: 'error',
    build: { write: false, lib: { entry: resolve('tests/fixtures/canyon.ts'), name: 'CanyonFixture', formats: ['iife'] } } });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs.flatMap(o => 'output' in o ? o.output : []).find(o => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Could not build canyon fixture.');
  script = chunk.code;
});
test('both faces of shelf walls use the canyon shader, not a cached terrain variant', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/canyon.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
  await page.route('**/canyon-fixture', route => route.fulfill({ contentType: 'text/html',
    body: '<style>body{margin:0}canvas{width:100vw;height:100vh}</style><canvas></canvas><script src="/canyon.js"></script>' }));
  await page.goto('/canyon-fixture');
  const reports = [];
  for (const index of [0, 3]) for (const reverse of [false, true]) {
    const report = await page.evaluate(({ index, reverse }) => window.canyonWall(index, reverse), { index, reverse });
    reports.push(report);
    await page.screenshot({ path: `test-results/canyon-wall-${index}-${reverse ? 'back' : 'front'}.png` });
  }
  console.info('Wall shader variants', reports);
  expect(reports.every(r => r.source && r.distinct)).toBe(true);
  for (const report of reports) expect(report.cullingDifference).toBeLessThan(0.1);
  expect(errors).toEqual([]);
});
