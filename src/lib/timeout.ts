/** Time limits per kind of work (Phase 6d). */
export const TIMEOUTS = {
  /** One browser check (Lighthouse, axe, rendered fetch), and the browser tools as a whole. */
  browserMs: 90_000,
  /** One outbound API call (Google, DataForSEO, PageSpeed Insights). */
  networkMs: 30_000,
  /** run_audit as a whole. */
  auditMs: 10 * 60_000,
} as const;

/** How long a timed-out operation's cleanup (closing a browser) may take before we give up waiting. */
const CLEANUP_WAIT_MS = 15_000;

export class TimeoutError extends Error {
  override name = "TimeoutError";
}

const fmt = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);

/**
 * Settle with `promise`, or reject with a TimeoutError after `ms`. On timeout,
 * `onTimeout` runs first (abort a request, close a browser) and the rejection waits
 * for it, up to 15s, so a caller that moves on does not overlap with the old work.
 * The original promise keeps running unless `onTimeout` stops it; its later
 * rejection is swallowed.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      promise.catch(() => undefined);
      const err = new TimeoutError(`${label} timed out after ${fmt(ms)}`);
      const cleanup = (async () => {
        try {
          await onTimeout?.();
        } catch (e) {
          console.error(`crawlmark: cleanup after "${label}" timeout failed: ${(e as Error).message}`);
        }
      })();
      let wait: NodeJS.Timeout | undefined;
      const cap = new Promise<void>((r) => {
        wait = setTimeout(r, CLEANUP_WAIT_MS);
        wait.unref();
      });
      void Promise.race([cleanup, cap]).then(() => {
        clearTimeout(wait);
        reject(err);
      });
    }, ms);
    promise.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Run `fn` once when `signal` aborts (now, if it already has). Returns a disposer. */
export function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    fn();
    return () => undefined;
  }
  signal.addEventListener("abort", fn, { once: true });
  return () => signal.removeEventListener("abort", fn);
}
