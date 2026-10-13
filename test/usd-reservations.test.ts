/**
 * SEC-1 (Phase 12 B fix round): concurrent DataForSEO operations reserve their whole USD estimate, so calls
 * started together can't each pass a cap their sum would break. DataForSEO is a stubbed fetch on the closed
 * local port; spend goes to the temp ledger. No real network.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";
import { assertBudget, BudgetExceededError, pendingUsd, remainingUsd, spentThisMonth, withUsdReservation } from "../src/lib/budget.js";
import { keywordGap, type GapContext } from "../src/providers/seo-data.js";

const FIX = readFileSync(new URL("./fixtures/dataforseo/dataforseo_labs_google_domain_intersection_live.json", import.meta.url), "utf8");
const noGsc: GapContext = { gscAvailable: false, clientQueries: async () => new Set() };

function makeClient(slug: string, monthlyBudgetUsd: number): Client {
  return {
    slug, domain: slug, name: "Example Co", aliases: [], sources: [], brandTerms: [], trackedKeywords: [], competitors: [], competitorEntries: [],
    keyPages: [], alternates: { gsc: [], ga4: [] }, locationCode: 2840, languageCode: "en", monthlyBudgetUsd, country: "US", monthlyUnits: { ahrefs: 10_000, semrush: 5_000 },
  } as unknown as Client;
}

function slowDfs(): { targets: string[] } {
  const seen = { targets: [] as string[] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      if (new URL(input).hostname !== "127.0.0.1") throw new Error("real host");
      seen.targets.push((JSON.parse(String(init.body)) as { target1: string }[])[0]!.target1);
      await new Promise((r) => setTimeout(r, 20));
      return new Response(FIX, { status: 200 });
    }),
  );
  return seen;
}
afterEach(() => vi.unstubAllGlobals());

describe("USD reservations for multi-request DataForSEO calls", () => {
  it("two concurrent keyword_gap calls whose combined estimate exceeds the cap: one is refused before any request", async () => {
    const seen = slowDfs();
    // Each call: 2 competitors x ($0.012 + 100 x $0.00012) = $0.048; together $0.096 > $0.07.
    const c = makeClient("reserve.example.com", 0.07);
    const results = await Promise.allSettled([
      keywordGap(c, { competitors: ["a.example", "b.example"], limit: 100, minVolume: 0 }, { ctx: noGsc }),
      keywordGap(c, { competitors: ["c.example", "d.example"], limit: 100, minVolume: 0 }, { ctx: noGsc }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(BudgetExceededError);
    // Only the call that ran sent requests (its two competitors).
    expect(seen.targets).toHaveLength(2);
    expect(spentThisMonth(c.slug)).toBeLessThanOrEqual(0.07);
    // The reservation is released once the call ends.
    expect(pendingUsd([c.slug])).toEqual({ client: 0, global: 0 });
  });

  it("four parallel calls never record more than the cap", async () => {
    slowDfs();
    const c = makeClient("probe.example.com", 0.1);
    const calls = ["e", "f", "g", "h"].map((x) => keywordGap(c, { competitors: [`${x}1.example`, `${x}2.example`], limit: 100, minVolume: 0 }, { ctx: noGsc }));
    const results = await Promise.allSettled(calls);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(spentThisMonth(c.slug)).toBeLessThanOrEqual(0.1);
  });

  it("a reservation counts against other calls, never against its own checks, and is released when the call fails", async () => {
    const c = makeClient("own.example.com", 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ownRemaining: number | undefined;
    const a = withUsdReservation(c, 0.9, async () => {
      assertBudget(c, 0.05); // the call's own per-request check: its reservation isn't counted twice
      ownRemaining = remainingUsd(c).clientUsd;
      await gate;
      return "a";
    });
    // Another call, outside A's context, sees A's reservation.
    expect(pendingUsd([c.slug])).toEqual({ client: 0.9, global: 0.9 });
    expect(remainingUsd(c).clientUsd).toBe(0.1);
    await expect(withUsdReservation(c, 0.2, async () => "b")).rejects.toThrow(/plus \$0\.9000 reserved by calls in progress/);
    release();
    expect(await a).toBe("a");
    expect(ownRemaining).toBe(1);
    await expect(withUsdReservation(c, 0.5, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(pendingUsd([c.slug])).toEqual({ client: 0, global: 0 });
    expect(remainingUsd(c).clientUsd).toBe(1);
  });
});

describe("nested reservations", () => {
  it("an operation inside a reserved run doesn't count the outer reservation against itself, but others see both", async () => {
    const c = makeClient("nested.example.com", 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const outer = withUsdReservation(c, 0.6, () =>
      withUsdReservation(c, 0.3, async () => {
        assertBudget(c, 0.3); // its own check: neither reservation counted
        await gate;
        return "inner";
      }),
    );
    expect(pendingUsd([c.slug]).client).toBeCloseTo(0.9, 6);
    await expect(withUsdReservation(c, 0.2, async () => "x")).rejects.toBeInstanceOf(BudgetExceededError);
    release();
    expect(await outer).toBe("inner");
    expect(pendingUsd([c.slug])).toEqual({ client: 0, global: 0 });
  });
});
