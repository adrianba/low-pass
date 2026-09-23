import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import type {} from '../fixtures/shared-scene';

test.setTimeout(180_000);
let script: string;
test.beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: 'error',
    build: { write: false, lib: { entry: resolve('tests/fixtures/shared-scene.ts'), name: 'SharedScene', formats: ['iife'] } } });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs.flatMap(o => 'output' in o ? o.output : []).find(o => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Could not build shared-scene fixture.');
  script = chunk.code;
});
for (const terrain of ['green-valley', 'desert', 'river-canyon'] as const) {
  test(`${terrain}: shared actors, retained wrecks, water/ground attribution and repeatable rebasing`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width: 960, height: 540 });
    await page.route('**/shared-scene.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
    await page.route('**/shared-scene-fixture', route => route.fulfill({ contentType: 'text/html',
      body: '<style>body{margin:0}canvas{width:100vw;height:100vh}</style><canvas></canvas><script src="/shared-scene.js"></script>' }));
    await page.goto('/shared-scene-fixture');
    const first = await page.evaluate(terrain => window.sharedScene.configure(terrain), terrain);
    expect(first.origin).toBeGreaterThan(4096);
    expect(first.bombs).toEqual([true, true]);
    expect(first.aircraft.map(a => a.enabled)).toEqual([true, true]);
    expect(first.aircraft.map(a => a.position)).toEqual(first.expectedAircraft);
    expect(first.sharedRings).toBe(true); expect(first.soloHidden).toBe(true);
    expect(first.cameraError).toBeLessThan(0.001); expect(first.covered).toBe(true);
    expect(first.chunks).toBeLessThanOrEqual(first.chunkBudget);
    expect(await page.evaluate(() => window.sharedScene.prewarm(true))).toEqual({ cancelled: true, restored: true });
    expect(await page.evaluate(() => window.sharedScene.prewarm(false))).toEqual({ cancelled: false, restored: true });
    const replicated = await page.evaluate(() => window.sharedScene.replica(1));
    expect(replicated.replicated).toBe(true);
    expect(replicated.aircraft).toEqual(first.aircraft); expect(replicated.bombs).toEqual(first.bombs);
    expect(replicated.targets).toEqual(first.targets); expect(replicated.counts).toEqual(first.counts);
    expect(replicated.cameraError).toBeLessThan(0.001);
    await page.screenshot({ path: info.outputPath('replica-flight.png') });
    const settled = await page.evaluate(() => window.sharedScene.settle(1));
    expect(settled.targets.length).toBeGreaterThanOrEqual(2);
    expect(settled.targetPositions).toEqual(expect.arrayContaining(settled.targets.map(t => t.position)));
    expect(settled.scores).toEqual([1400, 1400]);
    expect(settled.scars).toBe(2);
    const rebased = await page.evaluate(() => window.sharedScene.freshOrigin(0));
    expect(rebased.origin).not.toBe(settled.origin);
    expect(rebased.cameraError).toBeLessThan(0.001);
    expect(rebased.aircraft.map(a => a.position)).toEqual(rebased.expectedAircraft);
    expect(rebased.scars).toBe(2);
    for (const slot of [0, 1, 0, 1] as const) {
      const current = await page.evaluate(slot => window.sharedScene.show(slot), slot);
      expect(current.cameraError).toBeLessThan(0.001);
      expect(current.aircraft.map(a => a.position)).toEqual(current.expectedAircraft);
      expect(current.counts).toEqual(rebased.counts);
      expect(current.covered).toBe(true);
    }
    const simultaneous = await page.evaluate(() => window.sharedScene.show(1, true));
    expect(simultaneous.scars).toBe(terrain === 'river-canyon' ? 1 : 2);
    expect(simultaneous.ripples).toBe(terrain === 'river-canyon' ? 1 : 0);
    expect((await page.evaluate(() => window.sharedScene.show(1, true))).counts).toEqual(simultaneous.counts);
    await page.screenshot({ path: info.outputPath(`shared-${terrain}.png`) });
    expect(await page.evaluate(() => window.sharedScene.solo())).toEqual({ otherHidden: true, targetsHidden: true, impactsHidden: true });
    await page.setViewportSize({ width: 720, height: 960 });
    const high = await page.evaluate(terrain => window.sharedScene.configure(terrain, 1, 'high'), terrain);
    expect(high.cameraError).toBeLessThan(0.001); expect(high.covered).toBe(true);
    expect(high.chunks).toBeLessThanOrEqual(high.chunkBudget);
    expect(errors).toEqual([]);
    await page.evaluate(() => window.sharedScene.dispose());
  });
}
