import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';

test('shared lobby gates readiness and preserves independent local settings through delayed messages', async ({ page }, info) => {
  const result = await build({ configFile: false, logLevel: 'error',
    build: { write: false, lib: { entry: resolve('tests/fixtures/lobby-ui.ts'), name: 'LobbyUi', formats: ['iife'] } } });
  const chunk = (Array.isArray(result) ? result : [result]).flatMap(r => 'output' in r ? r.output : []).find(c => c.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing lobby fixture.');
  await page.addInitScript(() => localStorage.setItem('low-pass.records.v1', 'existing-records'));
  await page.route('**/lobby-ui-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Local lobby UI fixture</title>
    <style>body{font:16px system-ui} main{display:flex;gap:40px} label{display:block;margin:16px 0} section{width:45%}</style>
    <p>UI-only fault harness, not real network or asset readiness.</p><label>Fixture course data verified<input id="fixture-verified" type="checkbox"></label>
    <main><section id="host-lobby"></section><section id="guest-lobby"></section></main><script src="/lobby-ui.js"></script>` }));
  await page.route('**/lobby-ui.js', route => route.fulfill({ contentType: 'text/javascript', body: chunk.code }));
  await page.goto('/lobby-ui-fixture');
  const host = page.locator('#host-lobby'), guest = page.locator('#guest-lobby');
  await expect(guest.locator('[data-control="players"]')).toContainText('assistance off');
  await expect(host.getByLabel('I am ready')).toBeDisabled();
  await expect(guest.getByLabel('Shared terrain')).toBeDisabled();
  await page.getByLabel('Fixture course data verified').check();
  await host.getByLabel('I am ready').check(); await guest.getByLabel('I am ready').check();
  await expect(host.locator('[data-control="status"]')).toHaveText('Both players are ready for this configuration.');
  await guest.getByLabel('My graphics quality').selectOption('high'); await guest.getByLabel('Mute my sound').check();
  await expect(host.getByLabel('My graphics quality')).toHaveValue('medium'); await expect(host.getByLabel('Mute my sound')).not.toBeChecked();
  await host.getByLabel('Shared terrain').selectOption('desert');
  await expect(guest.getByLabel('Shared terrain')).toHaveValue('desert');
  for (const panel of [host, guest]) { await expect(panel.getByLabel('I am ready')).not.toBeChecked(); await expect(panel.getByLabel('I am ready')).toBeDisabled(); }
  expect(await page.evaluate(() => window.lobbyUi.guestSoloTerrain())).toBe('river-canyon');
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ 'low-pass.records.v1': 'existing-records' });
  await page.screenshot({ path: info.outputPath('lobby-controls.png') });
});
