import { afterEach, describe, expect, it, vi } from 'vitest';
import { Radio, RADIO_STORAGE_KEY } from '../../src/audio/radio.js';

const radios: Radio[] = [];
afterEach(() => { for (const radio of radios.splice(0)) radio.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
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
  it('adds receive-only effects, clears playback on disconnect and ignores obsolete playback failures', async () => {
    vi.useFakeTimers();
    const node = () => ({ connect: vi.fn().mockReturnThis(), disconnect: vi.fn() });
    const param = () => ({ value: 0, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() });
    const gains = Array.from({ length: 3 }, () => ({ ...node(), gain: param() }));
    const samples = new Float32Array(512);
    const analyser = { ...node(), fftSize: 512, getFloatTimeDomainData: vi.fn((buffer: Float32Array) => buffer.set(samples)) };
    const noise = { ...node(), start: vi.fn(), stop: vi.fn(), loop: false, buffer: null };
    const context = {
      currentTime: 1, sampleRate: 48000, destination: node(), createGain: vi.fn()
        .mockReturnValueOnce(gains[0]).mockReturnValueOnce(gains[1]).mockReturnValueOnce(gains[2]),
      createBiquadFilter: vi.fn(() => ({ ...node(), frequency: { value: 0 } })),
      createDynamicsCompressor: vi.fn(() => ({ ...node(), threshold: { value: 0 }, ratio: { value: 0 } })),
      createBuffer: vi.fn(() => ({ getChannelData: () => new Float32Array(12000) })),
      createBufferSource: vi.fn(() => noise), createMediaStreamSource: vi.fn(node),
      createAnalyser: vi.fn(() => analyser), resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('AudioContext', function AudioContext() { return context; });
    const playback = { muted: false, srcObject: null, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() };
    vi.stubGlobal('Audio', function Audio() { return playback; });
    const { radio, warn } = setup();
    radio.receive({} as MediaStream);
    expect(playback.muted).toBe(true);
    expect(playback.play).toHaveBeenCalledOnce();
    expect(noise.start).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(100);
    expect(gains[1]!.gain.setTargetAtTime).not.toHaveBeenCalled();
    samples.fill(0.1);
    vi.advanceTimersByTime(50);
    expect(gains[1]!.gain.setTargetAtTime).toHaveBeenCalledWith(0.012, 1, 0.02);
    expect(gains[2]!.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.001, 1.08);
    radio.setTransmitting(true);
    radio.setReceive(true, 0.3);
    expect(gains[0]!.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 1);
    samples.fill(0);
    vi.advanceTimersByTime(200);
    expect(gains[1]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, 0.02);
    radio.receive(null);
    expect(playback.pause).toHaveBeenCalledOnce();
    expect(playback.srcObject).toBeNull();
    expect(noise.stop).toHaveBeenCalledOnce();
    const reads = analyser.getFloatTimeDomainData.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(analyser.getFloatTimeDomainData).toHaveBeenCalledTimes(reads);
    let rejectPlay!: (error: Error) => void;
    playback.play.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPlay = reject; }));
    radio.receive({} as MediaStream);
    radio.receive(null);
    rejectPlay(new Error('Playback aborted on disconnect'));
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();
    playback.play.mockRejectedValueOnce(new Error('Playback blocked'));
    radio.receive({} as MediaStream);
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith('Radio playback unavailable.');
  });
});
