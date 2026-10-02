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
    this.source?.disconnect();
    this.source = null;
    if (!stream || this.closed) return;
    try {
      this.prepareAudio();
      this.source = this.context!.createMediaStreamSource(stream);
      this.source.connect(this.input!);
      this.updateGain();
      void this.context!.resume().catch(() => this.warn('Radio playback unavailable.'));
    } catch { this.warn('Radio playback unavailable.'); }
  }
  private input: BiquadFilterNode | null = null;
  private prepareAudio(): void {
    if (this.context) return;
    const ctx = this.context = new AudioContext();
    const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 350;
    const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 3100;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -28; compressor.ratio.value = 4;
    this.gain = ctx.createGain();
    high.connect(low).connect(compressor).connect(this.gain).connect(ctx.destination);
    this.input = high;
    this.updateGain();
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
