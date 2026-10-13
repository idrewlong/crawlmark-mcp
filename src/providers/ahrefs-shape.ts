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
