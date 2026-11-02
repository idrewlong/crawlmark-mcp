import { google } from "googleapis";
import { env, type Client } from "../config.js";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import type { DateRange } from "../lib/dates.js";
import { gscError } from "../lib/google-access.js";
import { exclusionRegex, isExcludedQuery } from "../lib/gsc-exclusions.js";
import { historyCutoff, mergeRows, readMonths, storedMonths, wholeMonths } from "../lib/gsc-monthly.js";
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
    const mapped = gscError(err, siteUrl, whoAmI());
    // The friendlier message drops the HTTP status; keep it so callers can still tell a refusal from a hiccup.
    if (mapped !== err && mapped instanceof Error) Object.assign(mapped, { status: apiErrorInfo(err).status });
    throw mapped;
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
  /** D4: don't leave out the client's gscExcludeQueries (raw Search Console numbers). Default false. */
  includeExcludedQueries?: boolean;
  /** D5: never answer from stored monthly history (the backfill reads Google itself). */
  live?: boolean;
  /** Skip the cache for this call. */
  refresh?: boolean;
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

type Filter = { dimension: string; operator: string; expression: string };

const pct = (clicks: number, impressions: number) => (impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0);

/**
 * A5: rows of `raw` minus rows of `part` (the same request limited to the excluded queries), matched by identical keys.
 * Clicks and impressions are subtracted, CTR is recomputed, position is kept; rows left with no impressions are dropped.
 */
export function subtractRows(raw: GscRow[], part: GscRow[]): GscRow[] {
  const sub = new Map(part.map((r) => [r.keys.join("\u0000"), r]));
  const out: GscRow[] = [];
  for (const r of raw) {
    const p = sub.get(r.keys.join("\u0000"));
    if (!p) {
      out.push(r);
      continue;
    }
    const clicks = Math.max(0, r.clicks - p.clicks);
    const impressions = r.impressions - p.impressions;
    if (impressions <= 0) continue;
    out.push({ keys: r.keys, clicks, impressions, ctr: pct(clicks, impressions), position: r.position });
  }
  return out;
}

/** What gscQuery returns, plus the exclusions' share (present only when exclusions applied; summed over the rows asked for). */
export interface GscResult {
  rows: GscRow[];
  excluded?: { clicks: number; impressions: number };
  /** Caveats a report should show (e.g. saved history that predates the client's current exclusions). */
  notes?: string[];
}

/** D5: stored months answer a range wholly before Google's window, for totals, query and page requests. */
function fromHistory(client: Client, opts: GscQueryOptions, items: readonly string[]): GscResult | null {
  if (opts.live || !client.gscProperty) return null;
  const dims = opts.dimensions ?? [];
  const kind = dims.length === 0 ? "totals" : dims.length === 1 && dims[0] === "query" ? "query" : dims.length === 1 && dims[0] === "page" ? "page" : null;
  if (!kind || opts.pageContains || opts.queryContains || opts.queryRegex) return null;
  if (opts.startDate >= historyCutoff(Date.now())) return null;
  const months = wholeMonths(opts);
  if (!months) return null;
  const property = client.gscProperty;
  const stored = storedMonths(client.slug, property);
  if (!months.every((m) => stored.includes(m))) return null;
  const exclude = !opts.includeExcludedQueries && items.length > 0;
  const byMonth = readMonths(client.slug, property, months, kind);
  const rows = [...byMonth.values()].flat();
  const filtered = kind === "query" && exclude ? rows.filter((r) => !isExcludedQuery(r.keys[0] ?? "", items)) : rows;
  const merged = mergeRows(filtered);
  if (kind !== "totals") return { rows: merged.slice(0, opts.rowLimit ?? 1000) };
  const total = merged[0] ?? { keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 };
  if (!exclude) return { rows: [total] };
  // The saved `excluded` row is only valid for the exclusions it was computed with (its key is that regex). Months saved
  // under different (or no) exclusions can't be adjusted, so the whole range is returned raw, with a note.
  const current = exclusionRegex(items);
  const exByMonth = readMonths(client.slug, property, months, "excluded");
  if (months.some((m) => (exByMonth.get(m)?.[0]?.keys[0] ?? null) !== current)) {
    return { rows: [total], notes: ["Search Console history for these months was saved before the current query exclusions, so their totals are raw (the excluded queries are included)."] };
  }
  const ex = [...exByMonth.values()].flat();
  const excluded = { clicks: ex.reduce((a, r) => a + r.clicks, 0), impressions: ex.reduce((a, r) => a + r.impressions, 0) };
  const clicks = Math.max(0, total.clicks - excluded.clicks);
  const impressions = total.impressions - excluded.impressions;
  return { rows: impressions > 0 ? [{ keys: [], clicks, impressions, ctr: pct(clicks, impressions), position: total.position }] : [], excluded };
}

/** Search Analytics query with the exclusions' share. GSC data lags ~2-3 days, so completed months are safe to cache long. */
export async function gscQueryDetailed(client: Client, opts: GscQueryOptions): Promise<GscResult> {
  const items = client.gscExcludeQueries ?? [];
  const history = fromHistory(client, opts, items);
  if (history) return history;

  const siteUrl = requireProperty(client);
  const exclusion = opts.includeExcludedQueries ? null : exclusionRegex(items);
  const dims = opts.dimensions ?? [];
  const filters = [
    opts.pageContains && { dimension: "page", operator: "contains", expression: opts.pageContains },
    opts.queryContains && { dimension: "query", operator: "contains", expression: opts.queryContains },
    opts.queryRegex && { dimension: "query", operator: "includingRegex", expression: opts.queryRegex },
  ].filter(Boolean) as Filter[];

  const { refresh, live: _live, ...keyed } = opts;
  const key = cacheKey("gsc2", googleAuthIdentity(), siteUrl, keyed, ...(exclusion ? [exclusion] : []));
  const { value } = await cached(key, TTL.day, async (): Promise<GscResult> => {
    const sc = google.searchconsole({ version: "v1", auth: googleAuth() });
    const run = async (extra: Filter[]): Promise<GscRow[]> => {
      const all = [...filters, ...extra];
      let res;
      try {
        res = await guarded(siteUrl, () => sc.searchanalytics.query({
          siteUrl,
          requestBody: {
            startDate: opts.startDate,
            endDate: opts.endDate,
            dimensions: dims,
            rowLimit: opts.rowLimit ?? 1000,
            dimensionFilterGroups: all.length ? [{ filters: all }] : undefined,
          },
        }));
      } catch (err) {
        if (exclusion && apiErrorInfo(err).status === 400) {
          throw new Error(`Search Console rejected the gscExcludeQueries pattern: ${apiErrorInfo(err).message}`, { cause: err });
        }
        throw err;
      }
      return (res.data.rows ?? []).map((r) => ({
        keys: r.keys ?? [],
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        ctr: Number(((r.ctr ?? 0) * 100).toFixed(2)),
        position: Number((r.position ?? 0).toFixed(1)),
      }));
    };
    if (!exclusion) return { rows: await run([]) };
    // Query-level requests: Search Console filters the excluded queries out itself (exact).
    if (dims.includes("query")) return { rows: await run([{ dimension: "query", operator: "excludingRegex", expression: exclusion }]) };
    // Other requests: subtract the excluded queries' share (A5), key by key.
    const raw = await run([]);
    const part = await run([{ dimension: "query", operator: "includingRegex", expression: exclusion }]);
    return {
      rows: subtractRows(raw, part),
      excluded: { clicks: part.reduce((a, r) => a + r.clicks, 0), impressions: part.reduce((a, r) => a + r.impressions, 0) },
    };
  }, { refresh: refresh ?? false });
  return value;
}

/** Search Analytics query (see gscQueryDetailed). */
export async function gscQuery(client: Client, opts: GscQueryOptions): Promise<GscRow[]> {
  return (await gscQueryDetailed(client, opts)).rows;
}

/** Totals for a date range (no dimensions → one aggregate row). `excluded` is what the client's gscExcludeQueries took out, when they applied. */
export async function gscTotals(client: Client, range: DateRange): Promise<GscRow & { excluded?: { clicks: number; impressions: number }; notes?: string[] }> {
  const { rows, excluded, notes } = await gscQueryDetailed(client, { ...range, dimensions: [] });
  const row = rows[0] ?? { keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 };
  return { ...row, ...(excluded ? { excluded } : {}), ...(notes?.length ? { notes } : {}) };
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
