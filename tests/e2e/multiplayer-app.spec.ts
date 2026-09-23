import { test, expect } from '@playwright/test';
import type { CDPSession } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { roomService } from '../helpers/room-service.js';
import { loopbackPreview } from '../helpers/loopback-preview.js';

const route = process.env.MULTIPLAYER_ROUTE ?? 'direct';
async function applicationService() {
  const external = loopbackPreview(process.env.MULTIPLAYER_URL, '/multiplayer.html');
  if (!['direct', 'auto', 'udp', 'tcp', 'tls'].includes(route) ||
    route !== 'direct' && (!external || process.env.LOW_PASS_LIVE_TURN !== '1')) {
    throw new Error('Non-direct application tests require the local preview and explicit live TURN opt-in.');
  }
  return external ? {
    origin: new URL(external).origin,
    code: (await readFile(resolve('.secret/hosting-code'), 'utf8')).trim(),
    close: async () => {},
  } : roomService({ multiplayerApp: true });
}

declare global { interface Window {
  interruptTestSignaling: () => void; interruptTestPeer: () => void;
  readTestPhases: () => Array<{ phase: string; time: string; at: number }>;
  readTestConnections: () => number;
  readTestRelayPolicy: () => boolean;
  readTestAudio: () => { contexts: number; states: AudioContextState[] };
  readTestTiming: () => Array<{ kind: string; duration: number; at: number; phase: string; time: string }>;
  readTestGraphics: () => { renderer: string; live: Record<string, number> };
} }
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('multiplayer storage failure warns without blocking room controls or changing solo data', async ({ browser }) => {
  const server = await applicationService();
  const context = await browser.newContext({ viewport: { width: 840, height: 732 }, deviceScaleFactor: 0.25 });
  const page = await context.newPage();
  const solo = JSON.stringify({ version: 1, scores: [], settings: {
    quality: 'low', assist: false, muted: true, volume: 0.5, terrain: 'green-valley',
  } });
  try {
    await page.addInitScript(solo => {
      localStorage.setItem('low-pass.records.v1', solo);
      const getItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function(key: string) {
        if (key === 'low-pass.multiplayer-records.v1') throw new DOMException('Denied', 'SecurityError');
        return getItem.call(this, key);
      };
    }, solo);
    await page.goto(server.origin + '/multiplayer.html');
    await page.getByRole('button', { name: 'PRIVATE FLIGHT PREVIEW', exact: true }).click();
    await expect(page.locator('#notification')).toContainText('Multiplayer records unavailable');
    await page.locator('#match-setup-records summary').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#match-setup-records [data-records="scores"]')).toBeVisible();
    await expect(page.locator('#match-setup-records [data-records="scores"]')).toHaveText('No completed multiplayer scores yet.');
    await page.keyboard.press('Space');
    try { await page.getByLabel('Hosting access code', { exact: true }).fill(server.code); }
    catch { throw new Error('Could not enter the private hosting code; input details withheld.'); }
    await page.getByRole('button', { name: 'CREATE ROOM', exact: true }).click();
    await expect.poll(async () => /multiplayer\.html#join=/.test(await page.locator('#host-link').inputValue())).toBe(true);
    await expect(page.locator('#match-exit')).toBeInViewport({ ratio: 1 });
    await page.locator('#match-exit').click();
    await expect(page.locator('#start')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('low-pass.records.v1'))).toBe(solo);
  } finally { await context.close(); await server.close(); }
});
for (const [terrain, interrupted] of [['green-valley', false], ['river-canyon', false], ['green-valley', true]] as const)
test(`opt-in ${terrain} application plays on the real canvas and restores solo${interrupted ? ' after survivor disconnect' : ''}`, async ({ browser }, info) => {
  test.setTimeout(240_000);
  const server = await applicationService();
  const guestBrowser = await browser.browserType().launch({ channel: info.project.name === 'edge' ? 'msedge' : 'chromium' });
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 840, height: 732 }, deviceScaleFactor: 0.25 }),
    guestBrowser.newContext({ viewport: { width: 840, height: 732 }, deviceScaleFactor: 0.25 })]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const errors: string[] = [];
  const warnings: string[] = [];
  const profilers: CDPSession[] = [];
  const stored = JSON.stringify({ version: 1, settings: { quality: 'low', assist: false, muted: true, volume: 0.5, terrain },
    scores: [{ id: 'existing-solo-score', score: 1234, date: '2026-09-20T00:00:00Z', assisted: false }] });
  try {
    for (const page of pages) {
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
        if (message.type() === 'warning' && message.text().startsWith('Private match ')) warnings.push(message.text());
      });
      await page.addInitScript(({ value, graphics }) => {
        const timing: ReturnType<Window['readTestTiming']> = [];
        window.readTestTiming = () => structuredClone(timing);
        const slow = (kind: string, start: number, duration: number) => {
          if (duration < 100) return;
          const root = document.querySelector<HTMLElement>('#multiplayer-app');
          timing.push({ kind, duration, at: performance.timeOrigin + start, phase: root?.dataset.phase ?? '', time: root?.dataset.time ?? '' });
          if (timing.length > 128) timing.shift();
        };
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) slow('longtask', entry.startTime, entry.duration);
        }).observe({ entryTypes: ['longtask'] });
        let glTime = 0, glCalls = 0, renderer = '';
        const live: Record<string, number> = {};
        const resources = new WeakSet<object>();
        window.readTestGraphics = () => ({ renderer, live: { ...live } });
        for (const method of graphics ? Object.getOwnPropertyNames(WebGL2RenderingContext.prototype) : []) {
          const original = Object.getOwnPropertyDescriptor(WebGL2RenderingContext.prototype, method)?.value;
          if (method === 'constructor' || typeof original !== 'function') continue;
          Object.defineProperty(WebGL2RenderingContext.prototype, method, { configurable: true, writable: true,
            value: new Proxy(original, { apply(target, receiver, args) {
              const start = performance.now();
              try {
                const result = Reflect.apply(target, receiver, args);
                if (!renderer && receiver instanceof WebGL2RenderingContext) {
                  renderer = 'checking';
                  const info = receiver.getExtension('WEBGL_debug_renderer_info');
                  renderer = String(receiver.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? receiver.RENDERER));
                }
                if (/^create(?:Buffer|Texture|Program|Shader|VertexArray|Framebuffer|Renderbuffer|Query)$/.test(method) && result) {
                  resources.add(result); const kind = method.slice(6); live[kind] = (live[kind] ?? 0) + 1;
                }
                if (method.startsWith('delete') && args[0] && resources.delete(args[0])) {
                  const kind = method.slice(6); live[kind] = (live[kind] ?? 0) - 1;
                }
                return result;
              } finally {
                const elapsed = performance.now() - start;
                glTime += elapsed; glCalls++; slow(method, start, elapsed);
              }
            } }) });
        }
        const raf = requestAnimationFrame.bind(window);
        window.requestAnimationFrame = callback => raf(time => {
          const start = performance.now(), before = glTime, calls = glCalls;
          try { callback(time); }
          finally { slow(`animation (GL ${Math.round(glTime - before)}ms/${glCalls - calls} calls)`, start, performance.now() - start); }
        });
        const audio: AudioContext[] = [], NativeAudio = AudioContext;
        window.AudioContext = class extends NativeAudio {
          constructor(options?: AudioContextOptions) { super(options); audio.push(this); }
        };
        window.readTestAudio = () => ({ contexts: audio.length, states: audio.map(context => context.state) });
        const phases: ReturnType<Window['readTestPhases']> = [];
        window.readTestPhases = () => structuredClone(phases);
        document.addEventListener('DOMContentLoaded', () => new MutationObserver(changes => {
          for (const change of changes) {
            const root = change.target;
            if (!(root instanceof HTMLElement) || root.id !== 'multiplayer-app' || phases.at(-1)?.phase === root.dataset.phase) continue;
            phases.push({ phase: root.dataset.phase ?? '', time: root.dataset.time ?? '', at: Date.now() });
            if (phases.length > 64) phases.shift();
          }
        }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-phase'] }));
        const sockets: WebSocket[] = [], NativeSocket = WebSocket;
        const peers: RTCPeerConnection[] = [], NativePeer = RTCPeerConnection;
        window.readTestConnections = () => peers.length;
        window.readTestRelayPolicy = () => {
          const connected = peers.filter(peer => peer.connectionState === 'connected');
          return connected.length === 1 && connected[0]!.getConfiguration().iceTransportPolicy === 'relay';
        };
        globalThis.RTCPeerConnection = class extends NativePeer {
          constructor(configuration?: RTCConfiguration) { super(configuration); peers.push(this); }
        };
        globalThis.WebSocket = class extends NativeSocket {
          constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); }
        };
        window.interruptTestSignaling = () => {
          const socket = sockets.find(socket => socket.readyState === WebSocket.OPEN);
          if (!socket) throw new Error('No active test signaling socket.');
          socket.close(4000, 'test-only signaling interruption');
        };
        window.interruptTestPeer = () => {
          const connected = peers.filter(peer => peer.connectionState === 'connected');
          if (connected.length !== 1) throw new Error('Expected one active test peer.');
          connected[0]!.close();
        };
        const original = crypto.getRandomValues.bind(crypto);
        Object.defineProperty(crypto, 'getRandomValues', { value: (array: ArrayBufferView<ArrayBuffer>) => {
          original(array);
          if (array instanceof Uint32Array && array.length === 1) array[0] = 7;
          return array;
        } });
        localStorage.setItem('low-pass.records.v1', value);
      }, { value: stored, graphics: process.env.PROFILE_MULTIPLAYER === '1' || process.env.GRAPHICS_MULTIPLAYER === '1' });
    }
    const [host, guest] = [pages[0]!, pages[1]!];
    await host.goto(server.origin + '/multiplayer.html');
    await host.getByRole('button', { name: 'PRIVATE FLIGHT PREVIEW', exact: true }).click();
    try { await host.getByLabel('Hosting access code', { exact: true }).fill(server.code); }
    catch { throw new Error('Could not enter the private hosting code; input details withheld.'); }
    await host.getByRole('button', { name: 'CREATE ROOM', exact: true }).click();
    await expect.poll(async () => /multiplayer\.html#join=/.test(await host.locator('#host-link').inputValue())).toBe(true);
    try { await guest.goto(await host.locator('#host-link').inputValue()); }
    catch { throw new Error('Could not open the private invitation; URL details withheld.'); }
    await expect(guest).toHaveURL(server.origin + '/multiplayer.html');
    await guest.getByRole('button', { name: 'PRIVATE FLIGHT PREVIEW', exact: true }).click();
    await guest.getByRole('button', { name: 'ASK TO JOIN', exact: true }).click();
    await host.getByRole('button', { name: 'ADMIT PLAYER 2', exact: true }).click();
    for (const page of pages) {
      const connect = page.getByRole('button', { name: 'CONNECT LOBBY', exact: true });
      await expect(connect).toBeEnabled();
      await expect(connect).toBeInViewport({ ratio: 1 });
      await page.locator('#match-route').selectOption(route);
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
      await expect.poll(() => page.evaluate(() => window.readTestAudio())).toEqual({ contexts: 1, states: ['running'] });
      if (['udp', 'tcp', 'tls'].includes(route)) expect(await page.evaluate(() => window.readTestRelayPolicy())).toBe(true);
    }
    if (terrain === 'green-valley') {
      await guest.locator('#scene').focus();
      await guest.keyboard.down('KeyA'); await guest.keyboard.down('KeyA'); await guest.keyboard.up('KeyA');
      await expect(guest.locator('#match-assistance')).toHaveText('YOUR IMPACT ASSIST: OFF');
      await expect(guest.locator('#match-assist-1')).toHaveText('ASSISTED');
      await guest.keyboard.press('KeyA');
      await expect(guest.locator('#match-assistance')).toHaveText('YOUR IMPACT ASSIST: ON');
      await expect(host.locator('#match-assist-0')).toHaveText('UNASSISTED');
    }
    if (process.env.PROFILE_MULTIPLAYER === '1') for (const page of pages) {
      const profiler = await page.context().newCDPSession(page);
      await profiler.send('Profiler.enable'); await profiler.send('Profiler.start');
      profilers.push(profiler);
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
      await page.keyboard.down('Space');
      await page.keyboard.down('Space');
      await page.keyboard.up('Space');
      await expect(page.locator('#match-release')).toHaveText('BOMB IN FLIGHT');
      await expect(page.locator('#match-input')).toHaveText('');
      await expect(page.locator('#match-reticle')).toBeHidden();
    }
    await guest.evaluate(() => window.interruptTestPeer());
    await expect(guest.locator('#match-pause-card h2')).toHaveText('RECONNECTING');
    await expect(guest.locator('#match-ready')).toBeHidden();
    await guest.screenshot({ path: info.outputPath('guest-peer-recovery.png'), scale: 'css' });
    await expect.poll(async () => {
      const messages = await Promise.all(pages.map(page => page.locator('#match-message').textContent()));
      if (messages.some(Boolean)) throw new Error(JSON.stringify(messages));
      return Promise.all(pages.map(page => page.locator('#multiplayer-app').getAttribute('data-phase')));
    }, { timeout: 15_000 }).toEqual(['paused', 'paused']);
    for (const page of pages) {
      await expect(page.locator('#match-pause-readiness')).toHaveText('Player 1: not ready / Player 2: not ready');
      await expect(page.locator('#match-ready')).toBeEnabled();
      await page.locator('#match-ready').click();
    }
    for (const page of pages) await expect(page.locator('#multiplayer-app')).toHaveAttribute('data-phase', 'playing', { timeout: 10_000 });
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
        const phase = await host.locator('#multiplayer-app').getAttribute('data-phase');
        if (phase === 'paused' || phase === 'pausing' || phase === 'held') {
          throw new Error(JSON.stringify({ reason: await host.locator('#match-pause-reason').textContent(),
            message: await host.locator('#match-message').textContent(), warnings,
            times: await Promise.all(pages.map(page => page.locator('#multiplayer-app').getAttribute('data-time'))) }));
        }
        return phase;
      }, { timeout: 100_000 }).toBe('ending');
      await host.locator('#match-pause').click();
      for (const page of pages) await expect(page.locator('#multiplayer-app')).toHaveAttribute('data-phase', 'paused');
      for (const page of pages) await page.locator('#match-ready').click();
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
      for (const page of pages) await expect(page.locator('#multiplayer-app')).toHaveAttribute('data-phase', 'paused');
      await guest.evaluate(() => window.interruptTestSignaling());
      await Promise.all(pages.map(page => expect(page.locator('#match-network')).toBeVisible()));
      await guest.screenshot({ path: info.outputPath('guest-signaling-recovery.png'), scale: 'css' });
      await Promise.all(pages.map(page => expect(page.locator('#match-network')).toBeHidden()));
      const frozen = await host.locator('#multiplayer-app').getAttribute('data-time');
      await host.locator('#match-ready').click();
      await expect(guest.locator('#match-pause-readiness')).toContainText('Player 1: ready');
      await expect(host.locator('#multiplayer-app')).toHaveAttribute('data-time', frozen!);
      await guest.locator('#match-ready').click();
      for (const page of pages) await expect(page.locator('#multiplayer-app')).toHaveAttribute('data-phase', 'countdown');
      await guest.keyboard.press('Escape');
      for (const page of pages) await expect(page.locator('#multiplayer-app')).toHaveAttribute('data-phase', 'paused');
      await expect(host.locator('#match-pause-readiness')).toContainText('Player 2: not ready');
      await expect(host.locator('#multiplayer-app')).toHaveAttribute('data-time', frozen!);
      await guest.keyboard.down('Space');
      await guest.locator('#match-ready').click();
      for (const page of pages) await expect(page.locator('#multiplayer-app')).toHaveAttribute('data-phase', 'playing', { timeout: 10_000 });
      await guest.keyboard.down('Space');
      await expect(guest.locator('#match-input')).toHaveText('');
      await guest.keyboard.up('Space');
      await guest.keyboard.press('Escape');
      for (const page of pages) await expect(page.locator('#multiplayer-app')).toHaveAttribute('data-phase', 'paused');
    }
    await guest.screenshot({ path: info.outputPath('guest-native-canvas.png') });
    for (const page of pages) await expect.poll(() => page.evaluate(() => window.readTestAudio().states)).toEqual(['suspended']);
    if (terrain === 'green-valley') {
      await guest.locator('#match-local-settings summary').click();
      await guest.getByLabel('Mute my flight sound', { exact: true }).uncheck();
      await guest.getByLabel('My flight volume', { exact: true }).focus();
      await guest.keyboard.press('Home'); await guest.keyboard.press('ArrowRight');
      await expect(guest.getByLabel('My flight volume', { exact: true })).toHaveValue('1');
      await expect(host.getByLabel('Mute my flight sound', { exact: true })).toBeChecked();
      await guest.getByLabel('Mute my flight sound', { exact: true }).check();
      await guest.locator('#match-local-settings summary').click();
    }
    for (const page of pages) {
      await expect(page.locator('#match-reticle')).toBeHidden();
      const selectors = await page.locator('#match-results').isVisible()
        ? ['#match-results', '#match-exit'] : ['.score-card', '.miss-card', '#match-pause', '#match-exit'];
      for (const selector of selectors) {
        await expect(page.locator(`#multiplayer-app ${selector}`)).toBeInViewport({ ratio: 1 });
      }
    }
    if (terrain === 'green-valley') {
      await guest.setViewportSize({ width: 600, height: 600 });
      const card = await guest.locator('#match-pause-card').boundingBox();
      for (const selector of ['.score-card', '.miss-card']) {
        const score = await guest.locator(`#multiplayer-app ${selector}`).boundingBox();
        expect(card!.y).toBeGreaterThanOrEqual(score!.y + score!.height);
      }
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
      for (const page of pages) await page.locator('#match-ready').click();
      for (const page of pages) await expect(page.locator('#multiplayer-app')).toHaveAttribute('data-phase', 'playing', { timeout: 10_000 });
      await guest.locator('#scene').focus();
      // Release in the indicated HUD frame, not after a cross-process assertion/input round trip.
      await guest.evaluate(() => new Promise<void>((resolve, reject) => {
        let frame = 0;
        const timeout = setTimeout(() => {
          cancelAnimationFrame(frame); reject(new Error('No on-target guest release frame.'));
        }, 45_000);
        const check = () => {
          const phase = document.querySelector<HTMLElement>('#multiplayer-app')?.dataset.phase;
          if (phase !== 'playing') {
            clearTimeout(timeout); reject(new Error(`Flight stopped before the guest release: ${phase}`)); return;
          }
          const reticle = document.querySelector<HTMLElement>('#match-reticle');
          if (reticle && !reticle.hidden && reticle.classList.contains('on-target')) {
            const canvas = document.querySelector('#scene')!;
            for (const type of ['keydown', 'keyup']) canvas.dispatchEvent(new KeyboardEvent(type, { code: 'Space', key: ' ', bubbles: true }));
            clearTimeout(timeout); resolve();
          } else frame = requestAnimationFrame(check);
        };
        frame = requestAnimationFrame(check);
      }));
      await expect(guest.locator('#match-release')).toHaveText('BOMB IN FLIGHT');
      await expect.poll(async () => Number(await guest.locator('#match-score-1').innerText()), { timeout: 10_000 }).toBeGreaterThan(0);
      await expect.poll(async () => {
        const phase = await host.locator('#multiplayer-app').getAttribute('data-phase');
        if (phase === 'paused' || phase === 'pausing' || phase === 'held' || phase === 'recovering') {
          throw new Error(JSON.stringify({ phase, warnings, reason: await host.locator('#match-pause-reason').textContent() }));
        }
        return host.locator('#match-status-0').textContent();
      }, { timeout: 80_000 }).toBe('FLIGHT ENDED');
      await expect(host.locator('#match-view')).toHaveText('FINAL FLIGHT / PLAYER 1');
      for (const page of pages) {
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('low-pass.multiplayer-records.v1') ?? 'null')))
          .toMatchObject({ version: 1, scores: [{ slot: 0, score: 0, matchStatus: 'active' }],
            matches: [{ status: 'active', winner: null }] });
      }
      if (interrupted) {
        await contexts[1]!.close();
        await expect(host.locator('#multiplayer-app')).toHaveAttribute('data-phase', 'held', { timeout: 20_000 });
        await expect.poll(() => host.evaluate(() => JSON.parse(localStorage.getItem('low-pass.multiplayer-records.v1') ?? 'null')))
          .toMatchObject({ version: 1, scores: [{ slot: 0, score: 0, matchStatus: 'incomplete', opponent: { completed: false } }],
            matches: [{ status: 'incomplete', reason: 'left', winner: null }] });
      } else {
        await expect(host.locator('#match-view')).toHaveText('SPECTATING / PLAYER 2', { timeout: 10_000 });
        await expect(host.locator('#match-participation')).toContainText('Keep this tab open');
        await expect(guest.locator('#match-participation')).toContainText('Your flight continues on the same path.');
        await host.keyboard.press('Space');
        await expect(host.locator('#match-release')).toHaveText('SPECTATING');
        await expect(host.locator('#match-reticle')).toBeHidden();
        await host.screenshot({ path: info.outputPath('host-spectating-survivor.png'), scale: 'css' });
        for (const page of pages) await expect.poll(async () => {
          const phase = await page.locator('#multiplayer-app').getAttribute('data-phase');
          if (['held', 'paused', 'pausing', 'recovering'].includes(phase ?? '')) throw new Error(`Finale interrupted: ${phase}; ${warnings.join('; ')}`);
          return phase;
        }, { timeout: 45_000 }).toBe('over');
        await expect(host.locator('#match-score-0')).toHaveText('0');
        for (const page of pages) {
          await expect(page.locator('#match-release')).toHaveText('PLAYER 2 WINS');
          await expect(page.locator('#match-participation')).toHaveText('Both flights have ended.');
          const score = Number(await page.locator('#match-score-1').innerText());
          expect(await page.evaluate(() => JSON.parse(localStorage.getItem('low-pass.multiplayer-records.v1') ?? 'null')))
            .toMatchObject({ version: 1, scores: [{ slot: 1, score, assisted: true, matchStatus: 'complete' },
              { slot: 0, score: 0, matchStatus: 'complete' }], matches: [{ status: 'complete', winner: 1 }] });
        }
      }
    }
    for (const page of interrupted ? [host] : pages) {
      await expect(page.locator('#match-results')).toBeVisible();
      await expect(page.locator('#match-results')).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('table', { name: 'Private match player results' })).toBeVisible();
      await expect(page.locator('#match-result-players tr')).toHaveCount(2);
      if (interrupted) {
        await expect(page.locator('#match-result-title')).toHaveText('MATCH INCOMPLETE');
        await expect(page.locator('#match-result-description')).toContainText('No winner.');
        await expect(page.locator('#match-result-players tr[data-slot="1"]')).toContainText('UNFINISHED');
      } else {
        await expect(page.locator('#match-result-title')).toHaveText(terrain === 'green-valley' ? 'PLAYER 2 WINS' : /MATCH DRAW|PLAYER [12] WINS/);
      }
      await page.locator('#match-result-records summary').focus();
      await page.keyboard.press('Space');
      await expect(page.locator('#match-result-records [data-records="scores"] li')).toHaveCount(interrupted ? 1 : 2);
      await expect(page.locator('#match-result-records [data-records="matches"] li')).toHaveCount(1);
      await page.keyboard.press('Space');
      await expect(page.getByRole('button', { name: 'RETURN TO MENU', exact: true })).toBeInViewport({ ratio: 1 });
    }
    await (interrupted ? host : guest).screenshot({ path: info.outputPath('multiplayer-results.png'), scale: 'css' });
    expect(errors.filter(error => !error.startsWith('Private match held:'))).toEqual([]);
    if (terrain === 'green-valley' && !interrupted) {
      const connections = await Promise.all(pages.map(page => page.evaluate(() => window.readTestConnections())));
      await host.locator('#match-rematch-ready').click();
      await expect(guest.locator('#match-rematch-status')).toContainText('Player 1: ready');
      await expect(guest.locator('#match-rematch-ready')).toBeInViewport({ ratio: 1 });
      await guest.locator('#match-rematch-ready').click();
      await expect(guest.locator('#match-rematch-status')).toContainText('Returning to the lobby');
      await guest.keyboard.press('Escape');
      await expect(host.locator('#match-rematch-status')).toContainText('Player 2: not ready');
      await guest.locator('#match-rematch-ready').click();
      for (const page of pages) {
        await expect(page.locator('#multiplayer-app')).toHaveAttribute('data-phase', 'lobby', { timeout: 10_000 });
        await expect(page.locator('#match-results')).toBeHidden();
        await expect(page.getByLabel('I am ready')).not.toBeChecked();
        await expect(page.getByLabel('My graphics quality')).toHaveValue('low');
        await expect(page.getByLabel('Mute my sound')).toBeChecked();
        await expect.poll(() => page.evaluate(() => window.readTestAudio().states)).toEqual(['suspended']);
      }
      await host.getByLabel('Shared terrain').selectOption('desert');
      await guest.getByLabel('My impact assistance', { exact: true }).uncheck();
      for (const page of pages) {
        await expect(page.getByLabel('Shared terrain')).toHaveValue('desert');
        await expect(page.getByLabel('I am ready')).toBeEnabled({ timeout: 45_000 });
      }
      for (const page of pages) await page.getByLabel('I am ready').check();
      for (const page of pages) {
        await expect(page.locator('#multiplayer-app')).toHaveAttribute('data-phase', 'playing', { timeout: 15_000 });
        await expect(page.locator('#match-score-0')).toHaveText('0');
        await expect(page.locator('#match-score-1')).toHaveText('0');
        await expect(page.locator('#match-misses-0')).toHaveText('0 / 3 MISSES');
        await expect(page.locator('#match-assist-1')).toHaveText('UNASSISTED');
      }
      expect(await Promise.all(pages.map(page => page.evaluate(() => window.readTestConnections())))).toEqual(connections);
      for (const page of pages) {
        await expect.poll(async () => {
          const phase = await page.locator('#multiplayer-app').getAttribute('data-phase');
          if (['held', 'paused', 'pausing', 'recovering'].includes(phase ?? '')) throw new Error(`Rematch interrupted: ${phase}; ${warnings.join('; ')}`);
          return phase;
        }, { timeout: 80_000 }).toBe('over');
        await expect(page.locator('#match-result-title')).toHaveText('MATCH DRAW');
        await expect(page.locator('#match-result-title')).toBeFocused();
        const saved = await page.evaluate(() => {
          const value = JSON.parse(localStorage.getItem('low-pass.multiplayer-records.v1')!);
          return { scores: value.scores.length, matches: value.matches.map((match: { matchId: string; status: string }) =>
            ({ id: match.matchId, status: match.status })) };
        });
        expect(saved.scores).toBe(4); expect(saved.matches).toHaveLength(2);
        expect(new Set(saved.matches.map((match: { id: string }) => match.id)).size).toBe(2);
        expect(saved.matches.every((match: { status: string }) => match.status === 'complete')).toBe(true);
      }
      await guest.screenshot({ path: info.outputPath('rematch-draw-results.png'), scale: 'css' });
      expect(errors).toEqual([]);
    }
    await host.getByRole('button', { name: 'RETURN TO MENU', exact: true }).focus();
    await host.keyboard.press('Space');
    await expect(host.locator('#multiplayer-app')).toHaveCount(0);
    await expect(host.locator('#start')).toBeVisible();
    await expect(host.locator('#session-name')).toHaveText('SOLO TRAINING RANGE');
    await expect.poll(() => host.evaluate(() => window.readTestAudio())).toEqual({ contexts: 1, states: ['suspended'] });
    await host.locator('#start').click();
    await expect(host.locator('#app')).toHaveAttribute('data-screen', 'playing');
    await expect(host.locator('#hud')).toBeVisible();
    expect(await host.evaluate(() => localStorage.getItem('low-pass.records.v1'))).toBe(stored);
  } finally {
    for (const [index, profiler] of profilers.entries()) {
      if (pages[index]!.isClosed()) continue;
      const { profile } = await profiler.send('Profiler.stop');
      await writeFile(info.outputPath(`player-${index + 1}.cpuprofile`), JSON.stringify(profile));
      await profiler.detach();
    }
    const states = await Promise.all(pages.map(page => page.isClosed() ? null : page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('#multiplayer-app');
      return { phase: root?.dataset.phase, time: root?.dataset.time,
        phases: window.readTestPhases?.() ?? [],
        timing: window.readTestTiming?.() ?? [], audio: window.readTestAudio?.(),
        graphics: window.readTestGraphics?.(),
        pause: document.querySelector('#match-pause-reason')?.textContent,
        release: document.querySelector('#match-release')?.textContent,
        input: document.querySelector('#match-input')?.textContent,
        scores: [0, 1].map(slot => document.querySelector(`#match-score-${slot}`)?.textContent),
        issue: document.querySelector('#match-result-error')?.textContent || document.querySelector('#match-message')?.textContent };
    })));
    const report = info.outputPath('redacted-match-status.json');
    await writeFile(report, JSON.stringify({ states, warnings, errors }, null, 2));
    await info.attach('redacted-match-status', { path: report, contentType: 'application/json' });
    await Promise.all(contexts.map(context => context.close())); await guestBrowser.close(); await server.close();
  }
});
