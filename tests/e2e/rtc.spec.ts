import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { roomService } from '../helpers/room-service.js';
import type {} from '../fixtures/rtc.js';

let code: string;
test.beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: 'error',
    build: { write: false, lib: { entry: resolve('tests/fixtures/rtc.ts'), name: 'RtcFixture', formats: ['iife'] } } });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(r => 'output' in r ? r.output : []);
  const chunk = chunks.find(c => c.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Could not build RTC fixture.');
  code = chunk.code;
});

async function pair(browser: Browser) {
  const server = await roomService();
  const store = server.service.rooms!.store;
  const host = store.create(store.authorize(server.code, 'fixture-host').capability, 'fixture-host');
  const guest = store.join(host.invitation.replace('-', ''));
  store.admit(host.capability, guest.room.participantId, true);
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const errors: string[] = [];
  for (const page of pages) {
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/rtc-fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: code }));
    await page.goto(server.origin + '/rtc-fixture');
  }
  const h = pages[0]!, g = pages[1]!;
  async function connect(generation = 1, epoch = 0, mismatch = false, relayOnly = false) {
    await g.evaluate(options => window.connectRtc(options), { role: 'guest' as const, capability: guest.capability, roomId: host.room.roomId,
      generation, epoch, mismatch, relayOnly, timeoutMs: relayOnly ? 1000 : 30_000 });
    await h.evaluate(options => window.connectRtc(options), { role: 'host' as const, capability: host.capability, roomId: host.room.roomId,
      generation, epoch, relayOnly, timeoutMs: relayOnly ? 1000 : 30_000 });
    await h.evaluate(() => window.rtcFixture.peer!.start());
  }
  return { server, h, g, pages, errors, connect, close: async () => {
    await Promise.all(pages.map(page => page.evaluate(() => window.rtcFixture?.close())));
    await Promise.all(contexts.map(context => context.close())); await server.close();
  } };
}
const open = (page: Page) => expect.poll(() => page.evaluate(() => window.rtcFixture.peer?.status)).toBe('open');

test('authenticated native peers transfer a real plan, multiplex commands/state, and recreate in a new epoch', async ({ browser }) => {
  const state = await pair(browser);
  try {
    await state.connect(); await Promise.all(state.pages.map(open));
    const sent = await state.h.evaluate(() => window.rtcFixture.plan());
    await state.g.evaluate(() => window.rtcFixture.command());
    await expect.poll(() => state.g.evaluate(() => ({ received: window.rtcFixture.received,
      errors: window.rtcFixture.errors, status: window.rtcFixture.peer!.status })), { timeout: 20_000 })
      .toEqual({ received: sent, errors: [], status: 'open' });
    await expect.poll(() => state.h.evaluate(() => window.rtcFixture.messages.filter(m => m.type === 'command').length)).toBe(1);
    await expect.poll(() => state.h.evaluate(() => window.rtcFixture.messages.filter(m => m.type === 'ping').length)).toBe(1);
    const diagnostics = await state.h.evaluate(() => window.rtcFixture.peer!.diagnostics());
    expect(diagnostics.selected?.local).toBe('host'); expect(diagnostics.selected?.remote).toBe('host');
    expect(diagnostics.selected?.protocol).toBe('udp');
    expect(await state.h.evaluate(() => window.rtcFixture.backpressure)).toBeGreaterThan(0);
    for (const page of state.pages) expect(await page.evaluate(() => window.rtcFixture.errors)).toEqual([]);
    await Promise.all(state.pages.map(page => page.evaluate(() => window.rtcFixture.close())));
    await expect.poll(() => state.server.service.signaling!.counts.authenticated).toBe(0);
    await state.connect(2, 1); await Promise.all(state.pages.map(open));
    await state.g.evaluate(() => window.rtcFixture.command());
    await expect.poll(() => state.h.evaluate(() => window.rtcFixture.messages.filter(m => m.type === 'command').map(m => m.epoch))).toEqual([1]);
    expect(state.errors).toEqual([]); expect(state.server.warnings).toEqual([]);
  } finally { await state.close(); }
});

test('native peers reject incompatible builds before exposing application messages', async ({ browser }) => {
  const state = await pair(browser);
  try {
    await state.connect(1, 0, true);
    await expect.poll(async () => Promise.all(state.pages.map(page => page.evaluate(() => window.rtcFixture.peer!.status))))
      .toEqual(['closed', 'closed']);
    const failures = await Promise.all(state.pages.map(page => page.evaluate(() => window.rtcFixture.peer!.failure)));
    expect(failures).toContain('compatibility');
    for (const page of state.pages) expect(await page.evaluate(() => window.rtcFixture.messages.length)).toBe(0);
    expect(state.errors).toEqual([]);
  } finally { await state.close(); }
});

test('test-only relay policy cannot silently fall back to a direct path', async ({ browser }) => {
  const state = await pair(browser);
  try {
    await state.connect(1, 0, false, true);
    await expect.poll(async () => Promise.all(state.pages.map(page => page.evaluate(() => window.rtcFixture.peer!.status))))
      .toEqual(['closed', 'closed']);
    for (const page of state.pages) {
      const diagnostic = await page.evaluate(() => window.rtcFixture.peer!.diagnostics());
      expect(diagnostic.selected).toBeNull(); expect(['timeout', 'connection']).toContain(diagnostic.failure);
    }
    expect(state.errors).toEqual([]);
  } finally { await state.close(); }
});
