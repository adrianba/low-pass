import { afterEach, describe, expect, it, vi } from 'vitest';
import { Radio, RADIO_STORAGE_KEY } from '../../src/audio/radio.js';

const radios: Radio[] = [];
afterEach(() => { for (const radio of radios.splice(0)) radio.close(); vi.unstubAllGlobals(); });
function setup(saved: string | null = null) {
  const stored = new Map<string, string>();
  if (saved !== null) stored.set(RADIO_STORAGE_KEY, saved);
  const warn = vi.fn();
  const radio = new Radio(() => ({
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
  }), warn);
  radios.push(radio);
  return { radio, stored, warn };
}

describe('private radio', () => {
  it('persists receive preferences independently and rejects invalid saved values', () => {
    const { radio, stored } = setup();
    radio.setReceive(true, 0.3);
    expect(stored.get(RADIO_STORAGE_KEY)).toBe('{"muted":true,"volume":0.3}');
    expect(setup(stored.get(RADIO_STORAGE_KEY)).radio.muted).toBe(true);
    const invalid = setup('{"muted":false,"volume":2}');
    expect(invalid.radio.volume).toBe(0.65);
    expect(invalid.warn).toHaveBeenCalledOnce();
    expect(invalid.stored.get(RADIO_STORAGE_KEY)).toBe('{"muted":false,"volume":2}');
  });
  it('keeps denied capture receive-only without blocking playback', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new Error('denied')) } });
    const { radio, warn } = setup();
    await radio.request();
    await radio.request();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    radio.setTransmitting(true);
    expect(radio.sending).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Microphone unavailable'));
  });
  it('disables capture by default, only transmits while held, and stops tracks on exit', async () => {
    const track = { enabled: true, readyState: 'live', stop: vi.fn(), onended: null as (() => void) | null };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({
      getAudioTracks: () => [track], getTracks: () => [track],
    }) } });
    const { radio } = setup();
    await radio.request();
    expect(track.enabled).toBe(false);
    radio.setTransmitting(true);
    expect(track.enabled).toBe(true);
    radio.setTransmitting(false);
    expect(track.enabled).toBe(false);
    radio.close();
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
