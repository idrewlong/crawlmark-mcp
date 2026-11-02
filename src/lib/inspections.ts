/**
 * Stored URL Inspection results and the per-property daily inspection count (Phase 13, spec 13.5.4,
 * D14, D15). Every inspection crawlmark makes (index-coverage runs, the indexing_issues section,
 * gsc_inspect_url and run_audit's key-page checks) is saved here and counted against the property's
 * Pacific-time day, so the daily budget holds across tools and processes.
 *
 * Google's text (coverage state, canonicals) is untrusted: control and invisible characters are stripped
 * and lengths capped before it is stored.
 */
import { normalizeUrl } from "../analysis/findings.js";
import { stripControl } from "./terminal-text.js";
import { db } from "./store.js";

export type InspectionOrigin = "key" | "gsc_top" | "sitemap" | "audit" | "manual";

/** What one inspection returned (IndexStatusInspectionResult, research G3). */
export interface InspectionRecord {
  url: string;
  verdict: string | null;
  coverageState: string | null;
  indexingState: string | null;
  pageFetchState: string | null;
  robotsTxtState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlTime: string | null;
  crawledAs: string | null;
}

export interface StoredInspection extends InspectionRecord {
  id: number;
  client: string;
  property: string;
  inspectedAt: number;
  origin: InspectionOrigin;
  inSitemap: boolean;
}

/** Inspections older than this are deleted on insert. */
export const INSPECTION_RETENTION_DAYS = 400;
/** Quota rows older than this are deleted on insert. */
export const QUOTA_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;

const PACIFIC = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });

/** The Google quota day (D15): the calendar day in America/Los_Angeles, `YYYY-MM-DD`, DST included. */
export function pacificDay(now: number | Date = Date.now()): string {
  const parts = PACIFIC.formatToParts(typeof now === "number" ? new Date(now) : now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** One line of untrusted Google text: control/invisible characters stripped, whitespace collapsed, capped. */
export function cleanText(s: string | null | undefined, max = 200): string | null {
  if (s === null || s === undefined) return null;
  const out = stripControl(String(s)).replace(/\s+/g, " ").trim();
  return out ? out.slice(0, max) : null;
}

/** A URL from Google: cleaned and normalised, or null. */
export function cleanUrl(s: string | null | undefined): string | null {
  const t = cleanText(s, 2000);
  return t ? normalizeUrl(t) : null;
}

/**
 * D7: before 0.2.0 the URL sent to Google had its trailing slash stripped, which Google answered with "URL is unknown to
 * Google" for pages that exist. Those rows have no `inspected_url`. They are ignored when reading results and re-checked first.
 * Audit and manual rows are excluded: run_audit and gsc_inspect_url (origin `manual`) always sent the URL exactly as
 * given, so "unknown to Google" there is a real answer for that URL form, not a stripped-slash artifact.
 */
const legacyUnknown = (a = "") => `(${a}inspected_url IS NULL AND ${a}failed = 0 AND ${a}origin NOT IN ('audit', 'manual') AND coalesce(lower(${a}coverage_state), '') LIKE '%unknown to google%')`;

interface Row {
  id: number;
  client: string;
  property: string;
  url: string;
  inspected_at: number;
  origin: string;
  verdict: string | null;
  coverage_state: string | null;
  indexing_state: string | null;
  page_fetch_state: string | null;
  robots_txt_state: string | null;
  google_canonical: string | null;
  user_canonical: string | null;
  last_crawl_time: string | null;
  crawled_as: string | null;
  in_sitemap: number;
}

const fromRow = (r: Row): StoredInspection => ({
  id: r.id,
  client: r.client,
  property: r.property,
  url: r.url,
  inspectedAt: r.inspected_at,
  origin: r.origin as InspectionOrigin,
  verdict: r.verdict,
  coverageState: r.coverage_state,
  indexingState: r.indexing_state,
  pageFetchState: r.page_fetch_state,
  robotsTxtState: r.robots_txt_state,
  googleCanonical: r.google_canonical,
  userCanonical: r.user_canonical,
  lastCrawlTime: r.last_crawl_time,
  crawledAs: r.crawled_as,
  inSitemap: r.in_sitemap === 1,
});

/**
 * Save one inspection (sanitised) and delete inspections older than INSPECTION_RETENTION_DAYS. `url` is the exact URL that
 * was sent to Google: it is kept as `inspected_url`, and its normalised form is the lookup key (`url`).
 */
export function saveInspection(i: InspectionRecord & { client: string; property: string; origin: InspectionOrigin; inspectedAt: number; inSitemap?: boolean }): void {
  const enumText = (s: string | null) => cleanText(s, 60);
  db.prepare("DELETE FROM url_inspections WHERE inspected_at < ?").run(i.inspectedAt - INSPECTION_RETENTION_DAYS * DAY_MS);
  db.prepare(
    `INSERT INTO url_inspections (client, property, url, inspected_at, origin, verdict, coverage_state, indexing_state, page_fetch_state, robots_txt_state, google_canonical, user_canonical, last_crawl_time, crawled_as, in_sitemap, inspected_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    i.client,
    i.property,
    normalizeUrl(cleanText(i.url, 2000) ?? i.url),
    i.inspectedAt,
    i.origin,
    enumText(i.verdict),
    cleanText(i.coverageState),
    enumText(i.indexingState),
    enumText(i.pageFetchState),
    enumText(i.robotsTxtState),
    cleanUrl(i.googleCanonical),
    cleanUrl(i.userCanonical),
    cleanText(i.lastCrawlTime, 40),
    enumText(i.crawledAs),
    i.inSitemap ? 1 : 0,
    cleanText(i.url, 2000),
  );
}

/** Every stored inspection of a client inspected in [fromMs, toMs), oldest first. */
export function inspectionsBetween(client: string, fromMs: number, toMs: number): StoredInspection[] {
  const rows = db.prepare(`SELECT * FROM url_inspections WHERE client = ? AND failed = 0 AND NOT ${legacyUnknown()} AND inspected_at >= ? AND inspected_at < ? ORDER BY inspected_at ASC, id ASC`).all(client, fromMs, toMs) as unknown as Row[];
  return rows.map(fromRow);
}

/** The newest inspection of each URL for a client (optionally one property), newest first. */
export function latestInspections(client: string, property?: string): StoredInspection[] {
  const rows = db
    .prepare(
      `SELECT * FROM url_inspections u WHERE client = ? AND failed = 0 AND NOT ${legacyUnknown("u.")}${property ? " AND property = ?" : ""}
       AND id = (SELECT id FROM url_inspections v WHERE v.client = u.client AND v.url = u.url AND v.failed = 0 AND NOT ${legacyUnknown("v.")}${property ? " AND v.property = u.property" : ""} ORDER BY inspected_at DESC, id DESC LIMIT 1)
       ORDER BY inspected_at DESC, id DESC`,
    )
    .all(...(property ? [client, property] : [client])) as unknown as Row[];
  return rows.map(fromRow);
}

/**
 * A failed inspection (Google answered with an error): recorded so the URL rotates to the back of the pool, but never
 * read as a result (latestInspections, the trend and the aggregate skip it).
 */
export function saveFailedInspection(i: { client: string; property: string; url: string; origin: InspectionOrigin; inspectedAt: number }): void {
  db.prepare("DELETE FROM url_inspections WHERE inspected_at < ?").run(i.inspectedAt - INSPECTION_RETENTION_DAYS * DAY_MS);
  db.prepare("INSERT INTO url_inspections (client, property, url, inspected_at, origin, failed, inspected_url) VALUES (?, ?, ?, ?, ?, 1, ?)").run(i.client, i.property, normalizeUrl(cleanText(i.url, 2000) ?? i.url), i.inspectedAt, i.origin, cleanText(i.url, 2000));
}

/** Whether the URL's newest stored result said it was in a sitemap (null when there is none). */
export function lastInSitemap(client: string, url: string): boolean | null {
  const row = db.prepare("SELECT in_sitemap FROM url_inspections WHERE client = ? AND url = ? AND failed = 0 ORDER BY inspected_at DESC, id DESC LIMIT 1").get(client, normalizeUrl(url)) as { in_sitemap: number } | undefined;
  return row ? row.in_sitemap === 1 : null;
}

/** When each URL was last inspected (normalised URL → ms), for the pool ordering. Failed attempts count, so they rotate. */
export function lastInspectedAt(client: string): Map<string, number> {
  const rows = db.prepare(`SELECT url, MAX(inspected_at) AS at FROM url_inspections WHERE client = ? AND NOT ${legacyUnknown()} GROUP BY url`).all(client) as unknown as { url: string; at: number }[];
  return new Map(rows.map((r) => [r.url, Number(r.at)]));
}

export interface QuotaDay {
  property: string;
  day: string;
  used: number;
  exhausted: boolean;
}

/** This property's count for a Pacific-time day (0 and not exhausted when nothing is stored). */
export function quotaFor(property: string, day: string): QuotaDay {
  const row = db.prepare("SELECT used, exhausted FROM gsc_inspection_quota WHERE property = ? AND day = ?").get(property, day) as { used: number; exhausted: number } | undefined;
  return { property, day, used: Number(row?.used ?? 0), exhausted: row?.exhausted === 1 };
}

function pruneQuota(day: string): void {
  const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - QUOTA_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
  db.prepare("DELETE FROM gsc_inspection_quota WHERE day < ?").run(cutoff);
}

/** Count `n` inspections against a property's day. */
export function addQuotaUse(property: string, day: string, n = 1): void {
  pruneQuota(day);
  db.prepare("INSERT INTO gsc_inspection_quota (property, day, used) VALUES (?, ?, ?) ON CONFLICT (property, day) DO UPDATE SET used = used + excluded.used").run(property, day, n);
}

/**
 * Reserve one inspection against the property's Pacific day before it's made (R-2): atomic, so concurrent runs (cron,
 * the MCP server, report sections) can never pass the budget together. True when reserved; false when the day is
 * marked used up or `budget` is reached. A reserved call counts whether it succeeds or fails.
 */
export function reserveQuota(property: string, day: string, budget: number): boolean {
  pruneQuota(day);
  db.prepare("INSERT OR IGNORE INTO gsc_inspection_quota (property, day, used, exhausted) VALUES (?, ?, 0, 0)").run(property, day);
  const r = db.prepare("UPDATE gsc_inspection_quota SET used = used + 1 WHERE property = ? AND day = ? AND exhausted = 0 AND used < ?").run(property, day, budget);
  return Number(r.changes) === 1;
}

/** Google said the property's quota is used up: no more inspections for it this Pacific day. */
export function markQuotaExhausted(property: string, day: string): void {
  pruneQuota(day);
  db.prepare("INSERT INTO gsc_inspection_quota (property, day, exhausted) VALUES (?, ?, 1) ON CONFLICT (property, day) DO UPDATE SET exhausted = 1").run(property, day);
}

/** The most sitemap URLs kept in a stored set (the sitemap reader's own URL cap is the same order). */
export const URL_SET_MAX = 50_000;

/** Replace the client's stored sitemap URL set for a property (normalised, deduplicated, capped). */
export function saveSitemapSet(client: string, property: string, urls: readonly string[], at: number): void {
  const list = [...new Set(urls.map((u) => normalizeUrl(u)))].slice(0, URL_SET_MAX);
  db.prepare("INSERT INTO inspection_url_sets (client, property, captured_at, urls) VALUES (?, ?, ?, ?) ON CONFLICT (client, property) DO UPDATE SET captured_at = excluded.captured_at, urls = excluded.urls").run(client, property, at, JSON.stringify(list));
}

/** The newest stored sitemap URL set for a client and property, or null. */
export function storedSitemapSet(client: string, property: string): { urls: string[]; capturedAt: number } | null {
  const row = db.prepare("SELECT captured_at, urls FROM inspection_url_sets WHERE client = ? AND property = ?").get(client, property) as { captured_at: number; urls: string } | undefined;
  if (!row) return null;
  try {
    const urls = JSON.parse(row.urls) as unknown;
    return Array.isArray(urls) ? { urls: urls.filter((u): u is string => typeof u === "string"), capturedAt: Number(row.captured_at) } : null;
  } catch {
    return null;
  }
}

/** When each URL last had a successful inspection for a client and property (normalised URL → ms). */
export function lastSuccessfulAt(client: string, property: string): Map<string, number> {
  const rows = db.prepare(`SELECT url, MAX(inspected_at) AS at FROM url_inspections WHERE client = ? AND property = ? AND failed = 0 AND NOT ${legacyUnknown()} GROUP BY url`).all(client, property) as unknown as { url: string; at: number }[];
  return new Map(rows.map((r) => [r.url, Number(r.at)]));
}

/**
 * Normalised URLs whose newest stored row is a legacy "URL is unknown to Google" result (see `legacyUnknown`) with no
 * newer result of any kind: the ones to re-check with the exact URL.
 */
export function legacyUnknownUrls(client: string, property: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT u.url FROM url_inspections u WHERE u.client = ? AND u.property = ? AND ${legacyUnknown("u.")}
       AND NOT EXISTS (SELECT 1 FROM url_inspections v WHERE v.client = u.client AND v.property = u.property AND v.url = u.url AND NOT ${legacyUnknown("v.")} AND (v.inspected_at > u.inspected_at OR (v.inspected_at = u.inspected_at AND v.id > u.id)))
       ORDER BY u.url`,
    )
    .all(client, property) as unknown as { url: string }[];
  return rows.map((r) => r.url);
}

/** The exact URL last sent to Google for each normalised URL of a client and property (rows with no record are left out). */
export function lastSentUrls(client: string, property: string): Map<string, string> {
  const rows = db
    .prepare("SELECT url, inspected_url FROM url_inspections WHERE client = ? AND property = ? AND inspected_url IS NOT NULL ORDER BY inspected_at ASC, id ASC")
    .all(client, property) as unknown as { url: string; inspected_url: string }[];
  return new Map(rows.map((r) => [r.url, r.inspected_url]));
}
