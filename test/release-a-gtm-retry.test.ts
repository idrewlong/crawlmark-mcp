/** D9c: Tag Manager calls are paced (2 at once) and retried on rate limits with a 60 s budget. Time is injected; googleapis is mocked. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ liveErrors: [] as unknown[], liveCalls: 0, optionsSeen: [] as unknown[] }));

vi.mock("googleapis", () => ({
  google: {
    tagmanager: (opts: unknown) => {
      state.optionsSeen.push(opts);
      return {
        accounts: {
          containers: {
            versions: {
              live: async () => {
                state.liveCalls++;
                const next = state.liveErrors.shift();
                if (next) throw next;
                return { data: { tag: [], trigger: [], variable: [], containerVersionId: "1", container: { publicId: "GTM-AAAA111", name: "Example", domainName: ["example.com"] } } };
              },
              },
            workspaces: { list: async () => ({ data: { workspace: [] } }) },
          },
        },
      };
    },
  },
}));
vi.mock("../src/providers/google.js", () => ({
  googleAuth: () => ({}),
  googleAuthIdentity: () => "test:gtm-retry",
  assertGoogleConfigured: () => {},
  googleAuthStatus: () => ({ mode: "service_account", auto: false, configured: true, email: "crawlmark@example-project.iam.gserviceaccount.com" }),
}));

const { gtmCall, gtmTiming, fetchGtmAuditData } = await import("../src/providers/gtm.js");
const realTiming = { ...gtmTiming }; // before beforeEach replaces them

const gaxiosError = (status: number, reason: string, headers?: Record<string, string>) => ({
  code: status,
  message: reason,
  response: { status, headers, data: { error: { message: reason, errors: [{ reason }] } } },
});
const rate = (headers?: Record<string, string>) => gaxiosError(403, "userRateLimitExceeded", headers);

let waits: number[] = [];
beforeEach(() => {
  waits = [];
  state.liveErrors = [];
  state.liveCalls = 0;
  state.optionsSeen = [];
  gtmTiming.sleep = async (ms: number) => void waits.push(ms);
  gtmTiming.pace = async () => undefined;
  gtmTiming.random = () => 0.5; // jitter factor 1.0
});

const ids = { accountId: "6000000001", containerId: "7000000001" };
let n = 0;
const audit = () => fetchGtmAuditData({ ...ids, containerId: `7${String(++n).padStart(9, "0")}` }, { refresh: true });

describe("Tag Manager pacing and retry", () => {
  it("retries a 403 userRateLimitExceeded twice, then succeeds", async () => {
    state.liveErrors = [rate(), rate()];
    const r = await audit();
    expect(r.value.container.publicId).toBe("GTM-AAAA111");
    expect(state.liveCalls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it("honours Retry-After seconds in place of the computed wait", async () => {
    state.liveErrors = [gaxiosError(429, "rateLimitExceeded", { "retry-after": "3" })];
    await audit();
    expect(waits).toEqual([3000]);
  });

  it("gives up at once when Retry-After is longer than the remaining budget", async () => {
    state.liveErrors = [gaxiosError(429, "rateLimitExceeded", { "retry-after": "120" })];
    await expect(audit()).rejects.toThrow(/rate limiting requests.*\(retried 0 times over 0s\)/);
    expect(state.liveCalls).toBe(1);
  });

  it("keeps retrying for 60 s of waiting at most, then throws the rate-limit message with the count", async () => {
    state.liveErrors = Array.from({ length: 20 }, () => rate());
    await expect(audit()).rejects.toThrow(/Tag Manager is rate limiting requests \(quota exceeded\)\. Wait a minute and retry\. \(retried 6 times over 60s\)/);
    const retryWaits = waits;
    expect(retryWaits).toEqual([1000, 2000, 4000, 8000, 16000, 29000]);
    expect(retryWaits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
    expect(state.liveCalls).toBe(7);
  });

  it("applies +-25% jitter to the waits", async () => {
    gtmTiming.random = () => 0;
    state.liveErrors = [rate()];
    await audit();
    expect(waits).toEqual([750]);
  });

  it("does not retry a 403 that isn't a rate limit", async () => {
    state.liveErrors = [gaxiosError(403, "forbidden")];
    await expect(audit()).rejects.toThrow(/denied access/);
    expect(state.liveCalls).toBe(1);
    expect(waits).toEqual([]);
  });

  it("runs at most 2 calls at once", async () => {
    let inFlight = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        gtmCall(async () => {
          inFlight++;
          max = Math.max(max, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
        }),
      ),
    );
    expect(max).toBe(2);
  });

  it("creates the Tag Manager client with gaxios retries off", async () => {
    await audit();
    expect(state.optionsSeen[0]).toMatchObject({ version: "v2", retry: false });
  });
});

describe("abort signal", () => {
  it("stops waiting between retries and rejects promptly", async () => {
    // The real (abortable) sleep: a 29 s wait must end the moment the signal aborts.
    gtmTiming.sleep = realTiming.sleep;
    const ctrl = new AbortController();
    let calls = 0;
    const started = Date.now();
    const p = gtmCall(async () => {
      calls++;
      throw rate();
    }, ctrl.signal);
    p.catch(() => undefined);
    setTimeout(() => ctrl.abort(new Error("timed out")), 50);
    await expect(p).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(calls).toBe(1);
  });

  it("rejects without calling at all when already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("gone"));
    let calls = 0;
    await expect(gtmCall(async () => void calls++, ctrl.signal)).rejects.toThrow("gone");
    expect(calls).toBe(0);
  });
});
