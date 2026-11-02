/**
 * D1: Lighthouse runs one at a time per process. The fake lighthouse fails the way the real one does
 * ("performance mark has not been set") when a second run starts while another is in flight.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  inFlight: 0,
  maxInFlight: 0,
  launches: 0,
  runMs: 50,
  urls: [] as string[],
}));

vi.mock("../src/clients.js", () => ({ loadRegistry: async () => ({ clients: [{ domain: "127.0.0.1" }] }) }));
vi.mock("chrome-launcher", () => ({
  launch: async () => {
    m.launches++;
    return { port: 9222, kill: async () => undefined };
  },
}));
vi.mock("lighthouse", () => ({
  default: async (url: string) => {
    m.urls.push(url);
    m.inFlight++;
    m.maxInFlight = Math.max(m.maxInFlight, m.inFlight);
    const overlapped = m.inFlight > 1;
    await new Promise((r) => setTimeout(r, m.runMs));
    m.inFlight--;
    if (overlapped) throw new Error('The "start lh:runner:gather" performance mark has not been set');
    return {
      lhr: {
        finalDisplayedUrl: url,
        categories: { performance: { score: 0.9 }, accessibility: { score: 1 }, "best-practices": { score: 1 }, seo: { score: 1 } },
        audits: {},
      },
    };
  },
}));
vi.mock("../src/providers/browser.js", async (orig) => ({
  ...(await orig<typeof import("../src/providers/browser.js")>()),
  lighthouseLaunchOptions: async () => ({}),
}));

process.env.ALLOW_PRIVATE_URLS = "true";
const { runLighthouse, lighthouseLimits } = await import("../src/providers/lighthouse.js");
const { createSerialQueue } = await import("../src/lib/concurrency.js");
const { TimeoutError } = await import("../src/lib/timeout.js");

beforeEach(() => {
  m.inFlight = 0;
  m.maxInFlight = 0;
  m.launches = 0;
  m.runMs = 50;
  m.urls = [];
  lighthouseLimits.runMs = 150_000;
  lighthouseLimits.queueMs = 600_000;
});
afterAll(() => {
  delete process.env.ALLOW_PRIVATE_URLS;
});

describe("runLighthouse in parallel", () => {
  it("runs three simultaneous calls one at a time and all succeed", async () => {
    const urls = [1, 2, 3].map((i) => `http://127.0.0.1:4999/p${i}`);
    const results = await Promise.all(urls.map((u) => runLighthouse(u, "mobile", { refresh: true })));
    expect(results.map((r) => r.scores.performance)).toEqual([90, 90, 90]);
    expect(m.maxInFlight).toBe(1);
  });

  it("starts the run timer when the call gets the slot, not when it queues", async () => {
    m.runMs = 80;
    lighthouseLimits.runMs = 100;
    const results = await Promise.all(
      ["a", "b"].map((p) => runLighthouse(`http://127.0.0.1:4999/${p}`, "mobile", { refresh: true })),
    );
    expect(results).toHaveLength(2);
    expect(m.maxInFlight).toBe(1);
  });

  it("times out a run that exceeds the run limit, naming the limit", async () => {
    m.runMs = 300;
    lighthouseLimits.runMs = 40;
    await expect(runLighthouse("http://127.0.0.1:4999/slow", "mobile", { refresh: true })).rejects.toThrow(/Lighthouse on http:\/\/127.0.0.1:4999\/slow timed out after 40ms/);
  });

  it("serves a cache hit while another run holds the slot", async () => {
    await runLighthouse("http://127.0.0.1:4999/cached", "mobile", { refresh: true });
    m.runMs = 150;
    const busy = runLighthouse("http://127.0.0.1:4999/busy", "mobile", { refresh: true });
    const t = Date.now();
    const hit = await runLighthouse("http://127.0.0.1:4999/cached", "mobile");
    expect(hit.scores.performance).toBe(90);
    expect(Date.now() - t).toBeLessThan(100);
    await busy;
  });

  it("rejects an abort while queued at once without launching Chrome for it", async () => {
    m.runMs = 150;
    const first = runLighthouse("http://127.0.0.1:4999/one", "mobile", { refresh: true });
    const ctrl = new AbortController();
    const second = runLighthouse("http://127.0.0.1:4999/two", "mobile", { refresh: true, signal: ctrl.signal });
    const settled = expect(second).rejects.toThrow(/stop/);
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort(new Error("stop"));
    await settled;
    await first;
    expect(m.launches).toBe(1);
    expect(m.urls).toEqual(["http://127.0.0.1:4999/one"]);
  });
});

describe("createSerialQueue", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("runs tasks strictly in order, one at a time", async () => {
    const q = createSerialQueue();
    const order: string[] = [];
    let running = 0;
    const task = (name: string, ms: number) => () =>
      (async () => {
        running++;
        expect(running).toBe(1);
        order.push(`start ${name}`);
        await sleep(ms);
        order.push(`end ${name}`);
        running--;
        return name;
      })();
    const out = await Promise.all([q.run(task("a", 30)), q.run(task("b", 5)), q.run(task("c", 5))]);
    expect(out).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(q.pending()).toBe(0);
  });

  it("removes a waiter whose signal aborts and rejects with the reason", async () => {
    const q = createSerialQueue();
    const ran: string[] = [];
    const first = q.run(async () => {
      await sleep(40);
      ran.push("first");
    });
    const ctrl = new AbortController();
    const second = q.run(async () => void ran.push("second"), { signal: ctrl.signal });
    const third = q.run(async () => void ran.push("third"));
    expect(q.pending()).toBe(3);
    ctrl.abort(new Error("cancelled"));
    await expect(second).rejects.toThrow("cancelled");
    expect(q.pending()).toBe(2);
    await Promise.all([first, third]);
    expect(ran).toEqual(["first", "third"]);
  });

  it("rejects a waiter that exceeds maxWaitMs with the earlier-runs text", async () => {
    const q = createSerialQueue();
    const first = q.run(() => sleep(80));
    const err = await q.run(async () => "never", { maxWaitMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toBe("waited 0s for 1 earlier Lighthouse run(s)");
    await first;
    expect(q.pending()).toBe(0);
  });

  it("frees the slot when a task throws", async () => {
    const q = createSerialQueue();
    const bad = q.run(async () => {
      throw new Error("boom");
    });
    const good = q.run(async () => "ok");
    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe("ok");
  });
});
