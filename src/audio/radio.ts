import type { StoragePort } from '../storage/records.js';

export const RADIO_STORAGE_KEY = 'low-pass.radio.v1';
interface Preferences { muted: boolean; volume: number }
const defaults: Preferences = { muted: false, volume: 0.65 };

export class Radio {
  private preferences: Preferences = { ...defaults };
  private storage: StoragePort | null = null;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private staticSource: AudioBufferSourceNode | null = null;
  private staticGain: GainNode | null = null;
  private squelchGain: GainNode | null = null;
  private monitor: ReturnType<typeof setInterval> | null = null;
  private talking = false;
  private quietSamples = 0;
  private stream: MediaStream | null = null;
  private requested = false;
  private transmitting = false;
  private closed = false;

  constructor(getStorage: () => StoragePort, private readonly warn: (message: string) => void) {
    try {
      this.storage = getStorage();
      const raw = this.storage.getItem(RADIO_STORAGE_KEY);
      if (raw !== null) {
        if (raw.length > 1024) throw new Error('Invalid radio preferences.');
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || !('muted' in value) || !('volume' in value) ||
          typeof value.muted !== 'boolean' || typeof value.volume !== 'number' ||
          !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1) throw new Error('Invalid radio preferences.');
        this.preferences = { muted: value.muted, volume: value.volume };
      }
    } catch {
      this.storage = null;
      this.warn('Radio preferences unavailable. Existing saved data was not replaced.');
    }
  }
  get muted(): boolean { return this.preferences.muted; }
  get volume(): number { return this.preferences.volume; }
  get track(): MediaStreamTrack | null { return this.stream?.getAudioTracks()[0] ?? null; }
  get canTransmit(): boolean { return !!this.track && this.track.readyState === 'live'; }
  get sending(): boolean { return this.transmitting && this.canTransmit; }
  async request(): Promise<void> {
    if (this.requested || this.closed) return;
    this.requested = true;
    try {
      this.prepareAudio();
      void this.context?.resume().catch(() => this.warn('Radio playback unavailable.'));
    } catch { this.warn('Radio playback unavailable.'); }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.track!.enabled = false;
      this.track!.onended = () => this.setTransmitting(false);
    } catch {
      this.warn('Microphone unavailable or permission declined. You can still receive radio and play.');
    }
  }
  setTransmitting(value: boolean): void {
    const next = value && this.canTransmit && !this.closed;
    if (this.transmitting === next) return;
    this.transmitting = next;
    if (this.track) this.track.enabled = this.transmitting;
    this.updateGain();
  }
  setReceive(muted: boolean, volume: number): void {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) return;
    this.preferences = { muted, volume };
    this.updateGain();
    try { this.storage?.setItem(RADIO_STORAGE_KEY, JSON.stringify(this.preferences)); }
    catch { this.storage = null; this.warn('Could not save radio preferences; they will last only this session.'); }
  }
  receive(stream: MediaStream | null): void {
    if (this.monitor !== null) clearInterval(this.monitor);
    this.monitor = null;
    this.source?.disconnect();
    this.source = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.staticSource?.stop();
    this.staticSource?.disconnect();
    this.staticSource = null;
    this.talking = false;
    this.quietSamples = 0;
    if (this.context && this.staticGain && this.squelchGain) {
      this.staticGain.gain.cancelScheduledValues(this.context.currentTime);
      this.staticGain.gain.setValueAtTime(0, this.context.currentTime);
      this.squelchGain.gain.cancelScheduledValues(this.context.currentTime);
      this.squelchGain.gain.setValueAtTime(0, this.context.currentTime);
    }
    if (!stream || this.closed) return;
    try {
      this.prepareAudio();
      this.source = this.context!.createMediaStreamSource(stream);
      this.source.connect(this.input!);
      this.analyser = this.context!.createAnalyser();
      this.analyser.fftSize = 512;
      this.source.connect(this.analyser);
      const noise = this.context!.createBufferSource();
      noise.buffer = this.staticBuffer!;
      noise.loop = true;
      noise.connect(this.staticGain!);
      noise.connect(this.squelchGain!);
      noise.start();
      this.staticSource = noise;
      const samples = new Float32Array(this.analyser.fftSize);
      this.monitor = setInterval(() => this.sampleActivity(samples), 50);
      this.updateGain();
      void this.context!.resume().catch(() => this.warn('Radio playback unavailable.'));
    } catch { this.receive(null); this.warn('Radio playback unavailable.'); }
  }
  private input: BiquadFilterNode | null = null;
  private staticBuffer: AudioBuffer | null = null;
  private prepareAudio(): void {
    if (this.context) return;
    const ctx = this.context = new AudioContext();
    const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 350;
    const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 3100;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -28; compressor.ratio.value = 4;
    this.gain = ctx.createGain();
    high.connect(low).connect(compressor).connect(this.gain).connect(ctx.destination);
    const noise = this.staticBuffer = ctx.createBuffer(1, Math.round(ctx.sampleRate / 4), ctx.sampleRate);
    const values = noise.getChannelData(0);
    for (let i = 0; i < values.length; i++) values[i] = Math.random() * 2 - 1;
    this.staticGain = ctx.createGain();
    this.staticGain.gain.value = 0;
    this.squelchGain = ctx.createGain();
    this.squelchGain.gain.value = 0;
    this.staticGain.connect(this.gain);
    this.squelchGain.connect(this.gain);
    this.input = high;
    this.updateGain();
  }
  private sampleActivity(samples: Float32Array<ArrayBuffer>): void {
    if (!this.analyser || !this.context || !this.staticGain || !this.squelchGain) return;
    this.analyser.getFloatTimeDomainData(samples);
    let power = 0;
    for (const sample of samples) power += sample * sample;
    const active = Math.sqrt(power / samples.length) > 0.012;
    this.quietSamples = active ? 0 : this.quietSamples + 1;
    if (active === this.talking || this.talking && this.quietSamples < 4) return;
    this.talking = active;
    const now = this.context.currentTime;
    this.staticGain.gain.cancelScheduledValues(now);
    this.staticGain.gain.setTargetAtTime(active ? 0.012 : 0, now, 0.02);
    this.squelchGain.gain.cancelScheduledValues(now);
    this.squelchGain.gain.setValueAtTime(0.045, now);
    this.squelchGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    this.squelchGain.gain.setValueAtTime(0, now + 0.081);
  }
  private updateGain(): void {
    if (this.context && this.gain) {
      const gain = this.gain.gain, at = this.context.currentTime;
      gain.cancelScheduledValues(at);
      if (this.transmitting || this.preferences.muted) gain.setValueAtTime(0, at);
      else gain.setTargetAtTime(this.preferences.volume, at, 0.005);
    }
  }
  close(): void {
    this.closed = true;
    this.setTransmitting(false);
    this.receive(null);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    void this.context?.close();
    this.context = null;
  }
}
