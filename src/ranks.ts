/**
 * Rank history for tracked keywords (Phase 12 B): reading the stored series
 * (rank_history, free and local) and checking ranks now (check_ranks and
 * `crawlmark-cli check-ranks`). Positions are ranks: lower is better.
 *
 * - The default check is free: Search Console's average position over the last 7
 *   complete days for every tracked keyword (B-D2).
 * - `live` adds a paid DataForSEO SERP check per keyword. The whole run's estimate is
 *   checked against the caps once, before the first request; `estimateOnly` makes no
 *   request and writes nothing. Only live checks feed the rank-drop alert.
 */
import { rankChange, rankDropAlert, summarizeRanks, type RankDrop, type RankSummary } from "./analysis/ranks.js";
import type { Client } from "./config.js";
import { BudgetExceededError } from "./lib/budget.js";
import { lastDays, type DateRange } from "./lib/dates.js";
import type { ProviderId } from "./lib/provider-ids.js";
import { isRealDate } from "./reports/templates/schema.js";
export { recordLiveRank } from "./lib/rank-history.js";
import { GSC_MARKET, normalizeRankKeyword, previousRanks, readRanks, saveRanks, serpRankRow, storedKeywords, type RankInput, type RankSource, type StoredRank } from "./lib/rank-history.js";
import type { GscQueryOptions, GscRow } from "./providers/gsc.js";
import { cliHint } from "./lib/cli-hint.js";

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const todayDay = (today: Date) => isoDay(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

export const RANK_HISTORY_NOTE =
  "Positions are ranks: lower is better, and a negative change is an improvement. gsc = Search Console average position over a 7-day window ending on `day` (free; moves with the mix of searches). " +
  "serp = live Google organic rank from DataForSEO on `day` (paid); a null rank means the site wasn't found within the depth checked.";

export interface GscPoint {
  day: string;
  rank: number | null;
  clicks: number | null;
  impressions: number | null;
}
export interface SerpPoint {
  day: string;
  rank: number | null;
  url: string | null;
}

export interface KeywordHistory {
  keyword: string;
  tracked: boolean;
  series: { gsc?: GscPoint[]; serp?: SerpPoint[] };
  summary: { gsc?: RankSummary; serp?: RankSummary };
}

export interface RankHistoryResult {
  client: string;
  since: string;
  until: string;
  source: "serp" | "gsc" | "both";
  keywords: KeywordHistory[];
  note: string;
}

export interface RankHistoryOptions {
  keyword?: string | undefined;
  source?: "serp" | "gsc" | "both" | undefined;
  since?: string | undefined;
  until?: string | undefined;
  today?: Date;
}

/** One point per day: when a day has several rows (another market), the latest check wins. */
function perDay(rows: StoredRank[]): StoredRank[] {
  const byDay = new Map<string, StoredRank>();
  for (const r of rows) {
    const cur = byDay.get(r.day);
    if (!cur || r.checkedAt >= cur.checkedAt) byDay.set(r.day, r);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** Stored rank history (rank_history tool, rank_trend sections). Free, local: no request is made. */
export function rankHistory(client: Pick<Client, "slug" | "trackedKeywords">, opts: RankHistoryOptions = {}): RankHistoryResult {
  const today = opts.today ?? new Date();
  const until = opts.until ?? todayDay(today);
  const since = opts.since ?? isoDay(Date.parse(`${until}T00:00:00Z`) - 180 * DAY_MS);
  for (const [name, v] of [["since", since], ["until", until]] as const) if (!isRealDate(v)) throw new Error(`${name} must be a real date, YYYY-MM-DD (got "${v}").`);
  if (since > until) throw new Error(`since (${since}) is after until (${until}).`);
  const source = opts.source ?? "both";
  const sources: RankSource[] = source === "both" ? ["gsc", "serp"] : [source];

  const tracked = client.trackedKeywords.map((k) => normalizeRankKeyword(k)).filter((k): k is string => Boolean(k));
  let keywords: string[];
  if (opts.keyword !== undefined) {
    const k = normalizeRankKeyword(opts.keyword);
    if (!k) throw new Error("keyword is empty.");
    keywords = [k];
  } else {
    keywords = [...new Set([...tracked, ...storedKeywords(client.slug, since, until)])];
  }

  const rows = readRanks({ client: client.slug, since, until, keywords, ...(sources.length === 1 ? { source: sources[0]! } : {}) });
  const out: KeywordHistory[] = keywords.map((keyword) => {
    const mine = rows.filter((r) => r.keyword === keyword);
    const series: KeywordHistory["series"] = {};
    const summary: KeywordHistory["summary"] = {};
    if (sources.includes("gsc")) {
      const g = perDay(mine.filter((r) => r.source === "gsc"));
      series.gsc = g.map((r) => ({ day: r.day, rank: r.rank, clicks: r.clicks, impressions: r.impressions }));
      summary.gsc = summarizeRanks(g);
    }
    if (sources.includes("serp")) {
      const s = perDay(mine.filter((r) => r.source === "serp"));
      series.serp = s.map((r) => ({ day: r.day, rank: r.rank, url: r.url }));
      summary.serp = summarizeRanks(s);
    }
    return { keyword, tracked: tracked.includes(keyword), series, summary };
  });
  return { client: client.slug, since, until, source, keywords: out, note: RANK_HISTORY_NOTE };
}

// ------------------------------------------------------------------ check_ranks

/** DataForSEO's per-SERP estimate (ESTIMATE_USD.serp in providers/dataforseo.ts); a conservative ceiling. */
export const SERP_ESTIMATE_USD = 0.002;
const GSC_ROW_LIMIT = 25_000;
/** Search Console caps a regex filter's length; long keyword lists are split over several (free) queries. */
const MAX_REGEX_CHARS = 3_500;

export interface CheckRanksDeps {
  googleConfigured(): boolean;
  gscQuery(client: Client, opts: GscQueryOptions): Promise<GscRow[]>;
  /** Throws ProviderUnavailableError when DataForSEO can't serve live SERPs for the client (no request). */
  requireSerp(client: Client): { fallbackFrom?: ProviderId };
  serp(client: Client, keyword: string): Promise<{ clientRank: number | null; clientUrl: string | null; costUsd: number; fromCache: boolean }>;
  /** Check `usd` against the caps and reserve it while `fn` runs (budget.ts withUsdReservation, SEC-1). */
  withUsdReservation<T>(client: Client, usd: number, fn: () => Promise<T>): Promise<T>;
  remainingUsd(client: Client): { clientUsd: number; globalUsd: number };
  serpEstimateUsd: number;
}

/** The real sources, loaded on first use (a dry run never loads Google or DataForSEO code). */
export async function loadCheckRanksDeps(): Promise<CheckRanksDeps> {
  const [google, gsc, seoData, dfs, budget] = await Promise.all([
    import("./providers/google.js"),
    import("./providers/gsc.js"),
    import("./providers/seo-data.js"),
    import("./providers/dataforseo.js"),
    import("./lib/budget.js"),
  ]);
  return {
    googleConfigured: google.googleConfigured,
    gscQuery: gsc.gscQuery,
    requireSerp: (c) => seoData.requireDataForSeo("serpLive", c),
    // R-5: always a fresh SERP (the user asked, and pays, for a check now), never a cached one from yesterday.
    serp: (c, k) => seoData.serp(c, k, undefined, { refresh: true }),
    withUsdReservation: budget.withUsdReservation,
    remainingUsd: budget.remainingUsd,
    serpEstimateUsd: dfs.ESTIMATE_USD.serp,
  };
}

export interface CheckRanksOptions {
  live?: boolean | undefined;
  /** A subset of the tracked keywords (any case or spacing); others are an error. */
  keywords?: string[] | undefined;
  estimateOnly?: boolean | undefined;
  today?: Date;
  /** Places a live rank must worsen by to alert (ALERT_RANK_DROP). */
  rankDropThreshold?: number;
}

export interface CheckRanksEstimate {
  client: string;
  live: boolean;
  keywords: string[];
  gscWindow: DateRange;
  estimate: { provider: "dataforseo" | "search_console"; usd: number; requests: number };
  remaining: { clientUsd: number; globalUsd: number };
  wouldExceed: boolean;
  fallbackFrom?: ProviderId;
  note: string;
}

export interface CheckRanksRow {
  keyword: string;
  gsc: { position: number | null; clicks: number; impressions: number; page: string | null } | null;
  live: { rank: number | null; url: string | null } | null;
  previous: { gsc: number | null; live: number | null };
  change: { gsc: number | null; live: number | null };
  /** Why this keyword's live check failed (the others still ran). */
  liveError?: string;
}

export interface CheckRanksResult {
  client: string;
  day: string;
  gscWindow: DateRange;
  live: boolean;
  results: CheckRanksRow[];
  saved: number;
  costUsd: number;
  estimate?: { provider: "dataforseo"; usd: number; requests: number };
  fallbackFrom?: ProviderId;
  /** Live checks only: keywords that left the top 10 or fell by at least the threshold. */
  rankDrops: RankDrop[];
  notes: string[];
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 300);
const RE2_SPECIAL = /[\\^$.|?*+()[\]{}]/g;

/** `(?i)^(?:a|b)$` regexes covering `keywords`, each under MAX_REGEX_CHARS. */
export function keywordRegexes(keywords: readonly string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const build = (list: string[]) => `(?i)^(?:${list.join("|")})$`;
  for (const k of keywords) {
    const esc = k.replace(RE2_SPECIAL, (c) => `\\${c}`);
    if (cur.length && build([...cur, esc]).length > MAX_REGEX_CHARS) {
      out.push(build(cur));
      cur = [];
    }
    cur.push(esc);
  }
  if (cur.length) out.push(build(cur));
  return out;
}

/** The tracked keywords to check: all of them, or the requested subset (each must be tracked). */
function selectKeywords(client: Client, requested: string[] | undefined): string[] {
  const tracked = [...new Set(client.trackedKeywords.map((k) => normalizeRankKeyword(k)).filter((k): k is string => Boolean(k)))];
  if (tracked.length === 0) throw new Error(`${client.domain} has no tracked keywords. Add some with add_keywords (or ${cliHint()} keywords add ${client.domain} "<keyword>").`);
  if (!requested?.length) return tracked;
  const wanted = [...new Set(requested.map((k) => normalizeRankKeyword(k) ?? ""))];
  const unknown = wanted.filter((k) => !tracked.includes(k));
  if (unknown.length) throw new Error(`Not tracked for ${client.domain}: ${unknown.map((k) => JSON.stringify(k)).join(", ")}. check_ranks checks tracked keywords only; add them with add_keywords first.`);
  return wanted;
}

const todayIso = (today: Date) => today.toISOString().slice(0, 10);

/** Plan a check without any request: the keywords, the Search Console window and the paid estimate. */
export function planCheckRanks(client: Client, opts: CheckRanksOptions, deps: Pick<CheckRanksDeps, "requireSerp" | "remainingUsd" | "serpEstimateUsd">): CheckRanksEstimate {
  const today = opts.today ?? new Date();
  const keywords = selectKeywords(client, opts.keywords);
  const live = opts.live === true;
  const gscWindow = lastDays(7, 3, today);
  const route = live ? deps.requireSerp(client) : {};
  const usd = live ? Number((keywords.length * deps.serpEstimateUsd).toFixed(4)) : 0;
  const remaining = deps.remainingUsd(client);
  return {
    client: client.slug,
    live,
    keywords,
    gscWindow,
    estimate: { provider: live ? "dataforseo" : "search_console", usd, requests: live ? keywords.length : 0 },
    remaining,
    wouldExceed: usd > remaining.clientUsd || usd > remaining.globalUsd,
    ...(route.fallbackFrom ? { fallbackFrom: route.fallbackFrom } : {}),
    note: live
      ? `${keywords.length} live SERP check(s) at about $${deps.serpEstimateUsd} each (an estimate; every live check is fetched fresh). Search Console positions are free.`
      : "Search Console positions only: free, no paid request.",
  };
}

/**
 * Check tracked keywords now and store the results (check_ranks). Search Console (free) for the last 7
 * complete days; with `live`, a DataForSEO SERP per keyword after one pre-flight cap check for the total.
 */
export async function checkRanks(client: Client, opts: CheckRanksOptions, deps: CheckRanksDeps): Promise<CheckRanksEstimate | CheckRanksResult> {
  const plan = planCheckRanks(client, opts, deps);
  if (opts.estimateOnly) return plan;
  const today = opts.today ?? new Date();
  const day = todayIso(today);
  const { keywords, gscWindow, live } = plan;
  const notes: string[] = [];
  const gscAvailable = deps.googleConfigured() && Boolean(client.gscProperty);
  if (!gscAvailable && !live) {
    throw new Error(
      `check_ranks needs Search Console for ${client.domain} (${deps.googleConfigured() ? "no Search Console property found" : `Google isn't set up: run ${cliHint()} setup --step google`}), or live: true for a paid live SERP check.`,
    );
  }
  // The whole run's paid estimate, once, before any request (free Search Console included), reserved until the
  // run ends so concurrent paid calls can't each pass the cap (SEC-1).
  const run = () => runCheck(client, plan, { day, gscAvailable, notes, threshold: opts.rankDropThreshold ?? 5 }, deps);
  return live ? deps.withUsdReservation(client, plan.estimate.usd, run) : run();
}

async function runCheck(
  client: Client,
  plan: CheckRanksEstimate,
  o: { day: string; gscAvailable: boolean; notes: string[]; threshold: number },
  deps: CheckRanksDeps,
): Promise<CheckRanksResult> {
  const { keywords, gscWindow, live } = plan;
  const { day, gscAvailable, notes } = o;

  // ---- Search Console (free): per-query totals, and the top page per query.
  const gsc = new Map<string, NonNullable<CheckRanksRow["gsc"]>>();
  let gscOk = false;
  if (gscAvailable) {
    try {
      const totals: GscRow[] = [];
      const byPage: GscRow[] = [];
      for (const re of keywordRegexes(keywords)) {
        totals.push(...(await deps.gscQuery(client, { ...gscWindow, dimensions: ["query"], rowLimit: GSC_ROW_LIMIT, queryRegex: re })));
        byPage.push(...(await deps.gscQuery(client, { ...gscWindow, dimensions: ["query", "page"], rowLimit: GSC_ROW_LIMIT, queryRegex: re })));
      }
      const top = new Map<string, GscRow>();
      for (const r of byPage) {
        const k = normalizeRankKeyword(r.keys[0] ?? "");
        if (!k) continue;
        const cur = top.get(k);
        if (!cur || r.clicks > cur.clicks || (r.clicks === cur.clicks && r.impressions > cur.impressions)) top.set(k, r);
      }
      for (const r of totals) {
        const k = normalizeRankKeyword(r.keys[0] ?? "");
        if (!k || !keywords.includes(k) || gsc.has(k)) continue;
        gsc.set(k, { position: r.impressions > 0 ? r.position : null, clicks: r.clicks, impressions: r.impressions, page: top.get(k)?.keys[1] ?? null });
      }
      gscOk = true;
    } catch (err) {
      if (!live) throw err;
      notes.push(`Search Console positions couldn't be fetched: ${errText(err)}`);
    }
  } else {
    notes.push(`No Search Console positions: ${deps.googleConfigured() ? `no Search Console property for ${client.domain}` : "Google isn't set up"}.`);
  }

  const prevGsc = previousRanks({ client: client.slug, keywords, source: "gsc", beforeDay: gscWindow.endDate });
  const prevSerp = previousRanks({ client: client.slug, keywords, source: "serp", beforeDay: day, market: String(client.locationCode) });

  // ---- Live SERPs (paid), one keyword at a time.
  const live_ = new Map<string, { rank: number | null; url: string | null }>();
  const liveErrors = new Map<string, string>();
  let costUsd = 0;
  if (live) {
    for (const k of keywords) {
      try {
        const r = await deps.serp(client, k);
        costUsd += r.costUsd;
        live_.set(k, { rank: r.clientRank, url: r.clientUrl });
      } catch (err) {
        liveErrors.set(k, errText(err));
        if (err instanceof BudgetExceededError) {
          notes.push(`Stopped the live checks: ${errText(err)}`);
          break;
        }
      }
    }
  }

  const rows: RankInput[] = [];
  const threshold = o.threshold;
  const rankDrops: RankDrop[] = [];
  const results: CheckRanksRow[] = keywords.map((k) => {
    const g = gscOk ? (gsc.get(k) ?? { position: null, clicks: 0, impressions: 0, page: null }) : null;
    const l = live_.get(k) ?? null;
    if (g) rows.push({ keyword: k, source: "gsc", day: gscWindow.endDate, rank: g.position, url: g.page, clicks: g.clicks, impressions: g.impressions, ...GSC_MARKET });
    if (l) rows.push(serpRankRow(client, k, day, l.rank, l.url));
    const pg = prevGsc.get(k)?.rank ?? null;
    const pl = prevSerp.get(k)?.rank ?? null;
    if (l) {
      const drop = rankDropAlert(k, prevSerp.has(k) ? pl : undefined, l.rank, threshold);
      if (drop) rankDrops.push(drop);
    }
    return {
      keyword: k,
      gsc: g,
      live: l,
      previous: { gsc: pg, live: pl },
      change: { gsc: rankChange(g?.position, pg), live: rankChange(l?.rank, pl) },
      ...(liveErrors.has(k) ? { liveError: liveErrors.get(k)! } : {}),
    };
  });
  const saved = saveRanks(client, rows);
  if (live && liveErrors.size === keywords.length && !gscOk) throw new Error(`Every live check failed (first error: ${liveErrors.values().next().value}).`);
  // R-2: say so whenever a live check failed (the CLI counts a client whose live checks all failed as failed).
  if (liveErrors.size) notes.push(`${liveErrors.size} of ${keywords.length} live check(s) failed; see liveError on each result.`);
  return {
    client: client.slug,
    day,
    gscWindow,
    live,
    results,
    saved,
    costUsd: Number(costUsd.toFixed(4)),
    ...(live ? { estimate: { provider: "dataforseo" as const, usd: plan.estimate.usd, requests: plan.estimate.requests } } : {}),
    ...(plan.fallbackFrom ? { fallbackFrom: plan.fallbackFrom } : {}),
    rankDrops,
    notes,
  };
}
