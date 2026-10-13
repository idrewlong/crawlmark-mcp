/**
 * Bing Webmaster Tools data, pure (Phase 12 C3): parse the JSON endpoint's rows
 * (`/Date(ms±hhmm)/` dates, flag-enum crawl issues), match Bing sites to a
 * client by host, and aggregate rows into windows. No I/O. Every string that
 * came from Bing (queries, URLs, site URLs) goes through stripControl here and
 * is capped in length, so callers and renderers only ever see clean text.
 *
 * Shapes are from Microsoft's IWebmasterApi reference (docs/research/2026-10-13-phase-12-apis.md, B4-B8).
 */
import { normalizeHost } from "../lib/clients.js";
import { pctChange, previousRange, rangeDays, type DateRange } from "../lib/dates.js";
import { stripControl } from "../lib/terminal-text.js";

/** Untrusted text from Bing: control and format characters removed, whitespace collapsed, capped. */
export function cleanText(v: unknown, max: number): string {
  const s = stripControl(typeof v === "string" ? v : v === undefined || v === null ? "" : String(v)).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) : s;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * A WCF JSON date, `/Date(1316156400000-0700)/`, to the calendar day it names (YYYY-MM-DD).
 * The milliseconds are UTC; the offset is the zone the day belongs to, so 1316156400000-0700
 * (07:00 UTC) is 2011-09-16 at midnight in UTC-7. ISO strings (the XML form) are accepted too.
 * Returns null for anything else.
 */
export function parseBingDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^\/Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)\/$/.exec(v.trim());
  if (m) {
    const ms = Number(m[1]);
    const offsetMin = m[2] ? (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4])) : 0;
    const d = new Date(ms + offsetMin * 60_000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const iso = /^(\d{4}-\d{2}-\d{2})T/.exec(v.trim());
  return iso ? iso[1]! : null;
}

// ---------------------------------------------------------------- sites

export interface BingSite {
  url: string;
  verified: boolean;
}

/** GetUserSites rows to sites. Only Url and IsVerified are kept; the verification codes are dropped here. */
export function parseUserSites(d: unknown): BingSite[] {
  if (!Array.isArray(d)) return [];
  return d.flatMap((row) => {
    const r = row as { Url?: unknown; IsVerified?: unknown };
    const url = cleanText(r.Url, 2000);
    return url ? [{ url, verified: r.IsVerified === true }] : [];
  });
}

/** Rank sites for one host: https first, then the root path, then the shortest URL. */
function siteRank(url: string): [number, number, number, string] {
  let root = 1;
  try {
    root = new URL(url).pathname === "/" ? 0 : 1;
  } catch {
    /* unparseable: rank last */
  }
  return [url.startsWith("https://") ? 0 : 1, root, url.length, url];
}

/**
 * True when a Bing site URL is on the client's domain or a subdomain of it (www. is ignored). A bingSite on
 * another host would mix another site's data into this client's reports, so it is refused (SEC-2).
 */
export function bingSiteOnDomain(site: string, domain: string): boolean {
  const host = normalizeHost(site);
  return host !== undefined && (host === domain || host.endsWith(`.${domain}`));
}

export type SiteMatch =
  | { ok: true; site: string; source: "bingSite" | "matched"; alternates: string[] }
  | { ok: false; reason: "override-other-host" | "override-not-found" | "override-unverified" | "no-match" | "unverified"; unverified: string[] };

/**
 * The Bing site for a client. A clients.yaml `bingSite` wins and must be one of this key's sites and verified
 * (compared ignoring a trailing slash and case). Otherwise the verified sites whose host normalises to the
 * client's domain (the same normaliser Search Console discovery uses), best ranked first.
 */
export function matchBingSite(sites: BingSite[], client: { domain: string; bingSite?: string | undefined }): SiteMatch {
  const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
  if (client.bingSite) {
    if (!bingSiteOnDomain(client.bingSite, client.domain)) return { ok: false, reason: "override-other-host", unverified: [] };
    const hit = sites.find((s) => norm(s.url) === norm(client.bingSite!));
    if (!hit) return { ok: false, reason: "override-not-found", unverified: [] };
    if (!hit.verified) return { ok: false, reason: "override-unverified", unverified: [hit.url] };
    return { ok: true, site: hit.url, source: "bingSite", alternates: [] };
  }
  const forHost = sites.filter((s) => normalizeHost(s.url) === client.domain);
  const verified = forHost.filter((s) => s.verified).sort((a, b) => {
    const x = siteRank(a.url);
    const y = siteRank(b.url);
    for (let i = 0; i < x.length; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]! ? -1 : 1;
    return 0;
  });
  if (verified.length) return { ok: true, site: verified[0]!.url, source: "matched", alternates: verified.slice(1).map((s) => s.url) };
  const unverified = forHost.filter((s) => !s.verified).map((s) => s.url);
  return { ok: false, reason: unverified.length ? "unverified" : "no-match", unverified };
}

// ---------------------------------------------------------------- traffic

export interface DayTraffic {
  date: string;
  clicks: number;
  impressions: number;
}

/** GetRankAndTrafficStats rows to days (rows with no readable date are dropped; repeated days are summed), ascending. */
export function parseTraffic(d: unknown): DayTraffic[] {
  const byDay = new Map<string, DayTraffic>();
  for (const row of Array.isArray(d) ? d : []) {
    const r = row as { Date?: unknown; Clicks?: unknown; Impressions?: unknown };
    const date = parseBingDate(r.Date);
    if (!date) continue;
    const cur = byDay.get(date) ?? { date, clicks: 0, impressions: 0 };
    cur.clicks += num(r.Clicks);
    cur.impressions += num(r.Impressions);
    byDay.set(date, cur);
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface StatRow {
  /** The query (GetQueryStats) or page URL (GetPageStats). */
  key: string;
  date: string;
  clicks: number;
  impressions: number;
  avgImpressionPosition: number | null;
}

/** GetQueryStats / GetPageStats rows (both `QueryStats`; the page URL is in `Query`). */
export function parseStatRows(d: unknown, maxKey: number): StatRow[] {
  return (Array.isArray(d) ? d : []).flatMap((row) => {
    const r = row as { Query?: unknown; Date?: unknown; Clicks?: unknown; Impressions?: unknown; AvgImpressionPosition?: unknown };
    const key = cleanText(r.Query, maxKey);
    const date = parseBingDate(r.Date);
    if (!key || !date) return [];
    const pos = num(r.AvgImpressionPosition);
    return [{ key, date, clicks: num(r.Clicks), impressions: num(r.Impressions), avgImpressionPosition: pos > 0 ? pos : null }];
  });
}

const inRange = (date: string, r: DateRange) => date >= r.startDate && date <= r.endDate;
const round = (n: number, digits: number) => Number(n.toFixed(digits));

export interface TopRow {
  clicks: number;
  impressions: number;
  /** Impression-weighted average of Bing's AvgImpressionPosition; null when Bing gave none. */
  avgPosition: number | null;
}

/** Sum stat rows inside `window` per key, top `limit` by clicks then impressions. */
export function topRows(rows: StatRow[], window: DateRange, limit: number): (TopRow & { key: string })[] {
  const acc = new Map<string, { clicks: number; impressions: number; posW: number; posImp: number }>();
  for (const r of rows) {
    if (!inRange(r.date, window)) continue;
    const a = acc.get(r.key) ?? { clicks: 0, impressions: 0, posW: 0, posImp: 0 };
    a.clicks += r.clicks;
    a.impressions += r.impressions;
    if (r.avgImpressionPosition !== null && r.impressions > 0) {
      a.posW += r.avgImpressionPosition * r.impressions;
      a.posImp += r.impressions;
    }
    acc.set(r.key, a);
  }
  return [...acc.entries()]
    .map(([key, a]) => ({ key, clicks: a.clicks, impressions: a.impressions, avgPosition: a.posImp > 0 ? round(a.posW / a.posImp, 1) : null }))
    .sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions || (x.key < y.key ? -1 : 1))
    .slice(0, limit);
}

export interface Totals {
  clicks: number;
  impressions: number;
  /** Percent, two decimals (as Search Console totals are reported elsewhere in crawlmark). */
  ctr: number;
}

export function totalsFor(days: DayTraffic[], window: DateRange): Totals & { daysWithData: number } {
  const inside = days.filter((d) => inRange(d.date, window));
  const clicks = inside.reduce((n, d) => n + d.clicks, 0);
  const impressions = inside.reduce((n, d) => n + d.impressions, 0);
  return { clicks, impressions, ctr: impressions > 0 ? round((clicks / impressions) * 100, 2) : 0, daysWithData: inside.length };
}

export interface TotalsChange {
  /** Percent change; null when the previous window had no impressions. */
  clicks: number | null;
  impressions: number | null;
  /** Percentage points. */
  ctr: number | null;
}

export function changeOf(cur: Totals, prev: Totals): TotalsChange {
  if (prev.impressions <= 0) return { clicks: null, impressions: null, ctr: null };
  return { clicks: pctChange(cur.clicks, prev.clicks), impressions: pctChange(cur.impressions, prev.impressions), ctr: round(cur.ctr - prev.ctr, 2) };
}

/**
 * The `days`-day window ending on the newest day Bing has traffic for (else `fallbackEnd`), and the
 * equal window before it.
 */
export function windowsFor(days: DayTraffic[], n: number, fallbackEnd: string): { window: DateRange; previous: DateRange } {
  const end = days.at(-1)?.date ?? fallbackEnd;
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const window = { startDate: new Date(endMs - (n - 1) * 86_400_000).toISOString().slice(0, 10), endDate: end };
  return { window, previous: previousRange(window) };
}

/** A note when a window reaches before the first day Bing returned (its history is limited). */
export function coverageNote(days: DayTraffic[], r: DateRange, label: string): string | undefined {
  const first = days[0]?.date;
  if (!first) return undefined;
  if (r.startDate < first) {
    return r.endDate < first
      ? `Bing returned no traffic for the ${label} (${r.startDate} to ${r.endDate}); its data starts on ${first}.`
      : `Bing's traffic data starts on ${first}, so the ${label} (${rangeDays(r)} days from ${r.startDate}) is partly missing.`;
  }
  return undefined;
}

// ---------------------------------------------------------------- crawl

export interface CrawlStat {
  date: string;
  crawledPages: number;
  crawlErrors: number;
  inIndex: number;
  inLinks: number;
  code2xx: number;
  code301: number;
  code302: number;
  code4xx: number;
  code5xx: number;
  blockedByRobotsTxt: number;
  containsMalware: number;
  allOtherCodes: number;
}

/** GetCrawlStats rows to days, ascending. */
export function parseCrawlStats(d: unknown): CrawlStat[] {
  return (Array.isArray(d) ? d : [])
    .flatMap((row) => {
      const r = row as Record<string, unknown>;
      const date = parseBingDate(r.Date);
      if (!date) return [];
      return [
        {
          date,
          crawledPages: num(r.CrawledPages),
          crawlErrors: num(r.CrawlErrors),
          inIndex: num(r.InIndex),
          inLinks: num(r.InLinks),
          code2xx: num(r.Code2xx),
          code301: num(r.Code301),
          code302: num(r.Code302),
          code4xx: num(r.Code4xx),
          code5xx: num(r.Code5xx),
          blockedByRobotsTxt: num(r.BlockedByRobotsTxt),
          containsMalware: num(r.ContainsMalware),
          allOtherCodes: num(r.AllOtherCodes),
        },
      ];
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The stats for the 30 days ending on the newest day returned. */
export function latestCrawlStats(stats: CrawlStat[], days = 30): CrawlStat[] {
  const last = stats.at(-1)?.date;
  if (!last) return [];
  const from = new Date(Date.parse(`${last}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return stats.filter((s) => s.date >= from);
}

/** UrlWithCrawlIssues.CrawlIssues, a [Flags] enum (B8), with readable labels. */
export const CRAWL_ISSUE_FLAGS: readonly { name: string; value: number; label: string }[] = [
  { name: "Code301", value: 1, label: "301 redirect" },
  { name: "Code302", value: 2, label: "302 redirect" },
  { name: "Code4xx", value: 4, label: "4xx error" },
  { name: "Code5xx", value: 8, label: "5xx error" },
  { name: "BlockedByRobotsTxt", value: 16, label: "blocked by robots.txt" },
  { name: "ContainsMalware", value: 32, label: "contains malware" },
  { name: "ImportantUrlBlockedByRobotsTxt", value: 64, label: "important URL blocked by robots.txt" },
  { name: "DnsErrors", value: 128, label: "DNS error" },
  { name: "TimeOutErrors", value: 256, label: "timed out" },
];

/** The issue labels in a CrawlIssues value: a number (JSON) or flag names (the XML form, "Code4xx, ContainsMalware"). */
export function crawlIssueLabels(v: unknown): string[] {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) {
    const labels = CRAWL_ISSUE_FLAGS.filter((f) => (v & f.value) !== 0).map((f) => f.label);
    const known = CRAWL_ISSUE_FLAGS.reduce((n, f) => n | f.value, 0);
    return (v & ~known) !== 0 ? [...labels, "other issue"] : labels;
  }
  if (typeof v === "string") {
    return v
      .split(/[\s,|]+/)
      .filter(Boolean)
      .map((name) => CRAWL_ISSUE_FLAGS.find((f) => f.name.toLowerCase() === name.toLowerCase())?.label ?? (name === "None" ? "" : "other issue"))
      .filter(Boolean);
  }
  return [];
}

export interface CrawlIssue {
  url: string;
  issue: string;
  httpCode: number | null;
  inLinks: number;
}

/** GetCrawlIssues rows, most-linked first (URLs with no recognised issue are dropped). */
export function parseCrawlIssues(d: unknown): CrawlIssue[] {
  return (Array.isArray(d) ? d : [])
    .flatMap((row) => {
      const r = row as { Url?: unknown; Issues?: unknown; HttpCode?: unknown; InLinks?: unknown };
      const url = cleanText(r.Url, 2000);
      const labels = crawlIssueLabels(r.Issues);
      if (!url || !labels.length) return [];
      const code = num(r.HttpCode);
      return [{ url, issue: labels.join(", "), httpCode: code > 0 ? code : null, inLinks: num(r.InLinks) }];
    })
    .sort((a, b) => b.inLinks - a.inLinks || (a.url < b.url ? -1 : 1));
}
