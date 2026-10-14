/**
 * Phase 13 B-4: provider sections (D1-D7). Real provider code against stubbed fetch on the closed local port
 * (fixtures shaped from the documented responses), a fake clock for snapshots, the temp ledger and cache. Checks:
 * pre-flight estimates (history only when needed), snapshot reuse (a second run makes no request), refresh,
 * comparisons by tolerance, new/lost as reported, no provider fallback, provider switch notes, Semrush retention,
 * competitors saved first with the denylist applied.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

process.env.SEMRUSH_API_KEY = "semrush-SECTIONS-sentinel-91f2";

const ps = await import("../src/reports/provider-sections.js");
const seo = await import("../src/providers/seo-data.js");
const { saveSnapshot } = await import("../src/lib/snapshots.js");
const { buildDenylist, BUILTIN_DENYLIST } = await import("../src/lib/competitor-denylist.js");
const { ProviderUnavailableError } = await import("../src/lib/provider-ids.js");
const semrushMod = await import("../src/providers/semrush.js");
semrushMod.semrushTiming.spacing = async () => undefined;

const dx = (n: string) => readFileSync(new URL(`./fixtures/dataforseo/${n}`, import.meta.url), "utf8");
const DFS: Record<string, string> = {
  "/v3/backlinks/summary/live": dx("backlinks_summary_live.json"),
  "/v3/backlinks/history/live": dx("p13/backlinks_history_live.json"),
  "/v3/dataforseo_labs/google/domain_rank_overview/live": dx("p13/domain_rank_overview_live.json"),
  "/v3/dataforseo_labs/google/historical_rank_overview/live": dx("p13/historical_rank_overview_live.json"),
  "/v3/dataforseo_labs/google/competitors_domain/live": dx("p13/competitors_domain_live.json"),
};
const sx = (n: string) => readFileSync(new URL(`./fixtures/semrush/${n}`, import.meta.url), "utf8");

interface Req {
  host: string;
  path: string;
  type: string | null;
  body: unknown;
}
function fake(): Req[] {
  const log: Req[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname !== "127.0.0.1") throw new Error(`test tried to reach a real host: ${url.hostname}`);
      log.push({ host: url.host, path: url.pathname, type: url.searchParams.get("type"), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.pathname.startsWith("/v3/")) return DFS[url.pathname] ? new Response(DFS[url.pathname], { status: 200 }) : new Response("{}", { status: 404 });
      const type = url.searchParams.get("type");
      if (type === "backlinks_overview") return new Response(sx("backlinks_overview.doc.csv"), { status: 200 });
      if (type === "domain_rank") return new Response(sx("p13/domain_rank.csv"), { status: 200 });
      if (type === "domain_rank_history") return new Response(sx("p13/domain_rank_history.csv"), { status: 200 });
      return new Response("ERROR 50 :: NOTHING FOUND", { status: 200 });
    }),
  );
  return log;
}
afterEach(() => vi.unstubAllGlobals());

const NOW = Date.parse("2026-10-02T12:00:00Z");
let n = 0;
function client(extra: Partial<Client> = {}): Client {
  n++;
  const domain = `sec${n}.example.com`;
  return { slug: domain, domain, name: "Example Co", aliases: [], competitors: [], locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5, country: "US", monthlyUnits: { ahrefs: 10_000, semrush: 10_000 }, ...extra } as unknown as Client;
}
function deps(now = NOW): import("../src/reports/provider-sections.js").ProviderSectionDeps {
  return {
    now: () => now,
    reuseDays: 7,
    route: (c, cap) => seo.routeProvider(c, cap),
    impl: (p) => seo.providerImpl(p),
    backlinksNow: (c, t) => seo.backlinksSummary(c, t),
    cached: () => false,
    denylist: () => buildDenylist([...BUILTIN_DENYLIST, "blocked.example"]).denylist,
  };
}
/** A September 2026 report: compare August 2026 and September 2025. */
const SEPT = { kind: "period" as const, end: "2026-09-30", toleranceDays: 10, comparisons: { previous_period: "2026-08-31", previous_year: "2025-09-30" }, trendMonths: 12 };

describe("backlinks (DataForSEO)", () => {
  it("first run: summary + history (13 months) in the estimate; comparisons from history; new/lost for September; second run requests nothing", async () => {
    const log = fake();
    const c = client();
    const planned = await ps.planSection(c, { type: "backlinks" }, SEPT, deps());
    expect(ps.estimateOf(planned)).toMatchObject({ provider: "dataforseo", usd: 0.05, units: 0, requests: 2, reused: false });
    expect(log).toHaveLength(0);
    const data = (await ps.runSection(planned, deps())) as import("../src/reports/report-types.js").BacklinksData;
    expect(log.map((l) => l.path)).toEqual(["/v3/backlinks/summary/live", "/v3/backlinks/history/live"]);
    expect((log[1]!.body as { date_from: string }[])[0]!.date_from).toBe("2025-09-01");
    expect(data.authority).toEqual({ metric: "dataforseo_rank", label: "DataForSEO Rank (0–1000)", scale: "0-1000" });
    expect(data).toMatchObject({ provider: "dataforseo", asOf: "2026-10-02", origin: "live", newLostLabel: "September 2026 (DataForSEO, monthly)" });
    expect(data.current).toMatchObject({ newReferringDomains: 12, lostReferringDomains: 7 });
    expect(data.comparisons.previous_period).toMatchObject({ asOf: "2026-08-01", origin: "provider_history", previous: { referringDomains: 191 } });
    expect(data.comparisons.previous_year).toBeNull();
    expect(data.trend.map((p) => p.day)).toEqual(["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-02"]);

    const again = await ps.planSection(c, { type: "backlinks" }, SEPT, deps(NOW + 3_600_000));
    expect(ps.estimateOf(again)).toMatchObject({ usd: 0, requests: 0, reused: true });
    const before = log.length;
    const d2 = (await ps.runSection(again, deps(NOW + 3_600_000))) as typeof data;
    expect(log.length).toBe(before);
    expect(d2.origin).toBe("reused");
    expect(d2.current.referringDomains).toBe(data.current.referringDomains);

    // refresh: true makes exactly one request (the summary; history is stored now).
    const fresh = await ps.planSection(c, { type: "backlinks", refresh: true }, SEPT, deps(NOW + 7_200_000));
    expect(ps.estimateOf(fresh)).toMatchObject({ requests: 1 });
  });

  it("a stored August snapshot serves the comparison: no history bought; history: false never buys it", async () => {
    const log = fake();
    const c = client();
    const key = { client: c.slug, kind: "backlinks" as const, target: c.domain, provider: "dataforseo" as const, market: "global" };
    for (const [day, rd] of [["2026-07-31", 186], ["2026-08-30", 198]] as const) saveSnapshot({ ...key, day, source: "live", capturedAt: NOW - 40 * 86_400_000, data: { referringDomains: rd, backlinks: 1700, authority: { metric: "dataforseo_rank", value: 300 } } }, NOW);
    const planned = await ps.planSection(c, { type: "backlinks" }, { ...SEPT, comparisons: { previous_period: "2026-08-31" } }, deps());
    expect(ps.estimateOf(planned)).toMatchObject({ usd: 0.025, requests: 1 });
    const data = (await ps.runSection(planned, deps())) as import("../src/reports/report-types.js").BacklinksData;
    expect(log.map((l) => l.path)).toEqual(["/v3/backlinks/summary/live"]);
    expect(data.comparisons.previous_period).toMatchObject({ asOf: "2026-08-30", origin: "reused", previous: { referringDomains: 198 } });
    expect(data.newLostLabel).toBeNull();
    const noHist = await ps.planSection(client(), { type: "backlinks", history: false }, SEPT, deps());
    expect(ps.estimateOf(noHist).requests).toBe(1);
  });

  it("a provider switch between months: no comparison across providers, and a note", async () => {
    fake();
    const c = client();
    saveSnapshot({ client: c.slug, kind: "backlinks", target: c.domain, provider: "ahrefs", market: "global", day: "2026-08-31", source: "live", capturedAt: NOW - 30 * 86_400_000, data: { referringDomains: 150 } }, NOW);
    const planned = await ps.planSection(c, { type: "backlinks", history: false }, SEPT, deps());
    const data = (await ps.runSection(planned, deps())) as import("../src/reports/report-types.js").BacklinksData;
    expect(data.comparisons.previous_period).toBeNull();
    expect(data.notes.join(" ")).toContain("Earlier months came from Ahrefs and aren't shown");
  });
});

describe("organic visibility", () => {
  it("DataForSEO: overview + history; bands mapped; comparison from the provider's September point", async () => {
    fake();
    const c = client();
    const planned = await ps.planSection(c, { type: "organic_visibility" }, SEPT, deps());
    expect(ps.estimateOf(planned)).toMatchObject({ usd: 0.12212, requests: 2 });
    const v = (await ps.runSection(planned, deps())) as import("../src/reports/report-types.js").VisibilityData;
    expect(v).toMatchObject({ market: "2840", trafficLabel: "DataForSEO estimated traffic", distributionAvailable: true });
    expect(v.current).toEqual({ keywords: 1204, top3: 41, pos4_10: 118, pos11_20: 160, pos21_100: 885, traffic: 3950 });
    expect(v.comparisons.previous_period?.change.keywords).toBe(108);
  });

  it("Semrush: no bands, history via domain_rank_history; never a DataForSEO request though DataForSEO is configured", async () => {
    const log = fake();
    const c = client({ dataProvider: "semrush" } as Partial<Client>);
    const planned = await ps.planSection(c, { type: "organic_visibility" }, SEPT, deps());
    expect(ps.estimateOf(planned)).toMatchObject({ provider: "semrush", usd: 0, units: 10 + 130 });
    const v = (await ps.runSection(planned, deps())) as import("../src/reports/report-types.js").VisibilityData;
    expect(log.every((l) => !l.path.startsWith("/v3/"))).toBe(true);
    expect(v.distributionAvailable).toBe(false);
    expect(v.notes).toContain("Semrush's API doesn't report keywords by position band.");
    expect(v.comparisons.previous_period).toMatchObject({ asOf: "2026-08-15", origin: "provider_history" });
  });

  it("Semrush backlinks: no history call to anyone; last year's figures are dropped with a note", async () => {
    const log = fake();
    const c = client({ dataProvider: "semrush" } as Partial<Client>);
    const planned = await ps.planSection(c, { type: "backlinks" }, SEPT, deps());
    expect(ps.estimateOf(planned)).toMatchObject({ provider: "semrush", units: 40, requests: 1 });
    const data = (await ps.runSection(planned, deps())) as import("../src/reports/report-types.js").BacklinksData;
    expect(log.map((l) => l.type)).toEqual(["backlinks_overview"]);
    expect(data.authority.label).toBe("Semrush Authority Score (0–100)");
    expect(data.notes.join(" ")).toContain("Semrush data is kept for 31 days");
  });

  it("no fallback: an Ahrefs client without a key is ProviderUnavailableError naming the setup step, and nothing is requested", async () => {
    const log = fake();
    const c = client({ dataProvider: "ahrefs" } as Partial<Client>);
    const err = await ps.planSection(c, { type: "organic_visibility" }, SEPT, deps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as Error).message).toContain("setup --step ahrefs");
    expect(log).toHaveLength(0);
  });
});

describe("competitor overview (D7)", () => {
  it("saved first in saved order, then suggested by shared keywords; denylist applied; the client's own row from its stored visibility", async () => {
    fake();
    const c = client({ domain: "example.com", slug: "comp-owner.example.com", competitors: ["competitor-b.example", "competitor-a.example"] } as Partial<Client>);
    saveSnapshot({ client: c.slug, kind: "visibility", target: "example.com", provider: "dataforseo", market: "2840", day: "2026-10-01", source: "live", capturedAt: NOW, data: { keywords: 1204, traffic: 3950 } }, NOW);
    const d = deps();
    d.denylist = () => buildDenylist(["another.example.org"]).denylist;
    const planned = await ps.planSection(c, { type: "competitor_overview", limit: 4 }, SEPT, d);
    expect(ps.estimateOf(planned)).toMatchObject({ usd: Number((0.0144 + 2 * 0.01212).toFixed(6)), requests: 3 });
    const data = (await ps.runSection(planned, d)) as import("../src/reports/report-types.js").CompetitorOverviewData;
    expect(data.competitors.map((r) => [r.domain, r.origin, r.inProviderList])).toEqual([
      ["competitor-b.example", "saved", false],
      ["competitor-a.example", "saved", true],
      ["rival.example.net", "suggested", true],
      ["evilgro.example", "suggested", true],
    ]);
    expect(data.client).toMatchObject({ domain: "example.com", origin: "client", keywords: 1204, traffic: 3950 });
    expect(data.providerListSize).toBe(4);
    // Within the reuse window: nothing to buy.
    expect(ps.estimateOf(await ps.planSection(c, { type: "competitor_overview", limit: 4 }, SEPT, deps(NOW + 1000)))).toMatchObject({ reused: true, requests: 0 });
  });
});

describe("tools", () => {
  const spend = (left: number): import("../src/reports/provider-sections.js").SpendDeps => ({
    remainingUsd: () => ({ clientUsd: left, globalUsd: 50 }),
    remainingUnits: () => ({ client: left, global: 50_000 }),
    withUsdReservation: async (_c, _u, fn) => fn(),
    withUnitsReservation: async (_c, _p, _u, fn) => fn(),
    spent: () => ({ usd: 0, ahrefs: 0, semrush: 0 }),
  });

  it("organic_visibility never buys history unasked; estimateOnly makes no request; over the cap is refused before any request", async () => {
    const log = fake();
    const c = client();
    const est = await ps.providerTool(c, { type: "organic_visibility" }, { estimateOnly: true }, deps(), spend(5));
    expect(est).toMatchObject({ estimateOnly: true, provider: "dataforseo", usd: 0.01212, requests: 1, wouldExceed: false });
    expect(log).toHaveLength(0);
    await expect(ps.providerTool(c, { type: "organic_visibility" }, {}, deps(), spend(0.001))).rejects.toThrow(/needs \$0\.0121/);
    expect(log).toHaveLength(0);
    const r = (await ps.providerTool(c, { type: "organic_visibility" }, {}, deps(), spend(5))) as { current: { keywords: number }; fromCache: boolean };
    expect(log.map((l) => l.path)).toEqual(["/v3/dataforseo_labs/google/domain_rank_overview/live"]);
    expect(r.current.keywords).toBe(1204);
  });

  it("seo_trends lists each provider and market as its own series", () => {
    const c = client();
    saveSnapshot({ client: c.slug, kind: "visibility", target: c.domain, provider: "dataforseo", market: "2840", day: "2026-09-01", source: "provider_history", capturedAt: NOW + 10, data: { keywords: 5 } }, NOW);
    saveSnapshot({ client: c.slug, kind: "visibility", target: c.domain, provider: "ahrefs", market: "us", day: "2026-09-15", source: "live", capturedAt: NOW, data: { keywords: 7 } }, NOW);
    const t = ps.seoTrends(c, "visibility", undefined, 12, NOW);
    expect(t.series.map((s) => [s.provider, s.market, s.points.map((p) => (p as { keywords?: number | null }).keywords)])).toEqual([["dataforseo", "2840", [5]], ["ahrefs", "us", [7]]]);
    expect(t.notes[0]).toContain("aren't comparable");
  });
});

describe("SEC-4: competitor domains from a provider", () => {
  it("are normalised to plain bare hosts; markup, URLs with paths are reduced, invalid ones and the client's own are skipped", async () => {
    expect(ps.vendorDomain("WWW.Rival.Example.NET", "example.com")).toBe("rival.example.net");
    expect(ps.vendorDomain("https://rival.example.net/path", "example.com")).toBe("rival.example.net");
    expect(ps.vendorDomain("<img src=x onerror=alert(1)>", "example.com")).toBeNull();
    expect(ps.vendorDomain(`${"x".repeat(64)}.example.net`, "example.com")).toBeNull();
    expect(ps.vendorDomain(`${"a.".repeat(130)}example.net`, "example.com")).toBeNull();
    expect(ps.vendorDomain("not a domain", "example.com")).toBeNull();
    expect(ps.vendorDomain("blog.example.com", "example.com")).toBeNull();
    expect(ps.vendorDomain("www.example.com", "example.com")).toBeNull();
    expect(ps.vendorDomain(42, "example.com")).toBeNull();

    // End to end: a provider returning junk stores and lists only the valid competitor.
    const c = client({ domain: "example.com", slug: "sec4.example.com" } as Partial<Client>);
    const d = deps();
    const real = d.impl("dataforseo");
    d.impl = () => ({
      ...real,
      competitorOverview: async () => ({ rows: [{ domain: "<b>x</b>", commonKeywords: 1, keywords: 1, traffic: 1, inProviderList: true }, { domain: "shop.example.com", commonKeywords: 2, keywords: 2, traffic: 2, inProviderList: true }, { domain: "Good.Example.org", commonKeywords: 3, keywords: 3, traffic: 3, inProviderList: true }], providerListSize: 3, market: "2840", provider: "dataforseo", costUsd: 0, units: null, fromCache: false }),
    });
    const planned = await ps.planSection(c, { type: "competitor_overview", limit: 5, refresh: true }, SEPT, d);
    const data = (await ps.runSection(planned, d)) as import("../src/reports/report-types.js").CompetitorOverviewData;
    expect(data.competitors.map((r) => r.domain)).toEqual(["good.example.org"]);
  });
});

describe("R-2: tools reuse only recent live captures", () => {
  it("a 9-day-old capture or this month's provider-history point isn't today's figures; a 3-day-old live capture is", async () => {
    fake();
    const c = client();
    const key = { client: c.slug, kind: "visibility" as const, target: c.domain, provider: "dataforseo" as const, market: "2840" };
    const tool = ps.toolWindow(NOW, 0);
    expect(tool.kind).toBe("tool");
    saveSnapshot({ ...key, day: "2026-09-23", source: "live", capturedAt: NOW - 9 * 86_400_000, data: { keywords: 1 } }, NOW);
    saveSnapshot({ ...key, day: "2026-10-01", source: "provider_history", capturedAt: NOW - 86_400_000, data: { keywords: 2 } }, NOW);
    expect(ps.estimateOf(await ps.planSection(c, { type: "organic_visibility", history: false }, tool, deps())).requests).toBe(1);
    saveSnapshot({ ...key, day: "2026-09-29", source: "live", capturedAt: NOW - 3 * 86_400_000, data: { keywords: 3 } }, NOW);
    const reused = await ps.planSection(c, { type: "organic_visibility", history: false }, tool, deps());
    expect(ps.estimateOf(reused)).toMatchObject({ requests: 0, reused: true });
    // A report period still matches by tolerance: the 9-day-old capture is within 10 days of 30 September.
    const c2 = client();
    saveSnapshot({ ...key, client: c2.slug, target: c2.domain, day: "2026-09-23", source: "live", capturedAt: NOW - 9 * 86_400_000, data: { keywords: 1 } }, NOW);
    expect(ps.estimateOf(await ps.planSection(c2, { type: "organic_visibility", history: false, trendMonths: 0 }, SEPT, deps())).requests).toBe(0);
  });
});

describe("R-3, R-4: provider-history purchases", () => {
  const EMPTY = JSON.stringify({ ...JSON.parse(DFS["/v3/dataforseo_labs/google/historical_rank_overview/live"]!), tasks: [{ ...JSON.parse(DFS["/v3/dataforseo_labs/google/historical_rank_overview/live"]!).tasks[0], result: [{ items: [] }] }] });

  it("an empty history purchase isn't bought again on the next run", async () => {
    const saved = DFS["/v3/dataforseo_labs/google/historical_rank_overview/live"]!;
    DFS["/v3/dataforseo_labs/google/historical_rank_overview/live"] = EMPTY;
    try {
      const log = fake();
      const c = client();
      const first = await ps.planSection(c, { type: "organic_visibility" }, SEPT, deps());
      expect(ps.estimateOf(first).requests).toBe(2);
      await ps.runSection(first, deps());
      expect(log.filter((l) => l.path.endsWith("historical_rank_overview/live"))).toHaveLength(1);
      const second = await ps.planSection(c, { type: "organic_visibility" }, SEPT, deps(NOW + 3_600_000));
      expect(ps.estimateOf(second)).toMatchObject({ requests: 0, reused: true });
    } finally {
      DFS["/v3/dataforseo_labs/google/historical_rank_overview/live"] = saved;
    }
  });

  it("a 12-month tool purchase on 2 Oct doesn't stop a September report buying the 13 months its previous year needs", async () => {
    const log = fake();
    const c = client();
    const tool = await ps.planSection(c, { type: "organic_visibility", history: true, trendMonths: 12 }, ps.toolWindow(NOW, 12), deps());
    await ps.runSection(tool, deps());
    expect(log.filter((l) => l.path.endsWith("historical_rank_overview/live"))).toHaveLength(1);
    const report = await ps.planSection(c, { type: "organic_visibility" }, SEPT, deps(NOW + 3_600_000));
    expect(report.type === "series" && report.plan.history?.months).toBe(13);
    // The same report again after buying 13 months: covered.
    await ps.runSection(report, deps(NOW + 3_600_000));
    const again = await ps.planSection(c, { type: "organic_visibility" }, SEPT, deps(NOW + 7_200_000));
    expect(again.type === "series" && again.plan.history).toBeNull();
  });
});
