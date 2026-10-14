/**
 * Google indexing coverage (Phase 13, spec D14, D15): the inspection runner behind inspect_index_coverage,
 * `crawlmark-cli index-coverage` and the indexing_issues section's top-up, and the aggregate index_coverage
 * and the section show.
 *
 * Every inspection goes through URL Inspection with the read-only Search Console scope (webmasters.readonly);
 * crawlmark never asks Google to index anything. Runs stay within a per-property daily budget
 * (GSC_INSPECTION_DAILY_BUDGET, Pacific-time day), a per-run cap and GSC_INSPECTION_PER_MINUTE. A quota error
 * marks the property's day exhausted and stops the run at once (no retries).
 */
import type { Client } from "../config.js";
import { aggregateInspections, inspectionTrend, isoWeek, planPool, type PoolGroup } from "../analysis/indexing.js";
import { cleanText, inspectionsBetween, lastInSitemap, lastInspectedAt, latestInspections, markQuotaExhausted, pacificDay, quotaFor, reserveQuota, saveFailedInspection, saveInspection, type InspectionRecord } from "../lib/inspections.js";
import type { IndexingIssuesData } from "./report-types.js";

/** The tool's default per-run cap; the report section tops up at most 25 (its own maxInspections). */
export const DEFAULT_MAX_INSPECTIONS = 100;
export const DEFAULT_STALE_DAYS = 7;
/** A run stops starting new inspections after this long (the MCP tool's limit is 10 minutes). */
export const INSPECTION_TIME_LIMIT_MS = 9 * 60_000;
export const GSC_TOP_PAGES = 50;

export interface IndexingDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** One live URL Inspection call (unrecorded; the runner records it). */
  inspect(client: Client, url: string): Promise<InspectionRecord>;
  /** daily (the property's day is used up), rate (another 429), access (401/403) or other (SEC-2, SEC-3). */
  errorKind(err: unknown): "daily" | "rate" | "access" | "other";
  /** The top Search Console pages by impressions over the last 28 days. */
  topPages(client: Client): Promise<string[]>;
  /** URLs listed in the site's sitemaps (capped), read live with the crawler's user agent. */
  sitemapUrls(client: Client): Promise<string[]>;
  /** Search Console's sitemap list (cached a day). */
  sitemaps(client: Client): Promise<IndexingIssuesData["sitemaps"]>;
  /** GSC_INSPECTION_DAILY_BUDGET and GSC_INSPECTION_PER_MINUTE. */
  budget: number;
  perMinute: number;
}

/** The real sources, loaded on first use. */
export async function loadIndexingDeps(): Promise<IndexingDeps> {
  const [{ env }, gsc, { lastDays }, local, { crawlerUserAgent }, { packageVersion }] = await Promise.all([
    import("../config.js"),
    import("../providers/gsc.js"),
    import("../lib/dates.js"),
    import("./local-crawl.js"),
    import("../providers/crawler.js"),
    import("../lib/entry.js"),
  ]);
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    inspect: (c, url) => gsc.inspectUrlLive(c, url),
    errorKind: gsc.inspectionErrorKind,
    topPages: async (c) => {
      const rows = await gsc.gscQuery(c, { ...lastDays(28, 3), dimensions: ["page"], rowLimit: GSC_TOP_PAGES });
      return [...rows].sort((a, b) => b.impressions - a.impressions).flatMap((r) => (r.keys[0] ? [r.keys[0]] : [])).slice(0, GSC_TOP_PAGES);
    },
    sitemapUrls: async (c) => {
      const deps = await local.loadLocalCrawlDeps();
      const ua = crawlerUserAgent(packageVersion(new URL("../index.js", import.meta.url).href));
      const collected = await deps.sitemaps(c, [], { userAgent: ua });
      return [...collected.urls];
    },
    sitemaps: async (c) => (await gsc.gscSitemapsDetailed(c)).map((s) => ({ ...s, path: cleanText(s.path, 2000) ?? "" })),
    budget: env.GSC_INSPECTION_DAILY_BUDGET,
    perMinute: env.GSC_INSPECTION_PER_MINUTE,
  };
}

export interface InspectOptions {
  maxInspections?: number | undefined;
  staleDays?: number | undefined;
  dryRun?: boolean | undefined;
  signal?: AbortSignal | undefined;
  timeLimitMs?: number | undefined;
}

export interface InspectResult {
  property: string;
  planned: number;
  inspected: number;
  failed: number;
  /** errors: Google refused access (401/403), or MAX_CONSECUTIVE_FAILURES inspections in a row failed. */
  stoppedBy: null | "budget" | "quota" | "time" | "aborted" | "errors";
  quota: { day: string; used: number; budget: number; exhausted: boolean };
  byOrigin: Record<PoolGroup, number>;
  /** Operator notes (a source that couldn't be read). */
  notes: string[];
}

function requireProperty(client: Client): string {
  if (!client.gscProperty) throw new Error(`No Search Console property for ${client.domain}, so its URLs can't be inspected.`);
  return client.gscProperty;
}

const quotaNow = (property: string, day: string, budget: number) => {
  const q = quotaFor(property, day);
  return { day, used: q.used, budget, exhausted: q.exhausted };
};

/** A run stops after this many failed inspections in a row (not quota errors, which stop it at once). */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** One run per property at a time in this process, so concurrent runs don't double the pace or inspect the same URLs (R-2). */
const propertyLocks = new Map<string, Promise<unknown>>();
async function withPropertyLock<T>(property: string, fn: () => Promise<T>): Promise<T> {
  const prev = propertyLocks.get(property) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  propertyLocks.set(property, tail);
  try {
    return await run;
  } finally {
    if (propertyLocks.get(property) === tail) propertyLocks.delete(property);
  }
}

/**
 * Inspect the next URLs in the pool (D14) within the day's budget and the run's cap, at most perMinute a minute.
 * Each inspection is reserved against the property's Pacific day before it's made (atomic, so concurrent processes
 * can't pass the budget together; failed calls count too), then stored with its origin. `dryRun` plans only.
 */
export async function inspectIndexCoverage(client: Client, opts: InspectOptions, deps: IndexingDeps): Promise<InspectResult> {
  const property = requireProperty(client);
  const max = opts.maxInspections ?? DEFAULT_MAX_INSPECTIONS;
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const notes: string[] = [];
  const first = quotaFor(property, pacificDay(deps.now()));
  const leftAtStart = first.exhausted ? 0 : Math.max(0, deps.budget - first.used);

  let gscTop: string[] = [];
  let sitemapUrls: string[] = [];
  let sitemapKnown = true;
  if (max > 0 && leftAtStart > 0) {
    try {
      gscTop = await deps.topPages(client);
    } catch {
      notes.push("The top Search Console pages couldn't be read; key pages and sitemap URLs were used.");
    }
    try {
      sitemapUrls = await deps.sitemapUrls(client);
    } catch {
      sitemapKnown = false;
      notes.push("The sitemaps couldn't be read; key pages and top Search Console pages were used.");
    }
  }

  return withPropertyLock(property, async () => {
    const start = deps.now();
    const q = quotaFor(property, pacificDay(start));
    const left = q.exhausted ? 0 : Math.max(0, deps.budget - q.used);
    const pool = planPool({ property, keyPages: client.keyPages, gscTop, sitemapUrls, sitemapKnown, lastInspected: lastInspectedAt(client.slug), now: start, staleDays, seed: `${client.slug}:${isoWeek(start)}`, max });
    const planned = pool.slice(0, left);
    const byOrigin: Record<PoolGroup, number> = { key: 0, gsc_top: 0, sitemap: 0, oldest: 0 };
    for (const p of planned) byOrigin[p.group]++;
    // Nothing left today: Google said the quota is used up (quota), or crawlmark's own daily budget is (budget).
    let stoppedBy: InspectResult["stoppedBy"] = max > 0 && left === 0 ? (q.exhausted ? "quota" : "budget") : pool.length > planned.length ? "budget" : null;
    let lastDay = pacificDay(start);
    const result = (inspected: number, failed: number): InspectResult => ({ property, planned: planned.length, inspected, failed, stoppedBy, quota: quotaNow(property, lastDay, deps.budget), byOrigin, notes });
    if (opts.dryRun) return result(0, 0);

    const gap = Math.ceil(60_000 / Math.max(1, deps.perMinute));
    const limitMs = opts.timeLimitMs ?? INSPECTION_TIME_LIMIT_MS;
    let inspected = 0;
    let failed = 0;
    let inARow = 0;
    for (let i = 0; i < planned.length; i++) {
      if (opts.signal?.aborted) {
        stoppedBy = "aborted";
        break;
      }
      if (deps.now() - start > limitMs) {
        stoppedBy = "time";
        break;
      }
      if (i > 0) await deps.sleep(gap);
      const p = planned[i]!;
      const at = deps.now();
      // The Pacific day is read per call, so a run that crosses midnight counts against the new day.
      lastDay = pacificDay(at);
      if (!reserveQuota(property, lastDay, deps.budget)) {
        stoppedBy = quotaFor(property, lastDay).exhausted ? "quota" : "budget";
        break;
      }
      const origin = p.group === "oldest" ? (p.inSitemap ? "sitemap" : "manual") : p.group;
      try {
        const r = await deps.inspect(client, p.url);
        saveInspection({ ...r, url: p.url, client: client.slug, property, origin, inspectedAt: at, inSitemap: p.inSitemap ?? lastInSitemap(client.slug, p.url) ?? false });
        inspected++;
        inARow = 0;
      } catch (err) {
        const kind = deps.errorKind(err);
        if (kind === "daily" || kind === "rate") {
          // Only Google's daily limit marks the day used up; a per-minute 429 just ends this run.
          if (kind === "daily") markQuotaExhausted(property, lastDay);
          stoppedBy = "quota";
          break;
        }
        failed++;
        inARow++;
        saveFailedInspection({ client: client.slug, property, url: p.url, origin, inspectedAt: at });
        if (kind === "access") {
          stoppedBy = "errors";
          notes.push("Google refused access to this property's URL Inspection (401/403); the run stopped.");
          break;
        }
        if (inARow >= MAX_CONSECUTIVE_FAILURES) {
          stoppedBy = "errors";
          notes.push(`${MAX_CONSECUTIVE_FAILURES} inspections in a row failed; the run stopped.`);
          break;
        }
      }
    }
    return result(inspected, failed);
  });
}

export interface CoverageOptions {
  trendMonths?: number | undefined;
  limit?: number | undefined;
  /** Inspections made by this call (section top-up). */
  inspectedThisRun?: number | undefined;
  /** Sitemap URLs the run saw (else the sum of Search Console's submitted counts). */
  sitemapUrlsKnown?: number | undefined;
}

/** index_coverage and the section: the stored picture (latest inspection per URL), sitemap errors and the month trend. Local apart from the sitemap list (cached a day). */
export async function indexCoverage(client: Client, opts: CoverageOptions, deps: Pick<IndexingDeps, "now" | "sitemaps" | "budget">): Promise<IndexingIssuesData> {
  const property = requireProperty(client);
  const now = deps.now();
  const notes: string[] = [];
  const latest = latestInspections(client.slug, property);
  const agg = aggregateInspections(latest, { keyPages: client.keyPages, limit: opts.limit ?? 25, now });
  const months = opts.trendMonths ?? 6;
  const from = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - Math.max(0, months - 1), 1);
  const trend = inspectionTrend(inspectionsBetween(client.slug, from, now + 1), months, now);
  let sitemaps: IndexingIssuesData["sitemaps"] = [];
  try {
    sitemaps = await deps.sitemaps(client);
  } catch {
    notes.push("Search Console's sitemap list couldn't be read.");
  }
  const submitted = sitemaps.reduce((a, s) => a + (s.submitted ?? 0), 0);
  return {
    property,
    sample: {
      inspected: latest.length,
      inspectedThisRun: opts.inspectedThisRun ?? 0,
      keyPages: agg.keyPages,
      sitemapUrls: agg.sitemapUrls,
      sitemapUrlsKnown: opts.sitemapUrlsKnown ?? submitted,
      oldestDays: agg.oldestDays,
    },
    indexed: agg.indexed,
    byCoverage: agg.byCoverage,
    worst: agg.worst,
    canonicalMismatches: agg.canonicalMismatches,
    sitemaps,
    trend,
    quota: quotaNow(property, pacificDay(now), deps.budget),
    notes,
  };
}

/** The indexing_issues section: top up at most `maxInspections` (0 = stored only), then the stored picture. */
export async function indexingSection(client: Client, o: { maxInspections: number; staleDays: number; limit: number; trendMonths: number }, deps: IndexingDeps): Promise<IndexingIssuesData> {
  const run = o.maxInspections > 0 ? await inspectIndexCoverage(client, { maxInspections: o.maxInspections, staleDays: o.staleDays, timeLimitMs: 4 * 60_000 }, deps) : undefined;
  const data = await indexCoverage(client, { limit: o.limit, trendMonths: o.trendMonths, inspectedThisRun: run?.inspected ?? 0 }, deps);
  if (run?.stoppedBy === "quota") data.notes.push("Google's daily URL Inspection quota for this property is used up; stored results were used.");
  data.notes.push(...(run?.notes ?? []));
  return data;
}
