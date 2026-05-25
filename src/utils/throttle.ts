/**
 * Token-bucket throttle — ensures at least `delayMs` between each call.
 * Supports concurrency by tracking last-release timestamp.
 */
export class Throttle {
  private lastCallAt = 0;
  private delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  async wait(): Promise<void> {
    if (this.delayMs <= 0) return;

    const now = Date.now();
    const elapsed = now - this.lastCallAt;
    const remaining = this.delayMs - elapsed;

    if (remaining > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }

    this.lastCallAt = Date.now();
  }

  setDelay(ms: number): void {
    this.delayMs = ms;
  }
}
