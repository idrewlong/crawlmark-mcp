/**
 * Google indexing from stored URL Inspection results (Phase 13, spec 13.5.4 and D14). Pure: the pool
 * ordering for the next inspections, the coverage-state → issue mapping, the aggregation the report
 * section and index_coverage show, the month trend and the technical-issues rows (`gsc_inspection`).
 *
 * Google's Search Console API has no Page indexing report, so this is a sample: key pages, the top Search
 * Console pages and a rotating sample of sitemap URLs, labelled as a sample wherever it's shown.
 */
import { createHash } from "node:crypto";
import type { InspectionRecord, StoredInspection } from "../lib/inspections.js";
import type { IndexingIssuesData, IssueSeverity } from "../reports/report-types.js";
import { normalizeUrl } from "./findings.js";
import type { RawIssue } from "./tech-issues.js";

const DAY_MS = 86_400_000;
const SEVERITIES: IssueSeverity[] = ["critical", "high", "medium", "low"];

export type PoolGroup = "recheck" | "key" | "gsc_top" | "sitemap" | "oldest";
export interface PoolEntry {
  /** The normalised key (how results are stored and looked up). */
  url: string;
  /** The exact URL to send to Google: trailing slash and all (D7). */
  inspectUrl: string;
  group: PoolGroup;
  /** Null when the sitemaps couldn't be read this run (the stored value is kept). */
  inSitemap: boolean | null;
}

/**
 * Whether a URL belongs to a Search Console property (SEC-2): `sc-domain:example.com` covers example.com and its
 * subdomains; a URL-prefix property covers URLs with the same scheme and host whose path starts with its path.
 */
export function inProperty(url: string, property: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (property.startsWith("sc-domain:")) {
    const d = property.slice("sc-domain:".length).toLowerCase().replace(/\.$/, "");
    return Boolean(d) && (host === d || host.endsWith(`.${d}`));
  }
  let p: URL;
  try {
    p = new URL(property);
  } catch {
    return false;
  }
  if (u.protocol !== p.protocol || host !== p.hostname.toLowerCase() || u.port !== p.port) return false;
  const base = p.pathname.endsWith("/") ? p.pathname : `${p.pathname}/`;
  const path = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
  return path.startsWith(base);
}

/** ISO 8601 week, `YYYY-Www` (UTC): the sitemap sample rotates weekly. */
export function isoWeek(now: number): string {
  const d = new Date(now);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday 0
  const thursday = new Date(day - dow * DAY_MS + 3 * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = 1 + Math.floor((thursday.getTime() - yearStart) / (7 * DAY_MS));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** A deterministic shuffle: the same seed gives the same order, a new seed (next week) a new one. */
export function seededOrder(urls: string[], seed: string): string[] {
  const h = (u: string) => createHash("sha256").update(`${seed}\n${u}`).digest("hex");
  return urls.map((u) => [h(u), u] as const).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])).map(([, u]) => u);
}

const withoutFragment = (u: string) => u.trim().replace(/#.*$/, "");

/**
 * D14 pool order: (0) `recheck` URLs (earlier "unknown to Google" results made with a stripped slash) that are in a current
 * source; (1) key pages not inspected within staleDays; (2) the top Search Console pages, same rule;
 * (3) sitemap URLs never inspected, in an order seeded by client + ISO week; (4) the oldest inspected URLs
 * (also only those older than staleDays, so a small site isn't re-inspected the same day). Deduplicated
 * and cut to `max`. URLs outside the Search Console property are never planned.
 */
export function planPool(o: { property: string; keyPages: readonly string[]; gscTop: readonly string[]; sitemapUrls: readonly string[]; sitemapKnown?: boolean; lastInspected: ReadonlyMap<string, number>; now: number; staleDays: number; seed: string; max: number; onlyListed?: boolean; recheck?: readonly string[]; sentUrls?: ReadonlyMap<string, string> }): PoolEntry[] {
  const sitemap = new Set(o.sitemapUrls.map(normalizeUrl));
  // The first raw form of each URL seen in top Search Console pages, then sitemaps, then key pages is what gets inspected:
  // Google's own forms come first, so a key page typed without its trailing slash still sends the slash Google lists.
  const rawBy = new Map<string, string>();
  for (const r of [...o.gscTop, ...o.sitemapUrls, ...o.keyPages]) {
    const k = normalizeUrl(r);
    if (!rawBy.has(k)) rawBy.set(k, withoutFragment(r));
  }
  const fresh = (u: string) => {
    const at = o.lastInspected.get(u);
    return at !== undefined && o.now - at < o.staleDays * DAY_MS;
  };
  const out: PoolEntry[] = [];
  const seen = new Set<string>();
  const add = (raw: string, group: PoolGroup) => {
    if (out.length >= o.max) return;
    const u = normalizeUrl(raw);
    // Only URLs inside the property: Google refuses the rest, and they'd spend the budget.
    if (!/^https?:\/\//i.test(u) || !inProperty(u, o.property) || seen.has(u) || fresh(u)) return;
    seen.add(u);
    out.push({ url: u, inspectUrl: rawBy.get(u) ?? o.sentUrls?.get(u) ?? u, group, inSitemap: o.sitemapKnown === false ? null : sitemap.has(u) });
  };
  for (const u of o.recheck ?? []) if (rawBy.has(normalizeUrl(u))) add(u, "recheck");
  for (const u of o.keyPages) add(u, "key");
  for (const u of o.gscTop) add(u, "gsc_top");
  for (const u of seededOrder([...sitemap].filter((u) => !o.lastInspected.has(u)), o.seed)) add(u, "sitemap");
  // "Check all pages" (onlyListed): the oldest checks only among the key pages, top pages and sitemap URLs, so a full
  // pass covers exactly that set and nothing that has dropped out of it.
  const listed = o.onlyListed ? new Set([...o.keyPages, ...o.gscTop].map(normalizeUrl).concat([...sitemap])) : null;
  for (const [u] of [...o.lastInspected.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))) if (!listed || listed.has(u)) add(u, "oldest");
  return out;
}

/** The unique in-property http(s) URLs among key pages, top Search Console pages and sitemap URLs: what "check all pages" covers. */
export function fullPassSet(o: { property: string; keyPages: readonly string[]; gscTop: readonly string[]; sitemapUrls: readonly string[] }): Set<string> {
  const out = new Set<string>();
  for (const raw of [...o.keyPages, ...o.gscTop, ...o.sitemapUrls]) {
    const u = normalizeUrl(raw);
    if (/^https?:\/\//i.test(u) && inProperty(u, o.property)) out.add(u);
  }
  return out;
}

/** A sitemap URL counts as checked when it had a successful inspection within this many days. */
export const COVERAGE_WINDOW_DAYS = 30;

export interface SitemapProgress {
  /** Sitemap URLs in the property (the newest stored set). */
  sitemapUrls: number;
  /** Of those, how many had a successful inspection within COVERAGE_WINDOW_DAYS. */
  checked: number;
  /** Days since the oldest of those checks (at least 1), or null when none. */
  windowDays: number | null;
  /** Every sitemap URL checked within the window. */
  complete: boolean;
}

/** "N of M sitemap URLs inspected in the last K days" over a sitemap URL set and the latest successful inspection per URL. */
export function sitemapProgress(urls: readonly string[], lastOk: ReadonlyMap<string, number>, now: number): SitemapProgress {
  const set = new Set(urls.map(normalizeUrl));
  let checked = 0;
  let oldest: number | null = null;
  for (const u of set) {
    const at = lastOk.get(u);
    if (at === undefined || now - at > COVERAGE_WINDOW_DAYS * DAY_MS) continue;
    checked++;
    oldest = oldest === null ? at : Math.min(oldest, at);
  }
  return { sitemapUrls: set.size, checked, windowDays: oldest === null ? null : Math.max(1, Math.ceil((now - oldest) / DAY_MS)), complete: set.size > 0 && checked === set.size };
}

/** One line for the tool and the CLI: "all 23 sitemap pages checked (in the last 2 days)" or "120 of 4,000 sitemap URLs checked in the last 30 days". */
export function progressText(p: SitemapProgress): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const days = p.windowDays === null ? "" : ` in the last ${n(p.windowDays)} day${p.windowDays === 1 ? "" : "s"}`;
  if (!p.sitemapUrls) return "No sitemap URLs in this property are known yet.";
  if (p.complete) return `Complete: all ${n(p.sitemapUrls)} sitemap page${p.sitemapUrls === 1 ? "" : "s"} checked${days}.`;
  return `A sample: ${n(p.checked)} of ${n(p.sitemapUrls)} sitemap URLs checked${days || ` in the last ${COVERAGE_WINDOW_DAYS} days`}.`;
}

const FETCH_LABEL: Record<string, string> = { NOT_FOUND: "Not found (404)", BLOCKED_4XX: "Blocked (4xx)", ACCESS_DENIED: "Access denied (401)", ACCESS_FORBIDDEN: "Access forbidden (403)" };

/**
 * Spec 13.5.4: what's wrong with one inspected URL, checked in order (page fetch, robots.txt, noindex, verdict,
 * then the coverage text by keyword), or null when it's indexed. Unknown coverage strings fall back to the
 * enums and the verdict (research Not confirmed 9).
 */
export function coverageIssue(i: Pick<InspectionRecord, "verdict" | "coverageState" | "pageFetchState" | "robotsTxtState" | "indexingState">, ctx: { keyPage: boolean; inSitemap: boolean }): { severity: IssueSeverity; label: string } | null {
  const important = ctx.keyPage || ctx.inSitemap;
  const fetch = i.pageFetchState ?? "";
  if (fetch === "SERVER_ERROR") return { severity: "high", label: "Server error (5xx)" };
  if (FETCH_LABEL[fetch]) return { severity: important ? "high" : "medium", label: FETCH_LABEL[fetch]! };
  if (fetch === "SOFT_404") return { severity: "high", label: "Soft 404" };
  if (fetch === "REDIRECT_ERROR") return { severity: "medium", label: "Redirect error" };
  if (i.robotsTxtState === "DISALLOWED") return { severity: important ? "high" : "low", label: "Blocked by robots.txt" };
  if (i.indexingState === "BLOCKED_BY_META_TAG" || i.indexingState === "BLOCKED_BY_HTTP_HEADER") return { severity: important ? "high" : "low", label: "Excluded by noindex" };
  if (i.verdict === "PASS") return null;
  const cov = i.coverageState ?? "";
  if (!i.verdict && !cov) return null;
  const has = (s: string) => cov.toLowerCase().includes(s.toLowerCase());
  if (has("crawled") && has("not indexed")) return { severity: "medium", label: cov };
  if (has("discovered") && has("not indexed")) return { severity: "medium", label: cov };
  if (has("duplicate")) return { severity: "medium", label: cov };
  if (has("redirect")) return { severity: ctx.inSitemap ? "medium" : "low", label: cov };
  if (has("unknown to google")) return { severity: important ? "medium" : "low", label: cov };
  return { severity: "medium", label: `Not indexed: ${cov || "no coverage state"}` };
}

const canonicalDiffers = (i: Pick<InspectionRecord, "googleCanonical" | "userCanonical">) => Boolean(i.googleCanonical && i.userCanonical && normalizeUrl(i.googleCanonical) !== normalizeUrl(i.userCanonical));

export interface AggregateOptions {
  keyPages: readonly string[];
  limit: number;
  now: number;
}

/** Totals, coverage states, the worst URLs and canonical mismatches over the latest inspection per URL. */
export function aggregateInspections(latest: readonly StoredInspection[], o: AggregateOptions): Pick<IndexingIssuesData, "indexed" | "byCoverage" | "worst" | "canonicalMismatches"> & { keyPages: number; sitemapUrls: number; oldestDays: number | null } {
  const keys = new Set(o.keyPages.map(normalizeUrl));
  const states = new Map<string, { count: number; severity: IssueSeverity | null }>();
  const worst: IndexingIssuesData["worst"] = [];
  let indexed = 0;
  let mismatches = 0;
  let oldest: number | null = null;
  for (const i of latest) {
    const keyPage = keys.has(i.url);
    const issue = coverageIssue(i, { keyPage, inSitemap: i.inSitemap });
    if (i.verdict === "PASS") indexed++;
    if (canonicalDiffers(i)) mismatches++;
    const state = i.coverageState ?? (i.verdict === "PASS" ? "Indexed" : "Unknown");
    const s = states.get(state) ?? { count: 0, severity: null };
    s.count++;
    if (issue && (s.severity === null || SEVERITIES.indexOf(issue.severity) < SEVERITIES.indexOf(s.severity))) s.severity = issue.severity;
    states.set(state, s);
    if (issue) worst.push({ url: i.url, coverage: issue.label, severity: issue.severity, inSitemap: i.inSitemap, keyPage, lastCrawl: i.lastCrawlTime, googleCanonical: canonicalDiffers(i) ? i.googleCanonical : null, inspectedAt: new Date(i.inspectedAt).toISOString() });
    oldest = oldest === null ? i.inspectedAt : Math.min(oldest, i.inspectedAt);
  }
  worst.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || Number(b.keyPage) - Number(a.keyPage) || Number(b.inSitemap) - Number(a.inSitemap) || a.url.localeCompare(b.url));
  const total = latest.length;
  return {
    indexed: { count: indexed, share: total ? Number(((indexed / total) * 100).toFixed(1)) : null },
    byCoverage: [...states.entries()].map(([state, v]) => ({ state, count: v.count, severity: v.severity })).sort((a, b) => b.count - a.count || a.state.localeCompare(b.state)),
    worst: worst.slice(0, o.limit),
    canonicalMismatches: mismatches,
    keyPages: latest.filter((i) => keys.has(i.url)).length,
    sitemapUrls: latest.filter((i) => i.inSitemap).length,
    oldestDays: oldest === null ? null : Math.floor((o.now - oldest) / DAY_MS),
  };
}

/** Per calendar month (UTC), the URLs inspected that month and the share indexed (latest result per URL in the month). Months without inspections are left out. */
export function inspectionTrend(rows: readonly StoredInspection[], months: number, now: number): IndexingIssuesData["trend"] {
  if (months <= 0) return [];
  const d = new Date(now);
  const keys: string[] = [];
  for (let k = months - 1; k >= 0; k--) keys.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)).toISOString().slice(0, 7));
  const byMonth = new Map<string, Map<string, StoredInspection>>();
  for (const r of rows) {
    const m = new Date(r.inspectedAt).toISOString().slice(0, 7);
    if (!keys.includes(m)) continue;
    const urls = byMonth.get(m) ?? new Map<string, StoredInspection>();
    const prev = urls.get(r.url);
    if (!prev || r.inspectedAt >= prev.inspectedAt) urls.set(r.url, r);
    byMonth.set(m, urls);
  }
  return keys.flatMap((m) => {
    const urls = byMonth.get(m);
    if (!urls?.size) return [];
    const pass = [...urls.values()].filter((r) => r.verdict === "PASS").length;
    return [{ month: m, inspected: urls.size, indexedShare: Number(((pass / urls.size) * 100).toFixed(1)) }];
  });
}

/** Technical-issues rows from the latest inspection per URL (source `gsc_inspection`): not indexed, and Google's canonical differing from the page's. */
export function inspectionRawIssues(latest: readonly StoredInspection[], keyPages: readonly string[]): RawIssue[] {
  const keys = new Set(keyPages.map(normalizeUrl));
  const out: RawIssue[] = [];
  for (const i of latest) {
    const issue = coverageIssue(i, { keyPage: keys.has(i.url), inSitemap: i.inSitemap });
    if (issue) out.push({ source: "gsc_inspection", rule: "not-indexed", url: i.url, severity: issue.severity, nativeSeverity: issue.label, title: `Not indexed: ${issue.label}`, count: null });
    if (canonicalDiffers(i)) out.push({ source: "gsc_inspection", rule: "canonical-mismatch", url: i.url, severity: "medium", nativeSeverity: i.coverageState ?? "canonical", title: "Google chose a different canonical than the page declares", count: null });
  }
  return out;
}
