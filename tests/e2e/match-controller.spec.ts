import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { identityPlugin } from '../../scripts/build-identity.mjs';
import { roomService } from '../helpers/room-service.js';
import type {} from '../fixtures/match-controller.js';

let code: string;
const assets = new Map<string, string | Uint8Array>();
test.beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: 'error', plugins: [identityPlugin()],
    build: { write: false, lib: { entry: resolve('tests/fixtures/match-controller.ts'), name: 'MatchFixture', formats: ['iife'] } } });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(r => 'output' in r ? r.output : []);
  const chunk = chunks.find(c => c.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Could not build match fixture.');
  code = chunk.code;
  for (const output of chunks) if (output.type === 'asset') assets.set('/' + output.fileName, output.source);
});

for (const terrain of ['green-valley', 'river-canyon'] as const) test(`native ${terrain} lobby starts continuous play and streams next encounters`, async ({ browser }) => {
  test.setTimeout(180_000);
  const server = await roomService();
  const store = server.service.rooms!.store;
  const host = store.create(store.authorize(server.code, 'match-host').capability, 'match-host');
  const guest = store.join(host.invitation.replace('-', ''));
  store.admit(host.capability, guest.room.participantId, true);
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const errors: string[] = [];
  try {
    for (const page of pages) {
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.route('**/rtc-fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: code }));
      await page.route('**/assets/*', route => {
        const source = assets.get(new URL(route.request().url()).pathname);
        return source === undefined ? route.continue() : route.fulfill({
          contentType: 'text/javascript', body: typeof source === 'string' ? source : Buffer.from(source),
        });
      });
      await page.goto(server.origin + '/rtc-fixture');
    }
    const members = [host, guest].map(value => ({ capability: value.capability, room: store.status(value.capability) }));
    await Promise.all(pages.map((page, index) => page.evaluate(({ member, terrain }) => window.matchFixture.connect(member, terrain),
      { member: members[index]!, terrain })));
    await expect.poll(async () => {
      const reports = await Promise.all(pages.map(page => page.evaluate(() => window.matchFixture.report())));
      if (reports.some(report => report.issue)) throw new Error(JSON.stringify(reports));
      return reports;
    },
      { timeout: 45_000 }).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'playing', issue: null, players: expect.any(Array) }),
    ]));
    await expect.poll(async () => {
      const reports = await Promise.all(pages.map(page => page.evaluate(() => window.matchFixture.report())));
      if (reports.some(report => report.issue)) throw new Error(JSON.stringify(reports));
      return reports.map(report => ({ drops: report.drops, scores: report.players.map(player => player.score > 0), later: report.time > 42 }));
    }, { timeout: 70_000 }).toEqual([{ drops: 2, scores: [true, true], later: true }, { drops: 2, scores: [true, true], later: true }]);
    await expect.poll(async () => {
      const reports = await Promise.all(pages.map(page => page.evaluate(() => window.matchFixture.report())));
      if (reports.some(report => report.issue)) throw new Error(JSON.stringify(reports));
      return reports.map(report => ({ phase: report.phase, misses: report.players.map(player => player.misses), destroyed: report.destroyed }));
    }, { timeout: 90_000 }).toEqual([
      { phase: 'over', misses: [3, 3], destroyed: [true, true] },
      { phase: 'over', misses: [3, 3], destroyed: [true, true] },
    ]);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(pages.map(page => page.evaluate(() => window.matchFixture?.close())));
    await Promise.all(contexts.map(context => context.close())); await server.close();
  }
});
