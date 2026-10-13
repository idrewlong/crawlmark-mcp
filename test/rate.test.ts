import { afterEach, describe, expect, it, vi } from "vitest";
import { createLimiter } from "../src/lib/rate.js";

describe("createLimiter", () => {
  afterEach(() => vi.useRealTimers());

  async function starts(spacing: number, maxInFlight: number, count: number, holdMs = 0) {
    vi.useFakeTimers();
    const limiter = createLimiter({ maxInFlight, minSpacingMs: spacing });
    const t0 = Date.now();
    const at: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const all = Promise.all(
      Array.from({ length: count }, () =>
        limiter.run(async () => {
          at.push(Date.now() - t0);
          peak = Math.max(peak, ++inFlight);
          await new Promise((r) => setTimeout(r, holdMs));
          inFlight--;
        }),
      ),
    );
    await vi.runAllTimersAsync();
    await all;
    return { at, peak };
  }

  it("spaces Ahrefs starts by at least 1,000 ms", async () => {
    const { at } = await starts(1_000, 4, 4);
    expect(at).toEqual([0, 1000, 2000, 3000]);
  });

  it("spaces Semrush starts by at least 100 ms", async () => {
    const { at } = await starts(100, 4, 3);
    expect(at).toEqual([0, 100, 200]);
  });

  it("never has more than maxInFlight running", async () => {
    const { peak, at } = await starts(0, 4, 10, 500);
    expect(peak).toBe(4);
    expect(at.slice(0, 5)).toEqual([0, 0, 0, 0, 500]);
  });
});
