/**
 * Reports for a client on Ahrefs with no DataForSEO login (spec 9.5, 9.9 "Reports"):
 * backlinks come from Ahrefs, while on-page checks, crawls and live SERPs are
 * unavailable rather than failed. Browser checks and Google are mocked; Ahrefs is a
 * stubbed fetch with the documented fixtures.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

delete process.env.DATAFORSEO_LOGIN;
delete process.env.DATAFORSEO_PASSWORD;
process.env.AHREFS_API_KEY = "ahrefs-test-key";

const notHere = () => Promise.reject(new Error("not part of this test"));
vi.mock("../src/providers/lighthouse.js", () => ({ runLighthouse: vi.fn(notHere) }));
vi.mock("../src/providers/axe.js", () => ({ runAxe: vi.fn(notHere) }));
vi.mock("../src/providers/render.js", () => ({ checkRender: vi.fn(notHere) }));
vi.mock("../src/providers/gsc.js", () => ({ gscSitemaps: vi.fn(notHere), gscInspectUrl: vi.fn(notHere), gscQuery: vi.fn(notHere) }));
vi.mock("../src/reports/site-hygiene.js", () => ({ siteHygiene: vi.fn(notHere) }));

const { ahrefsTiming } = await import("../src/providers/ahrefs.js");
const { runAudit } = await import("../src/reports/audit.js");
const { getAudit } = await import("../src/lib/audits.js");
const { suggestCompetitors } = await import("../src/competitors.js");

ahrefsTiming.sleep = async () => {};
ahrefsTiming.spacing = async () => {};

const fx = (name: string) => readFileSync(new URL(`./fixtures/ahrefs/${name}`, import.meta.url), "utf8");
const FIX: Record<string, string> = {
  "/v3/site-explorer/backlinks-stats": fx("backlinks-stats.json"),
  "/v3/site-explorer/domain-rating": fx("domain-rating.json"),
  "/v3/site-explorer/organic-competitors": fx("organic-competitors.json"),
};
function fakeAhrefs() {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.hostname !== "127.0.0.1") throw new Error(`test tried to reach a real host: ${url.hostname}`);
      paths.push(url.pathname);
      const body = FIX[url.pathname];
      return body ? new Response(body, { status: 200, headers: { "x-api-units-cost-total-actual": "50" } }) : new Response("{}", { status: 404 });
    }),
  );
  return paths;
}

afterEach(() => vi.unstubAllGlobals());

const client = {
  slug: "example.com", name: "Example Co", domain: "example.com", aliases: [], sources: [], brandTerms: [], trackedKeywords: [], competitors: [],
  keyPages: ["https://example.com/"], alternates: { gsc: [], ga4: [] }, locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5,
  dataProvider: "ahrefs", country: "US", monthlyUnits: { ahrefs: 10_000, semrush: 5_000 },
} as unknown as Client;

describe("run_audit with dataProvider: ahrefs and no DataForSEO", () => {
  it("gets backlinks from Ahrefs, marks onPage and the crawl unavailable, and still saves", async () => {
    const paths = fakeAhrefs();
    const r = await runAudit(client, { backlinks: true, fullCrawl: true });
    expect(r.site.backlinks).toMatchObject({ ok: true, data: { provider: "ahrefs", summary: { backlinks: 1840, authority: { metric: "domain_rating" } } } });
    expect(r.site.crawl).toMatchObject({ ok: false, unavailable: true, error: expect.stringMatching(/^Site crawls need DataForSEO; ahrefs/) });
    expect(r.pages[0]!.onPage).toMatchObject({ ok: false, unavailable: true, error: expect.stringMatching(/^On-page checks need DataForSEO; ahrefs/) });
    expect(paths).toEqual(["/v3/site-explorer/backlinks-stats", "/v3/site-explorer/domain-rating"]);
    expect(getAudit(r.auditId)).toBeDefined();
  });
});

describe("suggest_competitors with dataProvider: ahrefs and no DataForSEO", () => {
  it("uses Ahrefs overlap, skips the SERP source with a note, and reports units", async () => {
    writeFileSync(process.env.CLIENTS_FILE!, "clients:\n  example.com:\n    domain: example.com\n    dataProvider: ahrefs\n    niche: example widgets\n");
    fakeAhrefs();
    const r = await suggestCompetitors("example.com");
    expect(r.sources.organicOverlap).toEqual({ ok: true, rows: 2, provider: "ahrefs" });
    expect(r.sources.localSerp).toMatchObject({ searched: 0, skipped: expect.stringMatching(/^Live SERP checks need DataForSEO/) });
    expect(r.notes.some((n) => n.startsWith("Local SERP source skipped: Live SERP checks need DataForSEO"))).toBe(true);
    expect(r.units).toEqual({ ahrefs: 50 });
  });
});
