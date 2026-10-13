import { google } from "googleapis";
import type { Client } from "../config.js";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import type { DateRange } from "../lib/dates.js";
import { gscError } from "../lib/google-access.js";
import { assertGoogleConfigured, googleAuth, googleAuthIdentity, googleAuthStatus } from "./google.js";

function whoAmI() {
  const s = googleAuthStatus();
  return s.mode === "none" ? { mode: "none" as const } : { mode: s.mode, email: s.email };
}

/** Run a Search Console call, turning a permission denial into an actionable error. */
async function guarded<T>(siteUrl: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw gscError(err, siteUrl, whoAmI());
  }
}

export type GscDimension = "query" | "page" | "country" | "device" | "date";

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQueryOptions extends DateRange {
  dimensions?: GscDimension[];
  rowLimit?: number;
  /** Filter to rows whose page contains this string, e.g. "/blog/". */
  pageContains?: string;
  /** Filter to rows whose query contains this string. */
  queryContains?: string;
  /** Filter to rows whose query matches this RE2 regular expression (Search Console `includingRegex`). */
  queryRegex?: string;
}

function requireProperty(client: Client): string {
  assertGoogleConfigured();
  if (!client.gscProperty) {
    throw new Error(
      `No Search Console property found for ${client.domain}. Give the Google account access to the site in Search Console ` +
        "(then call list_clients with refresh: true), or set gscProperty for it in clients.yaml.",
    );
  }
  return client.gscProperty;
}

/** Search Analytics query. GSC data lags ~2-3 days, so completed months are safe to cache long. */
export async function gscQuery(client: Client, opts: GscQueryOptions): Promise<GscRow[]> {
  const siteUrl = requireProperty(client);
  const filters = [
    opts.pageContains && { dimension: "page", operator: "contains", expression: opts.pageContains },
    opts.queryContains && { dimension: "query", operator: "contains", expression: opts.queryContains },
    opts.queryRegex && { dimension: "query", operator: "includingRegex", expression: opts.queryRegex },
  ].filter(Boolean) as { dimension: string; operator: string; expression: string }[];

  const key = cacheKey("gsc", googleAuthIdentity(), siteUrl, opts);
  const { value } = await cached(key, TTL.day, async () => {
    const sc = google.searchconsole({ version: "v1", auth: googleAuth() });
    const res = await guarded(siteUrl, () => sc.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: opts.startDate,
        endDate: opts.endDate,
        dimensions: opts.dimensions ?? [],
        rowLimit: opts.rowLimit ?? 1000,
        dimensionFilterGroups: filters.length ? [{ filters }] : undefined,
      },
    }));
    return (res.data.rows ?? []).map((r) => ({
      keys: r.keys ?? [],
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: Number(((r.ctr ?? 0) * 100).toFixed(2)),
      position: Number((r.position ?? 0).toFixed(1)),
    }));
  });
  return value;
}

/** Totals for a date range (no dimensions → one aggregate row). */
export async function gscTotals(client: Client, range: DateRange) {
  const [row] = await gscQuery(client, { ...range, dimensions: [] });
  return row ?? { keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 };
}

/** URL Inspection: index status, canonical, mobile usability for one URL. */
export async function gscInspectUrl(client: Client, url: string, opts: { refresh?: boolean } = {}) {
  const siteUrl = requireProperty(client);
  const { value } = await cached(cacheKey("gsc-inspect", googleAuthIdentity(), siteUrl, url), TTL.day, async () => {
    const sc = google.searchconsole({ version: "v1", auth: googleAuth() });
    const res = await guarded(siteUrl, () => sc.urlInspection.index.inspect({
      requestBody: { inspectionUrl: url, siteUrl },
    }));
    const r = res.data.inspectionResult;
    return {
      url,
      verdict: r?.indexStatusResult?.verdict,
      coverageState: r?.indexStatusResult?.coverageState,
      googleCanonical: r?.indexStatusResult?.googleCanonical,
      userCanonical: r?.indexStatusResult?.userCanonical,
      lastCrawlTime: r?.indexStatusResult?.lastCrawlTime,
      robotsTxtState: r?.indexStatusResult?.robotsTxtState,
      mobileVerdict: r?.mobileUsabilityResult?.verdict,
      richResults: r?.richResultsResult?.detectedItems?.map((i) => i.richResultType),
    };
  }, opts);
  return value;
}

export async function gscSitemaps(client: Client) {
  const siteUrl = requireProperty(client);
  const sc = google.searchconsole({ version: "v1", auth: googleAuth() });
  const res = await guarded(siteUrl, () => sc.sitemaps.list({ siteUrl }));
  return (res.data.sitemap ?? []).map((s) => ({
    path: s.path,
    lastSubmitted: s.lastSubmitted,
    lastDownloaded: s.lastDownloaded,
    isPending: s.isPending,
    errors: Number(s.errors ?? 0),
    warnings: Number(s.warnings ?? 0),
  }));
}
