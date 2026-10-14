/**
 * Phase 13 B-2: DataForSEO organic visibility, visibility history, backlink history and the competitor overview.
 * DataForSEO is a stubbed fetch on the closed local port (test/setup.ts) answering with hand-built fixtures shaped
 * from the documented responses; request bodies are recorded. No real network; spend goes to the temp ledger.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";
import { spentThisMonth } from "../src/lib/budget.js";
import { db } from "../src/lib/store.js";
import * as dfs from "../src/providers/dataforseo.js";
import { providerImpl } from "../src/providers/seo-data.js";

const fx = (name: string) => readFileSync(new URL(`./fixtures/dataforseo/p13/${name}`, import.meta.url), "utf8");
const FIX: Record<string, string> = {
  "/v3/dataforseo_labs/google/domain_rank_overview/live": fx("domain_rank_overview_live.json"),
  "/v3/dataforseo_labs/google/historical_rank_overview/live": fx("historical_rank_overview_live.json"),
  "/v3/backlinks/history/live": fx("backlinks_history_live.json"),
  "/v3/dataforseo_labs/google/competitors_domain/live": fx("competitors_domain_live.json"),
};

interface Sent {
  path: string;
  body: Record<string, unknown>[];
  auth: string | null;
}
function fakeDfs(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      if (url.hostname !== "127.0.0.1") throw new Error(`test tried to reach a real host: ${url.hostname}`);
      sent.push({ path: url.pathname, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      const body = FIX[url.pathname];
      return body ? new Response(body, { status: 200 }) : new Response("{}", { status: 404 });
    }),
  );
  return sent;
}
afterEach(() => vi.unstubAllGlobals());

let n = 0;
function client(extra: Partial<Client> = {}): Client {
  n++;
  const slug = `dfs${n}.example.com`;
  return { slug, domain: slug, name: "Example Co", aliases: [], competitors: [], locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5, country: "US", monthlyUnits: { ahrefs: 10_000, semrush: 5_000 }, ...extra } as unknown as Client;
}
const ledger = (c: Client) => db.prepare("SELECT endpoint, cost_usd FROM spend WHERE client = ? ORDER BY id").all(c.slug) as { endpoint: string; cost_usd: number }[];

describe("DataForSEO organic visibility (D6)", () => {
  it("domain_rank_overview: bare target and the client's market; bands, ETV and count mapped; cost recorded; cached", async () => {
    const sent = fakeDfs();
    const c = client();
    const r = await dfs.rankOverview(c, "www.example.com");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual([{ target: "example.com", location_code: 2840, language_code: "en" }]);
    expect(r.figures).toEqual({ keywords: 1204, top3: 41, pos4_10: 118, pos11_20: 160, pos21_100: 885, traffic: 3950, trafficLabel: "DataForSEO estimated traffic" });
    expect(r).toMatchObject({ market: "2840", provider: "dataforseo", units: null, fromCache: false, costUsd: 0.0101 });
    expect(ledger(c)).toEqual([{ endpoint: dfs.P13_PATHS.rankOverview, cost_usd: 0.0101 }]);
    const again = await dfs.rankOverview(c, "www.example.com");
    expect(again.fromCache).toBe(true);
    expect(sent).toHaveLength(1);
    expect(dfs.planRankOverview(c, "example.com").cost(1)).toBe(0.01212);
  });

  it("historical_rank_overview: date_from is the first of the month N months back; one point per month, oldest first", async () => {
    const sent = fakeDfs();
    const c = client();
    const r = await dfs.rankHistory(c, "example.com", 13);
    expect(sent[0]!.body[0]).toEqual({ target: "example.com", location_code: 2840, language_code: "en", date_from: dfs.monthsBackDay(13) });
    expect(r.points.map((p) => p.day)).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
    expect(r.points[2]).toMatchObject({ keywords: 1132, top3: 38, pos4_10: 111 });
    expect(dfs.planRankHistory(c, "example.com", 13).cost(1)).toBe(0.11);
    expect(dfs.monthsBackDay(13, new Date("2026-10-13T00:00:00Z"))).toBe("2025-09-01");
  });

  it("backlinks/history: rank_scale one_thousand; new/lost as reported; days from the provider's dates", async () => {
    const sent = fakeDfs();
    const c = client();
    const r = await dfs.backlinksHistoryDfs(c, "example.com", 13);
    expect(sent[0]!.body[0]).toEqual({ target: "example.com", date_from: dfs.monthsBackDay(13), rank_scale: "one_thousand" });
    expect(r.points.at(-1)).toEqual({ day: "2026-09-01", backlinks: 1702, referringDomains: 198, authority: { metric: "dataforseo_rank", value: 305 }, newBacklinks: 80, lostBacklinks: 52, newReferringDomains: 12, lostReferringDomains: 7 });
    expect(dfs.ESTIMATE_USD.backlinksHistory).toBe(0.025);
    expect(dfs.ESTIMATE_USD.backlinksSummary).toBe(0.025);
    expect(spentThisMonth(c.slug)).toBeCloseTo(0.02012, 6);
  });
});

describe("DataForSEO competitor overview (D7)", () => {
  it("asks for at least 20 rows, drops the target itself, strips control characters, and looks up missing saved competitors", async () => {
    const sent = fakeDfs();
    const c = client({ domain: "example.com" } as Partial<Client>);
    const r = await dfs.competitorOverviewDfs(c, { saved: ["competitor-a.example", "competitor-b.example"], limit: 5 });
    expect(sent.map((s) => s.path)).toEqual([`/v3${dfs.P13_PATHS.competitorsDomain}`, `/v3${dfs.P13_PATHS.rankOverview}`]);
    expect(sent[0]!.body[0]).toEqual({ target: "example.com", location_code: 2840, language_code: "en", limit: 20, item_types: ["organic"] });
    expect(sent[1]!.body[0]).toMatchObject({ target: "competitor-b.example" });
    expect(r.providerListSize).toBe(4);
    expect(r.rows.map((x) => x.domain)).toEqual(["competitor-a.example", "rival.example.net", "another.example.org", "evilgro.example", "competitor-b.example"]);
    expect(r.rows[0]).toEqual({ domain: "competitor-a.example", commonKeywords: 312, keywords: 2408, traffic: 7901, inProviderList: true });
    expect(r.rows.at(-1)).toMatchObject({ domain: "competitor-b.example", commonKeywords: null, inProviderList: false });
    // Ceiling: the list plus every saved competitor on its own.
    expect(dfs.planCompetitorOverviewDfs(c, { saved: ["a.example", "b.example"], limit: 5 }).cost(1)).toBeCloseTo(0.0144 + 2 * 0.01212, 6);
  });

  it("the provider interface exposes every Phase 13 B call and plan", () => {
    const p = providerImpl("dataforseo");
    for (const k of ["planBacklinksSummary", "planOrganicOverview", "organicOverview", "planOrganicHistory", "organicHistory", "planBacklinksHistory", "backlinksHistory", "planCompetitorOverview", "competitorOverview", "market"] as const) expect(typeof p[k]).toBe("function");
    expect(p.planBacklinksSummary!(client(), "example.com").cost(1)).toBe(0.025);
  });
});
