/**
 * An in-process request limiter for the Ahrefs and Semrush clients (Phase 9): at
 * most `maxInFlight` calls at once, and at least `minSpacingMs` between call starts,
 * matching each provider's documented rate limit (Ahrefs 60/min; Semrush 10/s and
 * 10 at once). One limiter per provider, shared by every caller in the process.
 */
export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface LimiterOptions {
  maxInFlight: number;
  minSpacingMs: number;
  /** Injectable for tests; defaults to setTimeout (so fake timers work). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createLimiter(o: LimiterOptions): Limiter {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  let nextStart = 0;

  async function acquire(): Promise<void> {
    // A released slot is handed straight to the next waiter, so a newcomer can't jump the queue.
    if (inFlight >= o.maxInFlight) await new Promise<void>((r) => waiting.push(r));
    else inFlight++;
    const t = now();
    const startAt = Math.max(t, nextStart);
    nextStart = startAt + o.minSpacingMs;
    if (startAt > t) await sleep(startAt - t);
  }

  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }

  return {
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
