import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 960, height: 540 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('low-pass.records.v1')) {
      localStorage.setItem('low-pass.records.v1', JSON.stringify({
        version: 1, scores: [], settings: { quality: 'low', assist: true, muted: false, volume: 0.55 },
      }));
    }
  });
});

for (const terrain of ['green-valley', 'desert'] as const) {
  test(`loads real 3D assets, starts a flight, drops accurately, and pauses in ${terrain}`, async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    const externalRequests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.protocol.startsWith('http') && url.origin !== new URL(baseURL!).origin) externalRequests.push(url.href);
    });
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-screen', 'menu', { timeout: 30_000 });
    await page.locator('#settings summary').click();
    await page.locator('#terrain').selectOption(terrain);
    await page.screenshot({ path: `test-results/menu-${terrain}.png` });
    await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    const reticle = page.getByRole('img', { name: 'Predicted bomb impact' });
    await expect(reticle).toBeVisible();
    await expect(reticle).toHaveCSS('width', '26px');
    await expect(reticle).toHaveCSS('z-index', '1');
    await page.keyboard.press('KeyA');
    await expect(reticle).toBeHidden();
    await page.keyboard.press('KeyA');
    await expect(reticle).toBeVisible();
    await page.screenshot({ path: `test-results/aim-${terrain}.png` });
    await page.waitForFunction(() => Number(document.querySelector('#aim-readout')?.getAttribute('data-accuracy')) >= 40,
      undefined, { timeout: 25_000, polling: 'raf' });
    await page.keyboard.press('Space');
    await expect(page.locator('#flight-status')).toContainText('BOMB AWAY');
    await expect(page.locator('#result')).toContainText(/ON TARGET|PRECISION HIT/, { timeout: 15_000 });
    await expect(page.locator('#misses')).toHaveText('0 / 3');
    await expect(page.locator('#app')).toHaveAttribute('data-damage', '0');
    await expect(page.locator('#app')).toHaveAttribute('data-missile', 'true');
    await expect(reticle).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#app')).toHaveAttribute('data-screen', 'paused');
    await page.screenshot({ path: `test-results/flight-${terrain}.png` });
    await page.getByRole('button', { name: 'RESUME FLIGHT' }).click();
    await expect(page.locator('#app')).toHaveAttribute('data-screen', 'playing');
    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
  });
}

test('two survivable missile hits precede the final strike and all damage resets on restart', async ({ page }) => {
  test.setTimeout(210_000);
  await page.goto('/');
  await page.locator('#settings summary').click();
  await page.locator('#terrain').selectOption('desert');
  await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
  const app = page.locator('#app');
  await expect(app).toHaveAttribute('data-damage', '1', { timeout: 60_000 });
  await expect(app).toHaveAttribute('data-screen', 'playing');
  await expect(page.locator('#damage')).toHaveText('AIRFRAME DAMAGED');
  await expect(page.locator('#misses')).toHaveText('1 / 3');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('low-pass.records.v1')!).scores.length)).toBe(0);
  await page.screenshot({ path: 'test-results/damaged-flight.png' });
  await expect(app).toHaveAttribute('data-damage', '2', { timeout: 60_000 });
  await expect(app).toHaveAttribute('data-screen', 'playing');
  await expect(page.locator('#damage')).toHaveText('CRITICAL DAMAGE');
  await expect(page.locator('#misses')).toHaveText('2 / 3');
  await expect(app).toHaveAttribute('data-screen', 'ending', { timeout: 120_000 });
  await expect(page.getByRole('img', { name: 'Predicted bomb impact' })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(app).toHaveAttribute('data-screen', 'paused');
  await page.locator('#settings summary').click();
  await expect(page.locator('#terrain')).toBeDisabled();
  await expect(page.locator('#terrain')).toHaveValue('desert');
  const phase = await app.getAttribute('data-finale');
  await page.waitForTimeout(300);
  await expect(app).toHaveAttribute('data-finale', phase!);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('low-pass.records.v1')!).scores);
  expect(saved).toHaveLength(1);
  expect(saved[0].score).toBe(0);
  await page.getByRole('button', { name: 'RESUME FLIGHT' }).click();
  await expect(app).toHaveAttribute('data-finale', 'destroyed', { timeout: 15_000 });
  await expect(page.locator('#flight-status')).toHaveText('AIRCRAFT DESTROYED');
  await page.screenshot({ path: 'test-results/missile-finale.png' });
  await expect(app).toHaveAttribute('data-screen', 'over', { timeout: 15_000 });
  await page.locator('#records summary').click();
  await expect(page.locator('#score-list')).toContainText('0 pts');
  await page.getByRole('button', { name: 'FLY AGAIN' }).click();
  await expect(app).toHaveAttribute('data-screen', 'playing');
  await expect(app).toHaveAttribute('data-finale', 'none');
  await expect(app).toHaveAttribute('data-missile', 'false');
  await expect(app).toHaveAttribute('data-damage', '0');
  await expect(app).toHaveAttribute('data-terrain', 'desert');
  await expect(page.locator('#damage')).toHaveText('AIRFRAME OK');
  await expect(page.locator('#misses')).toHaveText('0 / 3');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'menu');
  await page.locator('#records summary').click();
  await expect(page.locator('#score-list')).toContainText('0 pts');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('low-pass.records.v1')!).scores.length)).toBe(1);
});

test('settings persist', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'menu');
  await page.locator('#settings summary').click();
  await page.locator('#assist').uncheck();
  await page.locator('#mute').check();
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'menu');
  await page.locator('#settings summary').click();
  await expect(page.locator('#assist')).not.toBeChecked();
  await expect(page.locator('#mute')).toBeChecked();
});

test('fully loaded solo flight, scoring and pause do not require a reachable server', async ({ page, context }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'menu', { timeout: 30_000 });
  await context.setOffline(true);
  try {
    const reachable = await page.evaluate(async () => {
      try { await fetch('/healthz', { cache: 'no-store' }); return true; }
      catch { return false; }
    });
    expect(reachable).toBe(false);
    await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    await page.waitForFunction(() => Number(document.querySelector('#aim-readout')?.getAttribute('data-accuracy')) >= 40,
      undefined, { timeout: 25_000, polling: 'raf' });
    await page.keyboard.press('Space');
    await expect(page.locator('#result')).toContainText(/ON TARGET|PRECISION HIT/, { timeout: 15_000 });
    expect(Number(await page.locator('#score').textContent())).toBeGreaterThan(0);
    await expect(page.locator('#misses')).toHaveText('0 / 3');
    await page.keyboard.press('Escape');
    await expect(page.locator('#app')).toHaveAttribute('data-screen', 'paused');
    await page.getByRole('button', { name: 'RESUME FLIGHT' }).click();
    await expect(page.locator('#app')).toHaveAttribute('data-screen', 'playing');
    expect(errors).toEqual([]);
  } finally { await context.setOffline(false); }
});

test('essential asset failures show a recoverable error instead of an empty game', async ({ page }) => {
  await page.route('**/assets/kestrel.glb', route => route.abort());
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'error');
  await expect(page.getByRole('button', { name: 'RELOAD GAME' })).toBeVisible();
});

test('malformed local data warns without blocking play', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('low-pass.records.v1', '{broken'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'menu');
  await expect(page.locator('#notification')).toContainText('only this session');
  await page.getByRole('button', { name: 'BEGIN FLIGHT' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'playing');
});
