/**
 * Report charts and comparisons find a stored point with findPoint (D3): a live capture inside the tolerance, else
 * the provider's monthly history point for the same month. A history point of a neighbouring month (DataForSEO and
 * Ahrefs date them the 1st, Semrush mid-month) must never stand in, or the report would label September's figures
 * "August 2026". Fake clock and fake dates only; no provider is called.
 */
import { describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import { saveSnapshot, type SnapshotKey } from "../src/lib/snapshots.js";
import { buildVisibilityData, findPoint, planSeries, toolWindow, type ProviderSectionDeps } from "../src/reports/provider-sections.js";

let n = 0;
const keyFor = (provider: SnapshotKey["provider"] = "dataforseo"): SnapshotKey => ({ client: `fp${++n}.example.com`, kind: "visibility", target: "example.com", provider, market: "2840" });
const NOW = Date.parse("2026-10-02T12:00:00Z");
const fig = (keywords: number) => ({ keywords, top3: 1, pos4_10: 2, pos11_20: 3, pos21_100: 4, traffic: 10, trafficLabel: "est" });
const put = (k: SnapshotKey, day: string, source: "live" | "provider_history", keywords: number, capturedAt = NOW) => saveSnapshot({ ...k, day, source, capturedAt, data: fig(keywords) }, NOW);

describe("findPoint", () => {
  it("does not answer for August 31 with September's history point dated the 1st", () => {
    const k = keyFor();
    put(k, "2026-09-01", "provider_history", 90);
    expect(findPoint(k, "2026-08-31", 10, NOW)).toBeUndefined();
  });

  it("does not answer for September 30 with October's history point dated the 1st", () => {
    const k = keyFor();
    put(k, "2026-10-01", "provider_history", 95);
    expect(findPoint(k, "2026-09-30", 10, NOW)).toBeUndefined();
  });

  it("uses the history point of the asked month, dated the 1st (DataForSEO, Ahrefs) or mid-month (Semrush)", () => {
    const k = keyFor();
    put(k, "2026-08-01", "provider_history", 80);
    put(k, "2026-09-01", "provider_history", 90);
    expect(findPoint(k, "2026-08-31", 10, NOW)).toMatchObject({ day: "2026-08-01", source: "provider_history" });
    const s = keyFor("semrush");
    put(s, "2026-08-15", "provider_history", 70);
    expect(findPoint(s, "2026-08-31", 10, NOW)).toMatchObject({ day: "2026-08-15" });
  });

  it("prefers a live capture inside the tolerance over the month's history point", () => {
    const k = keyFor();
    put(k, "2026-08-01", "provider_history", 80);
    put(k, "2026-08-28", "live", 85);
    expect(findPoint(k, "2026-08-31", 10, NOW)).toMatchObject({ day: "2026-08-28", source: "live" });
    // The nearest point is the history point here (a live one is 9 days away); the live capture still wins inside the tolerance.
    const j = keyFor();
    put(j, "2026-08-31", "provider_history", 1);
    put(j, "2026-09-09", "live", 2);
    expect(findPoint(j, "2026-08-31", 10, NOW)).toMatchObject({ day: "2026-09-09", source: "live" });
  });
});

/** A routed provider that sells visibility at a fixed estimate and has no history to buy. */
function fakeDeps(now: number, reuseDays = 7): ProviderSectionDeps {
  const plan = { keyParts: { t: "example.com" }, unit: "usd" as const, requests: 1, cost: () => 0.1, breakdown: () => "one overview" };
  return {
    now: () => now,
    reuseDays,
    route: async () => ({ provider: "dataforseo" as const }),
    impl: () => ({ market: () => "2840", planOrganicOverview: () => plan }) as never,
    backlinksNow: async () => {
      throw new Error("not used");
    },
    cached: () => false,
    denylist: () => ({}) as never,
  };
}
const client = (slug: string) => ({ slug, domain: "example.com" }) as unknown as Client;
const SEPT = { kind: "period" as const, end: "2026-09-30", toleranceDays: 10, comparisons: { previous_period: "2026-08-31" }, trendMonths: 0 };

describe("a report period never shows a neighbouring month's point", () => {
  it("fetches instead of using October's history point as September's current figures", async () => {
    const k = { ...keyFor(), client: "fp-sept.example.com", target: "example.com" };
    put(k, "2026-10-01", "provider_history", 95);
    const plan = await planSeries(client(k.client), "visibility", SEPT, { history: false }, fakeDeps(NOW));
    expect("fetch" in plan.current).toBe(true);
  });

  it("uses September's own history point as the current figures, labelled as of the 1st, with no August comparison from September's point", async () => {
    const k = { ...keyFor(), client: "fp-sept2.example.com", target: "example.com" };
    put(k, "2026-09-01", "provider_history", 90);
    const plan = await planSeries(client(k.client), "visibility", SEPT, { history: false }, fakeDeps(NOW));
    expect("use" in plan.current && plan.current.use.day).toBe("2026-09-01");
    const data = buildVisibilityData(plan, null, NOW);
    expect(data).toMatchObject({ asOf: "2026-09-01", origin: "provider_history", current: { keywords: 90 } });
    expect(data.comparisons.previous_period ?? null).toBeNull();
  });

  it("compares with August only from an August point", async () => {
    const k = { ...keyFor(), client: "fp-sept3.example.com", target: "example.com" };
    put(k, "2026-08-01", "provider_history", 80);
    put(k, "2026-09-01", "provider_history", 90);
    const plan = await planSeries(client(k.client), "visibility", SEPT, { history: false }, fakeDeps(NOW));
    const data = buildVisibilityData(plan, null, NOW);
    expect(data.comparisons.previous_period).toMatchObject({ asOf: "2026-08-01", origin: "provider_history", change: { keywords: 10 } });
  });
});

describe("a tool's current figures are reused only within SNAPSHOT_REUSE_DAYS", () => {
  it("fetches when the newest live capture is 8 days old and a history point exists for this month", async () => {
    const k = { ...keyFor(), client: "fp-tool.example.com", target: "example.com" };
    put(k, "2026-09-24", "live", 70, Date.parse("2026-09-24T09:00:00Z"));
    put(k, "2026-10-01", "provider_history", 95);
    const plan = await planSeries(client(k.client), "visibility", toolWindow(NOW, 0), { history: false }, fakeDeps(NOW, 7));
    expect("fetch" in plan.current).toBe(true);
  });

  it("reuses a live capture 5 days old", async () => {
    const k = { ...keyFor(), client: "fp-tool2.example.com", target: "example.com" };
    put(k, "2026-09-27", "live", 72, Date.parse("2026-09-27T09:00:00Z"));
    const plan = await planSeries(client(k.client), "visibility", toolWindow(NOW, 0), { history: false }, fakeDeps(NOW, 7));
    expect("use" in plan.current && plan.current.use.day).toBe("2026-09-27");
  });
});
