import { env, type Client } from "../config.js";
import { assertBudget, recordSpend } from "../lib/budget.js";
import { cached, cacheKey, TTL } from "../lib/cache.js";

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

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<DfsTask<T>> {
  const res = await fetch(`${env.DATAFORSEO_BASE_URL}${path}`, {
    method,
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
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
      const task = await request<T>("POST", path, body);
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

/** Live organic SERP for one keyword. Returns the client's rank if found. */
export async function serp(client: Client, keyword: string, depth = 100) {
  const res = await paid<SerpResult>(
    client,
    "serp",
    "/serp/google/organic/live/regular",
    [{ keyword, depth, ...geo(client) }],
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

// ------------------------------------------------------- domain analytics

export function rankedKeywords(client: Client, target = client.domain, limit = 100) {
  return paid<unknown>(
    client,
    "rankedKeywords",
    "/dataforseo_labs/google/ranked_keywords/live",
    [{ target, limit, ...geo(client), order_by: ["keyword_data.keyword_info.search_volume,desc"] }],
    TTL.week,
  );
}

export function competitorDomains(client: Client, limit = 20) {
  return paid<unknown>(
    client,
    "competitors",
    "/dataforseo_labs/google/competitors_domain/live",
    [{ target: client.domain, limit, ...geo(client) }],
    TTL.month,
  );
}

export function backlinksSummary(client: Client, target = client.domain) {
  return paid<unknown>(
    client,
    "backlinksSummary",
    "/backlinks/summary/live",
    [{ target, internal_list_limit: 10, include_subdomains: true }],
    TTL.week,
  );
}

// ------------------------------------------------------------------ on-page

/** Start an async site crawl. Poll with onPageSummary(taskId). */
export async function onPageStartCrawl(client: Client, maxPages = 100) {
  assertBudget(client, ESTIMATE_USD.onPageTask * (maxPages / 100));
  const task = await request<unknown>("POST", "/on_page/task_post", [
    {
      target: client.domain,
      max_crawl_pages: maxPages,
      load_resources: true,
      enable_javascript: false,
      check_spell: false,
    },
  ]);
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

/** Instant on-page check for a single URL, no crawl needed. */
export function instantPage(client: Client, url: string) {
  return paid<unknown>(client, "instantPage", "/on_page/instant_pages", [{ url, enable_javascript: true }], TTL.day);
}
