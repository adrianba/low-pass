import { test, expect } from '@playwright/test';
import { roomService } from '../helpers/room-service.js';
import { loopbackPreview } from '../helpers/loopback-preview.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function applicationService() {
  const external = loopbackPreview(process.env.MULTIPLAYER_MENU_URL, '/');
  return external ? { origin: new URL(external).origin, code: (await readFile(resolve('.secret/hosting-code'), 'utf8')).trim(),
    close: async () => {} } : roomService();
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
const stored = JSON.stringify({ version: 1, scores: [], settings: {
  quality: 'low', assist: false, muted: true, volume: 0.5, terrain: 'green-valley',
} });

test('configured production menu opens private rooms and consumes root invitation fragments', async ({ browser }) => {
  const server = await applicationService();
  const host = await browser.newContext(), guest = await browser.newContext();
  try {
    for (const context of [host, guest]) await context.addInitScript(value => localStorage.setItem('low-pass.records.v1', value), stored);
    const hostPage = await host.newPage(), guestPage = await guest.newPage();
    await hostPage.goto(server.origin + '/');
    await hostPage.getByRole('button', { name: 'PRIVATE FLIGHT', exact: true }).click();
    try { await hostPage.getByLabel('Hosting access code', { exact: true }).fill(server.code); }
    catch { throw new Error('Could not enter the private hosting code; input details withheld.'); }
    await hostPage.getByRole('button', { name: 'CREATE ROOM', exact: true }).click();
    await expect.poll(async () => (await hostPage.locator('#host-link').inputValue()).startsWith(`${server.origin}/#join=`)).toBe(true);
    const invitation = await hostPage.locator('#host-link').inputValue();
    try { await guestPage.goto(invitation); }
    catch { throw new Error('Could not open the private invitation; URL details withheld.'); }
    await expect.poll(() => guestPage.url() === server.origin + '/').toBe(true);
    await guestPage.getByRole('button', { name: 'PRIVATE FLIGHT', exact: true }).click();
    await expect(guestPage.locator('#match-role')).toHaveValue('guest');
    await expect(guestPage.getByLabel('Room invitation', { exact: true })).not.toHaveValue('');
    await guestPage.getByRole('button', { name: 'ASK TO JOIN', exact: true }).click();
    await hostPage.getByRole('button', { name: 'ADMIT PLAYER 2', exact: true }).click();
    await expect(guestPage.getByRole('button', { name: 'CONNECT LOBBY', exact: true })).toBeEnabled();
    for (const page of [guestPage, hostPage]) {
      await page.locator('#match-exit').click();
      await expect(page.getByRole('button', { name: 'BEGIN FLIGHT' })).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('low-pass.records.v1'))).toBe(stored);
    }
  } finally { await host.close(); await guest.close(); await server.close(); }
});

for (const state of ['disabled', 'unavailable', 'offline'] as const) {
  test(`production menu preserves solo play when multiplayer is ${state}`, async ({ browser }) => {
    const server = await applicationService(), context = await browser.newContext();
    try {
      await context.addInitScript(value => localStorage.setItem('low-pass.records.v1', value), stored);
      const page = await context.newPage();
      await page.route('**/api/multiplayer/capabilities', route => state === 'offline' ? route.abort() : route.fulfill({
        contentType: 'application/json', body: JSON.stringify(state === 'disabled'
          ? { multiplayer: false, reason: 'not_implemented' }
          : { multiplayer: false, reason: 'service_error', rooms: true, signaling: true, turn: false }),
      }));
      await page.goto(server.origin + '/');
      if (state === 'offline') await expect(page.locator('#notification')).toContainText('Solo play is unaffected');
      await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
      await expect(page.locator('#private-flight')).toBeHidden();
      await expect(page.locator('#app')).toHaveAttribute('data-screen', 'playing');
      expect(await page.evaluate(() => localStorage.getItem('low-pass.records.v1'))).toBe(stored);
    } finally { await context.close(); await server.close(); }
  });
}
