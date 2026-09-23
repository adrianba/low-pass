export const PROTOCOL_VERSION = 1;
export const PHYSICS_HZ = 120;
export const MAX_WIRE_BYTES = 16 * 1024;
export const MAX_TRANSFER_BYTES = 16 * 1024 * 1024;
export const TRANSFER_CHUNK_BYTES = 8192;
export const MAX_TRANSFER_CHUNKS = MAX_TRANSFER_BYTES / TRANSFER_CHUNK_BYTES;
export const MAX_PLANS = 4;
export const MAX_EFFECTS = 8;
export const MAX_RECOVERY_REFERENCES = MAX_PLANS + MAX_EFFECTS + 4;
export const MAX_ENCOUNTER_SEQUENCE = 100_000;
export const MAX_TRACK_KNOTS = 2048;
export const MAX_TRACK_DURATION = 3600;
export const MIN_TRACK_INTERVAL = 0.000001;
export const MAX_TRACK_COMPONENT = 1_000_000_000;
export const MAX_CAMERA_SAMPLES = 32_768;
export const MAX_SESSION_SECONDS = 100_000_000;

export const CHANNELS = Object.freeze({
  control: Object.freeze({ ordered: true }),
  state: Object.freeze({ ordered: false, maxRetransmits: 0 }),
});
export type Channel = keyof typeof CHANNELS;
export type Role = 'host' | 'guest';
