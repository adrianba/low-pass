import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { build } from 'vite';
import { resolve, join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { roomService } from '../helpers/room-service.js';
import type {} from '../fixtures/rtc.js';

declare global { interface Window {
  radioOutputPower: () => number; radioReport: () => Promise<unknown>;
  radioCaptureStates: () => MediaStreamTrackState[];
} }

const mediaArgs = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
test.use({ trace: 'off' });

let code: string;
let audioDirectory: string;
test.beforeAll(async () => {
  audioDirectory = await mkdtemp(join(tmpdir(), 'low-pass-radio-'));
  const rate = 48_000, samples = rate * 2, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 900 * i / rate)), 44 + i * 2);
  const audioFile = join(audioDirectory, 'microphone.wav');
  await writeFile(audioFile, wav);
  mediaArgs.push(`--use-file-for-fake-audio-capture=${audioFile}`);
  const result = await build({ configFile: false, logLevel: 'error',
    build: { write: false, lib: { entry: resolve('tests/fixtures/rtc.ts'), name: 'RtcFixture', formats: ['iife'] } } });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(r => 'output' in r ? r.output : []);
  const chunk = chunks.find(c => c.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Could not build radio fixture.');
  code = chunk.code;
});
test.afterAll(async () => { if (audioDirectory) await rm(audioDirectory, { recursive: true, force: true }); });

async function observeRadio(page: Page, denied = false) {
  await page.addInitScript(denied => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const tracks: MediaStreamTrack[] = [];
    window.radioCaptureStates = () => tracks.map(track => track.readyState);
    navigator.mediaDevices.getUserMedia = async () => {
      if (denied) throw new DOMException('Test microphone denied', 'NotAllowedError');
      // Preserve the known in-band tone rather than having speech processing suppress it.
      const stream = await capture({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      tracks.push(...stream.getTracks());
      return stream;
    };
    const createGain = AudioContext.prototype.createGain;
    const play = HTMLMediaElement.prototype.play, players: HTMLMediaElement[] = [];
    HTMLMediaElement.prototype.play = function() { players.push(this); return play.call(this); };
    const outputs = new WeakMap<AudioContext, AnalyserNode>();
    const contexts: AudioContext[] = [];
    const peers: RTCPeerConnection[] = [], NativePeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(config?: RTCConfiguration) { super(config); peers.push(this); }
    };
    window.radioReport = async () => ({
      contexts: contexts.map(context => context.state),
      warnings: window.rtcFixture?.errors,
      players: players.map(player => ({ paused: player.paused, muted: player.muted,
        readyState: player.readyState, time: player.currentTime })),
      peers: await Promise.all(peers.map(async peer => ({
        state: peer.connectionState,
        audio: peer.getTransceivers().map(t => ({ direction: t.direction, current: t.currentDirection,
          sender: t.sender.track?.enabled, receiver: t.receiver.track.readyState })),
        stats: [...(await peer.getStats()).values()].filter(s => ['inbound-rtp', 'outbound-rtp', 'media-source'].includes(s.type))
          .map(s => ({ type: s.type, kind: s.kind, packetsSent: s.packetsSent, packetsReceived: s.packetsReceived,
            totalAudioEnergy: s.totalAudioEnergy, audioLevel: s.audioLevel, bytesSent: s.bytesSent,
            bytesReceived: s.bytesReceived, jitterBufferEmittedCount: s.jitterBufferEmittedCount,
            totalSamplesReceived: s.totalSamplesReceived, concealedSamples: s.concealedSamples,
            totalSamplesDuration: s.totalSamplesDuration })),
      }))),
    });
    AudioContext.prototype.createGain = function() {
      const gain = createGain.call(this);
      if (!outputs.has(this)) {
        contexts.push(this);
        const analyser = this.createAnalyser();
        analyser.fftSize = 2048;
        gain.connect(analyser);
        outputs.set(this, analyser);
        window.radioOutputPower = () => {
          const samples = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(samples);
          return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        };
      }
      return gain;
    };
  }, denied);
}

for (const denied of [null, 'host', 'guest'] as const)
test(`native radio carries audible push-to-talk and reconnects (${denied ?? 'neither'} microphone denied)`, async ({ playwright }, info) => {
  const server = await roomService();
  const store = server.service.rooms!.store;
  const host = store.create(store.authorize(server.code, 'radio-host').capability, 'radio-host');
  const guest = store.join(host.invitation.replace('-', ''));
  store.admit(host.capability, guest.room.participantId, true);
  const browser = await playwright.chromium.launch({ channel: info.project.name === 'edge' ? 'msedge' : 'chromium', args: mediaArgs });
  const otherBrowser = await playwright.chromium.launch({
    channel: info.project.name === 'edge' ? 'msedge' : 'chromium', args: mediaArgs,
  });
  const contexts = await Promise.all([browser.newContext(), otherBrowser.newContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  try {
    for (const [index, page] of pages.entries()) {
      await observeRadio(page, denied === (index === 0 ? 'host' : 'guest'));
      await page.route('**/rtc-fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: code }));
      await page.goto(server.origin + '/rtc-fixture');
      await page.locator('body').click();
    }
    const h = pages[0]!, g = pages[1]!;
    for (const generation of [1, 2]) {
      await g.evaluate(options => window.connectRtc(options), { role: 'guest' as const, roomId: host.room.roomId,
        capability: guest.capability, generation, epoch: generation - 1, radio: true });
      await h.evaluate(options => window.connectRtc(options), { role: 'host' as const, roomId: host.room.roomId,
        capability: host.capability, generation, epoch: generation - 1, radio: true });
      await h.evaluate(() => window.rtcFixture.peer!.start());
      for (const [index, page] of pages.entries()) {
        const cannotTransmit = denied === (index === 0 ? 'host' : 'guest');
        await expect.poll(() => page.evaluate(() => window.rtcFixture.peer?.status)).toBe('open');
        expect(await page.evaluate(() => window.rtcFixture.radio?.canTransmit)).toBe(!cannotTransmit);
        expect(await page.evaluate(() => window.rtcFixture.errors)).toEqual(cannotTransmit
          ? ['Microphone unavailable or permission declined. You can still receive radio and play.'] : []);
      }
      for (const [sender, receiver] of [[g, h], [h, g]]) {
        if (!await sender!.evaluate(() => window.rtcFixture.radio!.canTransmit)) continue;
        await sender!.evaluate(() => window.rtcFixture.radio!.setTransmitting(true));
        await expect.poll(() => receiver!.evaluate(() => window.radioOutputPower()), { timeout: 10_000 }).toBeGreaterThan(0.001);
        await receiver!.evaluate(() => window.rtcFixture.radio!.setReceive(true, 0.65));
        await expect.poll(() => receiver!.evaluate(() => window.radioOutputPower())).toBeLessThan(0.0001);
        await receiver!.evaluate(() => window.rtcFixture.radio!.setReceive(false, 0.65));
        await expect.poll(() => receiver!.evaluate(() => window.radioOutputPower())).toBeGreaterThan(0.001);
        await receiver!.evaluate(() => window.rtcFixture.radio!.setReceive(false, 0));
        await expect.poll(() => receiver!.evaluate(() => window.radioOutputPower())).toBeLessThan(0.0001);
        await receiver!.evaluate(() => window.rtcFixture.radio!.setReceive(false, 0.65));
        await expect.poll(() => receiver!.evaluate(() => window.radioOutputPower())).toBeGreaterThan(0.001);
        if (await receiver!.evaluate(() => window.rtcFixture.radio!.canTransmit)) {
          await receiver!.evaluate(() => window.rtcFixture.radio!.setTransmitting(true));
          await expect.poll(() => receiver!.evaluate(() => window.radioOutputPower())).toBeLessThan(0.0001);
          await receiver!.evaluate(() => window.rtcFixture.radio!.setTransmitting(false));
        }
        await sender!.evaluate(() => window.rtcFixture.radio!.setTransmitting(false));
        await expect.poll(() => receiver!.evaluate(() => window.radioOutputPower())).toBeLessThan(0.0001);
      }
      for (const page of pages) {
        await page.evaluate(() => window.rtcFixture.close());
        expect(await page.evaluate(() => window.radioCaptureStates().every(state => state === 'ended'))).toBe(true);
      }
      await expect.poll(() => server.service.signaling!.counts.authenticated).toBe(0);
    }
  } finally {
    const report = JSON.stringify(await Promise.all(pages.map(page => page.evaluate(() => window.radioReport()))), null, 2);
    await writeFile(info.outputPath('radio-report.json'), report);
    await info.attach('radio-report', { contentType: 'application/json', body: report });
    await Promise.all(contexts.map(context => context.close()));
    await otherBrowser.close();
    await browser.close();
    await server.close();
  }
});

test('application radio uses M with lobby controls focused and stops on key release, blur and exit', async ({ playwright }, info) => {
  test.setTimeout(120_000);
  const server = await roomService();
  const browser = await playwright.chromium.launch({ channel: info.project.name === 'edge' ? 'msedge' : 'chromium', args: mediaArgs });
  const otherBrowser = await playwright.chromium.launch({
    channel: info.project.name === 'edge' ? 'msedge' : 'chromium', args: mediaArgs,
  });
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 840, height: 732 }, deviceScaleFactor: 0.25 }),
    otherBrowser.newContext({ viewport: { width: 840, height: 732 }, deviceScaleFactor: 0.25 })]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const errors: string[] = [];
  try {
    for (const page of pages) {
      page.on('pageerror', error => errors.push(error.message));
      await observeRadio(page);
      await page.addInitScript(() => localStorage.setItem('low-pass.records.v1', JSON.stringify({
        version: 1, scores: [], settings: { quality: 'low', assist: false, muted: true, volume: 0.5, terrain: 'green-valley' },
      })));
      await page.goto(server.origin + '/');
      await page.getByRole('button', { name: 'PRIVATE FLIGHT', exact: true }).click();
      await page.locator('#match-route').selectOption('direct');
    }
    const h = pages[0]!, g = pages[1]!;
    await h.getByLabel('Hosting access code', { exact: true }).fill(server.code);
    await h.getByRole('button', { name: 'CREATE ROOM', exact: true }).click();
    await expect(h.locator('#host-link')).not.toHaveValue('');
    const invitation = new URL(await h.locator('#host-link').inputValue()).hash.slice('#join='.length);
    await g.locator('#match-role').selectOption('guest');
    await g.getByLabel('Room invitation', { exact: true }).fill(invitation);
    await g.getByRole('button', { name: 'ASK TO JOIN', exact: true }).click();
    await h.getByRole('button', { name: 'ADMIT PLAYER 2', exact: true }).click();
    for (const page of pages) await page.getByRole('button', { name: 'CONNECT LOBBY', exact: true }).click();
    for (const page of pages) await expect(page.locator('#match-radio-status')).toHaveText('Radio: hold M to transmit', { timeout: 30_000 });
    for (const [sender, receiver] of [[h, g], [g, h]]) {
      await sender!.locator('#match-radio summary').click();
      await sender!.locator('#match-radio-volume').focus();
      await sender!.keyboard.down('m');
      await expect(sender!.locator('#match-radio-status')).toHaveText('Radio: hold M to transmit');
      await sender!.keyboard.up('m');
      await sender!.locator('#match-radio summary').focus();
      await sender!.keyboard.down('m');
      await expect(sender!.locator('#match-radio-status')).toContainText('transmitting');
      await expect.poll(() => receiver!.evaluate(() => window.radioOutputPower())).toBeGreaterThan(0.001);
      await sender!.keyboard.up('m');
      await expect(sender!.locator('#match-radio-status')).toHaveText('Radio: hold M to transmit');
      await expect.poll(() => receiver!.evaluate(() => window.radioOutputPower())).toBeLessThan(0.0001);
      await sender!.keyboard.down('m');
      await expect(sender!.locator('#match-radio-status')).toContainText('transmitting');
      await sender!.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
        window.dispatchEvent(new Event('blur'));
      });
      await expect(sender!.locator('#match-radio-status')).toHaveText('Radio: hold M to transmit');
      await sender!.evaluate(() => {
        Reflect.deleteProperty(document, 'hasFocus');
        window.dispatchEvent(new Event('focus'));
      });
      await sender!.keyboard.up('m');
    }
    for (const page of pages) {
      await page.locator('#match-exit').click();
      expect(await page.evaluate(() => window.radioCaptureStates())).toEqual(['ended']);
    }
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await otherBrowser.close();
    await browser.close();
    await server.close();
  }
});
