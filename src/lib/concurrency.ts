import { TimeoutError } from "./timeout.js";

/** Map over `items` with at most `limit` calls of `fn` in flight. Results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export interface SerialQueue {
  run<T>(fn: () => Promise<T>, o?: { signal?: AbortSignal | undefined; maxWaitMs?: number | undefined }): Promise<T>;
  /** Tasks running or waiting. */
  pending(): number;
}

/**
 * Strict FIFO queue that runs one task at a time. A waiter whose signal aborts leaves the queue and
 * rejects with the signal's reason; one that waits longer than `maxWaitMs` rejects with a TimeoutError.
 * A task that throws still frees the slot.
 */
export function createSerialQueue(): SerialQueue {
  interface Waiter {
    start: () => void;
  }
  const waiting: Waiter[] = [];
  let busy = false;

  const handOff = () => {
    const w = waiting.shift();
    if (w) w.start(); // the slot passes straight to the next waiter
    else busy = false;
  };

  return {
    pending: () => waiting.length + (busy ? 1 : 0),
    async run(fn, o = {}) {
      o.signal?.throwIfAborted();
      if (busy) {
        await new Promise<void>((resolve, reject) => {
          let timer: NodeJS.Timeout | undefined;
          let off = () => undefined as void;
          const waiter: Waiter = {
            start: () => {
              clearTimeout(timer);
              off();
              resolve();
            },
          };
          const leave = () => {
            const i = waiting.indexOf(waiter);
            if (i >= 0) waiting.splice(i, 1);
            clearTimeout(timer);
            off();
          };
          waiting.push(waiter);
          const signal = o.signal;
          if (signal) {
            const onAbort = () => {
              leave();
              reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted while waiting for earlier Lighthouse runs"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            off = () => signal.removeEventListener("abort", onAbort);
          }
          if (o.maxWaitMs !== undefined) {
            timer = setTimeout(() => {
              const earlier = waiting.indexOf(waiter) + 1;
              leave();
              reject(new TimeoutError(`waited ${Number((o.maxWaitMs! / 1000).toFixed(1))}s for ${earlier} earlier Lighthouse run(s)`));
            }, o.maxWaitMs);
          }
        });
      } else {
        busy = true;
      }
      try {
        return await fn();
      } finally {
        handOff();
      }
    },
  };
}
