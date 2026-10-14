import { env, type Client } from "../config.js";
import { TIMEOUTS } from "../lib/timeout.js";
import { assertAiBudget, assertBudget, recordSpend, withUsdReservation } from "../lib/budget.js";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import { mergeGaps, mergeIdeas } from "../analysis/keyword-gap.js";
import type { KeywordGapRequest, KeywordGapRouted, KeywordIdeasRequest, KeywordIdeasRouted, PaidPlan } from "./seo-data.js";
import {
  mapLlmMentions,
  mapLlmTargetMetrics,
  type LlmMention,
  type LlmTargetMetrics,
  type RawLlmMentions,
  type RawLlmTargetMetrics,
  mapBusinessInfo,
  mapMapsSerp,
  mapReviews,
  type LocalReviews,
  type RawBusinessInfo,
  type RawMapsSerp,
  type RawReviews,
  mapDomainIntersection,
  mapLabsKeywordIdeas,
  type RawDomainIntersection,
  type RawLabsKeywords,
  mapBacklinksSummary,
  mapCompetitors,
  mapInstantPage,
  mapRankedKeywords,
  mapSerpOrganic,
  mapUserData,
  dataForSeoMode,
  isAuthRejection,
  type RawBacklinksSummary,
  type RawCompetitors,
  type RawInstantPages,
  type RawRankedKeywords,
  type RawSerp,
  type RawUserData,
  type DataForSeoStatus,
} from "./dataforseo-shape.js";

export type {
  LlmMention,
  LlmTargetMetrics,
  LocalBusiness,
  LocalReview,
  LocalReviews,
  MapsResult,
  BacklinksSummary,
  Competitor,
  CompetitorsResult,
  InstantPage,
  RankedKeyword,
  RankedKeywordsResult,
  SerpOrganicItem,
  SerpOrganicResult,
} from "./dataforseo-shape.js";

/**
 * Thin DataForSEO v3 client. Every call goes through the cache and the budget
 * check, and the actual cost DataForSEO reports is written to the spend ledger.
 *
 * Estimates are deliberately conservative ceilings used only for the pre-flight
 * budget check; check dataforseo.com/pricing and tune them for your usage.
 */
export const ESTIMATE_USD = {
  searchVolume: 0.075,
  serp: 0.002,
  rankedKeywords: 0.02,
  competitors: 0.02,
  backlinksSummary: 0.02,
  onPageTask: 0.0125, // ~$0.000125 per page × 100 pages
  onPageRead: 0,
  instantPage: 0.0025,
  /** Phase 12 C4: Business Data my_business_info/live; the docs' example task cost (research D4). */
  myBusinessInfo: 0.0054,
  /** Phase 12 C4: SERP google/maps/live/advanced, one SERP of up to 100 results (research D7). */
  mapsSerp: 0.002,
} as const;

interface DfsTask<T> {
  id: string;
  status_code: number;
  status_message: string;
  cost: number;
  result: T[] | null;
}

interface DfsResponse<T> {
  status_code: number;
  status_message: string;
  cost: number;
  tasks: DfsTask<T>[];
}

/** True when the DataForSEO login and password are set (no network). */
export function isDataForSeoConfigured(): boolean {
  return Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD);
}

function authHeader(): string {
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) {
    throw new Error("DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set. See .env.example.");
  }
  return "Basic " + Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString("base64");
}

/**
 * One DataForSEO request. A task status >= 40000 is an error, except the codes in `pendingCodes`
 * (40601 Task Handed, 40602 Task In Queue, for task_get on a task that isn't ready), which come back as the task.
 */
async function request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal, pendingCodes: readonly number[] = [], timeoutMs: number = TIMEOUTS.networkMs): Promise<DfsTask<T>> {
  const res = await fetch(`${env.DATAFORSEO_BASE_URL}${path}`, {
    method,
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`DataForSEO ${path} HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as DfsResponse<T>;
  const task = json.tasks?.[0];
  if (!task) throw new Error(`DataForSEO ${path}: empty response (${json.status_message})`);
  // 20000 = ok, 20100 = task created
  if (task.status_code >= 40000 && !pendingCodes.includes(task.status_code)) {
    throw new Error(`DataForSEO ${path} ${task.status_code}: ${task.status_message}`);
  }
  return task;
}

/** A fetch that gave up (our 30s timeout) or was aborted: DataForSEO may still have run, and billed, the task. */
function isTimeoutOrAbort(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Run a paid request. If it times out or is aborted, the call may still have been
 * billed, so the pre-flight estimate is written to the ledger (endpoint
 * "<path> (timeout, estimated)") to keep the budget cap honest, then the error is rethrown.
 */
async function billedRequest<T>(clientSlug: string, path: string, body: unknown, estimateUsd: number, what: string, timeoutMs: number = TIMEOUTS.networkMs): Promise<DfsTask<T>> {
  try {
    return await request<T>("POST", path, body, undefined, [], timeoutMs);
  } catch (err) {
    if (!isTimeoutOrAbort(err)) throw err;
    recordSpend(clientSlug, "dataforseo", `${path} (timeout, estimated)`, estimateUsd);
    throw new Error(`DataForSEO ${path} timed out after ${timeoutMs / 1000}s; ${what} The estimated cost ($${estimateUsd}) was recorded against the budget.`);
  }
}

/** Cached + budgeted call. Only real (non-cached) calls hit the ledger. */
async function paid<T>(
  client: Client,
  name: keyof typeof ESTIMATE_USD,
  path: string,
  body: unknown,
  ttl: number,
  opts: { refresh?: boolean } = {},
): Promise<{ result: T[]; costUsd: number; fromCache: boolean }> {
  const key = cacheKey("dfs", env.DATAFORSEO_BASE_URL, path, body);
  const { value, fromCache } = await cached(
    key,
    ttl,
    async () => {
      assertBudget(client, ESTIMATE_USD[name]);
      const task = await billedRequest<T>(client.slug, path, body, ESTIMATE_USD[name], "DataForSEO may still have billed it.");
      recordSpend(client.slug, "dataforseo", path, task.cost ?? 0);
      return { result: task.result ?? [], costUsd: task.cost ?? 0 };
    },
    opts,
  );
  return { ...value, costUsd: fromCache ? 0 : value.costUsd, fromCache };
}

const geo = (c: Client) => ({ location_code: c.locationCode, language_code: c.languageCode });

// ---------------------------------------------------------------- keywords

export interface KeywordVolume {
  keyword: string;
  search_volume: number | null;
  competition: string | null;
  cpc: number | null;
  monthly_searches?: { year: number; month: number; search_volume: number }[];
}

/** Google Ads search volume for up to 1,000 keywords in one call. */
export function searchVolume(client: Client, keywords: string[]) {
  return paid<KeywordVolume>(
    client,
    "searchVolume",
    "/keywords_data/google_ads/search_volume/live",
    [{ keywords, ...geo(client) }],
    TTL.month,
  );
}

// -------------------------------------------------------------------- SERP

interface SerpResult {
  keyword: string;
  items?: { type: string; rank_group: number; rank_absolute: number; domain?: string; url?: string; title?: string }[];
}

/**
 * Market for a SERP request: a DataForSEO `location_name` (e.g.
 * "Austin,Texas,United States") when given, else the client's location code.
 */
const serpGeo = (c: Client, locationName?: string) =>
  locationName ? { location_name: locationName, language_code: c.languageCode } : geo(c);

/** Live organic SERP for one keyword. Returns the client's rank if found. */
export async function serp(client: Client, keyword: string, depth = 100, opts: { refresh?: boolean } = {}) {
  const res = await paid<SerpResult>(
    client,
    "serp",
    "/serp/google/organic/live/regular",
    [{ keyword, depth, ...serpGeo(client) }],
    TTL.day,
    opts,
  );
  const items = (res.result[0]?.items ?? []).filter((i) => i.type === "organic");
  const mine = items.find((i) => i.domain?.replace(/^www\./, "").endsWith(client.domain));
  return {
    keyword,
    clientRank: mine?.rank_group ?? null,
    clientUrl: mine?.url ?? null,
    top10: items.slice(0, 10).map((i) => ({ rank: i.rank_group, domain: i.domain, url: i.url, title: i.title })),
    costUsd: res.costUsd,
    fromCache: res.fromCache,
  };
}

/**
 * Live organic SERP for one keyword, every organic result up to `depth`, in a
 * named location (`locationName`) or the client's market. Paid, cached 1 day.
 */
export async function serpOrganic(client: Client, keyword: string, opts: { depth?: number; locationName?: string } = {}) {
  const res = await paid<RawSerp>(
    client,
    "serp",
    "/serp/google/organic/live/regular",
    [{ keyword, depth: opts.depth ?? 20, ...serpGeo(client, opts.locationName) }],
    TTL.day,
  );
  return { ...mapSerpOrganic(res.result[0]), costUsd: res.costUsd, fromCache: res.fromCache };
}

// ------------------------------------------------------- domain analytics

export async function rankedKeywords(client: Client, target = client.domain, limit = 100) {
  const { result, costUsd, fromCache } = await paid<RawRankedKeywords>(
    client,
    "rankedKeywords",
    "/dataforseo_labs/google/ranked_keywords/live",
    [{ target, limit, item_types: ["organic"], ...geo(client), order_by: ["keyword_data.keyword_info.search_volume,desc"] }],
    TTL.week,
  );
  return { ...mapRankedKeywords(result[0]), costUsd, fromCache };
}

export async function competitorDomains(client: Client, limit = 20) {
  const { result, costUsd, fromCache } = await paid<RawCompetitors>(
    client,
    "competitors",
    "/dataforseo_labs/google/competitors_domain/live",
    [{ target: client.domain, limit, item_types: ["organic"], ...geo(client) }],
    TTL.month,
  );
  return { ...mapCompetitors(result[0]), costUsd, fromCache };
}

export async function backlinksSummary(client: Client, target = client.domain) {
  const { result, costUsd, fromCache } = await paid<RawBacklinksSummary>(
    client,
    "backlinksSummary",
    "/backlinks/summary/live",
    [{ target, internal_list_limit: 10, include_subdomains: true }],
    TTL.week,
  );
  return { summary: mapBacklinksSummary(result[0]), costUsd, fromCache };
}

// ------------------------------------------------ Labs: keyword ideas and gap (Phase 12 B)

/** Labs Live price for every endpoint used here (research D3): per task plus per item returned. */
export const LABS_USD = { task: 0.012, item: 0.00012 } as const;
export const LABS_PATHS = {
  keywordIdeas: "/dataforseo_labs/google/keyword_ideas/live",
  keywordSuggestions: "/dataforseo_labs/google/keyword_suggestions/live",
  domainIntersection: "/dataforseo_labs/google/domain_intersection/live",
} as const;

const usd6 = (n: number) => Number(n.toFixed(6));
/** One Labs task asking for up to `limit` items: $0.012 + limit x $0.00012 (a ceiling; fewer items cost less). */
export const labsTaskUsd = (limit: number) => usd6(LABS_USD.task + limit * LABS_USD.item);
const perSeed = (limit: number, seeds: number) => Math.max(1, Math.ceil(limit / Math.max(1, seeds)));

interface LabsTask {
  path: string;
  body: Record<string, unknown>;
  limit: number;
  seed: string | null;
}

/** related: one keyword_ideas task with every seed; matching: one keyword_suggestions task per seed, ceil(limit / seeds) each. */
function ideaTasks(client: Client, req: KeywordIdeasRequest): LabsTask[] {
  if (req.mode === "related") return [{ path: LABS_PATHS.keywordIdeas, body: { keywords: req.seeds, ...geo(client), limit: req.limit }, limit: req.limit, seed: req.seeds.length === 1 ? req.seeds[0]! : null }];
  const per = perSeed(req.limit, req.seeds.length);
  return req.seeds.map((seed) => ({ path: LABS_PATHS.keywordSuggestions, body: { keyword: seed, ...geo(client), limit: per }, limit: per, seed }));
}

export function planLabsKeywordIdeas(client: Client, req: KeywordIdeasRequest): PaidPlan {
  const n = req.mode === "related" ? 1 : req.seeds.length;
  return {
    keyParts: { base: env.DATAFORSEO_BASE_URL, mode: req.mode, seeds: req.seeds, limit: req.limit, ...geo(client) },
    unit: "usd",
    requests: n,
    cost: (limit) => usd6(n * labsTaskUsd(req.mode === "related" ? limit : perSeed(limit, req.seeds.length))),
    breakdown: (limit) =>
      req.mode === "related"
        ? `1 keyword_ideas task × ($0.012 + ${limit} × $0.00012)`
        : `${n} keyword_suggestions task(s) × ($0.012 + ${perSeed(limit, req.seeds.length)} × $0.00012)`,
  };
}

/**
 * A whole multi-request Labs operation, cached as one entry (TTL.week) under the plan's key parts. On a miss,
 * the whole operation's estimate is checked against the USD caps before the first request; each request's
 * actual cost is recorded (a timeout records its estimate).
 */
async function labsOperation<V>(
  client: Client,
  capability: "keywordIdeas" | "keywordGap",
  plan: PaidPlan,
  limit: number,
  opts: { refresh?: boolean | undefined },
  run: (send: <T>(path: string, body: unknown, estimateUsd: number) => Promise<DfsTask<T>>) => Promise<V>,
): Promise<{ value: V; costUsd: number; fromCache: boolean }> {
  const { value, fromCache } = await cached(
    cacheKey("seo", "dataforseo", capability, plan.keyParts),
    TTL.week,
    // The whole operation's estimate is checked and reserved (SEC-1) until its last request ends.
    () => withUsdReservation(client, plan.cost(limit), async () => {
      let cost = 0;
      const send = async <T>(path: string, body: unknown, estimateUsd: number): Promise<DfsTask<T>> => {
        const task = await billedRequest<T>(client.slug, path, [body], estimateUsd, "DataForSEO may still have billed it.");
        recordSpend(client.slug, "dataforseo", path, task.cost ?? 0);
        cost += task.cost ?? 0;
        return task;
      };
      const v = await run(send);
      return { value: v, costUsd: usd6(cost) };
    }),
    { refresh: opts.refresh ?? false },
  );
  return { value: value.value, costUsd: fromCache ? 0 : value.costUsd, fromCache };
}

/** Keyword ideas from DataForSEO Labs (`related`: keyword_ideas; `matching`: keyword_suggestions). */
export async function labsKeywordIdeas(client: Client, req: KeywordIdeasRequest, opts: { refresh?: boolean } = {}): Promise<KeywordIdeasRouted> {
  const plan = planLabsKeywordIdeas(client, req);
  const r = await labsOperation(client, "keywordIdeas", plan, req.limit, opts, async (send) => {
    const lists = [];
    for (const t of ideaTasks(client, req)) {
      const task = await send<RawLabsKeywords>(t.path, t.body, labsTaskUsd(t.limit));
      lists.push(mapLabsKeywordIdeas(task.result?.[0], t.seed));
    }
    return { ideas: mergeIdeas(lists, req.limit) };
  });
  return { ...r.value, provider: "dataforseo", costUsd: r.costUsd, units: null, fromCache: r.fromCache };
}

/** DataForSEO wants bare domains (no scheme, no www.). */
const bareDomain = (d: string) => d.replace(/^www\./, "");

export function planLabsKeywordGap(client: Client, req: KeywordGapRequest): PaidPlan {
  const n = req.competitors.length;
  return {
    // minVolume is applied to the cached rows afterwards, so it isn't part of the key.
    keyParts: { base: env.DATAFORSEO_BASE_URL, target: bareDomain(client.domain), competitors: req.competitors, limit: req.limit, ...geo(client) },
    unit: "usd",
    requests: n,
    cost: (limit) => usd6(n * labsTaskUsd(limit)),
    breakdown: (limit) => `${n} competitor(s) × domain_intersection ($0.012 + ${limit} × $0.00012)`,
  };
}

/** Keyword gap from Labs domain_intersection: per competitor, target1 = competitor, target2 = client, intersections: false. */
export async function labsKeywordGap(client: Client, req: KeywordGapRequest, opts: { refresh?: boolean } = {}): Promise<KeywordGapRouted> {
  const plan = planLabsKeywordGap(client, req);
  const r = await labsOperation(client, "keywordGap", plan, req.limit, opts, async (send) => {
    const per = [];
    for (const competitor of req.competitors) {
      const body = { target1: bareDomain(competitor), target2: bareDomain(client.domain), intersections: false, item_types: ["organic"], ...geo(client), limit: req.limit };
      const task = await send<RawDomainIntersection>(LABS_PATHS.domainIntersection, body, labsTaskUsd(req.limit));
      per.push({ domain: competitor, rows: mapDomainIntersection(task.result?.[0]) });
    }
    return per;
  });
  const merged = mergeGaps(r.value, { metric: "dataforseo_kd", clientCheck: "provider", minVolume: req.minVolume });
  return { gaps: merged.gaps, perCompetitor: merged.perCompetitor, provider: "dataforseo", costUsd: r.costUsd, units: null, fromCache: r.fromCache };
}

// ------------------------------------------------ local SEO: Business Data and Maps (Phase 12 C4)

export const LOCAL_PATHS = {
  businessInfo: "/business_data/google/my_business_info/live",
  mapsSerp: "/serp/google/maps/live/advanced",
  reviewsPost: "/business_data/google/reviews/task_post",
  reviewsGet: "/business_data/google/reviews/task_get",
} as const;
/** Google Reviews in the priority queue (results within about a minute): $0.0015 per 10 reviews, billed per started 10 (research D6). */
export const REVIEWS_USD_PER_10 = 0.0015;
export const reviewsTaskUsd = (depth: number) => usd6(Math.ceil(depth / 10) * REVIEWS_USD_PER_10);
/** task_get statuses that mean "not ready yet" (DataForSEO errors appendix): 40601 Task Handed, 40602 Task In Queue. */
export const TASK_NOT_READY = [40601, 40602] as const;

/** Where local searches run: the client's area (a DataForSEO location_name), else its location code. */
export const localGeo = (c: Client) => (c.area ? { location_name: c.area, language_code: c.languageCode } : geo(c));


/**
 * Cache key for the local endpoints (SEC-1). Their cache holds the *mapped* value only, never the raw payload
 * (which carries place_topics, people_also_search, attributes and review quotes in local_justifications);
 * the "dfs-local" namespace keeps any older raw "dfs" rows from being read as mapped ones.
 */
export const localCacheKey = (path: string, body: unknown) => cacheKey("dfs-local", env.DATAFORSEO_BASE_URL, path, body);

/** Like `paid`, but maps the result inside the cached function, so only the mapped value is stored. */
async function paidLocal<R, V>(client: Client, name: "myBusinessInfo" | "mapsSerp", path: string, body: unknown, map: (raw: R | undefined) => V, opts: { refresh?: boolean } = {}) {
  const { value, fromCache } = await cached(
    localCacheKey(path, body),
    TTL.day,
    async () => {
      assertBudget(client, ESTIMATE_USD[name]);
      const task = await billedRequest<R>(client.slug, path, body, ESTIMATE_USD[name], "DataForSEO may still have billed it.");
      recordSpend(client.slug, "dataforseo", path, task.cost ?? 0);
      return { mapped: map(task.result?.[0]), costUsd: task.cost ?? 0 };
    },
    opts,
  );
  return { mapped: value.mapped, costUsd: fromCache ? 0 : value.costUsd, fromCache };
}

/**
 * Google Business Profile lookup by name (`keyword`) or `place_id:<id>`. Paid (about $0.0054), cached a day.
 * The docs (D4) list `place_id:` / `cid:` as identifiers the keyword field accepts, with no surcharge; the 5x price
 * is documented only for search operators (`site:`, `inurl:`) on Reviews. The C4 live check must confirm a
 * place-ID lookup costs the same as a name lookup.
 */
export async function myBusinessInfo(client: Client, body: Record<string, unknown>, opts: { refresh?: boolean } = {}) {
  const res = await paidLocal<RawBusinessInfo, ReturnType<typeof mapBusinessInfo>>(client, "myBusinessInfo", LOCAL_PATHS.businessInfo, [body], mapBusinessInfo, opts);
  return { businesses: res.mapped, costUsd: res.costUsd, fromCache: res.fromCache };
}

/** Google Maps results for one keyword. Paid (about $0.002 per SERP of up to 100), cached a day. */
export async function mapsSerp(client: Client, body: Record<string, unknown>, opts: { refresh?: boolean } = {}) {
  const res = await paidLocal<RawMapsSerp, ReturnType<typeof mapMapsSerp>>(client, "mapsSerp", LOCAL_PATHS.mapsSerp, [body], mapMapsSerp, opts);
  return { results: res.mapped, costUsd: res.costUsd, fromCache: res.fromCache };
}

/**
 * Post a Google Reviews task (task-based only; there is no Live endpoint). The caller checks and reserves the
 * estimate first. The actual cost is recorded; a timeout records the estimate (the task may exist anyway).
 */
export async function reviewsTaskPost(client: Client, body: Record<string, unknown>, estimateUsd: number): Promise<{ taskId: string; costUsd: number }> {
  assertBudget(client, estimateUsd);
  const task = await billedRequest<unknown>(client.slug, LOCAL_PATHS.reviewsPost, [body], estimateUsd, "a reviews task may have been created and billed anyway.");
  recordSpend(client.slug, "dataforseo", LOCAL_PATHS.reviewsPost, task.cost ?? 0);
  if (!task.id) throw new Error("DataForSEO created no reviews task id.");
  return { taskId: task.id, costUsd: task.cost ?? 0 };
}

/** Read a reviews task (free: only posting is billed). `ready: false` while DataForSEO is still working on it. */
export async function reviewsTaskGet(clientSlug: string, taskId: string): Promise<{ ready: false } | { ready: true; reviews: LocalReviews }> {
  const task = await request<RawReviews>("GET", `${LOCAL_PATHS.reviewsGet}/${encodeURIComponent(taskId)}`, undefined, undefined, TASK_NOT_READY);
  // Reading should be free; anything DataForSEO did charge shows up in the ledger.
  if ((task.cost ?? 0) > 0) recordSpend(clientSlug, "dataforseo", `${LOCAL_PATHS.reviewsGet} (read)`, task.cost);
  if ((TASK_NOT_READY as readonly number[]).includes(task.status_code)) return { ready: false };
  return { ready: true, reviews: mapReviews(task.result?.[0]) };
}

// ------------------------------------------------ AI Optimization: LLM Mentions (Phase 12 C5)

/** LLM Mentions paths (research D9, D10, D17). search_mentions/live replaces the legacy search/live (which still works). */
export const AI_PATHS = {
  searchMentions: "/ai_optimization/llm_mentions/search_mentions/live",
  targetMetrics: "/ai_optimization/llm_mentions/target_metrics/live",
} as const;
/** LLM Mentions price (research D11): $0.10 per task plus $0.001 per row returned. */
export const AI_USD = { task: 0.1, row: 0.001 } as const;
/** One LLM Mentions task asking for up to `rows` rows (a ceiling; fewer rows cost less). */
export const aiTaskUsd = (rows: number) => usd6(AI_USD.task + rows * AI_USD.row);
/** LLM Mentions Live calls can take up to 120 s (research D10). */
const AI_TIMEOUT_MS = 130_000;

/**
 * Cache key for LLM Mentions (SEC-5). The cache holds only the mapped value (what mapLlmMentions /
 * mapLlmTargetMetrics keep), never the raw payload with full answers, other sources, brands and fan-out queries;
 * the "dfs-ai" namespace keeps any older raw rows from being read as mapped ones.
 */
export const aiCacheKey = (path: string, body: unknown) => cacheKey("dfs-ai", env.DATAFORSEO_BASE_URL, path, body);

/**
 * One AI-visibility request, cached a week under its body, mapped inside the cached function. On a miss the AI
 * sub-cap and the client and global caps are checked (the caller has reserved the estimate), and the actual cost
 * is recorded under the /ai_optimization/ path, which is what the sub-cap sums.
 */
async function paidAi<R, V>(client: Client, path: string, body: unknown, estimateUsd: number, map: (raw: R | undefined) => V, opts: { refresh?: boolean } = {}) {
  const { value, fromCache } = await cached(
    aiCacheKey(path, body),
    TTL.week,
    async () => {
      assertAiBudget(estimateUsd);
      assertBudget(client, estimateUsd);
      const task = await billedRequest<R>(client.slug, path, body, estimateUsd, "DataForSEO may still have billed it.", AI_TIMEOUT_MS);
      recordSpend(client.slug, "dataforseo", path, task.cost ?? 0);
      return { mapped: map(task.result?.[0]), costUsd: task.cost ?? 0 };
    },
    { refresh: opts.refresh ?? false },
  );
  return { mapped: value.mapped, costUsd: fromCache ? 0 : value.costUsd, fromCache };
}

/** AI answers that cite `clientDomain` (llm_mentions/search_mentions/live). */
export async function llmSearchMentions(client: Client, body: Record<string, unknown>, rows: number, clientDomain: string, opts: { refresh?: boolean } = {}): Promise<{ items: LlmMention[]; total: number | null; costUsd: number; fromCache: boolean }> {
  const r = await paidAi<RawLlmMentions, ReturnType<typeof mapLlmMentions>>(client, AI_PATHS.searchMentions, [body], aiTaskUsd(rows), (raw) => mapLlmMentions(raw, clientDomain), opts);
  return { ...r.mapped, costUsd: r.costUsd, fromCache: r.fromCache };
}

/** Aggregate mention counts for a domain (llm_mentions/target_metrics/live). */
export async function llmTargetMetrics(client: Client, body: Record<string, unknown>, estimateUsd: number, opts: { refresh?: boolean } = {}): Promise<{ metrics: LlmTargetMetrics; costUsd: number; fromCache: boolean }> {
  const r = await paidAi<RawLlmTargetMetrics, LlmTargetMetrics>(client, AI_PATHS.targetMetrics, [body], estimateUsd, mapLlmTargetMetrics, opts);
  return { metrics: r.mapped, costUsd: r.costUsd, fromCache: r.fromCache };
}

// ------------------------------------------------------------------ on-page

/** Start an async site crawl. Poll with onPageSummary(taskId). */
export async function onPageStartCrawl(client: Client, maxPages = 100) {
  const estimate = ESTIMATE_USD.onPageTask * (maxPages / 100);
  assertBudget(client, estimate);
  const task = await billedRequest<unknown>(client.slug, "/on_page/task_post", [
    {
      target: client.domain,
      max_crawl_pages: maxPages,
      load_resources: true,
      enable_javascript: false,
      check_spell: false,
    },
  ], estimate, "a crawl may have started anyway; check the DataForSEO dashboard before starting another.");
  recordSpend(client.slug, "dataforseo", "/on_page/task_post", task.cost ?? 0);
  return { taskId: task.id, costUsd: task.cost ?? 0 };
}

interface OnPageSummary {
  crawl_progress: "in_progress" | "finished";
  crawl_status?: { pages_crawled: number; pages_in_queue: number; max_crawl_pages: number };
  domain_info?: { checks?: Record<string, boolean> };
  page_metrics?: { onpage_score?: number; checks?: Record<string, number>; broken_links?: number; duplicate_title?: number };
}

/** Crawl summary: progress, onpage score and counts per issue type. */
/** DataForSEO task IDs are UUID-like; anything else is refused before it reaches a URL path (SEC-5). */
export const TASK_ID_RE = /^[0-9a-z-]{8,64}$/i;
export function checkTaskId(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`"${taskId.slice(0, 80)}" isn't a DataForSEO task ID (letters, digits and hyphens, 8 to 64 characters).`);
  return encodeURIComponent(taskId);
}

export async function onPageSummary(taskId: string) {
  const task = await request<OnPageSummary>("GET", `/on_page/summary/${checkTaskId(taskId)}`);
  const r = task.result?.[0];
  const issues = Object.entries(r?.page_metrics?.checks ?? {})
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([check, pages]) => ({ check, pages }));
  return {
    taskId,
    status: r?.crawl_progress ?? "in_progress",
    crawl: r?.crawl_status,
    onpageScore: r?.page_metrics?.onpage_score,
    domainChecks: r?.domain_info?.checks,
    issues,
  };
}

/** Pages from a finished crawl that fail a given check, e.g. "no_description". */
export async function onPagePagesWithIssue(taskId: string, check: string, limit = 50) {
  const task = await request<{ items?: { url: string; status_code: number; meta?: { title?: string } }[] }>(
    "POST",
    "/on_page/pages",
    [{ id: taskId, limit, filters: [`checks.${check}`, "=", true] }],
  );
  return (task.result?.[0]?.items ?? []).map((p) => ({ url: p.url, status: p.status_code, title: p.meta?.title }));
}

export interface CrawlUrls {
  /** True when the crawl finished and ran out of pages before its cap, so a URL it never reached is truly unlinked. */
  exhaustive: boolean;
  urls: string[];
}

/**
 * URLs a finished crawl reached. Reads an existing task only (no task is posted), so it starts
 * no crawl and records no spend. Throws if the crawl has not finished.
 */
export async function onPageCrawlUrls(clientSlug: string, taskId: string, opts: { signal?: AbortSignal } = {}): Promise<CrawlUrls> {
  let cost = 0;
  try {
    const summaryTask = await request<OnPageSummary>("GET", `/on_page/summary/${checkTaskId(taskId)}`, undefined, opts.signal);
    cost += summaryTask.cost ?? 0;
    const sum = summaryTask.result?.[0];
    if (sum?.crawl_progress !== "finished") throw new Error("The stored crawl has not finished");
    const urls: string[] = [];
    const PAGE = 1000;
    for (let offset = 0; offset < 5000; offset += PAGE) {
      opts.signal?.throwIfAborted();
      const task = await request<{ items?: { url: string }[] }>("POST", "/on_page/pages", [{ id: taskId, limit: PAGE, offset }], opts.signal);
      cost += task.cost ?? 0;
      const items = task.result?.[0]?.items ?? [];
      urls.push(...items.map((i) => i.url));
      if (items.length < PAGE) break;
    }
    const c = sum.crawl_status;
    return { exhaustive: !!c && c.pages_in_queue === 0 && c.pages_crawled < c.max_crawl_pages && urls.length < 5000, urls };
  } finally {
    // Reading a task should be free; anything DataForSEO did charge shows up in the ledger.
    if (cost > 0) recordSpend(clientSlug, "dataforseo", "/on_page/pages (stored crawl read)", cost);
  }
}

/** Instant on-page check for a single URL, no crawl needed. */
export async function instantPage(client: Client, url: string, opts: { refresh?: boolean } = {}) {
  const { result, costUsd, fromCache } = await paid<RawInstantPages>(
    client,
    "instantPage",
    "/on_page/instant_pages",
    [{ url, enable_javascript: true }],
    TTL.day,
    opts,
  );
  return { page: mapInstantPage(result[0]), costUsd, fromCache };
}

// ------------------------------------------------------------------- status

export type DataForSeoStatusResult =
  | ({ credentialsConfigured: true; credentialsWork: true; reachable: true } & DataForSeoStatus & { costUsd: 0 })
  | {
      credentialsConfigured: boolean;
      /** false only when the login is missing or DataForSEO rejected it; null when the API couldn't be reached, so the credentials are untested. */
      credentialsWork: false | null;
      reachable: boolean;
      mode: "sandbox" | "live";
      apiHost: string;
      error: string;
      costUsd: 0;
    };

export interface DataForSeoCredentials {
  login?: string | undefined;
  password?: string | undefined;
  baseUrl: string;
}

/**
 * Free account check: `GET /appendix/user_data`. Reports the mode (from the base
 * URL), the balance and whether the credentials work. Not cached (the balance
 * should be current) and nothing is recorded to the spend ledger. A missing or
 * rejected login (`credentialsWork: false`) and an unreachable API (network
 * error, 5xx, 429, timeout: `credentialsWork: null`, `reachable: false`) are
 * reported in the result, not thrown, so a health check can show them. The
 * error text never includes the credentials. Takes explicit credentials so the
 * setup wizard can check them before saving; `dataForSeoStatus` uses the env.
 */
export async function checkDataForSeoCredentials(c: DataForSeoCredentials, fetchImpl: typeof fetch = fetch): Promise<DataForSeoStatusResult> {
  const mode = dataForSeoMode(c.baseUrl);
  const apiHost = new URL(c.baseUrl).hostname;
  if (!c.login || !c.password) {
    return { credentialsConfigured: false, credentialsWork: false, reachable: true, mode, apiHost, error: "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set.", costUsd: 0 };
  }
  const path = "/appendix/user_data";
  try {
    const res = await fetchImpl(`${c.baseUrl}${path}`, {
      method: "GET",
      headers: { Authorization: "Basic " + Buffer.from(`${c.login}:${c.password}`).toString("base64") },
      signal: AbortSignal.timeout(TIMEOUTS.networkMs),
    });
    if (!res.ok) throw new Error(`DataForSEO ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as DfsResponse<RawUserData>;
    const task = json.tasks?.[0];
    if (!task) throw new Error(`DataForSEO ${path}: empty response (${json.status_message})`);
    if (task.status_code >= 40000) throw new Error(`DataForSEO ${path} ${task.status_code}: ${task.status_message}`);
    return { credentialsConfigured: true, credentialsWork: true, reachable: true, ...mapUserData(task.result?.[0], c.baseUrl), costUsd: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const rejected = isAuthRejection(message);
    return {
      credentialsConfigured: true,
      credentialsWork: rejected ? false : null,
      reachable: rejected,
      mode,
      apiHost,
      error: rejected ? "DataForSEO rejected the credentials (check DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD)." : message.slice(0, 300),
      costUsd: 0,
    };
  }
}

/** The free account check with the configured credentials (the `dataforseo_status` tool). */
export function dataForSeoStatus(): Promise<DataForSeoStatusResult> {
  return checkDataForSeoCredentials({ login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD, baseUrl: env.DATAFORSEO_BASE_URL });
}
