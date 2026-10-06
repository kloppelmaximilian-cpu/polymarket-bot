/**
 * Token bucket. `take()` resolves when a token is available, so callers are
 * throttled rather than rejected — exceeding a venue's published limit gets
 * the IP banned, which is worse than waiting.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSecond);
    this.last = t;
  }

  /** Non-blocking: true if a token was taken. */
  tryTake(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  async take(cost = 1): Promise<void> {
    for (;;) {
      if (this.tryTake(cost)) return;
      const deficit = cost - this.tokens;
      await this.sleep(Math.max(5, Math.ceil((deficit / this.refillPerSecond) * 1000)));
    }
  }

  available(): number {
    this.refill();
    return this.tokens;
  }
}
