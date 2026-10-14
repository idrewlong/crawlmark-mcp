/**
 * Ahrefs API v3 client (Phase 9). Endpoints, parameters, field costs, headers and
 * error bodies follow docs/research/ahrefs-api-v3.md "Endpoints" (Ahrefs' OpenAPI
 * spec, accessed 2026-10-13); the pure parts live in ./ahrefs-shape.ts.
 *
 * - Auth is `Authorization: Bearer <AHREFS_API_KEY>`; the key is never put in a URL,
 *   log, error, cache key or ledger row.
 * - Every uncached call checks the unit caps first (assertUnits) and records the units
 *   the response headers report (else the estimate). A timeout records the estimate.
 * - At most 4 requests in flight and 1,000 ms between starts (the documented 60/min).
 * - Errors are never retried (a retry could double-bill), except one retry of a 429.
 */
import { env, type Client } from "../config.js";
import { globalUnitCap, recordUnits, unitsThisMonth } from "../lib/budget.js";
import { TTL } from "../lib/cache.js";
import { ahrefsCountry, noCountryMessage } from "../lib/country.js";
import { ProviderUnavailableError } from "../lib/provider-ids.js";
import { createLimiter } from "../lib/rate.js";
import { TIMEOUTS } from "../lib/timeout.js";
import { mergeGaps } from "../analysis/keyword-gap.js";
import { normalizeKeyword } from "../lib/clients.js";
import {
  AHREFS_GAP_CLIENT_ROWS,
  gapFields,
  gapKeywordsRequest,
  ideasFields,
  keywordIdeasRequest,
  mapAhrefsGapRows,
  mapAhrefsIdeas,
  type RawAhrefsGapKeywords,
  type RawAhrefsTerms,
  AHREFS_KEYWORD_BATCH,
  AHREFS_PATHS,
  ahrefsErrorText,
  ahrefsEstimates,
  backlinksStatsRequest,
  BACKLINKS_FIELDS,
  classifyAhrefsError,
  domainRatingRequest,
  estimateAhrefsUnits,
  keywordsOverviewRequest,
  mapAhrefsAccount,
  mapAhrefsBacklinks,
  mapAhrefsCompetitors,
  mapAhrefsKeywordVolumes,
  mapAhrefsRankedKeywords,
  organicCompetitorsRequest,
  organicKeywordsRequest,
  rankedFields,
  competitorFields,
  unitsFromHeaders,
  VOLUME_SELECT,
  type AhrefsAccount,
  type AhrefsErrorKind,
  type AhrefsParams,
  type RawAhrefsBacklinksStats,
  type RawAhrefsCompetitors,
  type RawAhrefsDomainRating,
  type RawAhrefsKeywordsOverview,
  type RawAhrefsLimitsAndUsage,
  type RawAhrefsOrganicKeywords,
} from "./ahrefs-shape.js";
import {
  ahrefsCompetitorRows,
  domainRatingHistoryRequest,
  keywordsHistoryRequest,
  mapAhrefsBacklinksHistory,
  mapAhrefsCompetitorsFull,
  mapAhrefsVisibility,
  mapAhrefsVisibilityHistory,
  metricsHistoryRequest,
  metricsRequest,
  organicCompetitorsFullRequest,
  p13AhrefsEstimates,
  refdomainsHistoryRequest,
  type RawAhrefsCompetitorsFull,
  type RawAhrefsDomainRatingHistory,
  type RawAhrefsKeywordsHistory,
  type RawAhrefsMetrics,
  type RawAhrefsMetricsHistory,
  type RawAhrefsRefdomainsHistory,
} from "./ahrefs-shape.js";
import type {
  BacklinksHistoryRouted,
  CompetitorOverviewRequest,
  CompetitorOverviewRouted,
  OrganicHistoryRouted,
  OrganicOverviewRouted,
  ProviderCompetitor,
  BacklinksRouted,
  CompetitorsRouted,
  GapContext,
  KeywordGapRequest,
  KeywordGapRouted,
  KeywordIdeasRequest,
  KeywordIdeasRouted,
  KeywordVolumeResult,
  PaidPlan,
  RankedKeywordsRouted,
  SeoDataProvider,
} from "./seo-data.js";
import { normalizeKeywordList } from "./semrush-shape.js";
import { isTimeoutOrAbort, redact, retryAfterMs, todayUtc, unitsCall } from "./units-billing.js";
import { assertAhrefsAllowed } from "./ahrefs-site-audit.js";

/**
 * Ahrefs storage decision (fix round R-5): responses that are row lists (keywords, competitors, ideas, the gap) are
 * cached for at most a day, and every Ahrefs cache entry is tracked so a purge deletes it. Counts and aggregates
 * (backlink totals, visibility figures and their history) keep the usual week.
 */
export const AHREFS_ROW_TTL = TTL.day;

export class AhrefsApiError extends Error {
  override name = "AhrefsApiError";
  constructor(
    readonly status: number,
    readonly kind: AhrefsErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** A 2xx response whose body isn't JSON. Carries the units the headers reported, if any, so they can be recorded. */
export class AhrefsBadBodyError extends Error {
  override name = "AhrefsBadBodyError";
  constructor(
    message: string,
    readonly headerUnits: number | null,
  ) {
    super(message);
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Test seams: the wait before the one 429 retry (`sleep`), and the limiter's start spacing (`spacing`). */
export const ahrefsTiming = { sleep: realSleep, spacing: realSleep };

/** Shared by every Ahrefs call in this process: 4 in flight, 1,000 ms between starts (60/min). */
export const ahrefsLimiter = createLimiter({ maxInFlight: 4, minSpacingMs: 1_000, sleep: (ms) => ahrefsTiming.spacing(ms) });

interface Sent<T> {
  json: T;
  /** Units from the response headers; null when Ahrefs sent none (N5). */
  headerUnits: number | null;
}

/** One GET through the limiter. A 429 is retried once after Retry-After (or 2 s); any other error is thrown, never retried. */
async function send<T>(key: string, req: AhrefsParams, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Sent<T>> {
  const url = `${env.AHREFS_BASE_URL}${req.path}?${new URLSearchParams(req.params).toString()}`;
  for (let attempt = 0; ; attempt++) {
    const res = await ahrefsLimiter.run(async () => {
      try {
        return await fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUTS.networkMs)]) : AbortSignal.timeout(TIMEOUTS.networkMs),
        });
      } catch (err) {
        if (isTimeoutOrAbort(err)) throw err;
        // Network errors can carry the URL in their cause; build our own message.
        throw new Error(`Couldn't reach Ahrefs (${req.path}): ${redact(err instanceof Error ? err.message : String(err), [key])}`);
      }
    });
    if (res.status === 429 && attempt === 0) {
      // Throttled, so not billed (both docs describe 429 as throttling): one retry.
      await ahrefsTiming.sleep(retryAfterMs(res.headers.get("retry-after")));
      continue;
    }
    if (!res.ok) {
      const info = classifyAhrefsError(res.status, redact(ahrefsErrorText(await res.text()), [key]), req.path);
      throw new AhrefsApiError(res.status, info.kind, info.message);
    }
    const headerUnits = unitsFromHeaders(res.headers);
    const text = await res.text();
    try {
      return { json: JSON.parse(text) as T, headerUnits };
    } catch {
      // A 200 that isn't JSON: Ahrefs may still have billed it, so the caller records units.
      throw new AhrefsBadBodyError(`Ahrefs ${req.path} answered with an unreadable body: ${redact(text, [key], 120) || "(empty)"}`, headerUnits);
    }
  }
}

function apiKey(): string {
  if (!env.AHREFS_API_KEY) throw new ProviderUnavailableError("keywordVolume", "ahrefs", "AHREFS_API_KEY is not set. Run setup --step ahrefs.");
  return env.AHREFS_API_KEY;
}

/**
 * A billed request: records the units Ahrefs reports (else `fallbackUnits`) under the
 * endpoint path. A timeout or abort records `estimate` as "<path> (timeout, estimated)",
 * since Ahrefs may still have billed it, then rethrows.
 */
async function billed<T>(client: Client, req: AhrefsParams, estimate: number, fallbackUnits: (json: T) => number): Promise<{ json: T; units: number }> {
  const key = apiKey();
  try {
    const { json, headerUnits } = await send<T>(key, req);
    const units = headerUnits ?? fallbackUnits(json);
    recordUnits(client.slug, "ahrefs", req.path, units);
    return { json, units };
  } catch (err) {
    if (err instanceof AhrefsBadBodyError) {
      // Answered 2xx, so it was probably billed: the reported units, else the estimate.
      recordUnits(client.slug, "ahrefs", `${req.path} (unreadable body${err.headerUnits === null ? ", estimated" : ""})`, err.headerUnits ?? estimate);
      throw err;
    }
    if (!isTimeoutOrAbort(err)) throw err;
    recordUnits(client.slug, "ahrefs", `${req.path} (timeout, estimated)`, estimate);
    throw new Error(`Ahrefs ${req.path} timed out after ${TIMEOUTS.networkMs / 1000}s; Ahrefs may still have billed it. The estimated ${estimate} units were recorded against the cap.`);
  }
}

/**
 * Phase 13 B: one billed Ahrefs GET for the Site Audit reader (ahrefs-site-audit.ts), which checks its own path
 * allowlist before calling this. Same limiter, key handling, redaction and unit recording as every Ahrefs call.
 */
export async function ahrefsGet<T>(client: Client, req: AhrefsParams, estimate: number): Promise<{ json: T; units: number }> {
  // Defence in depth (SEC-6): the Site Audit allowlist is checked here too, so no other caller can reach a write.
  assertAhrefsAllowed("GET", req.path);
  return billed<T>(client, req, estimate, () => estimate);
}

/** The client's Ahrefs country, or unavailable (a city-level location code and no `country`). */
function country(client: Client, capability: "keywordVolume" | "rankedKeywords" | "competitorDomains" | "keywordIdeas" | "keywordGap" | "organicOverview" | "competitorOverview"): string {
  if (!client.country) throw new ProviderUnavailableError(capability, "ahrefs", noCountryMessage(client));
  return ahrefsCountry(client.country);
}

const meta = (r: { units: number; fromCache: boolean }) => ({ provider: "ahrefs" as const, costUsd: 0, units: r.units, fromCache: r.fromCache });

// ------------------------------------------------------------------ capabilities

export async function ahrefsKeywordVolume(client: Client, input: string[], opts: { refresh?: boolean } = {}): Promise<KeywordVolumeResult> {
  // Ahrefs takes `keywords` comma-separated, so a comma inside an entry is several billed keywords:
  // split on commas too, so the estimate counts what is actually sent.
  const keywords = normalizeKeywordList(input.flatMap((k) => k.split(",")));
  const cc = country(client, "keywordVolume");
  const batches: string[][] = [];
  for (let i = 0; i < keywords.length; i += AHREFS_KEYWORD_BATCH) batches.push(keywords.slice(i, i + AHREFS_KEYWORD_BATCH));
  const r = await unitsCall({
    client,
    provider: "ahrefs",
    capability: "keywordVolume",
    keyParts: { country: cc, keywords },
    ttl: AHREFS_ROW_TTL,
    // The whole batch is checked before the first request.
    estimate: batches.reduce((sum, b) => sum + ahrefsEstimates.keywordBatch(b.length), 0),
    refresh: opts.refresh,
    run: async () => {
      const result = [];
      let units = 0;
      // Batches run one after another.
      for (const batch of batches) {
        const req = keywordsOverviewRequest({ keywords: batch, country: cc });
        const { json, units: u } = await billed<RawAhrefsKeywordsOverview>(client, req, ahrefsEstimates.keywordBatch(batch.length), (j) =>
          estimateAhrefsUnits(VOLUME_SELECT, j.keywords?.length ?? 0),
        );
        units += u;
        result.push(...mapAhrefsKeywordVolumes(json, batch));
      }
      return { value: { result }, units };
    },
  });
  return { ...r.value, ...meta(r) };
}

export async function ahrefsRankedKeywords(client: Client, target: string, limit: number, opts: { refresh?: boolean } = {}): Promise<RankedKeywordsRouted> {
  const cc = country(client, "rankedKeywords");
  const estimate = ahrefsEstimates.rankedKeywords(limit);
  const r = await unitsCall({
    client,
    provider: "ahrefs",
    capability: "rankedKeywords",
    keyParts: { target, country: cc, limit },
    ttl: AHREFS_ROW_TTL,
    estimate,
    refresh: opts.refresh,
    run: async () => {
      const req = organicKeywordsRequest({ target, country: cc, date: todayUtc(), limit });
      const { json, units } = await billed<RawAhrefsOrganicKeywords>(client, req, estimate, (j) => estimateAhrefsUnits(rankedFields(), j.keywords?.length ?? 0));
      return { value: mapAhrefsRankedKeywords(json, target), units };
    },
  });
  return { ...r.value, ...meta(r) };
}

export async function ahrefsCompetitorDomains(client: Client, limit: number, opts: { refresh?: boolean } = {}): Promise<CompetitorsRouted> {
  const cc = country(client, "competitorDomains");
  const target = client.domain;
  const estimate = ahrefsEstimates.competitorDomains(limit);
  const r = await unitsCall({
    client,
    provider: "ahrefs",
    capability: "competitorDomains",
    keyParts: { target, country: cc, limit },
    ttl: AHREFS_ROW_TTL,
    estimate,
    refresh: opts.refresh,
    run: async () => {
      const req = organicCompetitorsRequest({ target, country: cc, date: todayUtc(), limit });
      const { json, units } = await billed<RawAhrefsCompetitors>(client, req, estimate, (j) => estimateAhrefsUnits(competitorFields(), j.competitors?.length ?? 0));
      return { value: mapAhrefsCompetitors(json, target), units };
    },
  });
  return { ...r.value, ...meta(r) };
}

export async function ahrefsBacklinksSummary(client: Client, target: string, opts: { refresh?: boolean } = {}): Promise<BacklinksRouted> {
  const r = await unitsCall({
    client,
    provider: "ahrefs",
    capability: "backlinksSummary",
    keyParts: { target },
    ttl: TTL.week,
    estimate: ahrefsEstimates.backlinksStats() + ahrefsEstimates.domainRating(),
    refresh: opts.refresh,
    run: async () => {
      // Each call records its own ledger row.
      const date = todayUtc();
      const stats = await billed<RawAhrefsBacklinksStats>(client, backlinksStatsRequest({ target, date }), ahrefsEstimates.backlinksStats(), () =>
        estimateAhrefsUnits(BACKLINKS_FIELDS, 1),
      );
      const dr = await billed<RawAhrefsDomainRating>(client, domainRatingRequest({ target, date }), ahrefsEstimates.domainRating(), () => ahrefsEstimates.domainRating());
      return { value: { summary: mapAhrefsBacklinks(stats.json, dr.json, target) }, units: stats.units + dr.units };
    },
  });
  return { ...r.value, ...meta(r) };
}

// ------------------------------------------------------------------ keyword ideas and gap (Phase 12 B)

/** Seeds for Ahrefs' comma-separated `keywords`: a comma inside a seed makes more seeds, so split first. */
const ahrefsSeeds = (seeds: readonly string[]) => normalizeKeywordList(seeds.flatMap((k) => k.split(",")));

export function planAhrefsKeywordIdeas(client: Client, req: KeywordIdeasRequest): PaidPlan {
  const cc = country(client, "keywordIdeas");
  return {
    keyParts: { country: cc, mode: req.mode, seeds: ahrefsSeeds(req.seeds), limit: req.limit },
    unit: "units",
    requests: 1,
    cost: (limit) => ahrefsEstimates.keywordIdeas(limit),
    breakdown: (limit) => `1 ${req.mode === "related" ? "related-terms" : "matching-terms"} request, max(50, 22 × ${limit} rows)`,
  };
}

/** Keyword ideas: one related-terms or matching-terms request with every seed. */
export async function ahrefsKeywordIdeas(client: Client, req: KeywordIdeasRequest, opts: { refresh?: boolean } = {}): Promise<KeywordIdeasRouted> {
  const plan = planAhrefsKeywordIdeas(client, req);
  const seeds = ahrefsSeeds(req.seeds);
  const estimate = plan.cost(req.limit);
  const r = await unitsCall({
    client,
    provider: "ahrefs",
    capability: "keywordIdeas",
    keyParts: plan.keyParts,
    ttl: AHREFS_ROW_TTL,
    estimate,
    refresh: opts.refresh,
    run: async () => {
      const req2 = keywordIdeasRequest({ mode: req.mode, keywords: seeds, country: plan.keyParts.country as string, limit: req.limit });
      const { json, units } = await billed<RawAhrefsTerms>(client, req2, estimate, (j) => estimateAhrefsUnits(ideasFields(), j.keywords?.length ?? 0));
      return { value: { ideas: mapAhrefsIdeas(json, seeds.length === 1 ? seeds[0]! : null).slice(0, req.limit) }, units };
    },
  });
  return { ...r.value, ...meta(r) };
}

export function planAhrefsKeywordGap(client: Client, req: KeywordGapRequest, ctx: Pick<GapContext, "gscAvailable">): PaidPlan {
  const cc = country(client, "keywordGap");
  const n = req.competitors.length;
  const clientCall = ctx.gscAvailable ? 0 : 1;
  return {
    keyParts: { country: cc, target: client.domain, competitors: req.competitors, limit: req.limit, clientCheck: ctx.gscAvailable ? "gsc" : "provider" },
    unit: "units",
    requests: n + clientCall,
    cost: (limit) => n * ahrefsEstimates.gapCompetitor(limit) + clientCall * ahrefsEstimates.gapClient(),
    breakdown: (limit) =>
      `${n} competitor(s) × organic-keywords max(50, 13 × ${limit} rows)` +
      (clientCall ? ` + the client's own keywords (no Search Console): max(50, 13 × ${AHREFS_GAP_CLIENT_ROWS} rows)` : "; the client's rankings come from its Search Console (free)"),
  };
}

/**
 * Keyword gap (B-D3): Ahrefs has no gap endpoint, so each competitor's organic keywords are read and the ones the
 * client already ranks for are removed. "Already ranks" comes from the client's own Search Console (queries with
 * impressions in the last 90 days, free; clientCheck "gsc"), or, without a property, from one organic-keywords
 * call for the client (1,000 rows, in the estimate; clientCheck "provider"). Search Console is read before any paid request.
 */
export async function ahrefsKeywordGap(client: Client, req: KeywordGapRequest, ctx: GapContext, opts: { refresh?: boolean } = {}): Promise<KeywordGapRouted> {
  const plan = planAhrefsKeywordGap(client, req, ctx);
  const cc = plan.keyParts.country as string;
  const r = await unitsCall({
    client,
    provider: "ahrefs",
    capability: "keywordGap",
    keyParts: plan.keyParts,
    ttl: AHREFS_ROW_TTL,
    estimate: plan.cost(req.limit),
    refresh: opts.refresh,
    run: async () => {
      let units = 0;
      const date = todayUtc();
      let exclude: Set<string>;
      if (ctx.gscAvailable) {
        exclude = await ctx.clientQueries();
      } else {
        const own = await billed<RawAhrefsGapKeywords>(client, gapKeywordsRequest({ target: client.domain, country: cc, date, limit: AHREFS_GAP_CLIENT_ROWS }), ahrefsEstimates.gapClient(), (j) =>
          estimateAhrefsUnits(gapFields(), j.keywords?.length ?? 0),
        );
        units += own.units;
        exclude = new Set(mapAhrefsGapRows(own.json).filter((k) => k.position !== null).map((k) => normalizeKeyword(k.keyword)).filter((k): k is string => Boolean(k)));
      }
      const per = [];
      for (const competitor of req.competitors) {
        const res = await billed<RawAhrefsGapKeywords>(client, gapKeywordsRequest({ target: competitor, country: cc, date, limit: req.limit }), ahrefsEstimates.gapCompetitor(req.limit), (j) =>
          estimateAhrefsUnits(gapFields(), j.keywords?.length ?? 0),
        );
        units += res.units;
        per.push({ domain: competitor, rows: mapAhrefsGapRows(res.json) });
      }
      // Cached before the minimum volume is applied, so a different minVolume reuses it.
      const merged = mergeGaps(per, { metric: "ahrefs_kd", clientCheck: ctx.gscAvailable ? "gsc" : "provider", minVolume: 0, exclude });
      return { value: { ...merged, exclusionSource: ctx.gscAvailable ? "gsc" : "provider" }, units };
    },
  });
  const v = r.value;
  const notes = [
    v.exclusionSource === "gsc"
      ? `${v.excluded} competitor keyword(s) were dropped because ${client.domain} already gets Search Console impressions for them (last 90 days).`
      : `${v.excluded} competitor keyword(s) were dropped because ${client.domain} already ranks for them (its top ${AHREFS_GAP_CLIENT_ROWS} Ahrefs keywords).`,
    "Ahrefs keyword difficulty isn't requested for the gap (it would add 10 units per row), so difficulty is null.",
  ];
  return {
    gaps: req.minVolume > 0 ? v.gaps.filter((g) => (g.volume ?? 0) >= req.minVolume) : v.gaps,
    perCompetitor: v.perCompetitor,
    notes,
    ...meta(r),
  };
}

// ------------------------------------------------------------------ Phase 13 B: visibility, history, competitors

/** The first day of the month `months` months before now (UTC). */
const monthsBack = (months: number, now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1)).toISOString().slice(0, 10);
const bareTarget = (t: string) => t.replace(/^www\./, "").toLowerCase();

export function planAhrefsBacklinksSummary(_client: Client, target: string): PaidPlan {
  const units = ahrefsEstimates.backlinksStats() + ahrefsEstimates.domainRating();
  return { keyParts: { target }, unit: "units", requests: 2, cost: () => units, breakdown: () => `backlinks-stats + domain-rating (${units} units)` };
}

export function planAhrefsOrganicOverview(client: Client, target: string): PaidPlan {
  const units = p13AhrefsEstimates.organicOverview();
  return { keyParts: { target: bareTarget(target), country: country(client, "organicOverview") }, unit: "units", requests: 2, cost: () => units, breakdown: () => `metrics (50) + keywords-history for the latest month (50) = ${units} units` };
}

/** Visibility now: metrics (keywords, top 3, traffic) + the latest month's keywords-history row (the other bands). */
export async function ahrefsOrganicOverview(client: Client, target: string, opts: { refresh?: boolean } = {}): Promise<OrganicOverviewRouted> {
  const plan = planAhrefsOrganicOverview(client, target);
  const cc = plan.keyParts.country as string;
  const t = plan.keyParts.target as string;
  const r = await unitsCall({
    client,
    provider: "ahrefs",
    capability: "organicOverview",
    keyParts: plan.keyParts,
    ttl: TTL.week,
    estimate: plan.cost(1),
    refresh: opts.refresh,
    run: async () => {
      const today = todayUtc();
      const m = await billed<RawAhrefsMetrics>(client, metricsRequest({ target: t, country: cc, date: today }), p13AhrefsEstimates.metricsOne(), () => p13AhrefsEstimates.metricsOne());
      const kh = await billed<RawAhrefsKeywordsHistory>(client, keywordsHistoryRequest({ target: t, country: cc, dateFrom: monthsBack(1), dateTo: today }), 50, () => 50);
      return { value: mapAhrefsVisibility(m.json, kh.json), units: m.units + kh.units };
    },
  });
  return { figures: r.value, market: cc, ...meta(r) };
}

export function planAhrefsOrganicHistory(client: Client, target: string, months: number, now = new Date()): PaidPlan {
  const units = p13AhrefsEstimates.organicHistory(months);
  return { keyParts: { target: bareTarget(target), country: country(client, "organicOverview"), dateFrom: monthsBack(months, now) }, unit: "units", requests: 2, cost: () => units, breakdown: () => `keywords-history + metrics-history, ${months} months = ${units} units` };
}

export async function ahrefsOrganicHistory(client: Client, target: string, months: number, opts: { refresh?: boolean } = {}): Promise<OrganicHistoryRouted> {
  const plan = planAhrefsOrganicHistory(client, target, months);
  const cc = plan.keyParts.country as string;
  const t = plan.keyParts.target as string;
  const dateFrom = plan.keyParts.dateFrom as string;
  const r = await unitsCall({
    client,
    provider: "ahrefs",
    capability: "organicHistory",
    keyParts: plan.keyParts,
    ttl: TTL.week,
    estimate: plan.cost(1),
    refresh: opts.refresh,
    run: async () => {
      const today = todayUtc();
      const kh = await billed<RawAhrefsKeywordsHistory>(client, keywordsHistoryRequest({ target: t, country: cc, dateFrom, dateTo: today }), Math.max(50, 6 * months), () => Math.max(50, 6 * months));
      const mh = await billed<RawAhrefsMetricsHistory>(client, metricsHistoryRequest({ target: t, country: cc, dateFrom, dateTo: today }), Math.max(50, 11 * months), () => Math.max(50, 11 * months));
      return { value: mapAhrefsVisibilityHistory(kh.json, mh.json), units: kh.units + mh.units };
    },
  });
  return { points: r.value, market: cc, ...meta(r) };
}

export function planAhrefsBacklinksHistory(_client: Client, target: string, months: number, now = new Date()): PaidPlan {
  const units = p13AhrefsEstimates.backlinksHistory(months);
  return { keyParts: { target: bareTarget(target), dateFrom: monthsBack(months, now) }, unit: "units", requests: 2, cost: () => units, breakdown: () => `refdomains-history + domain-rating-history, ${months} months = ${units} units` };
}

export async function ahrefsBacklinksHistory(client: Client, target: string, months: number, opts: { refresh?: boolean } = {}): Promise<BacklinksHistoryRouted> {
  const plan = planAhrefsBacklinksHistory(client, target, months);
  const t = plan.keyParts.target as string;
  const dateFrom = plan.keyParts.dateFrom as string;
  const r = await unitsCall({
    client,
    provider: "ahrefs",
    capability: "backlinksHistory",
    keyParts: plan.keyParts,
    ttl: TTL.week,
    estimate: plan.cost(1),
    refresh: opts.refresh,
    run: async () => {
      const today = todayUtc();
      const rd = await billed<RawAhrefsRefdomainsHistory>(client, refdomainsHistoryRequest({ target: t, dateFrom, dateTo: today }), Math.max(50, 6 * months), () => Math.max(50, 6 * months));
      const dr = await billed<RawAhrefsDomainRatingHistory>(client, domainRatingHistoryRequest({ target: t, dateFrom, dateTo: today }), 50, () => 50);
      return { value: mapAhrefsBacklinksHistory(rd.json, dr.json), units: rd.units + dr.units };
    },
  });
  return { points: r.value, ...meta(r) };
}

export function planAhrefsCompetitorOverview(client: Client, req: CompetitorOverviewRequest): PaidPlan {
  const units = p13AhrefsEstimates.competitorOverview(req.limit, req.saved.length);
  const rows = ahrefsCompetitorRows(req.limit);
  return {
    keyParts: { target: bareTarget(client.domain), country: country(client, "competitorOverview"), rows, saved: req.saved },
    unit: "units",
    requests: 1 + req.saved.length,
    cost: () => units,
    breakdown: () => `organic-competitors max(50, 15 × ${rows} rows)${req.saved.length ? ` + up to ${req.saved.length} metrics call(s) (50 each) for saved competitors the list misses` : ""} = ${units} units`,
  };
}

/** Organic competitors (organic-competitors, 15 units per row) and a metrics call per saved competitor the list misses (D7). */
export async function ahrefsCompetitorOverview(client: Client, req: CompetitorOverviewRequest, opts: { refresh?: boolean } = {}): Promise<CompetitorOverviewRouted> {
  const plan = planAhrefsCompetitorOverview(client, req);
  const cc = plan.keyParts.country as string;
  const t = plan.keyParts.target as string;
  const r = await unitsCall({
    client,
    provider: "ahrefs",
    capability: "competitorOverview",
    keyParts: plan.keyParts,
    ttl: AHREFS_ROW_TTL,
    estimate: plan.cost(1),
    refresh: opts.refresh,
    run: async () => {
      const today = todayUtc();
      const rows = plan.keyParts.rows as number;
      const list = await billed<RawAhrefsCompetitorsFull>(client, organicCompetitorsFullRequest({ target: t, country: cc, date: today, limit: rows }), p13AhrefsEstimates.competitorOverview(req.limit, 0), () => 50);
      let units = list.units;
      const out: ProviderCompetitor[] = mapAhrefsCompetitorsFull(list.json, t);
      const size = out.length;
      for (const saved of req.saved) {
        if (out.some((x) => x.domain === saved)) continue;
        const m = await billed<RawAhrefsMetrics>(client, metricsRequest({ target: saved, country: cc, date: today }), p13AhrefsEstimates.metricsOne(), () => p13AhrefsEstimates.metricsOne());
        units += m.units;
        const f = mapAhrefsVisibility(m.json, undefined);
        out.push({ domain: saved, commonKeywords: null, keywords: f.keywords, traffic: f.traffic, inProviderList: false });
      }
      // Counts per competitor only (no keyword lists): what Ahrefs data crawlmark keeps (Ahrefs storage decision).
      return { value: { rows: out, providerListSize: size }, units };
    },
  });
  return { ...r.value, market: cc, ...meta(r) };
}

export const ahrefsProvider: SeoDataProvider = {
  id: "ahrefs",
  capabilities: new Set(["keywordVolume", "rankedKeywords", "competitorDomains", "backlinksSummary", "keywordIdeas", "keywordGap", "organicOverview", "competitorOverview"]),
  planBacklinksSummary: (c, t) => planAhrefsBacklinksSummary(c, t),
  planOrganicOverview: (c, t) => planAhrefsOrganicOverview(c, t),
  organicOverview: (c, t, o) => ahrefsOrganicOverview(c, t, o),
  planOrganicHistory: (c, t, m) => planAhrefsOrganicHistory(c, t, m),
  organicHistory: (c, t, m, o) => ahrefsOrganicHistory(c, t, m, o),
  planBacklinksHistory: (c, t, m) => planAhrefsBacklinksHistory(c, t, m),
  backlinksHistory: (c, t, m, o) => ahrefsBacklinksHistory(c, t, m, o),
  planCompetitorOverview: (c, r) => planAhrefsCompetitorOverview(c, r),
  competitorOverview: (c, r, o) => ahrefsCompetitorOverview(c, r, o),
  market: (c, cap) => country(c, cap),
  configured: () => Boolean(env.AHREFS_API_KEY),
  planKeywordIdeas: (c, r) => planAhrefsKeywordIdeas(c, r),
  keywordIdeas: (c, r, o) => ahrefsKeywordIdeas(c, r, o),
  planKeywordGap: (c, r, ctx) => planAhrefsKeywordGap(c, r, ctx),
  keywordGap: (c, r, ctx, o) => ahrefsKeywordGap(c, r, ctx, o),
  keywordVolume: (c, k, o) => ahrefsKeywordVolume(c, k, o),
  rankedKeywords: (c, t, l, o) => ahrefsRankedKeywords(c, t, l, o),
  competitorDomains: (c, l, o) => ahrefsCompetitorDomains(c, l, o),
  backlinksSummary: (c, t, o) => ahrefsBacklinksSummary(c, t, o),
};

// ------------------------------------------------------------------ account check (free)

export type AhrefsKeyCheck =
  | ({ configured: true; works: true; reachable: true; error: null; costUsd: 0 } & AhrefsAccount)
  | {
      configured: boolean;
      /** false: no key, or Ahrefs rejected it; null: Ahrefs couldn't be reached, so the key is untested. */
      works: false | null;
      reachable: boolean;
      /** The HTTP status Ahrefs answered with, when it answered. */
      status?: number;
      error: string;
      costUsd: 0;
    };

/**
 * The free account check: `GET /subscription-info/limits-and-usage` ("free and do not
 * consume any API units"). Never throws and never caches; the error text never
 * contains the key. 401/403 and any other 4xx mean rejected (N6); a network error,
 * timeout, 429 or 5xx means unreachable (untested).
 */
export async function checkAhrefsKey(key: string | undefined, fetchImpl: typeof fetch = fetch): Promise<AhrefsKeyCheck> {
  if (!key) return { configured: false, works: false, reachable: true, error: "AHREFS_API_KEY is not set.", costUsd: 0 };
  const path = AHREFS_PATHS.limitsAndUsage;
  let res: Response;
  try {
    res = await fetchImpl(`${env.AHREFS_BASE_URL}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUTS.networkMs),
    });
  } catch (err) {
    return { configured: true, works: null, reachable: false, error: `Couldn't reach Ahrefs: ${redact(err instanceof Error ? err.message : String(err), [key])}`, costUsd: 0 };
  }
  if (res.ok) {
    try {
      return { configured: true, works: true, reachable: true, error: null, ...mapAhrefsAccount((await res.json()) as RawAhrefsLimitsAndUsage), costUsd: 0 };
    } catch {
      return { configured: true, works: null, reachable: false, status: res.status, error: "Ahrefs answered with an unreadable body.", costUsd: 0 };
    }
  }
  const vendor = redact(ahrefsErrorText(await res.text().catch(() => "")), [key]);
  if (res.status === 429 || res.status >= 500) {
    return { configured: true, works: null, reachable: false, status: res.status, error: `Ahrefs is unavailable (HTTP ${res.status})${vendor ? `: ${vendor}` : ""}`, costUsd: 0 };
  }
  return { configured: true, works: false, reachable: true, status: res.status, error: classifyAhrefsError(res.status === 403 ? 403 : 401, vendor, path).message, costUsd: 0 };
}

/** The `ahrefs_status` tool: the free check with the configured key, plus this month's ledger units and caps. Never shows the key. */
export async function ahrefsStatus() {
  const check = await checkAhrefsKey(env.AHREFS_API_KEY);
  return {
    ...check,
    unitsUsedThisMonth: unitsThisMonth(undefined, "ahrefs"),
    monthlyUnitCap: globalUnitCap("ahrefs"),
    defaultClientMonthlyUnits: env.DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS,
  };
}
