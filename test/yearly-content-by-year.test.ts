/**
 * Release 0.5.0 Y2.3: the content_by_year section (C4) from a saved crawl and Search Console page clicks. Fake deps and a
 * hand-built YearlyCtx; no network. example.com only.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CrawlPage, PublishedDate } from "../src/analysis/crawl.js";
import type { GscRow } from "../src/providers/gsc.js";
import type { StoredCrawl } from "../src/lib/crawls.js";
import { defaultPageGroups } from "../src/lib/page-groups.js";
import { contentByYear } from "../src/reports/yearly/content-by-year.js";
import type { YearlyCtx } from "../src/reports/yearly/context.js";
import { resolvePeriod } from "../src/reports/templates/period.js";
import { runTemplate, SectionUnavailableError } from "../src/reports/templates/run.js";
import type { Client } from "../src/lib/clients.js";
import { client as baseClient, fakeDeps } from "./fixtures/reports/deps.js";

const today = new Date("2026-10-13T12:00:00Z");
const E = "https://example.com";
const client = { ...baseClient, pageGroups: defaultPageGroups() } as unknown as Client;

const page = (path: string, published: PublishedDate | null | undefined, o: Partial<CrawlPage> = {}): CrawlPage =>
  ({
    url: `${E}${path}`, depth: 1, status: 200, finalUrl: `${E}${path}`, finalStatus: 200, redirectChain: [], contentType: "text/html", title: "T", description: null, canonical: null,
    robots: null, noindex: false, h1Count: 1, inlinks: 1, outlinks: 1, firstLinkedFrom: null, parsed: true, issues: [], ...(published !== undefined ? { published } : {}), ...o,
  }) as CrawlPage;
const j = (date: string): PublishedDate => ({ date, source: "jsonld" });
const m = (date: string): PublishedDate => ({ date, source: "meta" });
const u = (date: string): PublishedDate => ({ date, source: "url" });

const crawlOf = (pages: CrawlPage[], ranAt = Date.UTC(2026, 9, 10)): StoredCrawl => ({ id: "crawl_y2", client: "example.com", ranAt, settings: {}, summary: {}, exhaustive: true, pages });
const gsc = (rows: [string, number, number][]): GscRow[] => rows.map(([url, clicks, impressions]) => ({ keys: [url], clicks, impressions, ctr: 0, position: 5 }));

function ctxOf(opts: { crawl?: StoredCrawl; rows?: GscRow[]; today?: Date; client?: Client } = {}) {
  const calls: unknown[] = [];
  const t = opts.today ?? today;
  const deps = {
    ...fakeDeps(),
    latestLocalCrawl: () => opts.crawl,
    gscQuery: async (_c: unknown, o: unknown) => {
      calls.push(o);
      return opts.rows ?? [];
    },
  };
  const period = resolvePeriod({ range: "last_year" }, ["previous_year"], { year: "2025" }, t);
  const store = new Map<string, Promise<unknown>>();
  const notes: string[] = [];
  const ctx: YearlyCtx = {
    client: opts.client ?? client,
    deps: deps as never,
    today: t,
    period,
    gscPeriod: period,
    coverage: () => ({ complete: true, source: "google" }),
    once: (key, fn) => {
      if (!store.has(key)) store.set(key, fn());
      return store.get(key) as never;
    },
    totals: async () => {
      throw new Error("not used");
    },
    note: (n) => void notes.push(n),
  };
  return { ctx, calls, notes };
}
const spec = (o: Record<string, unknown> = {}) => ({ id: "content-years", type: "content_by_year" as const, ...o });
const rowOf = (d: Awaited<ReturnType<typeof contentByYear>>, year: string) => d.rows.find((r) => r.year === year);

describe("contentByYear", () => {
  const pages = [
    page("/blog/a", j("2025-03-01")),
    page("/blog/b", j("2025-08-09")),
    page("/blog/c", m("2024-02-02")),
    page("/services/x", u("2021")),
    page("/old", u("2019-05")),
    page("/undated", null),
    page("/lastmod-only", null),
  ];
  const rows = gsc([
    [`${E}/blog/a`, 100, 1000],
    [`${E}/blog/b`, 50, 500],
    [`${E}/blog/c`, 30, 300],
    [`${E}/services/x`, 10, 100],
    [`${E}/old`, 5, 50],
    [`${E}/undated`, 5, 50],
    [`${E}/not-in-the-crawl`, 999, 9999],
  ]);

  it("buckets pages by publish year, newest first, with Unknown last, clicks and shares", async () => {
    const { ctx, calls } = ctxOf({ crawl: crawlOf(pages), rows });
    const d = await contentByYear(spec(), ctx);
    expect(d.rows.map((r) => r.year)).toEqual(["2025", "2024", "2021", "2019", "Unknown"]);
    expect(rowOf(d, "2025")).toEqual({ year: "2025", pages: 2, clicks: 150, impressions: 1500, clicksShare: 75, clicksPerPage: 75 });
    expect(rowOf(d, "Unknown")).toMatchObject({ pages: 2, clicks: 5, impressions: 50, clicksPerPage: 2.5 });
    expect(d).toMatchObject({ crawlId: "crawl_y2", crawledAt: "2026-10-10T00:00:00.000Z", group: null, pagesConsidered: 7, staleDays: null });
    expect(d.sources).toEqual({ jsonld: 2, meta: 1, url: 2, none: 2 });
    // One page query for the current range; the Search Console rows join the crawled pages only.
    expect(calls).toEqual([{ startDate: "2025-01-01", endDate: "2025-12-31", dimensions: ["page"], rowLimit: 25_000 }]);
    expect(d.rows.reduce((a, r) => a + r.clicksShare, 0)).toBeCloseTo(100, 0);
  });

  it("folds older years into '<year> and earlier' with maxYears", async () => {
    const { ctx } = ctxOf({ crawl: crawlOf(pages), rows });
    const d = await contentByYear(spec({ maxYears: 3 }), ctx);
    expect(d.rows.map((r) => r.year)).toEqual(["2025", "2024", "2023 and earlier", "Unknown"]);
    expect(rowOf(d, "2023 and earlier")).toMatchObject({ pages: 2, clicks: 15 });
    // Four distinct years and maxYears 4 (or more): nothing to fold.
    for (const maxYears of [4, 5]) {
      const fits = await contentByYear(spec({ maxYears }), ctxOf({ crawl: crawlOf(pages), rows }).ctx);
      expect(fits.rows.map((r) => r.year)).toEqual(["2025", "2024", "2021", "2019", "Unknown"]);
    }
  });

  it("leaves pages before minYear out of the rows but counts them as considered", async () => {
    const { ctx } = ctxOf({ crawl: crawlOf(pages), rows });
    const d = await contentByYear(spec({ minYear: 2022 }), ctx);
    expect(d.rows.map((r) => r.year)).toEqual(["2025", "2024", "Unknown"]);
    expect(d.pagesConsidered).toBe(7);
    expect(d.sources.url).toBe(2);
    expect(d.rows.reduce((a, r) => a + r.clicksShare, 0)).toBeCloseTo(100, 0);
  });

  it("joins clicks across a trailing slash, www, scheme and case differences", async () => {
    const crawl = crawlOf([page("/blog/a/", j("2025-03-01")), page("/blog/b", j("2025-03-01"))]);
    const r = gsc([
      ["https://www.example.com/blog/a", 10, 100],
      ["http://EXAMPLE.com/blog/b/", 20, 200],
    ]);
    const d = await contentByYear(spec(), ctxOf({ crawl, rows: r }).ctx);
    expect(d.rows).toEqual([{ year: "2025", pages: 2, clicks: 30, impressions: 300, clicksShare: 100, clicksPerPage: 15 }]);
  });

  it("counts only parsed 200 pages, once each", async () => {
    const crawl = crawlOf([
      page("/a", j("2025-01-01")),
      page("/a/", j("2025-01-01")),
      page("/gone", undefined, { status: 404, finalStatus: 404, parsed: true }),
      page("/moved", undefined, { status: 301, parsed: false }),
      page("/skipped", undefined, { status: null, parsed: false, skipped: "robots" }),
      page("/sitemap-only", j("2024-01-01"), { fromSitemap: true, depth: null }),
    ]);
    const d = await contentByYear(spec(), ctxOf({ crawl, rows: [] }).ctx);
    expect(d.pagesConsidered).toBe(2);
    expect(d.rows.map((r) => [r.year, r.pages])).toEqual([["2025", 1], ["2024", 1]]);
  });

  it("filters by page group through the client's groups", async () => {
    const { ctx } = ctxOf({ crawl: crawlOf(pages), rows });
    const blog = await contentByYear(spec({ group: "Blog" }), ctx);
    expect(blog.group).toBe("Blog");
    expect(blog.pagesConsidered).toBe(3);
    expect(blog.rows.map((r) => r.year)).toEqual(["2025", "2024"]);
    const lower = await contentByYear(spec({ group: "blog" }), ctxOf({ crawl: crawlOf(pages), rows }).ctx);
    expect(lower.pagesConsidered).toBe(3);
    const other = await contentByYear(spec({ group: "Other" }), ctxOf({ crawl: crawlOf(pages), rows }).ctx);
    expect(other.pagesConsidered).toBe(3); // /old, /undated, /lastmod-only
    const custom = await contentByYear(spec({ group: "Docs" }), ctxOf({ crawl: crawlOf(pages), rows, client: { ...client, pageGroups: [{ name: "Docs", prefix: ["/blog/"] }] } as Client }).ctx);
    expect(custom.pagesConsidered).toBe(3);
  });

  it("says why it is unavailable: no crawl, and a crawl made before publish dates were collected", async () => {
    await expect(contentByYear(spec(), ctxOf({}).ctx)).rejects.toThrow(SectionUnavailableError);
    await expect(contentByYear(spec(), ctxOf({}).ctx)).rejects.toThrow(/^no saved local crawl for example\.com yet \(run .+ crawl, free\)$/);
    const old = crawlOf([page("/a", undefined), page("/b", undefined)]);
    await expect(contentByYear(spec(), ctxOf({ crawl: old }).ctx)).rejects.toThrow(/^the newest saved crawl was made before publish dates were collected; run .+ crawl again$/);
  });

  it("an old crawl with some pages keyed is still read (a page with published: null counts as Unknown)", async () => {
    const d = await contentByYear(spec(), ctxOf({ crawl: crawlOf([page("/a", null), page("/b", undefined)]), rows: [] }).ctx);
    expect(d.rows.map((r) => [r.year, r.pages])).toEqual([["Unknown", 2]]);
  });

  it("staleDays is the crawl's age in whole days when over 90, else null", async () => {
    const at = (days: number) => Date.UTC(2026, 9, 13, 12) - days * 86_400_000;
    const stale = async (days: number) => (await contentByYear(spec(), ctxOf({ crawl: crawlOf([page("/a", j("2025-01-01"))], at(days)), rows: [] }).ctx)).staleDays;
    expect(await stale(90)).toBeNull();
    expect(await stale(91)).toBe(91);
    expect(await stale(10)).toBeNull();
  });

  it("uses the stored page rows when the range is covered by saved history (the provider answers; the guard already noted it)", async () => {
    const { ctx, calls } = ctxOf({ crawl: crawlOf(pages), rows });
    ctx.coverage = () => ({ complete: true, source: "stored" });
    const d = await contentByYear(spec(), ctx);
    expect(calls).toHaveLength(1);
    expect(rowOf(d, "2025")!.clicks).toBe(150);
  });

  it("an empty crawl (no parsed pages) is empty rows, not an error", async () => {
    const d = await contentByYear(spec(), ctxOf({ crawl: crawlOf([page("/x", undefined, { status: 404, finalStatus: 404 })]), rows: [] }).ctx);
    expect(d.rows).toEqual([]);
    expect(d.pagesConsidered).toBe(0);
  });
});

describe("content_by_year through runTemplate", () => {
  it("is ok on the yearly template with a saved crawl", async () => {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-y2-"));
    const deps = { ...fakeDeps(), latestLocalCrawl: () => crawlOf([page("/blog/a", j("2025-03-01")), page("/blog/b", j("2024-03-01"))]) };
    const r = await runTemplate(baseClient, { homeDir: home, today, template: "yearly", include: ["content-years"], store: false }, deps);
    const s = r.sections.find((x) => x.id === "content-years")!;
    expect(s.status).toBe("ok");
    expect(s.status === "ok" ? (s.data as { rows: { year: string }[] }).rows.map((x) => x.year) : null).toEqual(["2025", "2024"]);
  });
});
