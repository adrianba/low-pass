import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'vite';
import { roomMembership } from '../../shared/protocol/rooms.js';
import { roomService } from '../helpers/room-service.js';
import { identityPlugin } from '../../scripts/build-identity.mjs';
import type {} from '../fixtures/room-controls.js';
import { loopbackPreview } from '../helpers/loopback-preview.js';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
let script: string;
test.beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: 'error', plugins: [identityPlugin()],
    build: { write: false, lib: { entry: resolve('tests/fixtures/room-controls.ts'), name: 'RoomControls', formats: ['iife'] } } });
  const chunk = (Array.isArray(result) ? result : [result]).flatMap(r => 'output' in r ? r.output : []).find(c => c.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Could not build room controls.');
  script = chunk.code;
});
async function load(page: Page, origin: string, url?: string) {
  if (!url) await page.route('**/room-controls.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
  await page.goto(url ?? origin + '/room-controls.html');
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
async function previewService(live = false) {
  const external = loopbackPreview(process.env.ROOM_CONTROLS_URL, '/room-controls.html');
  return external
    ? { origin: new URL(external).origin, url: external,
      code: (await readFile(resolve('.secret/hosting-code'), 'utf8')).trim(), close: async () => {} }
    : { ...await roomService({ roomControls: true, turnFile: live ? resolve('.secret/turn-secret') : undefined }), url: undefined };
}
async function admitPair(host: Page, guest: Page, server: { origin: string; code: string; url?: string }) {
  await load(host, server.origin, server.url);
  try { await host.getByLabel('Hosting access code', { exact: true }).fill(server.code); }
  catch { throw new Error('Could not enter the hosting code; private input details withheld.'); }
  await host.getByRole('button', { name: 'CREATE ROOM', exact: true }).click();
  const link = host.getByLabel('Room join link');
  await expect(link).toHaveValue(/#join=/);
  if (!server.url) await guest.route('**/room-controls.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
  await guest.goto(await link.inputValue());
  await guest.getByRole('button', { name: 'ASK TO JOIN', exact: true }).click();
  await host.getByRole('button', { name: 'ADMIT PLAYER 2', exact: true }).click();
  await expect(guest.locator('#guest-status')).toContainText('The host admitted you');
}

for (const height of [720, 600]) {
  test(`both players can see CONNECT LOBBY immediately after admission at ${height}px height`, async ({ browser }, info) => {
    const server = await previewService();
    const hostContext = await browser.newContext({ viewport: { width: 1000, height } });
    const guestContext = await browser.newContext({ viewport: { width: 1000, height } });
    const host = await hostContext.newPage(), guest = await guestContext.newPage();
    try {
      await admitPair(host, guest, server);
      for (const page of [host, guest]) {
        const connect = page.getByRole('button', { name: 'CONNECT LOBBY', exact: true });
        await expect(connect).toBeEnabled();
        if (!server.url) await page.screenshot({ path: info.outputPath(page === host ? 'host-admitted.png' : 'guest-admitted.png') });
        // Locator.click() would automatically scroll and conceal a below-the-fold control.
        await expect(connect).toBeInViewport({ ratio: 1 });
        await expect(connect).toBeFocused();
        expect(await page.evaluate(() => window.roomPreview.report())).toBeNull();
      }
      await expect(host.locator('#host-invitation')).toBeHidden();
      await expect(host.getByRole('button', { name: 'CANCEL / CLOSE ROOM', exact: true })).toBeEnabled();
    } finally {
      await Promise.all([host, guest].map(page => page.evaluate(() => window.roomPreview.dispose())));
      await hostContext.close(); await guestContext.close(); await server.close();
    }
  });
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
    await page.getByLabel('Room role').focus();
    await page.keyboard.press('Escape');
    await expect.poll(() => server.service.rooms!.store.counts.rooms).toBe(0);
    await expect(code).toBeFocused();
  } finally { await context.close(); await server.close(); }
});

test('guest controls consume a join link without auto-joining, follow decline/admission and preserve solo records', async ({ browser }, info) => {
  const server = await roomService({ roomControls: true });
  const hostContext = await browser.newContext(), guestContext = await browser.newContext();
  const host = await hostContext.newPage(), guest = await guestContext.newPage();
  try {
    await load(host, server.origin);
    await host.getByLabel('Hosting access code', { exact: true }).fill(server.code);
    await host.getByRole('button', { name: 'CREATE ROOM', exact: true }).click();
    const invitation = host.getByLabel('Room invitation', { exact: true }), link = host.getByLabel('Room join link');
    await expect(invitation).toHaveValue(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const first = await invitation.inputValue();
    expect(await link.inputValue()).toBe(server.origin + '/room-controls.html#join=' + first);
    await guest.addInitScript(() => localStorage.setItem('low-pass.records.v1', 'existing-guest-records'));
    await guest.route('**/room-controls.js', route => route.fulfill({ contentType: 'text/javascript', body: script }));
    await guest.goto(await link.inputValue());
    const input = guest.getByLabel('Room invitation', { exact: true });
    await expect(input).toHaveValue(first); await expect(input).toBeFocused();
    expect(new URL(guest.url()).hash).toBe('');
    expect(server.service.rooms!.store.counts.members).toBe(1);
    await input.press('Enter');
    await expect(guest.locator('#guest-status')).toContainText('Waiting for the host');
    await expect(input).toHaveValue(''); await expect(guest.locator('#guest-status')).toBeFocused();
    await host.getByRole('button', { name: 'DECLINE', exact: true }).click();
    await expect(guest.locator('#guest-error')).toContainText('declined');
    await expect(input).toBeVisible();
    await host.getByRole('button', { name: 'NEW INVITATION', exact: true }).click();
    await expect(invitation).toHaveValue(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await input.fill(await invitation.inputValue()); await input.press('Enter');
    await host.getByRole('button', { name: 'ADMIT PLAYER 2', exact: true }).click();
    await expect(guest.locator('#guest-status')).toContainText('The host admitted you');
    expect(await guest.evaluate(() => ({ ...localStorage }))).toEqual({ 'low-pass.records.v1': 'existing-guest-records' });
    await guest.screenshot({ path: info.outputPath('guest-admitted.png') });
    await guest.getByRole('button', { name: 'CANCEL / LEAVE ROOM', exact: true }).click();
    await expect(input).toBeFocused();
    await expect(host.locator('#host-error')).toContainText('closed this room');
    expect(server.service.rooms!.store.counts.rooms).toBe(0);
  } finally { await hostContext.close(); await guestContext.close(); await server.close(); }
});

test('guest invitation errors are explicit and a late canceled join frees its reserved slot', async ({ browser }) => {
  const server = await roomService({ roomControls: true });
  const context = await browser.newContext(), host = await context.newPage(), guest = await context.newPage();
  let release = () => {};
  try {
    await load(host, server.origin); await load(guest, server.origin);
    await guest.getByLabel('Room role').selectOption('guest');
    const input = guest.getByLabel('Room invitation', { exact: true });
    await expect(input).toBeFocused();
    for (const error of ['invalid_invitation', 'invitation_expired', 'room_full'] as const) {
      await guest.route('**/api/multiplayer/join', route => route.fulfill({
        status: error === 'room_full' ? 409 : 410, contentType: 'application/json', body: JSON.stringify({ error }),
      }));
      await input.fill('ABCD-EFGH'); await input.press('Enter');
      await expect(guest.locator('#guest-error')).toContainText(error === 'room_full' ? 'second player' : error === 'invitation_expired' ? 'expired' : 'invalid');
      await expect(input).toBeFocused(); await expect(input).toHaveValue('');
      await guest.unroute('**/api/multiplayer/join');
    }
    await host.getByLabel('Hosting access code', { exact: true }).fill(server.code);
    await host.getByRole('button', { name: 'CREATE ROOM', exact: true }).click();
    const invitation = host.getByLabel('Room invitation', { exact: true });
    await expect(invitation).toHaveValue(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const held = new Promise<void>(resolve => { release = resolve; });
    await guest.route('**/api/multiplayer/join', async route => {
      const response = await route.fetch(); await held; await route.fulfill({ response });
    });
    await input.fill(await invitation.inputValue()); await input.press('Enter');
    await expect.poll(() => server.service.rooms!.store.counts.members).toBe(2);
    await guest.getByRole('button', { name: 'CANCEL / LEAVE ROOM', exact: true }).click();
    await expect(guest.locator('#guest-status')).toContainText('Leaving the room');
    release();
    await expect(input).toBeEnabled();
    await expect.poll(() => server.service.rooms!.store.counts.members).toBe(1);
    await expect(invitation).toHaveValue('');
    await host.getByRole('button', { name: 'CANCEL / CLOSE ROOM', exact: true }).click();
  } finally { release(); await context.close(); await server.close(); }
});

test('admitted native peers verify real build identity and both plans before enabling shared readiness', async ({ browser }, info) => {
  test.setTimeout(100_000);
  const server = await roomService({ roomControls: true });
  const hostContext = await browser.newContext(), guestContext = await browser.newContext();
  const host = await hostContext.newPage(), guest = await guestContext.newPage(), errors: string[] = [];
  for (const page of [host, guest]) page.on('pageerror', () => errors.push('browser_script_error'));
  try {
    await admitPair(host, guest, server);
    for (const page of [host, guest]) {
      await page.getByLabel('Connection mode').selectOption('direct');
      await page.getByRole('button', { name: 'CONNECT LOBBY', exact: true }).click();
    }
    await expect(host.getByLabel('I am ready')).toBeDisabled();
    for (const page of [host, guest]) {
      await expect.poll(async () => {
        const status = (await page.evaluate(() => window.roomPreview.report()))?.connection.status;
        return status === 'open' || status === 'closed';
      }, { timeout: 35_000 }).toBe(true);
      expect((await page.evaluate(() => window.roomPreview.report()))?.connection.status).toBe('open');
      await expect.poll(async () => (await page.evaluate(() => window.roomPreview.report()))?.course?.verified, { timeout: 45_000 }).toBe(true);
      await expect(page.getByLabel('I am ready')).toBeEnabled();
    }
    const reports = await Promise.all([host, guest].map(page => page.evaluate(() => window.roomPreview.report())));
    expect(reports[0]?.compatibility).toEqual(reports[1]?.compatibility);
    expect(reports[0]?.compatibility.build).not.toBe('a'.repeat(64));
    expect(reports[0]?.course?.plans).toHaveLength(2);
    expect(reports[0]?.course?.plans).toEqual(reports[1]?.course?.plans);
    await host.getByLabel('I am ready').check(); await guest.getByLabel('I am ready').check();
    await expect(host.locator('#lobby [data-control="status"]')).toHaveText('Both players are ready for this configuration.');
    await host.getByLabel('Shared terrain').selectOption('river-canyon');
    await expect(guest.getByLabel('Shared terrain')).toHaveValue('river-canyon');
    await expect(guest.getByLabel('I am ready')).not.toBeChecked();
    await expect(guest.getByLabel('I am ready')).toBeDisabled();
    await expect.poll(async () => (await guest.evaluate(() => window.roomPreview.report()))?.course, { timeout: 45_000 })
      .toMatchObject({ terrain: 'river-canyon', verified: true });
    await expect(guest.getByLabel('I am ready')).toBeEnabled();
    await host.screenshot({ path: info.outputPath('connected-lobby.png') });
    expect(errors).toEqual([]);
  } finally {
    try {
      const reports = await Promise.all([host, guest].map(page => page.evaluate(() => window.roomPreview.report())));
      await info.attach('redacted-lobby', { body: Buffer.from(JSON.stringify({ reports }, null, 2)), contentType: 'application/json' });
      console.info(JSON.stringify({ reports }));
    } finally {
      await Promise.all([host, guest].map(page => page.evaluate(() => window.roomPreview.dispose())));
      await hostContext.close(); await guestContext.close(); await server.close();
    }
  }
});

test('native lobby refuses a mismatched build before enabling course or player readiness', async ({ browser }) => {
  const server = await roomService({ roomControls: true });
  const hostContext = await browser.newContext(), guestContext = await browser.newContext();
  const host = await hostContext.newPage(), guest = await guestContext.newPage();
  try {
    await admitPair(host, guest, server);
    for (const page of [host, guest]) await page.getByLabel('Connection mode').selectOption('direct');
    await host.getByRole('button', { name: 'CONNECT LOBBY', exact: true }).click();
    await guest.evaluate(() => window.roomPreview.connect({ ...window.roomPreview.identity, build: 'b'.repeat(64) }));
    for (const page of [host, guest]) {
      await expect.poll(async () => (await page.evaluate(() => window.roomPreview.report()))?.connection.status).toBe('closed');
      await expect(page.getByLabel('I am ready')).toBeDisabled();
    }
    const reports = await Promise.all([host, guest].map(page => page.evaluate(() => window.roomPreview.report())));
    expect(reports.some(report => report?.error === 'compatibility')).toBe(true);
    expect(reports.every(report => !report?.course?.verified)).toBe(true);
  } finally {
    await Promise.all([host, guest].map(page => page.evaluate(() => window.roomPreview.dispose())));
    await hostContext.close(); await guestContext.close(); await server.close();
  }
});

for (const mode of ['direct', 'udp', 'tcp', 'tls'] as const) {
  test(`opt-in deployed lobby readiness: ${mode}`, async ({ browser }, info) => {
    test.skip(process.env.LOW_PASS_LIVE_TURN !== '1', 'Requires explicit operator authorization and the ignored local TURN key.');
    test.setTimeout(100_000);
    const server = await previewService(true);
    const hostContext = await browser.newContext(), guestContext = await browser.newContext();
    const host = await hostContext.newPage(), guest = await guestContext.newPage();
    try {
      await admitPair(host, guest, server);
      for (const page of [host, guest]) {
        await page.getByLabel('Connection mode').selectOption(mode);
        await page.getByRole('button', { name: 'CONNECT LOBBY', exact: true }).click();
      }
      await host.getByLabel('Shared terrain').selectOption('river-canyon');
      for (const page of [host, guest]) {
        await expect.poll(async () => {
          const report = await page.evaluate(() => window.roomPreview.report());
          return report?.course?.verified || report?.connection.status === 'closed';
        }, { timeout: 75_000 }).toBe(true);
        const report = await page.evaluate(() => window.roomPreview.report());
        expect(report?.error).toBeNull();
        expect(report?.course).toMatchObject({ terrain: 'river-canyon', verified: true });
        expect(report?.connection.peer?.selected).toMatchObject(mode === 'direct'
          ? { local: 'host', remote: 'host' } : { local: 'relay', remote: 'relay', relayProtocol: mode });
        await expect(page.getByLabel('I am ready')).toBeEnabled();
      }
      await host.getByLabel('I am ready').check(); await guest.getByLabel('I am ready').check();
      await expect(host.locator('#lobby [data-control="status"]')).toHaveText('Both players are ready for this configuration.');
    } finally {
      try {
        const reports = await Promise.all([host, guest].map(page => page.evaluate(() => window.roomPreview.report())));
        await writeFile(info.outputPath('redacted-lobby.json'), JSON.stringify({ mode, reports }, null, 2));
        await info.attach('redacted-lobby', { body: Buffer.from(JSON.stringify({ mode, reports }, null, 2)), contentType: 'application/json' });
        console.info(JSON.stringify({ mode, reports }));
      } finally {
        await Promise.all([host, guest].map(page => page.evaluate(() => window.roomPreview.dispose())));
        await hostContext.close(); await guestContext.close(); await server.close();
      }
    }
  });
}
