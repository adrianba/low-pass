export class PacingError extends Error {}

/** A bounded byte budget; idle time never accumulates an unbounded send burst. */
export class BytePacer {
  private credit: number;
  private previous: number | null = null;
  constructor(readonly bytesPerSecond: number, readonly burstBytes: number) {
    if (!Number.isInteger(bytesPerSecond) || bytesPerSecond < 1 || bytesPerSecond > 4 * 1024 * 1024 ||
      !Number.isInteger(burstBytes) || burstBytes < 1 || burstBytes > 64 * 1024) throw new PacingError('Invalid pacing budget.');
    this.credit = burstBytes;
  }
  delay(bytes: number, now: number): number {
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > this.burstBytes ||
      !Number.isFinite(now) || Math.abs(now) > 1e12 || (this.previous !== null && now < this.previous)) {
      throw new PacingError('Invalid pacing input or clock.');
    }
    if (this.previous !== null) this.credit = Math.min(this.burstBytes, this.credit + (now - this.previous) * this.bytesPerSecond / 1000);
    this.previous = now;
    return Math.max(0, Math.ceil((bytes - this.credit) * 1000 / this.bytesPerSecond));
  }
  sent(bytes: number, now: number): void {
    if (this.delay(bytes, now) !== 0) throw new PacingError('Send exceeds pacing budget.');
    this.credit -= bytes;
  }
}
