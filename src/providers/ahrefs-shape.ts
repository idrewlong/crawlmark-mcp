/**
 * Pure Ahrefs API v3 helpers (Phase 9): request parameters, field costs, unit
 * estimates, units from response headers, the error classifier and the mappers to
 * crawlmark's existing types. No I/O.
 *
 * Source of truth: docs/research/ahrefs-api-v3.md (Ahrefs' OpenAPI spec and guides,
 * accessed 2026-10-13). Parameter names, enums, field costs and headers come from
 * there; anything listed under its "Not confirmed" takes the spec's safe reading
 * (specs/2026-10-13-1500-phase-9-seo-data-providers.md 9.11 N1-N6), marked below.
 */
import { stripControl } from "../lib/terminal-text.js";
import type { KeywordVolume } from "./dataforseo.js";
import type { BacklinksSummary, CompetitorsResult, RankedKeywordsResult } from "./dataforseo-shape.js";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

// ------------------------------------------------------------------ endpoints and fields

export const AHREFS_PATHS = {
  limitsAndUsage: "/subscription-info/limits-and-usage",
  organicKeywords: "/site-explorer/organic-keywords",
  organicCompetitors: "/site-explorer/organic-competitors",
  backlinksStats: "/site-explorer/backlinks-stats",
  domainRating: "/site-explorer/domain-rating",
  keywordsOverview: "/keywords-explorer/overview",
  relatedTerms: "/keywords-explorer/related-terms",
  matchingTerms: "/keywords-explorer/matching-terms",
  // Phase 13 B (research §3, A3)
  metrics: "/site-explorer/metrics",
  metricsHistory: "/site-explorer/metrics-history",
  keywordsHistory: "/site-explorer/keywords-history",
  refdomainsHistory: "/site-explorer/refdomains-history",
  domainRatingHistory: "/site-explorer/domain-rating-history",
} as const;

/** Per-row field costs documented by Ahrefs ("(10 units)" in each field's description); every other field costs 1. */
export const AHREFS_FIELD_UNITS: Readonly<Record<string, number>> = {
  volume: 10,
  sum_traffic: 10,
  traffic: 10,
  difficulty: 10,
  keyword_difficulty: 10,
  global_volume: 10,
  live_refdomains: 5,
  all_time_refdomains: 5,
  // Phase 13 B
  org_traffic: 10,
  org_cost: 10,
  paid_traffic: 10,
  paid_cost: 10,
  refdomains: 5,
};

/** The documented base cost: every request costs at least this. */
export const AHREFS_MIN_UNITS = 50;

/** Per-row cost of the unique fields in `select`/`where`/`order_by` (a field used twice counts once). */
export function ahrefsRowCost(fields: readonly string[]): number {
  return [...new Set(fields)].reduce((sum, f) => sum + (AHREFS_FIELD_UNITS[f] ?? 1), 0);
}

/** `max(50, per-row cost × rows)`, the documented formula. */
export function estimateAhrefsUnits(fields: readonly string[], rows: number): number {
  return Math.max(AHREFS_MIN_UNITS, ahrefsRowCost(fields) * Math.max(0, rows));
}

/** The order_by field names (`volume:desc,x:asc` -> volume, x). */
const orderFields = (orderBy: string) => orderBy.split(",").map((p) => p.split(":")[0]!.trim()).filter(Boolean);

export const RANKED_SELECT = ["keyword", "best_position", "best_position_url", "volume", "sum_traffic"] as const;
export const RANKED_ORDER = "volume:desc";
export const COMPETITORS_SELECT = ["competitor_domain", "keywords_common", "traffic"] as const;
export const COMPETITORS_ORDER = "keywords_common:desc";
export const VOLUME_SELECT = ["keyword", "volume", "cpc"] as const;
/** backlinks-stats has no select; all four fields come back (1+1+5+5 = 12 per row, one row). */
export const BACKLINKS_FIELDS = ["live", "all_time", "live_refdomains", "all_time_refdomains"] as const;
/** Keywords per keywords-explorer overview request (N4: no documented cap; the spec uses 100). */
export const AHREFS_KEYWORD_BATCH = 100;

/** Phase 12 B: keyword ideas (related-terms / matching-terms): 1 + 10 + 10 + 1 = 22 units per row (research A1). */
export const IDEAS_SELECT = ["keyword", "volume", "difficulty", "cpc"] as const;
export const IDEAS_ORDER = "volume:desc";
/** Phase 12 B: keyword gap rows from organic-keywords: 1 + 1 + 1 + 10 = 13 units per row (spec 12.B.2). */
export const GAP_SELECT = ["keyword", "best_position", "best_position_url", "volume"] as const;
export const GAP_ORDER = "volume:desc";
/** Without Search Console, the gap reads the client's own organic keywords: one call of this many rows. */
export const AHREFS_GAP_CLIENT_ROWS = 1000;

export const rankedFields = () => [...RANKED_SELECT, ...orderFields(RANKED_ORDER)];
export const ideasFields = () => [...IDEAS_SELECT, ...orderFields(IDEAS_ORDER)];
export const gapFields = () => [...GAP_SELECT, ...orderFields(GAP_ORDER)];
export const competitorFields = () => [...COMPETITORS_SELECT, ...orderFields(COMPETITORS_ORDER)];

/** Pre-flight estimates (spec 9.4): conservative ceilings using `limit` as the row count. */
export const ahrefsEstimates = {
  rankedKeywords: (limit: number) => estimateAhrefsUnits(rankedFields(), limit),
  competitorDomains: (limit: number) => estimateAhrefsUnits(competitorFields(), limit),
  keywordBatch: (keywords: number) => estimateAhrefsUnits(VOLUME_SELECT, keywords),
  backlinksStats: () => estimateAhrefsUnits(BACKLINKS_FIELDS, 1),
  /** The documented 50-unit-minimum example (2 fields, 1 row). */
  domainRating: () => AHREFS_MIN_UNITS,
  /** max(50, 22 x limit): one request with every seed. */
  keywordIdeas: (limit: number) => estimateAhrefsUnits(ideasFields(), limit),
  /** max(50, 13 x limit) per competitor. */
  gapCompetitor: (limit: number) => estimateAhrefsUnits(gapFields(), limit),
  /** max(50, 13 x 1000): the client's own keywords when Search Console isn't available. */
  gapClient: () => estimateAhrefsUnits(gapFields(), AHREFS_GAP_CLIENT_ROWS),
};

// ------------------------------------------------------------------ request parameters

export interface AhrefsParams {
  path: string;
  params: Record<string, string>;
}

/** Ranked keywords: `country` (lowercase), `date`, `limit` and `volume_mode=average` are always sent. */
export function organicKeywordsRequest(o: { target: string; country: string; date: string; limit: number }): AhrefsParams {
  return {
    path: AHREFS_PATHS.organicKeywords,
    params: {
      select: RANKED_SELECT.join(","),
      target: o.target,
      country: o.country,
      date: o.date,
      mode: "subdomains",
      volume_mode: "average",
      order_by: RANKED_ORDER,
      limit: String(o.limit),
    },
  };
}

/** Organic competitors: `country` is required here. */
export function organicCompetitorsRequest(o: { target: string; country: string; date: string; limit: number }): AhrefsParams {
  return {
    path: AHREFS_PATHS.organicCompetitors,
    params: {
      select: COMPETITORS_SELECT.join(","),
      target: o.target,
      country: o.country,
      date: o.date,
      mode: "subdomains",
      order_by: COMPETITORS_ORDER,
      limit: String(o.limit),
    },
  };
}

/** Keyword ideas: related-terms (`terms=also_rank_for`) or matching-terms (`match_mode=terms`), every seed in one request. */
export function keywordIdeasRequest(o: { mode: "related" | "matching"; keywords: readonly string[]; country: string; limit: number }): AhrefsParams {
  const base = { select: IDEAS_SELECT.join(","), country: o.country, keywords: o.keywords.join(","), order_by: IDEAS_ORDER, limit: String(o.limit) };
  return o.mode === "related"
    ? { path: AHREFS_PATHS.relatedTerms, params: { ...base, terms: "also_rank_for" } }
    : { path: AHREFS_PATHS.matchingTerms, params: { ...base, match_mode: "terms" } };
}

/** One domain's organic keywords for the gap (select exactly keyword,best_position,best_position_url,volume). */
export function gapKeywordsRequest(o: { target: string; country: string; date: string; limit: number }): AhrefsParams {
  return {
    path: AHREFS_PATHS.organicKeywords,
    params: { select: GAP_SELECT.join(","), target: o.target, country: o.country, date: o.date, mode: "subdomains", volume_mode: "average", order_by: GAP_ORDER, limit: String(o.limit) },
  };
}

export function keywordsOverviewRequest(o: { keywords: readonly string[]; country: string }): AhrefsParams {
  return {
    path: AHREFS_PATHS.keywordsOverview,
    params: { select: VOLUME_SELECT.join(","), country: o.country, keywords: o.keywords.join(","), limit: String(o.keywords.length) },
  };
}

export function backlinksStatsRequest(o: { target: string; date: string }): AhrefsParams {
  return { path: AHREFS_PATHS.backlinksStats, params: { target: o.target, date: o.date, mode: "subdomains" } };
}

export function domainRatingRequest(o: { target: string; date: string }): AhrefsParams {
  return { path: AHREFS_PATHS.domainRating, params: { target: o.target, date: o.date } };
}

// ------------------------------------------------------------------ units and errors

type HeaderSource = { get(name: string): string | null };

/**
 * Units a response actually cost, from the documented headers: `x-api-cache: hit`
 * is free; else `x-api-units-cost-total-actual`, else `x-api-units-cost-total`
 * (N5: the -actual header may be missing). Null when neither is present.
 */
export function unitsFromHeaders(h: HeaderSource): number | null {
  if (h.get("x-api-cache")?.trim().toLowerCase() === "hit") return 0;
  for (const name of ["x-api-units-cost-total-actual", "x-api-units-cost-total"]) {
    const v = h.get(name);
    if (v !== null && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

export type AhrefsErrorKind = "auth" | "rate" | "request" | "server";

export interface AhrefsErrorInfo {
  kind: AhrefsErrorKind;
  message: string;
}

/** The vendor text from an error body (`{ "error": string }`, documented for 400/401/403/429/500), else the raw text. */
export function ahrefsErrorText(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown };
    if (typeof j?.error === "string") return j.error;
  } catch {
    /* not JSON */
  }
  return body;
}

/**
 * Map a non-2xx Ahrefs response to the message the user sees (spec 9.2). `vendor` is
 * already redacted. N1: 401 vs 403 for a bad key isn't documented, so both are "key rejected".
 */
export function classifyAhrefsError(status: number, vendor: string, endpoint: string): AhrefsErrorInfo {
  const text = vendor || `HTTP ${status}`;
  if (status === 401 || status === 403) {
    return { kind: "auth", message: `Ahrefs rejected the API key (AHREFS_API_KEY): ${text}. Create one under Account settings > API keys.` };
  }
  if (status === 429) return { kind: "rate", message: "Ahrefs rate limit hit (60 requests/min by default); try again in a minute." };
  if (status === 400) {
    return { kind: "request", message: `Ahrefs rejected the request: ${text}. This is likely a crawlmark bug (endpoint ${endpoint}); please report it.` };
  }
  return { kind: "server", message: `Ahrefs ${endpoint} returned HTTP ${status}: ${text}` };
}

// ------------------------------------------------------------------ mappers

export interface RawAhrefsKeywordsOverview {
  keywords?: { keyword?: string | null; volume?: number | null; cpc?: number | null }[] | null;
}

/**
 * Keywords Explorer overview -> KeywordVolume. `cpc` is USD cents (-> dollars);
 * `volume` is the 12-month average; competition isn't supplied (null). A requested
 * keyword with no row comes back with null values, in request order.
 */
export function mapAhrefsKeywordVolumes(raw: RawAhrefsKeywordsOverview | undefined, requested: readonly string[]): KeywordVolume[] {
  const byKey = new Map<string, KeywordVolume>();
  for (const r of raw?.keywords ?? []) {
    const keyword = str(r.keyword);
    if (!keyword) continue;
    const cents = num(r.cpc);
    byKey.set(keyword.toLowerCase(), { keyword, search_volume: num(r.volume), competition: null, cpc: cents === null ? null : Math.round(cents) / 100 });
  }
  return requested.map((k) => byKey.get(k.toLowerCase()) ?? { keyword: k, search_volume: null, competition: null, cpc: null });
}

export interface RawAhrefsOrganicKeywords {
  keywords?: { keyword?: string | null; best_position?: number | null; best_position_url?: string | null; volume?: number | null; sum_traffic?: number | null }[] | null;
}

/** Site Explorer organic-keywords -> RankedKeywordsResult. totalCount is the rows returned (Ahrefs gives no total; N3). */
export function mapAhrefsRankedKeywords(raw: RawAhrefsOrganicKeywords | undefined, target: string): RankedKeywordsResult {
  const items = (raw?.keywords ?? []).flatMap((r) => {
    const keyword = str(r.keyword);
    return keyword
      ? [{ keyword, position: num(r.best_position), searchVolume: num(r.volume), url: str(r.best_position_url), estimatedTraffic: num(r.sum_traffic) }]
      : [];
  });
  return { target, totalCount: items.length, items };
}

export interface RawAhrefsCompetitors {
  competitors?: { competitor_domain?: string | null; keywords_common?: number | null; traffic?: number | null }[] | null;
}

/** Site Explorer organic-competitors -> CompetitorsResult. Rows with a null competitor_domain are dropped; avgPosition is null. */
export function mapAhrefsCompetitors(raw: RawAhrefsCompetitors | undefined, target: string): CompetitorsResult {
  const items = (raw?.competitors ?? []).flatMap((r) => {
    const domain = str(r.competitor_domain);
    return domain ? [{ domain, intersectingKeywords: num(r.keywords_common), avgPosition: null, estimatedTraffic: num(r.traffic) }] : [];
  });
  return { target, totalCount: items.length, items };
}

export interface RawAhrefsBacklinksStats {
  metrics?: { live?: number | null; all_time?: number | null; live_refdomains?: number | null; all_time_refdomains?: number | null } | null;
}
export interface RawAhrefsDomainRating {
  domain_rating?: { domain_rating?: number | null; ahrefs_rank?: number | null } | null;
}

/** backlinks-stats + domain-rating -> BacklinksSummary with a `domain_rating` authority. Rank and spam score stay DataForSEO-only (null). */
export function mapAhrefsBacklinks(
  stats: RawAhrefsBacklinksStats | undefined,
  dr: RawAhrefsDomainRating | undefined,
  target: string,
): BacklinksSummary & { authority: { metric: "domain_rating"; value: number | null } } {
  return {
    target,
    backlinks: num(stats?.metrics?.live),
    referringDomains: num(stats?.metrics?.live_refdomains),
    rank: null,
    spamScore: null,
    newBacklinks: null,
    lostBacklinks: null,
    authority: { metric: "domain_rating", value: num(dr?.domain_rating?.domain_rating) },
  };
}

export interface RawAhrefsLimitsAndUsage {
  limits_and_usage?: {
    subscription?: string | null;
    usage_reset_date?: string | null;
    units_limit_workspace?: number | null;
    units_usage_workspace?: number | null;
    units_limit_api_key?: number | null;
    units_usage_api_key?: number | null;
    api_key_expiration_date?: string | null;
  } | null;
}

export interface AhrefsAccount {
  plan: string | null;
  resetDate: string | null;
  unitsLimitWorkspace: number | null;
  unitsUsageWorkspace: number | null;
  /** null means the key has no limit of its own (the workspace numbers apply). */
  unitsLimitApiKey: number | null;
  unitsUsageApiKey: number | null;
  keyExpires: string | null;
}

export function mapAhrefsAccount(raw: RawAhrefsLimitsAndUsage | undefined): AhrefsAccount {
  const l = raw?.limits_and_usage;
  return {
    plan: str(l?.subscription),
    resetDate: str(l?.usage_reset_date),
    unitsLimitWorkspace: num(l?.units_limit_workspace),
    unitsUsageWorkspace: num(l?.units_usage_workspace),
    unitsLimitApiKey: num(l?.units_limit_api_key),
    unitsUsageApiKey: num(l?.units_usage_api_key),
    keyExpires: str(l?.api_key_expiration_date),
  };
}

/** "plan Standard, key 1,200 of 50,000 units used (resets 2026-11-01)"; workspace numbers when the key has no limit. */
export function describeAhrefsAccount(a: AhrefsAccount): string {
  const fmt = (n: number | null) => (n === null ? "?" : n.toLocaleString("en-US"));
  const usage =
    a.unitsLimitApiKey !== null
      ? `key ${fmt(a.unitsUsageApiKey)} of ${fmt(a.unitsLimitApiKey)} units used`
      : `workspace ${fmt(a.unitsUsageWorkspace)} of ${fmt(a.unitsLimitWorkspace)} units used`;
  return `plan ${a.plan ?? "unknown"}, ${usage}${a.resetDate ? ` (resets ${a.resetDate})` : ""}`;
}

// ------------------------------------------------------------------ keyword ideas and gap (Phase 12 B)

export interface RawAhrefsTerms {
  keywords?: { keyword?: string | null; volume?: number | null; difficulty?: number | null; cpc?: number | null }[] | null;
}

/** related-terms / matching-terms rows -> ideas. cpc is USD cents (-> dollars); competition and intent aren't requested (null). */
export function mapAhrefsIdeas(raw: RawAhrefsTerms | undefined, seed: string | null) {
  return (raw?.keywords ?? []).flatMap((r) => {
    const keyword = str(r.keyword)?.replace(/\s+/g, " ").trim();
    if (!keyword) return [];
    const cents = num(r.cpc);
    return [{ keyword, volume: num(r.volume), cpc: cents === null ? null : Math.round(cents) / 100, competition: null, difficulty: { metric: "ahrefs_kd" as const, value: num(r.difficulty) }, intent: null, seed }];
  });
}

export interface RawAhrefsGapKeywords {
  keywords?: { keyword?: string | null; best_position?: number | null; best_position_url?: string | null; volume?: number | null }[] | null;
}

/** organic-keywords gap rows (difficulty isn't selected for the gap: null). */
export function mapAhrefsGapRows(raw: RawAhrefsGapKeywords | undefined) {
  return (raw?.keywords ?? []).flatMap((r) => {
    const keyword = str(r.keyword)?.replace(/\s+/g, " ").trim();
    return keyword ? [{ keyword, volume: num(r.volume), difficulty: null, position: num(r.best_position), url: str(r.best_position_url) }] : [];
  });
}

// ------------------------------------------------------------------ Phase 13 B: visibility, history, competitors

export const AHREFS_TRAFFIC_LABEL = "Ahrefs organic traffic";
/** `metrics` has no select: every field comes back (org_cost, org_traffic, paid_cost and paid_traffic at 10 each), one row: 50. */
export const METRICS_FIELDS = ["org_cost", "org_keywords", "org_keywords_1_3", "org_traffic", "paid_cost", "paid_keywords", "paid_pages", "paid_traffic"] as const;
export const KEYWORDS_HISTORY_SELECT = ["date", "top3", "top4_10", "top11_20", "top21_50", "top51_plus"] as const;
export const METRICS_HISTORY_SELECT = ["date", "org_traffic"] as const;
/** refdomains-history and domain-rating-history take no select; these are the fields they return. */
export const REFDOMAINS_HISTORY_FIELDS = ["date", "refdomains"] as const;
export const DR_HISTORY_FIELDS = ["date", "domain_rating"] as const;
export const ORGANIC_COMPETITORS_SELECT = ["competitor_domain", "keywords_common", "keywords_competitor", "share", "domain_rating", "traffic"] as const;
export const ORGANIC_COMPETITORS_ORDER = "keywords_common:desc";
/** Rows asked of organic-competitors: at least 20 (spec 13.4). */
export const ahrefsCompetitorRows = (limit: number) => Math.max(limit, 20);

export const p13AhrefsEstimates = {
  /** metrics (50) + keywords-history for the latest month (6 fields, 1 row: 50) = 100. */
  organicOverview: () => estimateAhrefsUnits(METRICS_FIELDS, 1) + estimateAhrefsUnits(KEYWORDS_HISTORY_SELECT, 1),
  /** keywords-history (6 × months) + metrics-history (11 × months): 78 + 143 = 221 for 13 months. */
  organicHistory: (months: number) => estimateAhrefsUnits(KEYWORDS_HISTORY_SELECT, months) + estimateAhrefsUnits(METRICS_HISTORY_SELECT, months),
  /** refdomains-history (6 × months) + domain-rating-history (2 × months, at least 50). */
  backlinksHistory: (months: number) => estimateAhrefsUnits(REFDOMAINS_HISTORY_FIELDS, months) + estimateAhrefsUnits(DR_HISTORY_FIELDS, months),
  /** organic-competitors (15 × rows; 300 for 20) + metrics (50) per saved competitor the list may miss (a ceiling). */
  competitorOverview: (limit: number, saved: number) => estimateAhrefsUnits([...ORGANIC_COMPETITORS_SELECT, "keywords_common"], ahrefsCompetitorRows(limit)) + saved * estimateAhrefsUnits(METRICS_FIELDS, 1),
  metricsOne: () => estimateAhrefsUnits(METRICS_FIELDS, 1),
};

export function metricsRequest(o: { target: string; country: string; date: string }): AhrefsParams {
  return { path: AHREFS_PATHS.metrics, params: { target: o.target, date: o.date, country: o.country, mode: "subdomains" } };
}
export function keywordsHistoryRequest(o: { target: string; country: string; dateFrom: string; dateTo: string }): AhrefsParams {
  return { path: AHREFS_PATHS.keywordsHistory, params: { select: KEYWORDS_HISTORY_SELECT.join(","), target: o.target, country: o.country, date_from: o.dateFrom, date_to: o.dateTo, history_grouping: "monthly", mode: "subdomains" } };
}
export function metricsHistoryRequest(o: { target: string; country: string; dateFrom: string; dateTo: string }): AhrefsParams {
  return { path: AHREFS_PATHS.metricsHistory, params: { select: METRICS_HISTORY_SELECT.join(","), target: o.target, country: o.country, date_from: o.dateFrom, date_to: o.dateTo, history_grouping: "monthly", mode: "subdomains" } };
}
export function refdomainsHistoryRequest(o: { target: string; dateFrom: string; dateTo: string }): AhrefsParams {
  return { path: AHREFS_PATHS.refdomainsHistory, params: { target: o.target, date_from: o.dateFrom, date_to: o.dateTo, history_grouping: "monthly", mode: "subdomains" } };
}
export function domainRatingHistoryRequest(o: { target: string; dateFrom: string; dateTo: string }): AhrefsParams {
  return { path: AHREFS_PATHS.domainRatingHistory, params: { target: o.target, date_from: o.dateFrom, date_to: o.dateTo, history_grouping: "monthly" } };
}
export function organicCompetitorsFullRequest(o: { target: string; country: string; date: string; limit: number }): AhrefsParams {
  return {
    path: AHREFS_PATHS.organicCompetitors,
    params: { select: ORGANIC_COMPETITORS_SELECT.join(","), target: o.target, country: o.country, date: o.date, mode: "subdomains", order_by: ORGANIC_COMPETITORS_ORDER, limit: String(o.limit) },
  };
}

export interface RawAhrefsMetrics {
  metrics?: { org_keywords?: number | null; org_keywords_1_3?: number | null; org_traffic?: number | null } | null;
}
export interface RawAhrefsKeywordsHistory {
  keywords?: { date?: string | null; top3?: number | null; top4_10?: number | null; top11_20?: number | null; top21_50?: number | null; top51_plus?: number | null }[] | null;
}
export interface RawAhrefsMetricsHistory {
  metrics?: { date?: string | null; org_traffic?: number | null }[] | null;
}
export interface RawAhrefsRefdomainsHistory {
  refdomains?: { date?: string | null; refdomains?: number | null }[] | null;
}
export interface RawAhrefsDomainRatingHistory {
  domain_ratings?: { date?: string | null; domain_rating?: number | null }[] | null;
}
export interface RawAhrefsCompetitorsFull {
  competitors?: { competitor_domain?: string | null; keywords_common?: number | null; keywords_competitor?: number | null; traffic?: number | null }[] | null;
}

const day10 = (v: unknown) => {
  const s = str(v)?.slice(0, 10);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const sumBands = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

type Bands = { top3: number | null; pos4_10: number | null; pos11_20: number | null; pos21_100: number | null };
function bandsOf(r: NonNullable<RawAhrefsKeywordsHistory["keywords"]>[number] | undefined): Bands {
  // Ahrefs organic data stops at position 100, so 51+ is 51-100 (research §3).
  return { top3: num(r?.top3), pos4_10: num(r?.top4_10), pos11_20: num(r?.top11_20), pos21_100: sumBands(num(r?.top21_50), num(r?.top51_plus)) };
}

/** metrics + the latest keywords-history row -> visibility figures (D6). */
export function mapAhrefsVisibility(m: RawAhrefsMetrics | undefined, kh: RawAhrefsKeywordsHistory | undefined) {
  const rows = [...(kh?.keywords ?? [])].filter((r) => day10(r.date)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { keywords: num(m?.metrics?.org_keywords), ...bandsOf(rows.at(-1)), traffic: num(m?.metrics?.org_traffic), trafficLabel: AHREFS_TRAFFIC_LABEL };
}

/** keywords-history + metrics-history -> monthly visibility points; the keyword count is the sum of the bands. */
export function mapAhrefsVisibilityHistory(kh: RawAhrefsKeywordsHistory | undefined, mh: RawAhrefsMetricsHistory | undefined) {
  const traffic = new Map<string, number | null>();
  for (const r of mh?.metrics ?? []) {
    const d = day10(r.date);
    if (d) traffic.set(d, num(r.org_traffic));
  }
  const out = [];
  for (const r of kh?.keywords ?? []) {
    const day = day10(r.date);
    if (!day) continue;
    const b = bandsOf(r);
    const parts = [b.top3, b.pos4_10, b.pos11_20, b.pos21_100];
    out.push({ day, keywords: parts.every((x) => x === null) ? null : parts.reduce<number>((a, x) => a + (x ?? 0), 0), ...b, traffic: traffic.get(day) ?? null, trafficLabel: AHREFS_TRAFFIC_LABEL });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

/** refdomains-history + domain-rating-history -> monthly backlink points (no backlink count, no new/lost: D5). */
export function mapAhrefsBacklinksHistory(rd: RawAhrefsRefdomainsHistory | undefined, dr: RawAhrefsDomainRatingHistory | undefined) {
  const ratings = new Map<string, number | null>();
  for (const r of dr?.domain_ratings ?? []) {
    const d = day10(r.date);
    if (d) ratings.set(d, num(r.domain_rating));
  }
  const days = new Set<string>([...ratings.keys()]);
  const refs = new Map<string, number | null>();
  for (const r of rd?.refdomains ?? []) {
    const d = day10(r.date);
    if (d) {
      refs.set(d, num(r.refdomains));
      days.add(d);
    }
  }
  return [...days].sort().map((day) => ({
    day,
    backlinks: null,
    referringDomains: refs.get(day) ?? null,
    authority: { metric: "domain_rating" as const, value: ratings.get(day) ?? null },
    newBacklinks: null,
    lostBacklinks: null,
    newReferringDomains: null,
    lostReferringDomains: null,
  }));
}

/** organic-competitors -> competitors (their keywords = common + competitor-only); null domains and the target dropped. */
export function mapAhrefsCompetitorsFull(raw: RawAhrefsCompetitorsFull | undefined, target: string) {
  const own = target.toLowerCase().replace(/^www\./, "");
  const out: { domain: string; commonKeywords: number | null; keywords: number | null; traffic: number | null; inProviderList: true }[] = [];
  for (const r of raw?.competitors ?? []) {
    const raw0 = str(r.competitor_domain);
    const domain = raw0 ? stripControl(raw0).trim().toLowerCase().replace(/^www\./, "") : null;
    if (!domain || domain === own || out.some((o) => o.domain === domain)) continue;
    const common = num(r.keywords_common);
    const only = num(r.keywords_competitor);
    out.push({ domain, commonKeywords: common, keywords: common === null && only === null ? null : (common ?? 0) + (only ?? 0), traffic: num(r.traffic), inProviderList: true });
  }
  return out;
}
