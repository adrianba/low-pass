import type { Settings } from '../storage/records';
import type { CombatCue } from '../game/missile';

export class FlightAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private whine: OscillatorNode | null = null;
  private noise: AudioBuffer | null = null;
  private settings: Settings;
  private voices = 0;
  private falling: OscillatorNode | null = null;
  private fallingGain: GainNode | null = null;

  constructor(settings: Settings, private readonly warn: (message: string) => void) { this.settings = settings; }

  async start(): Promise<void> {
    try {
      if (!this.context) {
        const ctx = new AudioContext();
        this.context = ctx;
        const master = ctx.createGain();
        this.master = master;
        this.engineGain = ctx.createGain();
        this.engineGain.connect(master);
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -16;
        limiter.ratio.value = 8;
        master.connect(limiter).connect(ctx.destination);
        this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const data = this.noise.getChannelData(0);
        let last = 0;
        for (let i = 0; i < data.length; i++) {
          last = (last + (Math.random() * 2 - 1) * 0.08) / 1.02;
          data[i] = last * 2;
        }
        const rumble = ctx.createBufferSource();
        rumble.buffer = this.noise;
        rumble.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 900;
        const noiseGain = ctx.createGain();
        noiseGain.gain.value = 0.48;
        rumble.connect(filter).connect(noiseGain).connect(this.engineGain);
        rumble.start();
        this.whine = ctx.createOscillator();
        this.whine.type = 'triangle';
        const whineGain = ctx.createGain();
        whineGain.gain.value = 0.025;
        this.whine.connect(whineGain).connect(this.engineGain);
        this.whine.start();
      }
      this.configure(this.settings);
      await this.context.resume();
    } catch (error) {
      this.warn(`Audio unavailable: ${error instanceof Error ? error.message : String(error)} You can continue without sound.`);
    }
  }
  configure(settings: Settings): void {
    this.settings = settings;
    if (this.master && this.context) this.master.gain.setTargetAtTime(settings.muted ? 0 : settings.volume, this.context.currentTime, 0.03);
  }
  async pause(): Promise<void> {
    try { await this.context?.suspend(); }
    catch (error) { this.warn(`Could not pause audio: ${String(error)}`); }
  }
  update(speed: number, bombAge: number | null, aircraftAlive = true): void {
    const ctx = this.context;
    if (!ctx || !this.master) return;
    this.engineGain?.gain.setTargetAtTime(aircraftAlive ? 1 : 0, ctx.currentTime, 0.05);
    this.whine?.frequency.setTargetAtTime(110 + speed * 2, ctx.currentTime, 0.3);
    if (bombAge !== null && !this.falling) {
      this.falling = ctx.createOscillator();
      this.fallingGain = ctx.createGain();
      this.fallingGain.gain.value = 0.018;
      this.falling.connect(this.fallingGain).connect(this.master);
      this.falling.start();
    }
    if (this.falling && bombAge !== null) this.falling.frequency.setTargetAtTime(Math.max(120, 1500 - bombAge * 380), ctx.currentTime, 0.04);
    if (this.falling && bombAge === null) {
      this.falling.stop();
      this.falling.disconnect();
      this.fallingGain?.disconnect();
      this.falling = null;
      this.fallingGain = null;
    }
  }
  cue(type: 'release' | 'hit' | 'miss' | 'over' | 'target' | CombatCue): void {
    const ctx = this.context, master = this.master;
    if (!ctx || !master || ctx.state !== 'running' || this.voices > 6) return;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const impact = type === 'hit' || type === 'miss' || type === 'destroyed' || type === 'damaged';
    const duration = type === 'destroyed' ? 2.6 : type === 'damaged' ? 0.65 : impact ? 1.2 : type === 'flyby' ? 0.5
      : type === 'over' || type === 'missile' ? 0.8 : 0.18;
    let source: OscillatorNode | AudioBufferSourceNode;
    if (impact || type === 'flyby') {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noise;
      noise.loop = true;
      source = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = type === 'flyby' ? 'bandpass' : 'lowpass';
      filter.frequency.value = type === 'flyby' ? 1800 : type === 'destroyed' ? 1100 : 700;
      source.connect(filter).connect(gain);
      source.onended = () => { this.voices--; source.disconnect(); filter.disconnect(); gain.disconnect(); };
    } else {
      const tone = ctx.createOscillator();
      tone.type = type === 'over' || type === 'missile' ? 'triangle' : 'sine';
      const frequency = type === 'target' ? 740 : type === 'release' ? 180 : type === 'missile' ? 400 : 290;
      tone.frequency.setValueAtTime(frequency, now);
      tone.frequency.exponentialRampToValueAtTime(frequency * (type === 'missile' ? 4 : 0.55), now + duration);
      source = tone;
      source.connect(gain);
      source.onended = () => { this.voices--; source.disconnect(); gain.disconnect(); };
    }
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(type === 'destroyed' ? 2.5 : type === 'damaged' ? 1.4 : impact ? 1 : type === 'flyby' ? 0.9 : 0.10, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    gain.connect(master);
    this.voices++;
    source.start(now);
    source.stop(now + duration);
  }
}
