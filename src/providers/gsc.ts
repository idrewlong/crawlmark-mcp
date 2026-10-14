import { google } from "googleapis";
import { env, type Client } from "../config.js";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import type { DateRange } from "../lib/dates.js";
import { gscError } from "../lib/google-access.js";
import { apiErrorInfo } from "../lib/gtm.js";
import { lastInSitemap, markQuotaExhausted, pacificDay, reserveQuota, saveInspection, type InspectionOrigin, type InspectionRecord } from "../lib/inspections.js";
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

/** One URL Inspection result with every index-status field crawlmark stores (research G3). */
export interface RawInspection extends InspectionRecord {
  mobileVerdict: string | null | undefined;
  richResults: (string | null | undefined)[] | undefined;
}

export type InspectionErrorKind = "daily" | "rate" | "access" | "other";

/**
 * What a URL Inspection error means for the run (SEC-3): `daily` (the property's daily quota is used up; the day is
 * marked exhausted), `rate` (another 429 / RESOURCE_EXHAUSTED: stop, but don't mark the day), `access` (401/403: stop
 * at once), else `other`.
 */
export function inspectionErrorKind(err: unknown): InspectionErrorKind {
  const tagged = (err as { inspectionErrorKind?: InspectionErrorKind } | null)?.inspectionErrorKind;
  if (tagged) return tagged;
  const info = apiErrorInfo(err);
  const text = `${info.message} ${(err as { message?: string } | null)?.message ?? ""} ${info.reasons.join(" ")}`;
  const quota = info.status === 429 || /RESOURCE_EXHAUSTED|quotaExceeded|rateLimitExceeded|dailyLimitExceeded|quota exceeded/i.test(text);
  if (quota) return /per day|daily|perDay/i.test(text) ? "daily" : "rate";
  if (info.status === 401 || info.status === 403) return "access";
  return "other";
}

/** True for Google's quota and rate errors (429 / RESOURCE_EXHAUSTED / quotaExceeded). */
export const isQuotaError = (err: unknown): boolean => {
  const k = inspectionErrorKind(err);
  return k === "daily" || k === "rate";
};

/** Raised before a gsc_inspect_url / run_audit inspection when the property's day is used up (SEC-4). */
export const QUOTA_USED_UP = "Google's URL Inspection quota for this property is used up today";

/**
 * One live URL Inspection call (webmasters.readonly; read-only, no "request indexing"), not cached and not
 * recorded: callers reserve it against the property's day first and record it (inspections.ts). Errors carry
 * `inspectionErrorKind` (the classification is made before the permission-error message rewrite drops the status).
 */
export async function inspectUrlLive(client: Client, url: string): Promise<RawInspection> {
  const siteUrl = requireProperty(client);
  const sc = google.searchconsole({ version: "v1", auth: googleAuth() });
  let res;
  try {
    res = await sc.urlInspection.index.inspect({ requestBody: { inspectionUrl: url, siteUrl } });
  } catch (err) {
    const kind = inspectionErrorKind(err);
    const mapped = gscError(err, siteUrl, whoAmI());
    const out = mapped instanceof Error ? mapped : new Error(String(mapped));
    throw Object.assign(out, { inspectionErrorKind: kind });
  }
  const r = res.data.inspectionResult;
  const ix = r?.indexStatusResult;
  return {
    url,
    verdict: ix?.verdict ?? null,
    coverageState: ix?.coverageState ?? null,
    indexingState: ix?.indexingState ?? null,
    pageFetchState: ix?.pageFetchState ?? null,
    robotsTxtState: ix?.robotsTxtState ?? null,
    googleCanonical: ix?.googleCanonical ?? null,
    userCanonical: ix?.userCanonical ?? null,
    lastCrawlTime: ix?.lastCrawlTime ?? null,
    crawledAs: ix?.crawledAs ?? null,
    mobileVerdict: r?.mobileUsabilityResult?.verdict,
    richResults: r?.richResultsResult?.detectedItems?.map((i) => i.richResultType),
  };
}

/** Store an inspection (Phase 13 D14); it was reserved against the property's day before the call. Never fails the caller. */
export function recordInspection(client: Client, r: InspectionRecord, origin: InspectionOrigin, extra: { inSitemap?: boolean; now?: number } = {}): void {
  const now = extra.now ?? Date.now();
  try {
    saveInspection({ ...r, client: client.slug, property: client.gscProperty ?? "", origin, inspectedAt: now, inSitemap: extra.inSitemap ?? lastInSitemap(client.slug, r.url) ?? false });
  } catch (err) {
    console.error(`crawlmark: couldn't store a URL Inspection result: ${(err as Error).message}`);
  }
}

/**
 * URL Inspection: index status, canonical, mobile usability for one URL. Phase 13: a live call (cache miss) is first
 * reserved against the property's Pacific-day budget (refused when it's used up), then stored (output unchanged).
 */
export async function gscInspectUrl(client: Client, url: string, opts: { refresh?: boolean; origin?: "audit" | "manual" } = {}) {
  const siteUrl = requireProperty(client);
  const { value } = await cached(cacheKey("gsc-inspect", googleAuthIdentity(), siteUrl, url), TTL.day, async () => {
    const day = pacificDay();
    if (!reserveQuota(siteUrl, day, env.GSC_INSPECTION_DAILY_BUDGET)) throw new Error(`${QUOTA_USED_UP} (GSC_INSPECTION_DAILY_BUDGET).`);
    let r: RawInspection;
    try {
      r = await inspectUrlLive(client, url);
    } catch (err) {
      if (inspectionErrorKind(err) === "daily") {
        try {
          markQuotaExhausted(siteUrl, day);
        } catch {
          /* the store is best effort here */
        }
      }
      throw err;
    }
    recordInspection(client, r, opts.origin ?? "manual");
    return {
      url,
      verdict: r.verdict ?? undefined,
      coverageState: r.coverageState ?? undefined,
      googleCanonical: r.googleCanonical ?? undefined,
      userCanonical: r.userCanonical ?? undefined,
      lastCrawlTime: r.lastCrawlTime ?? undefined,
      robotsTxtState: r.robotsTxtState ?? undefined,
      mobileVerdict: r.mobileVerdict,
      richResults: r.richResults,
    };
  }, { refresh: opts.refresh ?? false });
  return value;
}

/** Sitemaps with their submitted URL counts (Phase 13 indexing section; `contents[].indexed` is deprecated and not read). */
export async function gscSitemapsDetailed(client: Client) {
  const siteUrl = requireProperty(client);
  const { value } = await cached(cacheKey("gsc-sitemaps-detailed", googleAuthIdentity(), siteUrl), TTL.day, async () => {
    const sc = google.searchconsole({ version: "v1", auth: googleAuth() });
    const res = await guarded(siteUrl, () => sc.sitemaps.list({ siteUrl }));
    return (res.data.sitemap ?? []).map((s) => {
      const counts = (s.contents ?? []).map((c) => Number(c.submitted ?? NaN)).filter((n) => Number.isFinite(n));
      return {
        path: s.path ?? "",
        lastDownloaded: s.lastDownloaded ?? null,
        isPending: Boolean(s.isPending),
        errors: Number(s.errors ?? 0),
        warnings: Number(s.warnings ?? 0),
        submitted: counts.length ? counts.reduce((a, b) => a + b, 0) : null,
      };
    });
  });
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
