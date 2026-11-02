/**
 * Bing Webmaster Tools API client (Phase 12 C3), read-only and free.
 *
 * Only the methods in BING_READ_METHODS can be called: bingGet refuses anything else
 * at runtime, so no submit, add, remove, save, update, enable, verify or fetch method
 * (URL or sitemap submission, IndexNow, site changes) is reachable from crawlmark.
 *
 * The key travels in the `apikey` query parameter, as Bing requires. So the request URL
 * is never logged, cached, put in an error or returned: cache keys are
 * cacheKey("bing", keyFingerprint(key), method, siteUrl), where the fingerprint is the first
 * 8 hex characters of the key's SHA-256 (so a new key never sees the old account's cached
 * data, and the key can't be recovered from it); errors carry fixed text plus Bing's
 * redacted error code; network failures report only the error's class.
 */
import { createHash } from "node:crypto";
import { env } from "../config.js";
import {
  changeOf,
  cleanText,
  coverageNote,
  latestCrawlStats,
  matchBingSite,
  parseCrawlIssues,
  parseCrawlStats,
  parseStatRows,
  parseTraffic,
  parseUserSites,
  topRows,
  totalsFor,
  windowsFor,
  type BingSite,
  type CrawlIssue,
  type CrawlStat,
  type DayTraffic,
  type Totals,
  type TotalsChange,
} from "../analysis/bing.js";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import type { DateRange } from "../lib/dates.js";
import { ProviderUnavailableError } from "../lib/provider-ids.js";
import { TIMEOUTS } from "../lib/timeout.js";
import type { BingOverviewData } from "../reports/report-types.js";
import { redact } from "./units-billing.js";
import { cliHint } from "../lib/cli-hint.js";

/** Every Bing method crawlmark may call. All are reads. */
export const BING_READ_METHODS = ["GetUserSites", "GetRankAndTrafficStats", "GetQueryStats", "GetPageStats", "GetCrawlStats", "GetCrawlIssues", "GetUrlInfo"] as const;
export type BingReadMethod = (typeof BING_READ_METHODS)[number];

export const BING_SETUP_HINT = "Run setup --step bing.";
export const NO_BING_KEY = "Bing Webmaster Tools needs BING_WEBMASTER_API_KEY (free: Bing Webmaster Tools > Settings > API Access > Generate API Key). Run setup --step bing.";
export const BING_KEY_REJECTED = "Bing rejected the API key; run setup --step bing.";
export const BING_NOTES = ["Bing updates query stats weekly"] as const;

/** No key, or Bing refused the key: the data is unavailable, not failed. */
export class BingUnavailableError extends ProviderUnavailableError {
  override name = "BingUnavailableError";
  constructor(message: string) {
    super("bingWebmaster", null, message);
  }
}

/** The client has no verified Bing site this key can read. */
export class BingSiteError extends Error {
  override name = "BingSiteError";
}

/** Bing returned an error (HTTP 400 with `{ ErrorCode, Message }`, or another status). The message never holds the key or URL. */
export class BingApiError extends Error {
  override name = "BingApiError";
  constructor(
    message: string,
    readonly code: number | null,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A non-reversible 8-hex-character tag for a key, used only to separate cache entries per key (SEC-3). */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** The cache key for one Bing read. Never contains the key itself. */
export function bingCacheKey(key: string, method: BingReadMethod, siteUrl?: string, url?: string): string {
  return url === undefined ? cacheKey("bing", keyFingerprint(key), method, siteUrl ?? null) : cacheKey("bing", keyFingerprint(key), method, siteUrl ?? null, url);
}

export function bingKey(e: { BING_WEBMASTER_API_KEY?: string | undefined } = env): string | undefined {
  return e.BING_WEBMASTER_API_KEY || undefined;
}

/** ApiErrorCode (Microsoft.Bing.Webmaster.Api.Interfaces; research B7). */
const ERROR_NAMES: Record<number, string> = {
  1: "InternalError",
  2: "UnknownError",
  3: "InvalidApiKey",
  4: "ThrottleUser",
  5: "ThrottleHost",
  6: "UserBlocked",
  7: "InvalidUrl",
  8: "InvalidParameter",
  9: "TooManySites",
  10: "UserNotFound",
  11: "NotFound",
  12: "AlreadyExists",
  13: "NotAllowed",
  14: "NotAuthorized",
  15: "UnexpectedState",
  16: "Deprecated",
};

/** Classify an error response. Pure; the body is redacted by the caller before it gets here. */
export function bingErrorMessage(status: number, body: string): { unavailable: boolean; retryable: boolean; code: number | null; message: string } {
  let code: number | null = null;
  try {
    const j = JSON.parse(body) as { ErrorCode?: unknown };
    if (typeof j.ErrorCode === "number") code = j.ErrorCode;
  } catch {
    const m = /ErrorCode[^0-9]{0,40}(\d{1,3})/.exec(body);
    if (m) code = Number(m[1]);
  }
  if (code === 3 || code === 6 || code === 10) {
    return { unavailable: true, retryable: false, code, message: code === 3 ? BING_KEY_REJECTED : `Bing refused this API key (${ERROR_NAMES[code]}). ${BING_SETUP_HINT}` };
  }
  if (code === 4 || code === 5 || status === 429) return { unavailable: false, retryable: true, code, message: "Bing Webmaster Tools is throttling requests for this key. Try again in a few minutes." };
  if (code === 7 || code === 13 || code === 14) return { unavailable: false, retryable: false, code, message: `Bing refused the site (${ERROR_NAMES[code]}): it isn't a site this key can read.` };
  if (code !== null) return { unavailable: false, retryable: code === 1, code, message: `Bing Webmaster Tools returned error ${code}${ERROR_NAMES[code] ? ` (${ERROR_NAMES[code]})` : ""}.` };
  return { unavailable: false, retryable: status >= 500, code: null, message: `Bing Webmaster Tools returned HTTP ${status}.` };
}

export interface BingCallOptions {
  /** Defaults to BING_WEBMASTER_API_KEY; a missing key is BingUnavailableError. */
  key?: string | undefined;
  fetchImpl?: typeof fetch;
  refresh?: boolean;
  /** Skip the cache entirely (the setup key check). */
  noCache?: boolean;
  signal?: AbortSignal | undefined;
  /** Injected for tests (the retry backoff). */
  sleep?: (ms: number) => Promise<void>;
}

export interface BingParams {
  siteUrl?: string;
  url?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** One retry for throttling and server errors, after 1.5 to 3 seconds. */
const RETRY_BASE_MS = 1_500;

/**
 * One read from the Bing Webmaster JSON API, unwrapped from `{ d: ... }`, cached a day under
 * bingCacheKey (a key fingerprint, method, siteUrl[, url]). Throws for a method not in BING_READ_METHODS before
 * anything else happens.
 */
export async function bingGet<T = unknown>(method: BingReadMethod, params: BingParams = {}, opts: BingCallOptions = {}): Promise<{ value: T; fromCache: boolean }> {
  if (!(BING_READ_METHODS as readonly string[]).includes(method)) throw new Error(`Bing method ${String(method).slice(0, 60)} is not on crawlmark's read-only list.`);
  const key = opts.key ?? bingKey();
  if (!key) throw new BingUnavailableError(NO_BING_KEY);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  const call = async (): Promise<T> => {
    const qs = new URLSearchParams();
    if (params.siteUrl !== undefined) qs.set("siteUrl", params.siteUrl);
    if (params.url !== undefined) qs.set("url", params.url);
    qs.set("apikey", key);
    const url = `${env.BING_BASE_URL}/${method}?${qs.toString()}`;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      let text: string;
      try {
        const timeout = AbortSignal.timeout(TIMEOUTS.networkMs);
        res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout });
        // The body is read inside the same guard: a connection cut mid-body ("terminated") is a network failure too.
        text = await res.text();
      } catch (err) {
        // Only the error's class: a fetch error's message or cause can carry the request URL (and so the key).
        const name = err instanceof Error ? err.name : "Error";
        if (attempt === 1 && name !== "AbortError") {
          await sleep(RETRY_BASE_MS + Math.floor(Math.random() * RETRY_BASE_MS));
          continue;
        }
        throw new Error(`Couldn't reach Bing Webmaster Tools (${name === "TimeoutError" ? "timed out" : redact(name, [key], 60)}).`);
      }
      if (!res.ok) {
        const e = bingErrorMessage(res.status, redact(text, [key], 2000));
        if (e.unavailable) throw new BingUnavailableError(e.message);
        if (e.retryable && attempt === 1) {
          await sleep(RETRY_BASE_MS + Math.floor(Math.random() * RETRY_BASE_MS));
          continue;
        }
        throw new BingApiError(e.message, e.code, res.status);
      }
      try {
        return ((JSON.parse(text) as { d?: unknown }).d ?? null) as T;
      } catch {
        throw new Error("Bing Webmaster Tools returned something that isn't JSON.");
      }
    }
  };

  if (opts.noCache) return { value: await call(), fromCache: false };
  return cached(bingCacheKey(key, method, params.siteUrl, params.url), TTL.day, call, { refresh: opts.refresh ?? false });
}

/**
 * The sites this key can see (GetUserSites), cached a day as parsed sites only: Url and IsVerified,
 * never the AuthenticationCode / DnsVerificationCode Bing also returns.
 */
export async function bingUserSites(opts: BingCallOptions = {}): Promise<{ sites: BingSite[]; fromCache: boolean }> {
  const fetchSites = async () => parseUserSites((await bingGet("GetUserSites", {}, { ...opts, noCache: true })).value);
  if (opts.noCache) return { sites: await fetchSites(), fromCache: false };
  const key = opts.key ?? bingKey();
  if (!key) throw new BingUnavailableError(NO_BING_KEY);
  const r = await cached(bingCacheKey(key, "GetUserSites"), TTL.day, fetchSites, { refresh: opts.refresh ?? false });
  return { sites: r.value, fromCache: r.fromCache };
}

/** Why a key check failed: Bing refused the key, Bing couldn't be reached, Bing is throttling, or another Bing error. */
export type BingCheckFailure = "refused" | "network" | "throttled" | "other";
export type BingKeyCheck = { ok: true; sites: number; verified: number } | { ok: false; kind: BingCheckFailure; problem: string };

/** The setup check: one free GetUserSites call (no client data sent), never cached. The key is never in the result. */
export async function checkBingKey(key: string, fetchImpl: typeof fetch = fetch): Promise<BingKeyCheck> {
  try {
    const { sites } = await bingUserSites({ key, fetchImpl, noCache: true, sleep: async () => undefined });
    return { ok: true, sites: sites.length, verified: sites.filter((s) => s.verified).length };
  } catch (err) {
    const problem = redact(err instanceof Error ? err.message : String(err), [key], 400);
    const kind: BingCheckFailure =
      err instanceof BingUnavailableError
        ? "refused"
        : err instanceof BingApiError && (err.code === 4 || err.code === 5 || err.status === 429)
          ? "throttled"
          : /^Couldn't reach Bing/.test(problem)
            ? "network"
            : "other";
    return { ok: false, kind, problem };
  }
}

/** Resolve a client's Bing site, or throw a BingSiteError naming bingSite. */
export async function bingSiteFor(client: { domain: string; bingSite?: string | undefined }, opts: BingCallOptions = {}): Promise<{ site: string; source: "bingSite" | "matched"; alternates: string[] }> {
  const { sites } = await bingUserSites(opts);
  const m = matchBingSite(sites, client);
  if (m.ok) return { site: m.site, source: m.source, alternates: m.alternates };
  const fix = `set bingSite for this client to one of this key's verified sites (${cliHint()} clients set ${client.domain} --bing-site <url>, or set_client_profile)`;
  const verified = sites.filter((s) => s.verified).map((s) => s.url);
  const list = verified.length ? ` This key's verified sites: ${verified.slice(0, 20).join(", ")}${verified.length > 20 ? ", ..." : ""}.` : " This key has no verified sites.";
  switch (m.reason) {
    case "override-other-host":
      throw new BingSiteError(`clients.yaml bingSite ${cleanText(client.bingSite, 300)} for ${client.domain} is on another host, so it would show another site's Bing data. Use a Bing site on ${client.domain} or a subdomain of it, or clear bingSite (${cliHint()} clients set ${client.domain} --bing-site none).`);
    case "override-not-found":
      throw new BingSiteError(`clients.yaml bingSite ${cleanText(client.bingSite, 300)} for ${client.domain} isn't a site this Bing key can read: ${fix}, or clear it.${list}`);
    case "override-unverified":
      throw new BingSiteError(`clients.yaml bingSite ${cleanText(client.bingSite, 300)} for ${client.domain} isn't verified in Bing Webmaster Tools yet. Verify it at https://www.bing.com/webmasters, or ${fix}.`);
    case "unverified":
      throw new BingSiteError(`${client.domain} is in Bing Webmaster Tools but not verified (${m.unverified.join(", ")}). Verify it at https://www.bing.com/webmasters, or ${fix}.`);
    default:
      throw new BingSiteError(`No verified Bing Webmaster Tools site for ${client.domain} with this key. Add and verify it at https://www.bing.com/webmasters (you can import it from Search Console), or ${fix}.${list}`);
  }
}

// ---------------------------------------------------------------- report

export interface BingTotals extends Totals {
  change: TotalsChange;
}

export interface BingReportResult {
  site: string;
  siteSource: "bingSite" | "matched";
  window: DateRange;
  /** The comparison window; its totals are null when Bing has no traffic for any day of it (history is limited). */
  previous: DateRange & { clicks: number | null; impressions: number | null; ctr: number | null };
  totals: BingTotals;
  byDay: DayTraffic[];
  topQueries: { query: string; clicks: number; impressions: number; avgPosition: number | null }[];
  topPages: { page: string; clicks: number; impressions: number; avgPosition: number | null }[];
  crawl: { stats: CrawlStat[]; issues: CrawlIssue[]; issueCount: number };
  notes: string[];
  fromCache: boolean;
}

const NO_CHANGE = { clicks: null, impressions: null, ctr: null } as const;

/** The raw reads behind a report, fetched one after another (Bing documents no rate limit; this keeps it gentle). */
async function fetchAll(site: string, opts: BingCallOptions, include: { crawl: boolean }) {
  const traffic = await bingGet("GetRankAndTrafficStats", { siteUrl: site }, opts);
  const queries = await bingGet("GetQueryStats", { siteUrl: site }, opts);
  const pages = await bingGet("GetPageStats", { siteUrl: site }, opts);
  const crawlStats = include.crawl ? await bingGet("GetCrawlStats", { siteUrl: site }, opts) : undefined;
  const crawlIssues = include.crawl ? await bingGet("GetCrawlIssues", { siteUrl: site }, opts) : undefined;
  const all = [traffic, queries, pages, crawlStats, crawlIssues].filter((x): x is { value: unknown; fromCache: boolean } => x !== undefined);
  return {
    days: parseTraffic(traffic.value),
    queries: parseStatRows(queries.value, 300),
    pages: parseStatRows(pages.value, 2000),
    crawlStats: crawlStats ? parseCrawlStats(crawlStats.value) : [],
    crawlIssues: crawlIssues ? parseCrawlIssues(crawlIssues.value) : [],
    fromCache: all.every((x) => x.fromCache),
  };
}

function weeklyNote(rows: { date: string }[], window: DateRange, what: string): string | undefined {
  if (!rows.length) return `Bing returned no ${what} stats for this site.`;
  const inside = rows.filter((r) => r.date >= window.startDate && r.date <= window.endDate);
  return inside.length ? undefined : `Bing's ${what} stats have no rows dated inside ${window.startDate} to ${window.endDate} (they are weekly and lag behind the daily traffic).`;
}

/** bing_report: the last `days` days (ending on Bing's newest traffic day) vs the `days` before. */
export async function bingReport(client: { domain: string; bingSite?: string | undefined }, req: { days?: number | undefined } = {}, opts: BingCallOptions & { today?: Date } = {}): Promise<BingReportResult> {
  const days = Math.min(180, Math.max(7, Math.round(req.days ?? 28)));
  const { site, source } = await bingSiteFor(client, opts);
  const data = await fetchAll(site, opts, { crawl: true });
  const yesterday = new Date((opts.today ?? new Date()).getTime() - 86_400_000).toISOString().slice(0, 10);
  const { window, previous } = windowsFor(data.days, days, yesterday);
  const cur = totalsFor(data.days, window);
  const prevAll = totalsFor(data.days, previous);
  const prev = prevAll.daysWithData > 0 ? prevAll : null;
  const notes = [
    ...BING_NOTES,
    ...[coverageNote(data.days, window, "window"), coverageNote(data.days, previous, "previous window"), weeklyNote(data.queries, window, "query"), weeklyNote(data.pages, window, "page")].filter((n): n is string => Boolean(n)),
  ];
  if (!data.days.length) notes.push("Bing returned no daily traffic for this site yet (new sites take a few days).");
  return {
    site,
    siteSource: source,
    window,
    previous: { ...previous, clicks: prev?.clicks ?? null, impressions: prev?.impressions ?? null, ctr: prev?.ctr ?? null },
    totals: { clicks: cur.clicks, impressions: cur.impressions, ctr: cur.ctr, change: prev ? changeOf(cur, prev) : NO_CHANGE },
    byDay: data.days.filter((d) => d.date >= window.startDate && d.date <= window.endDate),
    topQueries: topRows(data.queries, window, 25).map((r) => ({ query: r.key, clicks: r.clicks, impressions: r.impressions, avgPosition: r.avgPosition })),
    topPages: topRows(data.pages, window, 25).map((r) => ({ page: r.key, clicks: r.clicks, impressions: r.impressions, avgPosition: r.avgPosition })),
    crawl: { stats: latestCrawlStats(data.crawlStats), issues: data.crawlIssues.slice(0, 50), issueCount: data.crawlIssues.length },
    notes,
    fromCache: data.fromCache,
  };
}

export type { BingOverviewData };

/** The report template's bing_overview section data: a given period (and comparison) rather than the latest days. */
export async function bingOverview(
  client: { domain: string; bingSite?: string | undefined },
  req: { window: DateRange; compare?: { which: "previous_period" | "previous_year"; range: DateRange } | undefined; limit: number },
  opts: BingCallOptions = {},
): Promise<BingOverviewData> {
  const { site } = await bingSiteFor(client, opts);
  const data = await fetchAll(site, opts, { crawl: true });
  const cur = totalsFor(data.days, req.window);
  // A comparison Bing has no traffic for (it keeps limited history) is "no data", never zeros.
  const prevAll = req.compare ? totalsFor(data.days, req.compare.range) : undefined;
  const prev = prevAll && prevAll.daysWithData > 0 ? prevAll : undefined;
  const notes = [
    ...BING_NOTES,
    ...[
      coverageNote(data.days, req.window, "report period"),
      req.compare ? coverageNote(data.days, req.compare.range, req.compare.which === "previous_year" ? "previous year" : "previous period") : undefined,
      weeklyNote(data.queries, req.window, "query"),
    ].filter((n): n is string => Boolean(n)),
  ];
  return {
    site,
    window: req.window,
    comparedWith: req.compare ?? null,
    totals: { clicks: cur.clicks, impressions: cur.impressions, ctr: cur.ctr, change: prev ? changeOf(cur, prev) : NO_CHANGE },
    previous: prev ? { clicks: prev.clicks, impressions: prev.impressions, ctr: prev.ctr } : null,
    topQueries: topRows(data.queries, req.window, req.limit).map((r) => ({ query: r.key, clicks: r.clicks, impressions: r.impressions, avgPosition: r.avgPosition })),
    topPages: topRows(data.pages, req.window, req.limit).map((r) => ({ page: r.key, clicks: r.clicks, impressions: r.impressions, avgPosition: r.avgPosition })),
    crawl: { latest: data.crawlStats.at(-1) ?? null, issueCount: data.crawlIssues.length },
    limit: req.limit,
    notes,
  };
}
