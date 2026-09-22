import { test, expect } from '@playwright/test';
import type { Browser, TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import { roomService } from '../helpers/room-service.js';
import type {} from '../fixtures/connectivity.js';
import { loopbackPreview } from '../helpers/loopback-preview.js';

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

async function exercise(browser: Browser, mode: Mode, info: TestInfo, live: boolean, soakMs = 0) {
  const external = loopbackPreview(process.env.CONNECTIVITY_URL, '/connectivity.html');
  const server = external ? {
    origin: new URL(external).origin,
    code: (await readFile(resolve('.secret/hosting-code'), 'utf8')).trim(),
    warnings: null, close: async () => {},
  } : await roomService({ connectivity: true, turnFile: live ? resolve('.secret/turn-secret') : undefined });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const [host, guest] = [pages[0]!, pages[1]!], errors: string[] = [];
  const credentialExpiries: number[] = [];
  const observations: Array<{ elapsedMs: number; generations: number[] }> = [];
  const started = performance.now();
  try {
    for (const page of pages) {
      page.on('pageerror', () => errors.push('browser_script_error'));
      if (soakMs) page.on('response', response => {
        if (response.url().endsWith('/api/multiplayer/room/ice') && response.ok()) {
          void response.json().then((value: unknown) => {
            if (typeof value === 'object' && value !== null && 'expiresAtMs' in value && typeof value.expiresAtMs === 'number') {
              credentialExpiries.push(value.expiresAtMs);
            } else errors.push('invalid_credential_expiry');
          }).catch(() => errors.push('unreadable_credential_expiry'));
        }
      });
      if (!external) await page.route('**/connectivity.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
      await page.goto(external ?? server.origin + '/connectivity.html');
      await page.locator('#mode').selectOption(mode);
      await page.evaluate(() => localStorage.setItem('low-pass.records.v1', 'existing-local-records'));
    }
    try { await host.locator('#access').fill(server.code); }
    catch { throw new Error('Could not enter the hosting code; private input details withheld.'); }
    await host.locator('#host').click();
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
    if (soakMs) {
      console.info('Verified initial TLS relay data. Starting the bounded 21-minute continuity hold.');
      const until = performance.now() + soakMs;
      while (performance.now() < until) {
        await new Promise(resolve => setTimeout(resolve, Math.min(30_000, until - performance.now())));
        const current = await Promise.all(pages.map(page => page.evaluate(() => window.connectivity.report())));
        expect(current.map(report => report.connection?.status)).toEqual(['open', 'open']);
        for (const report of current) { expect(report.error).toBeNull(); expect(report.errors).toEqual([]); }
        observations.push({ elapsedMs: performance.now() - started, generations: current.map(report => report.generation) });
        if (observations.length % 10 === 0) console.info(`Relay continuity check: ${Math.floor((performance.now() - started) / 60_000)} minutes connected.`);
      }
      expect(credentialExpiries).toHaveLength(2);
      expect(Date.now()).toBeGreaterThan(Math.max(...credentialExpiries) + 60_000);
      const reconnectAt = performance.now();
      await Promise.all(pages.map(page => page.evaluate(() => window.connectivity.reconnect())));
      await expect.poll(async () => (await Promise.all(pages.map(page => page.evaluate(() => window.connectivity.report()))))
        .map(report => report.connection?.status), { timeout: 15_000 }).toEqual(['open', 'open']);
      expect(performance.now() - reconnectAt).toBeLessThan(15_000);
      expect(credentialExpiries).toHaveLength(4);
      expect(Math.min(...credentialExpiries.slice(2))).toBeGreaterThan(Math.max(...credentialExpiries.slice(0, 2)));
      for (const page of pages) await page.locator('#probe').click();
      await host.locator('#plan').click();
      await expect.poll(async () => {
        const [h, g] = await Promise.all(pages.map(page => page.evaluate(() => window.connectivity.report())));
        return h!.generation === 2 && g!.generation === 2 && !!h!.sentPlan && h!.sentPlan.digest === g!.receivedPlan?.digest &&
          h!.commandReceived && g!.commandReceived && h!.rttSamples > 0 && g!.rttSamples > 0;
      }, { timeout: 35_000 }).toBe(true);
    }
    expect(errors).toEqual([]); if (server.warnings) expect(server.warnings).toEqual([]);
  } finally {
    try {
      const reports = await Promise.all(pages.map(page => page.evaluate(() => window.connectivity?.report() ?? null)));
      const summary = { mode, live, elapsedMs: performance.now() - started,
        fixtureDigest: external ? null : createHash('sha256').update(script).digest('hex'), observations,
        credentialExpiries, reports, scriptErrors: errors };
      await writeFile(info.outputPath('redacted-connectivity.json'), JSON.stringify(summary, null, 2));
      await info.attach('redacted-connectivity', { body: Buffer.from(JSON.stringify(summary, null, 2)), contentType: 'application/json' });
      if (live) console.info(JSON.stringify(summary));
    } finally {
      await Promise.all(pages.map(page => page.evaluate(() => window.connectivity?.dispose())))
        .finally(() => Promise.all(contexts.map(context => context.close())))
        .finally(() => server.close());
    }

  }
}

test('opt-in deployed TURN long-lived TLS allocation and fresh-credential recreation', async ({ browser }, info) => {
  test.skip(process.env.LOW_PASS_LIVE_TURN !== '1' || process.env.LOW_PASS_TURN_SOAK !== '1', 'Explicit 21-minute relay soak opt-in required.');
  test.setTimeout(1_440_000);
  await exercise(browser, 'tls', info, true, 21 * 60_000);
});

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
