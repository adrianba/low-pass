import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { build } from 'vite';
import { roomMembership } from '../../shared/protocol/rooms.js';
import { roomService } from '../helpers/room-service.js';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
let script: string;
test.beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: 'error',
    build: { write: false, lib: { entry: resolve('tests/fixtures/room-controls.ts'), name: 'RoomControls', formats: ['iife'] } } });
  const chunk = (Array.isArray(result) ? result : [result]).flatMap(r => 'output' in r ? r.output : []).find(c => c.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Could not build room controls.');
  script = chunk.code;
});
async function load(page: Page, origin: string) {
  await page.route('**/room-controls.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
  await page.goto(origin + '/room-controls.html');
  await expect(page.getByLabel('Hosting access code', { exact: true })).toBeEnabled();
}
async function post(page: Page, path: string, data: object, credential?: string) {
  return page.evaluate(async ({ path, data, credential }) => {
    const response = await fetch('/api/multiplayer/' + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() as unknown };
  }, { path, data, credential });
}

test('host controls clear credentials, copy safely, decline/renew/admit and close a real private room', async ({ browser }, info) => {
  const server = await roomService({ roomControls: true });
  const context = await browser.newContext(), guestContext = await browser.newContext();
  const page = await context.newPage(), guest = await guestContext.newPage(), errors: string[] = [];
  page.on('pageerror', () => errors.push('browser_script_error'));
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } } });
      localStorage.setItem('low-pass.records.v1', 'existing-local-records');
    });
    await load(page, server.origin); await guest.goto(server.origin + '/room-fixture');
    const code = page.getByLabel('Hosting access code', { exact: true });
    await expect(code).toBeFocused();
    await code.fill('incorrect'); await code.press('Enter');
    await expect(page.locator('#host-error')).toContainText('was not accepted');
    await expect(code).toHaveValue(''); await expect(code).toBeFocused();
    await code.fill(server.code); await code.press('Enter');
    const invitation = page.getByLabel('Room invitation', { exact: true });
    await expect(invitation).toHaveValue(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await expect(invitation).toBeFocused(); await expect(code).toHaveValue('');
    expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ 'low-pass.records.v1': 'existing-local-records' });
    await page.getByRole('button', { name: 'COPY INVITATION', exact: true }).click();
    await expect(page.locator('#host-copy-status')).toContainText('copy it manually');
    expect(await invitation.evaluate((element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!)).toBe(9);
    const first = roomMembership.parse((await post(guest, 'join', { invitation: await invitation.inputValue() })).body);
    await expect(page.getByRole('button', { name: 'DECLINE', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'DECLINE', exact: true }).click();
    await expect(invitation).toHaveValue('');
    expect((await post(guest, 'room/status', {}, first.capability)).body).toEqual({ error: 'admission_denied' });
    await page.getByRole('button', { name: 'NEW INVITATION', exact: true }).click();
    await expect(invitation).toHaveValue(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const second = roomMembership.parse((await post(guest, 'join', { invitation: await invitation.inputValue() })).body);
    await page.getByRole('button', { name: 'ADMIT PLAYER 2', exact: true }).click();
    await expect(page.locator('#host-status')).toContainText('Both players admitted');
    await expect(invitation).toHaveValue('');
    expect((await post(guest, 'room/status', {}, second.capability)).status).toBe(200);
    await page.screenshot({ path: info.outputPath('host-admitted.png') });
    await page.getByRole('button', { name: 'CANCEL / CLOSE ROOM', exact: true }).click();
    await expect(code).toBeFocused();
    await expect.poll(() => server.service.rooms!.store.counts.rooms).toBe(0);
    expect(errors).toEqual([]); expect(server.warnings).toEqual([]);
  } finally { await context.close(); await guestContext.close(); await server.close(); }
});

test('canceling after server-side creation cleans up the late response without exposing its invitation', async ({ browser }) => {
  const server = await roomService({ roomControls: true }), context = await browser.newContext(), page = await context.newPage();
  let release = () => {};
  try {
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/multiplayer/rooms', async route => {
      const response = await route.fetch(); await held; await route.fulfill({ response });
    });
    await load(page, server.origin);
    await page.getByLabel('Hosting access code', { exact: true }).fill(server.code);
    await page.getByRole('button', { name: 'CREATE ROOM', exact: true }).click();
    await expect.poll(() => server.service.rooms!.store.counts.rooms).toBe(1);
    await page.getByRole('button', { name: 'CANCEL / CLOSE ROOM', exact: true }).click();
    await expect(page.locator('#host-status')).toContainText('Closing the room');
    release();
    await expect(page.getByLabel('Hosting access code', { exact: true })).toBeEnabled();
    await expect.poll(() => server.service.rooms!.store.counts.rooms).toBe(0);
    await expect(page.getByLabel('Room invitation', { exact: true })).toHaveValue('');
  } finally { release(); await context.close(); await server.close(); }
});

test('unavailable service, failed refresh and clipboard success are explicit and recoverable', async ({ browser }) => {
  const server = await roomService({ roomControls: true }), context = await browser.newContext(), page = await context.newPage();
  try {
    await page.route('**/api/multiplayer/capabilities', route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ multiplayer: false, reason: 'configuration_error' }),
    }));
    await page.route('**/room-controls.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
    await page.goto(server.origin + '/room-controls.html');
    await expect(page.locator('#host-error')).toContainText('Private rooms are unavailable');
    await expect(page.getByRole('button', { name: 'CREATE ROOM', exact: true })).toBeDisabled();
    await page.unroute('**/api/multiplayer/capabilities');
    await page.getByRole('button', { name: 'CHECK SERVICE AGAIN', exact: true }).click();
    const code = page.getByLabel('Hosting access code', { exact: true });
    await expect(code).toBeFocused(); await code.fill(server.code); await code.press('Enter');
    const invitation = page.getByLabel('Room invitation', { exact: true });
    await expect(invitation).toHaveValue(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} } }));
    await page.getByRole('button', { name: 'COPY INVITATION', exact: true }).click();
    await expect(page.locator('#host-copy-status')).toHaveText('Invitation copied.');
    await page.route('**/api/multiplayer/room/status', route => route.abort());
    await page.getByRole('button', { name: 'REFRESH ROOM', exact: true }).click();
    await expect(page.locator('#host-error')).toContainText('could not be reached');
    await page.unroute('**/api/multiplayer/room/status');
    await page.getByRole('button', { name: 'REFRESH ROOM', exact: true }).click();
    await expect(page.locator('#host-error')).toHaveText('');
    await page.keyboard.press('Escape');
    await expect.poll(() => server.service.rooms!.store.counts.rooms).toBe(0);
    await expect(code).toBeFocused();
  } finally { await context.close(); await server.close(); }
});
