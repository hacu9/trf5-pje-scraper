/**
 * Politeness gate.
 *
 * Two jobs:
 *
 * 1. Cap how many requests are in flight (`concurrency`, normally 1).
 * 2. Keep a minimum wall clock gap between the START of two requests, plus a
 *    small random jitter so the traffic does not look like a metronome.
 *
 * It also owns a global pause. When the client decides the server is asking us
 * to slow down, it calls `pause(ms)` and every waiter, including the ones
 * already queued, blocks until the pause expires. That is what turns a burst of
 * 429 answers into one shared cool down instead of many independent ones.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export class RateLimiter {
  private active = 0;
  private lastStart = 0;
  private pausedUntil = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly minIntervalMs: number,
    private readonly jitterMs: number,
  ) {
    if (concurrency < 1) throw new Error('concurrency must be at least 1');
  }

  /** Block every caller until `Date.now() + ms`. Extends an existing pause, never shortens it. */
  pause(ms: number): void {
    const until = Date.now() + ms;
    if (until > this.pausedUntil) this.pausedUntil = until;
  }

  /** Milliseconds left on the global pause, or 0. */
  pauseRemaining(): number {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  /** Run `task` under the gate. The gate is released even when the task throws. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    while (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;

    // Honour the global pause first, then the minimum gap. The pause is checked
    // in a loop because another task may extend it while this one is waiting.
    for (;;) {
      const remaining = this.pauseRemaining();
      if (remaining === 0) break;
      await sleep(remaining);
    }

    // Reserve the slot BEFORE awaiting, not after.
    //
    // With concurrency above 1 the obvious version is wrong: two callers read
    // the same `lastStart`, compute the same target, sleep the same amount and
    // then start together, which breaks the minimum gap exactly when it matters
    // most. Writing `lastStart` first makes the second caller queue behind the
    // slot the first one already claimed.
    const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
    const earliest = Math.max(Date.now(), this.lastStart + this.minIntervalMs + jitter);
    this.lastStart = earliest;
    const wait = earliest - Date.now();
    if (wait > 0) await sleep(wait);
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }
}
