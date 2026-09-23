import { test, expect } from '@playwright/test';
import { roomService } from '../helpers/room-service.js';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
for (const terrain of ['green-valley', 'river-canyon'] as const) test(`opt-in ${terrain} application plays on the real canvas and restores solo`, async ({ browser }, info) => {
  test.setTimeout(180_000);
  const server = await roomService({ multiplayerApp: true });
  const guestBrowser = await browser.browserType().launch({ channel: info.project.name === 'edge' ? 'msedge' : 'chromium' });
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 840, height: 732 }, deviceScaleFactor: 0.25 }),
    guestBrowser.newContext({ viewport: { width: 840, height: 732 }, deviceScaleFactor: 0.25 })]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const errors: string[] = [];
  const stored = JSON.stringify({ version: 1, settings: { quality: 'low', assist: false, muted: true, volume: 0.5, terrain },
    scores: [{ id: 'existing-solo-score', score: 1234, date: '2026-09-20T00:00:00Z', assisted: false }] });
  try {
    for (const page of pages) {
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.addInitScript(value => {
        const original = crypto.getRandomValues.bind(crypto);
        Object.defineProperty(crypto, 'getRandomValues', { value: (array: ArrayBufferView<ArrayBuffer>) => {
          original(array);
          if (array instanceof Uint32Array && array.length === 1) array[0] = 7;
          return array;
        } });
        localStorage.setItem('low-pass.records.v1', value);
      }, stored);
    }
    const [host, guest] = [pages[0]!, pages[1]!];
    await host.goto(server.origin + '/multiplayer.html');
    await host.getByRole('button', { name: 'PRIVATE FLIGHT PREVIEW', exact: true }).click();
    await host.getByLabel('Hosting access code', { exact: true }).fill(server.code);
    await host.getByRole('button', { name: 'CREATE ROOM', exact: true }).click();
    await expect(host.locator('#host-link')).toHaveValue(/multiplayer\.html#join=/);
    await guest.goto(await host.locator('#host-link').inputValue());
    await expect(guest).toHaveURL(server.origin + '/multiplayer.html');
    await guest.getByRole('button', { name: 'PRIVATE FLIGHT PREVIEW', exact: true }).click();
    await guest.getByRole('button', { name: 'ASK TO JOIN', exact: true }).click();
    await host.getByRole('button', { name: 'ADMIT PLAYER 2', exact: true }).click();
    for (const page of pages) {
      const connect = page.getByRole('button', { name: 'CONNECT LOBBY', exact: true });
      await expect(connect).toBeEnabled();
      await expect(connect).toBeInViewport({ ratio: 1 });
      await page.locator('#match-route').selectOption('direct');
      await connect.click();
    }
    await expect.poll(async () => {
      const messages = await Promise.all(pages.map(page => page.locator('#match-message').textContent()));
      if (messages.some(Boolean) || errors.length) throw new Error(JSON.stringify({ messages, errors }));
      return Promise.all(pages.map(page => page.getByLabel('I am ready').isEnabled()));
    }, { timeout: 50_000 }).toEqual([true, true]);
    if (terrain === 'green-valley') {
      await guest.getByLabel('My impact assistance', { exact: true }).check();
      await expect(host.locator('[data-control="players"]')).toContainText('Player 2: not ready, assistance on');
      await expect(guest.getByLabel('I am ready')).toBeEnabled();
    }
    for (const page of pages) await page.getByLabel('I am ready').check();
    for (const page of pages) {
      await expect(page.locator('#match-instruments')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('#multiplayer-app')).toHaveAttribute('data-phase', /playing|held/, { timeout: 15_000 });
      if (await page.locator('#match-message').isVisible()) throw new Error(JSON.stringify({
        message: await page.locator('#match-message').innerText(),
        timing: await page.locator('#multiplayer-app').evaluate(element => ({ ...((element as HTMLElement).dataset) })), errors,
      }));
    }
    for (const page of pages) {
      const localSlot = page === host ? 0 : 1;
      await expect(page.locator('#session-name')).toHaveText('PRIVATE TWO-PLAYER FLIGHT');
      await expect(page.locator(`#match-player-${localSlot}`)).toContainText('YOU');
      await expect(page.locator('#match-assist-0')).toHaveText('UNASSISTED');
      await expect(page.locator('#match-assist-1')).toHaveText(terrain === 'green-valley' ? 'ASSISTED' : 'UNASSISTED');
      await expect.poll(async () => {
        const messages = await Promise.all(pages.map(page => page.locator('#match-message').textContent()));
        if (messages.some(Boolean)) throw new Error(JSON.stringify({ messages, errors }));
        return page.locator('#match-release').innerText();
      }, { timeout: 20_000 }).toBe('SPACE TO RELEASE');
      if (terrain === 'green-valley' && page === guest) await expect(page.locator('#match-reticle')).toBeVisible();
      else await expect(page.locator('#match-reticle')).toBeHidden();
      await page.keyboard.press('Space');
      await expect(page.locator('#match-reticle')).toBeHidden();
    }
    await expect.poll(async () => {
      if (await guest.locator('#match-message').isVisible()) throw new Error(JSON.stringify(await Promise.all(pages.map(async page => ({
        message: await page.locator('#match-message').textContent(),
        timing: await page.locator('#multiplayer-app').evaluate(element => ({ ...((element as HTMLElement).dataset) })),
      })))));
      return guest.locator('#match-misses-0').innerText();
    }, { timeout: 20_000 }).toContain('1 / 3');
    for (const page of pages) {
      await expect(page.locator('#match-message')).toBeHidden();
      expect(await page.evaluate(() => localStorage.getItem('low-pass.records.v1'))).toBe(stored);
    }
    if (terrain === 'river-canyon') {
      await expect.poll(async () => {
        const messages = await Promise.all(pages.map(page => page.locator('#match-message').textContent()));
        if (messages.some(Boolean)) throw new Error(JSON.stringify({ messages, times: await Promise.all(
          pages.map(page => page.locator('#multiplayer-app').getAttribute('data-time'))) }));
        return Promise.all(pages.map(page => page.locator('#multiplayer-app').getAttribute('data-phase')));
      }, { timeout: 100_000 }).toEqual(['over', 'over']);
      for (const page of pages) for (const slot of [0, 1]) {
        await expect(page.locator(`#match-misses-${slot}`)).toContainText('3 / 3');
      }
    } else {
      await host.locator('#match-pause').click();
      for (const page of pages) await expect(page.locator('#multiplayer-app')).toHaveAttribute('data-phase', 'held');
    }
    await guest.screenshot({ path: info.outputPath('guest-native-canvas.png') });
    for (const page of pages) {
      await expect(page.locator('#match-reticle')).toBeHidden();
      for (const selector of ['.score-card', '.miss-card', '#match-pause', '#match-exit']) {
        await expect(page.locator(`#multiplayer-app ${selector}`)).toBeInViewport({ ratio: 1 });
      }
    }
    if (terrain === 'green-valley') {
      await guest.setViewportSize({ width: 600, height: 600 });
      for (const selector of ['.score-card', '.miss-card', '#match-pause', '#match-exit']) {
        await expect(guest.locator(`#multiplayer-app ${selector}`)).toBeInViewport({ ratio: 1 });
      }
      await expect.poll(async () => {
        const image = await guest.locator('#scene').screenshot({ style: '#app { visibility: hidden }' });
        return guest.evaluate(async bytes => {
          const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!;
          context.drawImage(bitmap, 0, 0); bitmap.close();
          const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data, colors = new Set<number>();
          for (let index = 0; index < rgba.length; index += 4) colors.add(rgba[index]! * 65536 + rgba[index + 1]! * 256 + rgba[index + 2]!);
          return colors.size;
        }, [...image]);
      }).toBeGreaterThan(64);
      await guest.screenshot({ path: info.outputPath('guest-compact-instruments.png'), scale: 'css' });
    }
    expect(errors.filter(error => !error.startsWith('Private match held:'))).toEqual([]);
    await host.getByRole('button', { name: 'LEAVE PRIVATE FLIGHT', exact: true }).click();
    await expect(host.locator('#multiplayer-app')).toHaveCount(0);
    await expect(host.locator('#start')).toBeVisible();
    await expect(host.locator('#session-name')).toHaveText('SOLO TRAINING RANGE');
    await host.locator('#start').click();
    await expect(host.locator('#app')).toHaveAttribute('data-screen', 'playing');
    await expect(host.locator('#hud')).toBeVisible();
    expect(await host.evaluate(() => localStorage.getItem('low-pass.records.v1'))).toBe(stored);
  } finally {
    await Promise.all(contexts.map(context => context.close())); await guestBrowser.close(); await server.close();
  }
});
