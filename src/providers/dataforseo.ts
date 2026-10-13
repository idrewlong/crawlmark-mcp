import { env, type Client } from "../config.js";
import { TIMEOUTS } from "../lib/timeout.js";
import { assertBudget, recordSpend } from "../lib/budget.js";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import {
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
const ESTIMATE_USD = {
  searchVolume: 0.075,
  serp: 0.002,
  rankedKeywords: 0.02,
  competitors: 0.02,
  backlinksSummary: 0.02,
  onPageTask: 0.0125, // ~$0.000125 per page × 100 pages
  onPageRead: 0,
  instantPage: 0.0025,
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

function authHeader(): string {
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) {
    throw new Error("DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set. See .env.example.");
  }
  return "Basic " + Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString("base64");
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<DfsTask<T>> {
  const res = await fetch(`${env.DATAFORSEO_BASE_URL}${path}`, {
    method,
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUTS.networkMs)]) : AbortSignal.timeout(TIMEOUTS.networkMs),
  });
  if (!res.ok) throw new Error(`DataForSEO ${path} HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as DfsResponse<T>;
  const task = json.tasks?.[0];
  if (!task) throw new Error(`DataForSEO ${path}: empty response (${json.status_message})`);
  // 20000 = ok, 20100 = task created
  if (task.status_code >= 40000) {
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
async function billedRequest<T>(clientSlug: string, path: string, body: unknown, estimateUsd: number, what: string): Promise<DfsTask<T>> {
  try {
    return await request<T>("POST", path, body);
  } catch (err) {
    if (!isTimeoutOrAbort(err)) throw err;
    recordSpend(clientSlug, "dataforseo", `${path} (timeout, estimated)`, estimateUsd);
    throw new Error(`DataForSEO ${path} timed out after ${TIMEOUTS.networkMs / 1000}s; ${what} The estimated cost ($${estimateUsd}) was recorded against the budget.`);
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
export async function serp(client: Client, keyword: string, depth = 100) {
  const res = await paid<SerpResult>(
    client,
    "serp",
    "/serp/google/organic/live/regular",
    [{ keyword, depth, ...serpGeo(client) }],
    TTL.day,
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
export async function onPageSummary(taskId: string) {
  const task = await request<OnPageSummary>("GET", `/on_page/summary/${taskId}`);
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
    const summaryTask = await request<OnPageSummary>("GET", `/on_page/summary/${taskId}`, undefined, opts.signal);
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
