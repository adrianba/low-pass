import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import type {} from '../fixtures/transport';

test('browser schemas, WebCrypto and bounded transport deliver a real Canyon plan under faults', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const result = await build({ configFile: false, logLevel: 'error',
    build: { write: false, lib: { entry: resolve('tests/fixtures/transport.ts'), name: 'TransportFixture', formats: ['iife'] } } });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs.flatMap(o => 'output' in o ? o.output : []).find(o => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Could not build portable transport fixture.');
  await page.route('**/transport-fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: chunk.code }));
  await page.route('**/transport-fixture', route => route.fulfill({ contentType: 'text/html',
    body: '<link rel="icon" href="data:,"><script src="/transport-fixture.js"></script>' }));
  await page.goto('/transport-fixture');
  const outcome = await page.evaluate(() => window.transportReady);
  expect(outcome.ready).toBe(true);
  expect(outcome.deferred).toBe(2); expect(outcome.backpressure).toBeGreaterThan(0);
  expect(outcome.stats.retried).toBeGreaterThan(0); expect(outcome.stats.duplicated).toBeGreaterThan(0);
  expect(outcome.largestMessage).toBeLessThanOrEqual(16 * 1024);
  expect(outcome.completedDigest).toBe(outcome.expectedDigest);
  expect(outcome.knownHash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(outcome.watermarks).toEqual({ planRevision: 0, eventSequence: 0, snapshotSequence: 2 });
  expect(outcome.replicaScores).toEqual([100, 100]);
  expect(outcome.replicaPending).toBe(0);
  expect(outcome.deferredOutcome).toBe(true);
  expect(errors).toEqual([]);
});
