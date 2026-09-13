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

test('large turns retain river and wall coverage at both quality presets', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/canyon.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
  await page.route('**/canyon-fixture', route => route.fulfill({ contentType: 'text/html',
    body: '<style>body{margin:0}canvas{width:100vw;height:100vh}</style><canvas></canvas><script src="/canyon.js"></script>' }));
  await page.goto('/canyon-fixture');
  const reports = [];
  for (const quality of ['low', 'high'] as const) for (const along of [1800, 2400, 3000, 4300, 5600]) {
    const report = await page.evaluate(({ along, quality }) => window.canyonTwist(along, quality, false), { along, quality });
    reports.push({ along, quality, ...report });
    expect(report.covered).toBe(true);
    expect(report.terrain).toBeLessThan(100);
    expect(report.water).toBeLessThan(32);
    expect(report.speed).toBeLessThanOrEqual(350);
    await page.screenshot({ path: `test-results/canyon-turn-${along}-${quality}.png` });
  }
  await page.evaluate(() => window.canyonTwist(2400, 'high', true));
  await page.screenshot({ path: 'test-results/canyon-turn-overhead.png' });
  expect(await page.evaluate(() => window.canyonRebase())).toBeLessThan(0.2);
  console.info('Winding terrain coverage', reports);
  expect(errors).toEqual([]);
});

test('canyon missiles visibly rise from dry banks rather than arriving from above', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/canyon.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
  await page.route('**/canyon-fixture', route => route.fulfill({ contentType: 'text/html',
    body: '<style>body{margin:0}canvas{width:100vw;height:100vh}</style><canvas></canvas><script src="/canyon.js"></script>' }));
  await page.goto('/canyon-fixture');
  const banks = new Set<number>();
  for (const quality of ['low', 'high'] as const) {
    await page.setViewportSize(quality === 'low' ? { width: 960, height: 540 } : { width: 720, height: 960 });
    for (const [kind, pass, turn] of [['damage', 1, false], ['finale', 13, false], ['flyby', 7, false], ['damage', 13, true]] as const) {
      let meshes: number | null = null;
      for (const age of [0, 0.25, 0.75, 1.5, ...(kind === 'flyby' ? [1.7, 2.4, 2.79] : [])]) {
        const report = await page.evaluate(({ kind, pass, turn, age, quality }) =>
          window.canyonMissile(kind, pass, turn, age, quality), { kind, pass, turn, age, quality });
        expect(report.ground).toBeCloseTo(12, 3);
        expect(report.launchY).toBeCloseTo(20, 3);
        if (age <= 0.25) expect(report.visible).toBe(true);
        if (kind !== 'flyby' || age < 1) expect(report.below).toBe(true);
        expect(report.frozen).toBe(true);
        banks.add(report.bank);
        if (turn) {
          expect(report.origin).toBeGreaterThanOrEqual(8192);
          expect(report.turnError).toBeLessThan(40);
        }
        if (meshes !== null) expect(Math.abs(report.meshes - meshes)).toBeLessThan(60);
        else meshes = report.meshes;
        await page.screenshot({ path: `test-results/floor-missile-${kind}-${pass}-${turn}-${quality}-${age}.png` });
      }
    }
  }
  expect(banks.size).toBe(2);
  expect(errors).toEqual([]);
});
