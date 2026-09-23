import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('bounded multiplayer results display winner, draw, incomplete and empty records safely', async ({ page }, info) => {
  const built = await build({ configFile: false, logLevel: 'error',
    build: { write: false, lib: { entry: resolve('tests/fixtures/multiplayer-results.ts'), name: 'MultiplayerResults', formats: ['iife'] } } });
  const chunk = (Array.isArray(built) ? built : [built]).flatMap(value => 'output' in value ? value.output : []).find(value => value.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing results fixture.');
  const css = await readFile('src/ui/style.css', 'utf8');
  await page.route('**/results-fixture', route => route.fulfill({ contentType: 'text/html', body:
    `<!doctype html><title>Results UI fixture, not gameplay</title><style>${css}</style>
    <label style="position:fixed;top:15px;left:24px;z-index:3">Fixture outcome
      <select id="fixture-outcome"><option value="win">Winner</option><option value="draw">Draw</option>
        <option value="incomplete">Incomplete</option><option value="empty">Empty records</option></select></label>
    <div id="app" data-multiplayer="true"><section id="match-results" class="panel" hidden></section></div>
    <script src="/results-fixture.js"></script>` }));
  await page.route('**/results-fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: chunk.code }));
  await page.setViewportSize({ width: 600, height: 600 });
  await page.goto('/results-fixture');
  await expect(page.locator('#match-result-title')).toHaveText('PLAYER 2 WINS');
  await expect(page.locator('#match-result-title')).toBeFocused();
  await expect(page.getByRole('table', { name: 'Private match player results' })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('complete-results.png') });
  await page.getByLabel('Fixture outcome').selectOption('draw');
  await expect(page.locator('#match-result-title')).toHaveText('MATCH DRAW');
  await page.getByLabel('Fixture outcome').selectOption('incomplete');
  await expect(page.locator('#match-result-title')).toHaveText('MATCH INCOMPLETE');
  await expect(page.locator('#match-result-description')).toContainText('No winner.');
  await expect(page.locator('#match-result-players tr[data-slot="1"]')).toContainText('200');
  await expect(page.locator('#match-result-players tr[data-slot="1"]')).toContainText('UNFINISHED');
  await expect(page.locator('#match-result-error')).toHaveText('<b>Connection unavailable.</b>');
  await expect(page.locator('#match-result-error b')).toHaveCount(0);
  await page.locator('summary').focus(); await page.keyboard.press('Space');
  await expect(page.locator('[data-records="scores"] li')).toHaveCount(1);
  await expect(page.locator('[data-records="matches"]')).toContainText('MATCH INCOMPLETE');
  await page.getByLabel('Fixture outcome').selectOption('empty');
  await page.locator('summary').click();
  await expect(page.locator('[data-records="scores"]')).toHaveText('No completed multiplayer scores yet.');
  await expect(page.locator('[data-records="matches"]')).toHaveText('No multiplayer matches yet.');
});
