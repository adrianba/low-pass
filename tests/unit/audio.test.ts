import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlightAudio } from '../../src/audio/audio.js';
import { DEFAULT_SETTINGS } from '../../src/storage/records.js';

class Param {
  value = 0;
  setTargetAtTime = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}
class Node {
  disconnect = vi.fn();
  connect<T>(destination: T): T { return destination; }
}
class Source extends Node {
  start = vi.fn();
  stop = vi.fn();
  frequency = new Param();
  onended: (() => void) | null = null;
}
class Context {
  static instances: Context[] = [];
  state: AudioContextState = 'suspended';
  currentTime = 0;
  sampleRate = 16;
  destination = new Node();
  sources: Source[] = [];
  gains: Array<Node & { gain: Param }> = [];
  resume = vi.fn(async () => { this.state = 'running'; });
  suspend = vi.fn(async () => { this.state = 'suspended'; });
  constructor() { Context.instances.push(this); }
  createGain() {
    const node = Object.assign(new Node(), { gain: new Param() }); this.gains.push(node); return node;
  }
  createDynamicsCompressor() { return Object.assign(new Node(), { threshold: new Param(), ratio: new Param() }); }
  createBuffer() { return { getChannelData: () => new Float32Array(32) }; }
  createBiquadFilter() { return Object.assign(new Node(), { frequency: new Param() }); }
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  createOscillator() { return this.createBufferSource(); }
}
afterEach(() => { vi.unstubAllGlobals(); Context.instances.length = 0; });
function setup() {
  vi.stubGlobal('AudioContext', Context);
  const warn = vi.fn(), audio = new FlightAudio({ ...DEFAULT_SETTINGS, muted: false, volume: 0.4 }, warn);
  return { audio, warn };
}

describe('flight audio lifecycle', () => {
  it('unlocks silently from a gesture and reuses one context across start, pause and preferences', async () => {
    const { audio } = setup();
    await audio.unlock();
    const context = Context.instances[0]!;
    expect(context.state).toBe('suspended');
    expect(context.gains[0]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 0.03);
    audio.cue('release'); expect(context.sources).toHaveLength(2);
    await audio.start();
    expect(context.state).toBe('running');
    expect(context.gains[0]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.4, 0, 0.03);
    audio.configure({ ...DEFAULT_SETTINGS, muted: true });
    expect(context.gains[0]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 0.03);
    await audio.pause(); await audio.start();
    expect(Context.instances).toHaveLength(1);
  });
  it('does not let an outstanding resume leave a paused flight audible', async () => {
    const { audio } = setup();
    await audio.unlock();
    const context = Context.instances[0]!;
    let resume!: () => void;
    context.resume.mockImplementationOnce(() => new Promise<void>(resolve => {
      resume = () => { context.state = 'running'; resolve(); };
    }));
    const starting = audio.start();
    await audio.pause(); resume(); await starting;
    expect(context.state).toBe('suspended');
  });
  it('bounds one-shot voices and disposes falling tones and cue nodes on reset without double cleanup', async () => {
    const { audio } = setup();
    await audio.start();
    const context = Context.instances[0]!;
    audio.update(300, 1);
    const falling = context.sources[2]!;
    expect(context.sources[1]!.frequency.setTargetAtTime).toHaveBeenLastCalledWith(710, 0, 0.3);
    for (let cue = 0; cue < 20; cue++) audio.cue('hit');
    expect(context.sources).toHaveLength(10);
    const transient = context.sources.slice(3), ended = transient[0]!.onended!;
    audio.reset(); ended();
    expect(falling.stop).toHaveBeenCalledOnce();
    for (const source of transient) {
      expect(source.stop).toHaveBeenCalledTimes(2);
      expect(source.disconnect).toHaveBeenCalledOnce();
      expect(source.onended).toBeNull();
    }
    for (let cue = 0; cue < 8; cue++) audio.cue('destroyed');
    expect(context.sources).toHaveLength(17);
    audio.update(350, null, false);
    expect(context.gains[1]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 0.05);
    audio.reset();
  });
  it('reports audio failure without rejecting session play', async () => {
    const { audio, warn } = setup();
    await audio.unlock();
    Context.instances[0]!.resume.mockRejectedValueOnce(new Error('Device unavailable.'));
    await expect(audio.start()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Audio unavailable: Device unavailable.'));
  });
});
