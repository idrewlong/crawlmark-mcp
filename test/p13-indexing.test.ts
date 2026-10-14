/**
 * Phase 13 A-5: Google indexing coverage. The pool order and rotation, the coverage mapping, the aggregation
 * (pure); the inspection runner within the daily budget and per-run cap, stopping on a quota error; the
 * Pacific-day quota; the index-coverage CLI; gsc_inspect_url / run_audit recording inspections with their
 * outputs unchanged. Search Console is a fake (googleapis mocked, with a request log) answering with
 * fixtures built from the documented response shapes. example.com/org/net only; no network.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

const fake = vi.hoisted(() => ({
  log: [] as string[],
  /** 1-based inspection number that answers 429 RESOURCE_EXHAUSTED (0: never). */
  quotaOn: 0,
  failOn: 0,
  inspections: 0,
  byUrl: {} as Record<string, unknown>,
  defaultResult: undefined as unknown,
  sitemaps: undefined as unknown,
  topPages: [] as string[],
  quotaMessage: "Quota exceeded for quota metric 'URL Inspection requests' and limit 'URL Inspection requests per day per site'",
  /** HTTP status thrown on the failOn inspection. */
  failStatus: 500,
}));

vi.mock("googleapis", () => ({
  google: {
    searchconsole: () => ({
      urlInspection: {
        index: {
          inspect: async ({ requestBody }: { requestBody: { inspectionUrl: string; siteUrl: string } }) => {
            fake.inspections++;
            fake.log.push(`inspect ${requestBody.siteUrl} ${requestBody.inspectionUrl}`);
            if (fake.quotaOn && fake.inspections === fake.quotaOn) {
              throw Object.assign(new Error(fake.quotaMessage), { code: 429, response: { status: 429, data: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: fake.quotaMessage } } } });
            }
            if (fake.failOn && fake.inspections >= fake.failOn) throw Object.assign(new Error(fake.failStatus === 403 ? "The caller does not have permission" : "Backend Error"), { code: fake.failStatus, response: { status: fake.failStatus, data: { error: { code: fake.failStatus, message: "error" } } } });
            return { data: fake.byUrl[requestBody.inspectionUrl] ?? fake.defaultResult };
          },
        },
      },
      sitemaps: {
        list: async ({ siteUrl }: { siteUrl: string }) => {
          fake.log.push(`sitemaps ${siteUrl}`);
          return { data: fake.sitemaps };
        },
      },
      searchanalytics: {
        query: async ({ siteUrl }: { siteUrl: string }) => {
          fake.log.push(`query ${siteUrl}`);
          return { data: { rows: fake.topPages.map((p, i) => ({ keys: [p], clicks: 10, impressions: 1000 - i, ctr: 0.01, position: 5 })) } };
        },
      },
    }),
  },
}));
vi.mock("../src/providers/google.js", () => ({
  googleAuth: () => ({}),
  googleAuthIdentity: () => "sa:test@example.com",
  googleConfigured: () => true,
  assertGoogleConfigured: () => {},
  googleAuthStatus: () => ({ mode: "service_account", auto: false, configured: true, email: "test@example.com" }),
}));

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/google/p13/${name}`, import.meta.url), "utf8"));
const INDEXED = fixture("url-inspection-indexed.json");
const NOT_INDEXED = fixture("url-inspection-not-indexed.json");
fake.defaultResult = INDEXED;
fake.sitemaps = fixture("sitemaps-list.json");

const { aggregateInspections, coverageIssue, inspectionRawIssues, inspectionTrend, isoWeek, planPool, seededOrder } = await import("../src/analysis/indexing.js");
const { inspectIndexCoverage, indexCoverage, loadIndexingDeps } = await import("../src/reports/indexing.js");
const { latestInspections, quotaFor, pacificDay, saveInspection } = await import("../src/lib/inspections.js");
const { gscInspectUrl } = await import("../src/providers/gsc.js");
const { indexCoverageCommand } = await import("../src/index-coverage-cli.js");
const { db } = await import("../src/lib/store.js");

const E = "https://example.com";
const NOW = Date.parse("2026-10-13T12:00:00Z");
const DAY = 86_400_000;

beforeEach(() => {
  fake.log.length = 0;
  fake.quotaOn = 0;
  fake.failOn = 0;
  fake.inspections = 0;
  fake.byUrl = {};
  fake.topPages = [];
  fake.quotaMessage = "Quota exceeded for quota metric 'URL Inspection requests' and limit 'URL Inspection requests per day per site'";
  fake.failStatus = 500;
});

const client = (slug: string, property: string, keyPages: string[] = [`${E}/`, `${E}/services`]): Client =>
  ({ slug, domain: "example.com", name: "Example Co", gscProperty: property, keyPages, aliases: [] }) as unknown as Client;

async function deps(o: { sitemapUrls?: string[]; now?: () => number; budget?: number } = {}) {
  const real = await loadIndexingDeps();
  return { ...real, now: o.now ?? (() => NOW), sleep: async () => undefined, sitemapUrls: async () => o.sitemapUrls ?? [], ...(o.budget ? { budget: o.budget } : {}) };
}

describe("pool order (D14)", () => {
  it("stale key pages, then top Search Console pages, then never-inspected sitemap URLs (seeded by client + week), then the oldest", () => {
    const last = new Map<string, number>([
      [`${E}/services`, NOW - 2 * DAY], // fresh key page: skipped
      [`${E}`, NOW - 30 * DAY], // stale key page (the homepage, normalised)
      [`${E}/old-a`, NOW - 40 * DAY],
      [`${E}/old-b`, NOW - 20 * DAY],
      [`${E}/top-fresh`, NOW - DAY],
    ]);
    const sitemap = [`${E}/s1`, `${E}/s2`, `${E}/s3`, `${E}/old-b`];
    const seed = `example.com:${isoWeek(NOW)}`;
    const pool = planPool({ property: "sc-domain:example.com", keyPages: [`${E}/`, `${E}/services`], gscTop: [`${E}/top-fresh`, `${E}/top-new`], sitemapUrls: sitemap, lastInspected: last, now: NOW, staleDays: 7, seed, max: 50 });
    const expectedSitemap = seededOrder([`${E}/s1`, `${E}/s2`, `${E}/s3`], seed);
    expect(pool.map((p) => [p.url, p.group])).toEqual([
      [E, "key"],
      [`${E}/top-new`, "gsc_top"],
      ...expectedSitemap.map((u) => [u, "sitemap"]),
      [`${E}/old-a`, "oldest"],
      [`${E}/old-b`, "oldest"],
    ]);
    expect(pool.find((p) => p.url === `${E}/old-b`)?.inSitemap).toBe(true);
    // Deterministic within a week, different the next.
    expect(seededOrder(sitemap, seed)).toEqual(seededOrder(sitemap, seed));
    const nextWeek = `example.com:${isoWeek(NOW + 7 * DAY)}`;
    expect(nextWeek).not.toBe(seed);
    // The cap cuts the list in order.
    expect(planPool({ property: "sc-domain:example.com", keyPages: [`${E}/`], gscTop: [], sitemapUrls: sitemap, lastInspected: new Map(), now: NOW, staleDays: 7, seed, max: 2 }).map((p) => p.group)).toEqual(["key", "sitemap"]);
  });

  it("isoWeek follows ISO 8601 (Monday weeks, week 1 has the first Thursday)", () => {
    expect(isoWeek(Date.parse("2026-10-13T12:00:00Z"))).toBe("2026-W42");
    expect(isoWeek(Date.parse("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    expect(isoWeek(Date.parse("2026-01-01T12:00:00Z"))).toBe("2026-W01");
  });
});

describe("coverage mapping (spec 13.5.4)", () => {
  const base = { verdict: "NEUTRAL", coverageState: null, pageFetchState: "SUCCESSFUL", robotsTxtState: "ALLOWED", indexingState: "INDEXING_ALLOWED" };
  const plain = { keyPage: false, inSitemap: false };
  const important = { keyPage: false, inSitemap: true };
  it.each([
    [{ pageFetchState: "SERVER_ERROR" }, plain, "high", "Server error (5xx)"],
    [{ pageFetchState: "NOT_FOUND" }, important, "high", "Not found (404)"],
    [{ pageFetchState: "NOT_FOUND" }, plain, "medium", "Not found (404)"],
    [{ pageFetchState: "ACCESS_FORBIDDEN" }, plain, "medium", "Access forbidden (403)"],
    [{ pageFetchState: "SOFT_404" }, plain, "high", "Soft 404"],
    [{ pageFetchState: "REDIRECT_ERROR" }, plain, "medium", "Redirect error"],
    [{ robotsTxtState: "DISALLOWED" }, { keyPage: true, inSitemap: false }, "high", "Blocked by robots.txt"],
    [{ robotsTxtState: "DISALLOWED" }, plain, "low", "Blocked by robots.txt"],
    [{ indexingState: "BLOCKED_BY_META_TAG" }, important, "high", "Excluded by noindex"],
    [{ indexingState: "BLOCKED_BY_HTTP_HEADER" }, plain, "low", "Excluded by noindex"],
    [{ coverageState: "Crawled - currently not indexed" }, plain, "medium", "Crawled - currently not indexed"],
    [{ coverageState: "Discovered - currently not indexed" }, plain, "medium", "Discovered - currently not indexed"],
    [{ coverageState: "Duplicate, Google chose different canonical than user" }, plain, "medium", "Duplicate, Google chose different canonical than user"],
    [{ coverageState: "Page with redirect" }, plain, "low", "Page with redirect"],
    [{ coverageState: "Page with redirect" }, important, "medium", "Page with redirect"],
    [{ coverageState: "URL is unknown to Google" }, plain, "low", "URL is unknown to Google"],
    [{ coverageState: "URL is unknown to Google" }, { keyPage: true, inSitemap: false }, "medium", "URL is unknown to Google"],
    [{ coverageState: "Something new" }, plain, "medium", "Not indexed: Something new"],
  ] as const)("%j %j → %s", (over, ctx, severity, label) => {
    expect(coverageIssue({ ...base, ...over }, ctx)).toEqual({ severity, label });
  });
  it("an indexed page has no issue", () => {
    expect(coverageIssue({ ...base, verdict: "PASS", coverageState: "Submitted and indexed" }, plain)).toBeNull();
  });
});

describe("inspection runner", () => {
  it("inspects within the per-run cap, stores each result with its origin and counts the Pacific-day quota; dry run inspects nothing", async () => {
    const c = client("ix-run.example.com", "sc-domain:example.com");
    fake.topPages = [`${E}/top-1`, `${E}/top-2`];
    fake.byUrl[`${E}/top-1`] = NOT_INDEXED;
    const d = await deps({ sitemapUrls: [`${E}/s1`, `${E}/s2`, `${E}/s3`] });
    const dry = await inspectIndexCoverage(c, { maxInspections: 5, dryRun: true }, d);
    expect(dry).toMatchObject({ planned: 5, inspected: 0, stoppedBy: null, byOrigin: { key: 2, gsc_top: 2, sitemap: 1, oldest: 0 } });
    expect(fake.log.filter((l) => l.startsWith("inspect"))).toEqual([]);

    const r = await inspectIndexCoverage(c, { maxInspections: 5 }, d);
    expect(r).toMatchObject({ property: "sc-domain:example.com", planned: 5, inspected: 5, failed: 0, stoppedBy: null, quota: { day: "2026-10-13", used: 5, budget: 1000, exhausted: false } });
    expect(fake.log.filter((l) => l.startsWith("inspect"))).toHaveLength(5);
    const rows = latestInspections(c.slug);
    expect(rows).toHaveLength(5);
    expect(rows.find((x) => x.url === `${E}/top-1`)).toMatchObject({ origin: "gsc_top", verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed", googleCanonical: `${E}/plans`, userCanonical: `${E}/pricing`, crawledAs: "MOBILE" });
    expect(rows.find((x) => x.url === `${E}/services`)?.origin).toBe("key");
    expect(quotaFor("sc-domain:example.com", "2026-10-13").used).toBe(5);
  });

  it("stays within the day's budget and says so", async () => {
    const c = client("ix-budget.example.com", "https://example.com/budget/", []);
    const d = await deps({ sitemapUrls: [`${E}/budget/a`, `${E}/budget/b`, `${E}/budget/c`, `${E}/budget/d`], budget: 3 });
    const r = await inspectIndexCoverage(c, { maxInspections: 10 }, d);
    expect(r).toMatchObject({ planned: 3, inspected: 3, stoppedBy: "budget", quota: { used: 3, budget: 3 } });
    const again = await inspectIndexCoverage(c, { maxInspections: 10 }, d);
    expect(again).toMatchObject({ planned: 0, inspected: 0, stoppedBy: "budget" });
  });

  it("Google text is stored without control or bidi characters", async () => {
    const c = client("ix-hostile.example.com", "https://example.com/", [`${E}/x`]);
    fake.byUrl[`${E}/x`] = { inspectionResult: { indexStatusResult: { ...NOT_INDEXED.inspectionResult.indexStatusResult, coverageState: "Crawled \u202e- currently\u0000 not indexed\u2066 <script>" } } };
    await inspectIndexCoverage(c, { maxInspections: 1 }, await deps());
    const [row] = latestInspections(c.slug);
    expect(row!.coverageState).toBe("Crawled - currently not indexed <script>");
  });
});

describe("index-coverage CLI (Done-when)", () => {
  async function cli(flags: Record<string, unknown>, c: Client, d?: Awaited<ReturnType<typeof deps>>) {
    const lines: string[] = [];
    const errs: string[] = [];
    const prefix = c.gscProperty?.startsWith("https://") ? c.gscProperty.replace(/\/$/, "") : E;
    const dd = d ?? (await deps({ sitemapUrls: Array.from({ length: 20 }, (_, i) => `${prefix}/page-${i}`) }));
    const code = await indexCoverageCommand(
      [],
      { all: false, "dry-run": false, ...flags } as never,
      { out: (l) => void lines.push(l), warn: (l) => void errs.push(l), usage: (p) => (errs.push(p), 1) },
      { loadClients: async () => ({ clients: [c], skipped: [] }), run: (cl, o) => inspectIndexCoverage(cl, o, dd) },
    );
    return { code, json: JSON.parse(lines.join("\n") || "{}"), errs };
  }

  it("--max 5 inspects exactly 5 URLs, stores 5 rows, adds 5 to the day's quota and exits 0; --dry-run inspects nothing", async () => {
    const c = client("ix-cli.example.com", "https://example.com/cli/");
    const before = quotaFor("https://example.com/cli/", pacificDay(NOW)).used;
    const dry = await cli({ client: c.slug, max: "5", "dry-run": true }, c);
    expect(dry.code).toBe(0);
    expect(fake.log.filter((l) => l.startsWith("inspect"))).toEqual([]);
    expect(dry.json).toMatchObject({ command: "index-coverage", dryRun: true, results: [{ client: c.slug, planned: 5, inspected: 0 }] });
    const r = await cli({ client: c.slug, max: "5" }, c);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ command: "index-coverage", dryRun: false, results: [{ client: c.slug, property: "https://example.com/cli/", inspected: 5, stoppedBy: null, quota: { used: before + 5 } }], skipped: [], errors: [], exitCode: 0 });
    expect(fake.log.filter((l) => l.startsWith("inspect"))).toHaveLength(5);
    expect((db.prepare("SELECT COUNT(*) AS n FROM url_inspections WHERE client = ?").get(c.slug) as { n: number }).n).toBe(5);
    expect(quotaFor("https://example.com/cli/", pacificDay(NOW)).used).toBe(before + 5);
    // Only URLs inside the property were inspected (the key pages at the site root weren't).
    expect(fake.log.filter((l) => l.startsWith("inspect")).every((l) => l.includes(" https://example.com/cli/page-"))).toBe(true);
  });

  it("a 429 RESOURCE_EXHAUSTED on the 3rd inspection stops the run (quota, exit 2), and the next run the same Pacific day inspects nothing", async () => {
    const c = client("ix-quota.example.com", "https://example.com/quota/");
    fake.quotaOn = 3;
    const r = await cli({ client: c.slug, max: "10" }, c);
    expect(r.code).toBe(2);
    // The reserved 3rd call counts too: Google may have counted it.
    expect(r.json.results[0]).toMatchObject({ inspected: 2, stoppedBy: "quota", quota: { used: 3, exhausted: true } });
    expect(fake.log.filter((l) => l.startsWith("inspect"))).toHaveLength(3);
    fake.log.length = 0;
    // Later the same Pacific day (11 hours on, still 13 Oct in Los Angeles).
    const later = await cli({ client: c.slug, max: "10" }, c, await deps({ now: () => NOW + 11 * 3_600_000 }));
    expect(later.json.results[0]).toMatchObject({ planned: 0, inspected: 0, stoppedBy: "quota" });
    expect(fake.log.filter((l) => l.startsWith("inspect"))).toEqual([]);
    // Still "the quota ran out before the run finished" for a cron wrapper.
    expect(later.code).toBe(2);
    // The next Pacific day starts fresh.
    fake.quotaOn = 0;
    const nextDay = await cli({ client: c.slug, max: "2" }, c, await deps({ now: () => NOW + 20 * 3_600_000, sitemapUrls: [`${E}/quota/next-1`, `${E}/quota/next-2`, `${E}/quota/next-3`] }));
    expect(nextDay.json.results[0]).toMatchObject({ inspected: 2, quota: { day: "2026-10-14", used: 2, exhausted: false } });
  });

  it("usage errors exit 1; clients without a Search Console property are skipped", async () => {
    const c = client("ix-usage.example.com", "sc-domain:example.com");
    for (const f of [{}, { client: c.slug, max: "0" }, { client: c.slug, max: "501" }, { client: c.slug, "stale-days": "x" }]) expect((await cli(f, c)).code, JSON.stringify(f)).toBe(1);
    const none = await cli({ client: "x" }, { ...c, gscProperty: undefined } as Client);
    expect(none.json.skipped).toEqual([{ client: c.slug, reason: "no Search Console property" }]);
    expect(none.code).toBe(0);
  });
});

describe("aggregation and the index_coverage result", () => {
  it("uses the latest inspection per URL; counts indexed share, coverage states, the worst URLs, canonical mismatches, sitemaps and the trend", async () => {
    const c = client("ix-agg.example.com", "sc-domain:agg.example.com", [`${E}/pricing`]);
    const save = (url: string, at: number, f: typeof INDEXED, inSitemap = true) => saveInspection({ ...f.inspectionResult.indexStatusResult, url, client: c.slug, property: c.gscProperty!, origin: "sitemap", inspectedAt: at, inSitemap });
    save(`${E}/`, NOW - 40 * DAY, INDEXED);
    save(`${E}/pricing`, NOW - 40 * DAY, INDEXED);
    save(`${E}/pricing`, NOW - DAY, NOT_INDEXED);
    save(`${E}/blog`, NOW - 2 * DAY, INDEXED);
    const d = await deps();
    const r = await indexCoverage(c, { trendMonths: 3, limit: 10 }, d);
    expect(r.sample).toMatchObject({ inspected: 3, keyPages: 1, sitemapUrls: 3, sitemapUrlsKnown: 130, oldestDays: 40 });
    expect(r.indexed).toEqual({ count: 2, share: 66.7 });
    expect(r.byCoverage).toEqual([
      { state: "Submitted and indexed", count: 2, severity: null },
      { state: "Crawled - currently not indexed", count: 1, severity: "medium" },
    ]);
    expect(r.worst).toEqual([expect.objectContaining({ url: `${E}/pricing`, severity: "medium", keyPage: true, inSitemap: true, googleCanonical: `${E}/plans` })]);
    expect(r.canonicalMismatches).toBe(1);
    expect(r.sitemaps).toEqual([
      { path: `${E}/sitemap.xml`, lastDownloaded: "2026-10-12T02:00:00Z", isPending: false, errors: 0, warnings: 1, submitted: 118 },
      { path: `${E}/news-sitemap.xml`, lastDownloaded: "2026-10-10T02:00:00Z", isPending: false, errors: 2, warnings: 0, submitted: 12 },
    ]);
    expect(r.trend).toEqual([
      { month: "2026-09", inspected: 2, indexedShare: 100 },
      { month: "2026-10", inspected: 2, indexedShare: 50 },
    ]);
    expect(r.quota).toMatchObject({ budget: 1000, exhausted: false });
    // Technical-issue rows from the same latest results.
    const rows = inspectionRawIssues(latestInspections(c.slug), c.keyPages);
    expect(rows.map((x) => [x.rule, x.url, x.severity])).toEqual([
      ["not-indexed", `${E}/pricing`, "medium"],
      ["canonical-mismatch", `${E}/pricing`, "medium"],
    ]);
    expect(aggregateInspections([], { keyPages: [], limit: 5, now: NOW }).indexed).toEqual({ count: 0, share: null });
    expect(inspectionTrend([], 0, NOW)).toEqual([]);
  });
});

describe("gsc_inspect_url and run_audit record inspections (outputs unchanged)", () => {
  it("gsc_inspect_url's keys are the same as before; the call is stored (origin manual) and counted; a cached repeat records nothing", async () => {
    const c = client("ix-manual.example.com", "sc-domain:manual.example.com");
    const r = await gscInspectUrl(c, `${E}/contact`, { refresh: true });
    expect(Object.keys(r).sort()).toEqual(["coverageState", "googleCanonical", "lastCrawlTime", "mobileVerdict", "richResults", "robotsTxtState", "url", "userCanonical", "verdict"]);
    expect(r).toMatchObject({ verdict: "PASS", coverageState: "Submitted and indexed", richResults: ["Breadcrumbs"] });
    expect(latestInspections(c.slug)).toEqual([expect.objectContaining({ url: `${E}/contact`, origin: "manual", indexingState: "INDEXING_ALLOWED", pageFetchState: "SUCCESSFUL" })]);
    await gscInspectUrl(c, `${E}/contact`);
    expect(quotaFor("sc-domain:manual.example.com", pacificDay()).used).toBe(1);
    // run_audit passes origin "audit".
    await gscInspectUrl(c, `${E}/about`, { refresh: true, origin: "audit" });
    expect(latestInspections(c.slug).find((x) => x.url === `${E}/about`)?.origin).toBe("audit");
  });

  it("a quota error marks the property's day used up", async () => {
    const c = client("ix-manual-quota.example.com", "sc-domain:quota2.example.com");
    fake.quotaOn = 1;
    await expect(gscInspectUrl(c, `${E}/x`, { refresh: true })).rejects.toThrow(/Quota exceeded/);
    expect(quotaFor("sc-domain:quota2.example.com", pacificDay()).exhausted).toBe(true);
  });
});

describe("indexing in reports and technical issues", () => {
  it("the indexing_issues section tops up with its own cap, and is unavailable with no stored results", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fixtureReport } = await import("./fixtures/reports/report.js");
    const { fakeDeps } = await import("./fixtures/reports/deps.js");
    const { INDEXING, EMPTY_INDEXING } = await import("./fixtures/reports/p13-data.js");
    const home = mkdtempSync(join(tmpdir(), "crawlmark-p13-ix-"));
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "report-templates.yaml"), "version: 1\ntemplates:\n  t:\n    title: T\n    sections:\n      - { id: indexing, type: indexing_issues, maxInspections: 0, limit: 5 }\n");
    const calls: unknown[] = [];
    const ok = await fixtureReport({ homeDir: home, template: "t", include: [] }, fakeDeps({ indexingSection: async (_c, o) => (calls.push(o), INDEXING) }));
    expect(ok.sections[0]).toMatchObject({ status: "ok" });
    expect(calls).toEqual([{ maxInspections: 0, staleDays: 7, limit: 5, trendMonths: 6 }]);
    const none = await fixtureReport({ homeDir: home, template: "t", include: [] }, fakeDeps({ indexingSection: async () => EMPTY_INDEXING }));
    expect(none.sections[0]).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/^no URL Inspection results for example.com yet/) });
  });

  it("stored inspections feed technical_issues as the gsc_inspection source", async () => {
    const { loadTechIssuesDeps, technicalIssues } = await import("../src/reports/technical-issues.js");
    const c = client("ix-ti.example.com", "sc-domain:ti.example.com", [`${E}/pricing`]);
    saveInspection({ ...NOT_INDEXED.inspectionResult.indexStatusResult, url: `${E}/pricing`, client: c.slug, property: c.gscProperty!, origin: "key", inspectedAt: NOW, inSitemap: true });
    const d = { ...(await loadTechIssuesDeps()), now: () => NOW, latestAudit: () => undefined, latestCrawl: () => undefined, latestCrawlTask: () => undefined };
    const r = await technicalIssues(c, { baseBeforeMs: 0, sources: ["gsc_inspection"], save: false }, d);
    expect(r.sources).toEqual([expect.objectContaining({ source: "gsc_inspection", ranAt: new Date(NOW).toISOString() })]);
    expect(r.issues.map((i) => [i.key, i.url, i.sources[0]!.nativeSeverity])).toEqual([
      ["canonical-mismatch", `${E}/pricing`, "Crawled - currently not indexed"],
      ["not-indexed", `${E}/pricing`, "Crawled - currently not indexed"],
    ]);
  });
});

const { reserveQuota, lastInspectedAt: lastAt } = await import("../src/lib/inspections.js");
const { inProperty } = await import("../src/analysis/indexing.js");
const { validateTemplateText } = await import("../src/reports/templates/schema.js");
const { collectSitemaps } = await import("../src/reports/site-hygiene.js");

describe("fix round: reservations, property scope, failures, error kinds (R-2, SEC-1..4)", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it("reserveQuota is all-or-nothing at the budget, and refuses an exhausted day", () => {
    const p = "https://example.com/reserve/";
    const got = Array.from({ length: 7 }, () => reserveQuota(p, "2026-10-13", 5));
    expect(got).toEqual([true, true, true, true, true, false, false]);
    expect(quotaFor(p, "2026-10-13").used).toBe(5);
    markQuotaExhaustedFor(p, "2026-10-14");
    expect(reserveQuota(p, "2026-10-14", 5)).toBe(false);
  });

  it("three concurrent runs of 50 against a budget of 50 inspect at most 50 URLs, none twice", async () => {
    const c = client("ix-concurrent.example.com", "https://example.com/conc/", []);
    const urls = Array.from({ length: 200 }, (_, i) => `${E}/conc/p-${i}`);
    const d = { ...(await deps({ sitemapUrls: urls, budget: 50 })), sleep: async (_ms: number) => tick() };
    const runs = await Promise.all([1, 2, 3].map(() => inspectIndexCoverage(c, { maxInspections: 50 }, d)));
    const inspectedUrls = fake.log.filter((l) => l.startsWith("inspect https://example.com/conc/")).map((l) => l.split(" ")[2]);
    expect(inspectedUrls.length).toBeLessThanOrEqual(50);
    expect(new Set(inspectedUrls).size).toBe(inspectedUrls.length);
    expect(runs.reduce((a, r) => a + r.inspected, 0)).toBe(inspectedUrls.length);
    expect(quotaFor("https://example.com/conc/", pacificDay(NOW)).used).toBe(50);
  });

  it("a run that crosses Pacific midnight counts each call against its own day", async () => {
    const c = client("ix-midnight.example.com", "https://example.com/midnight/", []);
    // 23:59:58 in Los Angeles on 13 Oct (PDT, UTC-7) = 06:59:58Z on the 14th; each call moves the clock a second on.
    let t = Date.parse("2026-10-14T06:59:58Z");
    const d = { ...(await deps({ sitemapUrls: [`${E}/midnight/a`, `${E}/midnight/b`, `${E}/midnight/c`, `${E}/midnight/d`] })), now: () => (t += 1000) };
    const r = await inspectIndexCoverage(c, { maxInspections: 4 }, d);
    expect(r.inspected).toBe(4);
    const p = "https://example.com/midnight/";
    expect(quotaFor(p, "2026-10-13").used + quotaFor(p, "2026-10-14").used).toBe(4);
    expect(quotaFor(p, "2026-10-14").used).toBeGreaterThan(0);
  });

  it("only URLs inside the property are planned (sc-domain covers subdomains; a URL prefix needs scheme, host and path)", () => {
    expect(inProperty("https://example.com/a", "sc-domain:example.com")).toBe(true);
    expect(inProperty("https://shop.example.com/a", "sc-domain:example.com")).toBe(true);
    expect(inProperty("https://example.com.evil.example.net/a", "sc-domain:example.com")).toBe(false);
    expect(inProperty("https://notexample.com/", "sc-domain:example.com")).toBe(false);
    expect(inProperty("https://example.com/blog/x", "https://example.com/blog/")).toBe(true);
    expect(inProperty("https://example.com/blog", "https://example.com/blog/")).toBe(true);
    expect(inProperty("https://example.com/blogger", "https://example.com/blog/")).toBe(false);
    expect(inProperty("http://example.com/blog/x", "https://example.com/blog/")).toBe(false);
    expect(inProperty("https://www.example.com/blog/x", "https://example.com/blog/")).toBe(false);
    const pool = planPool({ property: "https://example.com/", keyPages: [`${E}/`, "https://example.net/"], gscTop: ["https://www.example.com/x"], sitemapUrls: [`${E}/s`, "https://example.org/s"], lastInspected: new Map(), now: NOW, staleDays: 7, seed: "s", max: 10 });
    expect(pool.map((p) => p.url)).toEqual([E, `${E}/s`]);
  });

  it("failed inspections are recorded so they rotate, never read as results; 5 in a row stop the run; 403 stops at once", async () => {
    const c = client("ix-fail.example.com", "https://example.com/fail/", []);
    const urls = Array.from({ length: 10 }, (_, i) => `${E}/fail/p-${i}`);
    fake.failOn = 1;
    const r = await inspectIndexCoverage(c, { maxInspections: 10 }, await deps({ sitemapUrls: urls }));
    expect(r).toMatchObject({ inspected: 0, failed: 5, stoppedBy: "errors" });
    expect(latestInspections(c.slug)).toEqual([]);
    expect(lastAt(c.slug).size).toBe(5);
    expect(quotaFor("https://example.com/fail/", pacificDay(NOW)).used).toBe(5);
    // The failed URLs rotate behind the never-inspected ones.
    fake.failOn = 0;
    fake.inspections = 0;
    fake.log.length = 0;
    const next = await inspectIndexCoverage(c, { maxInspections: 3, staleDays: 7 }, await deps({ sitemapUrls: urls, now: () => NOW + 8 * DAY }));
    expect(next.byOrigin).toMatchObject({ sitemap: 3, oldest: 0 });

    const denied = client("ix-denied.example.com", "https://example.com/denied/", []);
    fake.failOn = 1;
    fake.failStatus = 403;
    fake.log.length = 0;
    const d = await inspectIndexCoverage(denied, { maxInspections: 10 }, await deps({ sitemapUrls: [`${E}/denied/a`, `${E}/denied/b`] }));
    expect(d).toMatchObject({ inspected: 0, failed: 1, stoppedBy: "errors" });
    expect(fake.log.filter((l) => l.startsWith("inspect"))).toHaveLength(1);
  });

  it("a 429 that isn't the daily limit stops the run without marking the day used up (SEC-3)", async () => {
    const c = client("ix-rate.example.com", "https://example.com/rate/", []);
    fake.quotaOn = 2;
    fake.quotaMessage = "Quota exceeded for quota metric 'URL Inspection requests' and limit 'URL Inspection requests per minute per site'";
    const r = await inspectIndexCoverage(c, { maxInspections: 5 }, await deps({ sitemapUrls: [`${E}/rate/a`, `${E}/rate/b`, `${E}/rate/c`] }));
    expect(r).toMatchObject({ inspected: 1, stoppedBy: "quota", quota: { exhausted: false } });
  });

  it("gsc_inspect_url refuses a live call once the property's day is used up, and reserves before calling (SEC-4)", async () => {
    const c = client("ix-sec4.example.com", "sc-domain:sec4.example.com");
    markQuotaExhaustedFor("sc-domain:sec4.example.com", pacificDay());
    await expect(gscInspectUrl(c, "https://sec4.example.com/a", { refresh: true })).rejects.toThrow(/URL Inspection quota for this property is used up today/);
    expect(fake.log.filter((l) => l.startsWith("inspect"))).toEqual([]);
    const ok = client("ix-sec4b.example.com", "sc-domain:sec4b.example.com");
    await gscInspectUrl(ok, "https://sec4b.example.com/a", { refresh: true });
    expect(quotaFor("sc-domain:sec4b.example.com", pacificDay()).used).toBe(1);
  });

  it("a URL keeps its stored in-sitemap flag when this run couldn't read the sitemaps", async () => {
    const c = client("ix-insitemap.example.com", "https://example.com/ins/", [`${E}/ins/key`]);
    saveInspection({ ...INDEXED.inspectionResult.indexStatusResult, url: `${E}/ins/key`, client: c.slug, property: c.gscProperty!, origin: "key", inspectedAt: NOW - 30 * DAY, inSitemap: true });
    const d = { ...(await deps()), sitemapUrls: async () => { throw new Error("sitemap down"); } };
    await inspectIndexCoverage(c, { maxInspections: 1 }, d);
    expect(latestInspections(c.slug)[0]).toMatchObject({ url: `${E}/ins/key`, inSitemap: true });
  });

  it("a template may have only one indexing_issues section", () => {
    const r = validateTemplateText("version: 1\ntemplates:\n  t:\n    title: T\n    sections:\n      - { id: a, type: indexing_issues }\n      - { id: b, type: indexing_issues }\n", { today: new Date("2026-10-13T12:00:00Z") });
    expect(r.errors).toEqual([{ path: "templates.t.sections[1].type", message: "a template can have only one indexing_issues section (also sections[0])" }]);
  });

  it("sitemap <loc> entries on other hosts are left out of the sitemap URL set", async () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${E}/a</loc></url><url><loc>https://example.net/b</loc></url></urlset>`;
    const sm = await collectSitemaps({ roots: [`${E}/sitemap.xml`], siteOrigin: E, get: async (u) => ({ status: 200, finalUrl: u, redirects: 0, contentType: "application/xml", xRobotsTag: null, truncated: false, html: xml }) as never, onClientHost: (u) => new URL(u).hostname === "example.com", notes: [] });
    expect([...sm.urls]).toEqual([`${E}/a`]);
  });
});

function markQuotaExhaustedFor(property: string, day: string) {
  db.prepare("INSERT INTO gsc_inspection_quota (property, day, exhausted) VALUES (?, ?, 1) ON CONFLICT (property, day) DO UPDATE SET exhausted = 1").run(property, day);
}
