import { test, expect } from '@playwright/test';
import type { Browser, TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { roomService } from '../helpers/room-service.js';
import type {} from '../fixtures/connectivity.js';

// Real credential responses must never enter Playwright traces, HARs or videos.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
type Mode = 'direct' | 'auto' | 'udp' | 'tcp' | 'tls';
let script: string;
test.beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: 'error',
    build: { write: false, lib: { entry: resolve('tests/fixtures/connectivity.ts'), name: 'ConnectivityFixture', formats: ['iife'] } } });
  const chunk = (Array.isArray(result) ? result : [result]).flatMap(r => 'output' in r ? r.output : []).find(c => c.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Could not build diagnostic.');
  script = chunk.code;
});

async function exercise(browser: Browser, mode: Mode, info: TestInfo, live: boolean) {
  const external = process.env.CONNECTIVITY_URL;
  const server = external ? {
    origin: new URL(external).origin,
    code: (await readFile(resolve('.secret/hosting-code'), 'utf8')).trim(),
    warnings: null, close: async () => {},
  } : await roomService({ connectivity: true, turnFile: live ? resolve('.secret/turn-secret') : undefined });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const [host, guest] = [pages[0]!, pages[1]!], errors: string[] = [];
  const started = performance.now();
  try {
    for (const page of pages) {
      page.on('pageerror', () => errors.push('browser_script_error'));
      if (!external) await page.route('**/connectivity.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
      await page.goto(external ?? server.origin + '/connectivity.html');
      await page.locator('#mode').selectOption(mode);
      await page.evaluate(() => localStorage.setItem('low-pass.records.v1', 'existing-local-records'));
    }
    await host.locator('#access').fill(server.code); await host.locator('#host').click();
    await expect.poll(() => host.evaluate(() => window.connectivity.view().invitation)).not.toBeNull();
    const invitation = await host.evaluate(() => window.connectivity.view().invitation);
    if (!invitation) throw new Error('Missing invitation.');
    await guest.locator('#invitation').fill(invitation); await guest.locator('#join').click();
    await expect(host.locator('#admit')).toBeEnabled(); await host.locator('#admit').click();
    for (const page of [guest, host]) { await expect(page.locator('#connect')).toBeEnabled(); await page.locator('#connect').click(); }
    for (const page of pages) {
      await expect.poll(async () => {
        const state = (await page.evaluate(() => window.connectivity.report())).connection?.status;
        return state === 'open' || state === 'closed';
      }, { timeout: 35_000 }).toBe(true);
    }
    const connected = await Promise.all(pages.map(page => page.evaluate(() => window.connectivity.report())));
    expect(connected.map(report => report.connection?.status)).toEqual(['open', 'open']);
    if (mode === 'udp' || mode === 'tcp' || mode === 'tls') {
      for (const report of connected) {
        expect(report.connection?.selected?.local).toBe('relay');
        expect(report.connection?.selected?.remote).toBe('relay');
        expect(report.connection?.selected?.relayProtocol).toBe(mode);
      }
    } else if (mode === 'direct') {
      for (const report of connected) expect(report.connection?.selected?.local).toBe('host');
    }
    for (const page of pages) await page.locator('#probe').click();
    await host.locator('#plan').click();
    await expect.poll(async () => {
      const [h, g] = await Promise.all(pages.map(page => page.evaluate(() => window.connectivity.report())));
      return { complete: !!h!.sentPlan && h!.sentPlan.digest === g!.receivedPlan?.digest,
        commands: [h!.commandReceived, g!.commandReceived], probes: h!.rttSamples > 0 && g!.rttSamples > 0 };
    }, { timeout: 35_000 }).toEqual({ complete: true, commands: [true, true], probes: true });
    for (const page of pages) {
      const report = await page.evaluate(() => window.connectivity.report());
      expect(report.error).toBeNull(); expect(report.errors).toEqual([]);
      // A local diagnostic regression ceiling, not the game's eventual fairness envelope.
      if (live) expect(report.maximumRttMs).toBeLessThan(500);
      expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ 'low-pass.records.v1': 'existing-local-records' });
    }
    if (!live) await guest.locator('#report').screenshot({ path: info.outputPath('redacted-report.png') });
    expect(errors).toEqual([]); if (server.warnings) expect(server.warnings).toEqual([]);
  } finally {
    try {
      const reports = await Promise.all(pages.map(page => page.evaluate(() => window.connectivity?.report() ?? null)));
      const summary = { mode, live, elapsedMs: performance.now() - started, reports, scriptErrors: errors };
      await info.attach('redacted-connectivity', { body: Buffer.from(JSON.stringify(summary, null, 2)), contentType: 'application/json' });
      if (live) console.info(JSON.stringify(summary));
    } finally {
      await Promise.all(pages.map(page => page.evaluate(() => window.connectivity?.dispose())))
        .finally(() => Promise.all(contexts.map(context => context.close())))
        .finally(() => server.close());
    }
  }
}

test('local connectivity page exercises real room controls and direct peer data without touching records', async ({ browser }, info) => {
  await exercise(browser, 'direct', info, false);
  const html = await readFile(resolve('tests/fixtures/connectivity.html'), 'utf8');
  expect(html).not.toContain('static-auth-secret');
});

for (const mode of ['auto', 'udp', 'tcp', 'tls'] as const) {
  test(`opt-in deployed TURN connectivity: ${mode}`, async ({ browser }, info) => {
    test.skip(process.env.LOW_PASS_LIVE_TURN !== '1', 'Requires explicit operator authorization and the ignored local secret file.');
    test.setTimeout(100_000);
    await exercise(browser, mode, info, true);
  });
}
