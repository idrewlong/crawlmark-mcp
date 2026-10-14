/**
 * The SEO data provider layer (Phase 9, spec 9.2 and 9.5). Tools and reports call
 * the routed functions here instead of dataforseo.ts: each picks the client's
 * provider (clients.yaml dataProvider, else SEO_DATA_PROVIDER), checks it can
 * serve the capability, and returns today's shape plus `provider` and `units`.
 *
 * - Keyword volume, ranked keywords, competitors and backlinks route to DataForSEO,
 *   Ahrefs (./ahrefs.ts) or Semrush (./semrush.ts).
 * - Live SERPs, on-page checks and crawls are DataForSEO-only; requireDataForSeo
 *   gates them (with `fallbackFrom` when another provider is the client's choice).
 * - A missing key for the chosen provider never falls back (D2), and a provider
 *   that fails passes its error up as-is (rule 5).
 */
import { env, seoDefaultProvider, type Client } from "../config.js";
import { displayProviderValue, invalidProviderMessage, PROVIDER_LABELS, ProviderUnavailableError, type ProviderId } from "../lib/provider-ids.js";
import { ahrefsProvider } from "./ahrefs.js";
import * as dfs from "./dataforseo.js";
import { semrushProvider } from "./semrush.js";
import { normalizeKeywordList } from "./semrush-shape.js";
import type { BacklinksSummary, CompetitorsResult, KeywordVolume, RankedKeywordsResult } from "./dataforseo.js";
import { BudgetExceededError, remainingUsd, type UnitProvider } from "../lib/budget.js";
import { cacheKey, peekCache } from "../lib/cache.js";
import { isPlainDomain, normalizeHost, normalizeKeyword } from "../lib/clients.js";
import { lastDays } from "../lib/dates.js";
import { remainingUnits } from "./units-billing.js";

export { PROVIDER_IDS, PROVIDER_LABELS, ProviderUnavailableError, resolveDefaultProvider, isProviderId } from "../lib/provider-ids.js";
export type { DefaultProvider, DefaultProviderSource, ProviderId } from "../lib/provider-ids.js";
export type { KeywordVolume } from "./dataforseo.js";

export type Capability =
  | "keywordVolume"
  | "rankedKeywords"
  | "competitorDomains"
  | "backlinksSummary"
  | "keywordIdeas"
  | "keywordGap"
  | "serpLive"
  | "onPageInstant"
  | "siteCrawl"
  // Phase 12 C4: local SEO from DataForSEO Business Data and Maps (no Ahrefs or Semrush equivalent).
  | "localProfile"
  | "localPack"
  | "localReviews"
  // Phase 12 C5: AI-search visibility from DataForSEO LLM Mentions (also gated by AI_VISIBILITY_ENABLED).
  | "aiVisibility"
  // Phase 13 B: organic visibility (position bands, traffic) and the competitor overview, routed to the client's provider.
  | "organicOverview"
  | "competitorOverview";

/** The capabilities that route to the client's provider (Phase 12 B adds keyword ideas and keyword gap). */
export const ROUTED_CAPABILITIES = ["keywordVolume", "rankedKeywords", "competitorDomains", "backlinksSummary", "keywordIdeas", "keywordGap", "organicOverview", "competitorOverview"] as const satisfies readonly Capability[];
const DFS_ONLY = ["serpLive", "onPageInstant", "siteCrawl", "localProfile", "localPack", "localReviews", "aiVisibility"] as const satisfies readonly Capability[];

export const CAPABILITIES: Readonly<Record<ProviderId, ReadonlySet<Capability>>> = {
  dataforseo: new Set<Capability>([...ROUTED_CAPABILITIES, ...DFS_ONLY]),
  ahrefs: new Set<Capability>(ROUTED_CAPABILITIES),
  semrush: new Set<Capability>(ROUTED_CAPABILITIES),
};

/** Extra fields every routed result carries (additive to today's shapes). */
export interface ProviderMeta {
  provider: ProviderId;
  /** Set when the client's provider lacks the capability and DataForSEO served it. */
  fallbackFrom?: ProviderId;
  /** As today; 0 for ahrefs/semrush. */
  costUsd: number;
  /** API units used: null for dataforseo; 0 when served from cache. */
  units: number | null;
  fromCache: boolean;
}

export interface CallOpts {
  refresh?: boolean;
  signal?: AbortSignal;
}

/** Ahrefs, Semrush and DataForSEO all report a domain-strength number; they differ, so the metric is labelled (D7). */
export type AuthorityMetric = "dataforseo_rank" | "domain_rating" | "semrush_score";
export type RoutedBacklinksSummary = BacklinksSummary & { authority: { metric: AuthorityMetric; value: number | null } };

export type KeywordVolumeResult = { result: KeywordVolume[]; notes?: string[] } & ProviderMeta;
export type RankedKeywordsRouted = RankedKeywordsResult & { notes?: string[] } & ProviderMeta;
export type CompetitorsRouted = CompetitorsResult & { notes?: string[] } & ProviderMeta;
export type BacklinksRouted = { summary: RoutedBacklinksSummary | null } & ProviderMeta;

// ------------------------------------------------------------------ keyword ideas and gap (Phase 12 B)

/** Each provider's keyword difficulty is its own 0-100 scale, so it is labelled and never mixed (B-D4). */
export type DifficultyMetric = "dataforseo_kd" | "ahrefs_kd" | "semrush_kd";

export interface KeywordIdeasRequest {
  /** Normalised, 1..20. */
  seeds: string[];
  mode: "related" | "matching";
  /** Ideas wanted in total, 1..200. */
  limit: number;
}

export interface KeywordIdea {
  keyword: string;
  volume: number | null;
  /** USD per click. */
  cpc: number | null;
  /** Advertiser competition, 0-1 (DataForSEO, Semrush); null for Ahrefs. */
  competition: number | null;
  difficulty: { metric: DifficultyMetric; value: number | null };
  intent: string | null;
  /** The seed the idea came from; null when one request covered several seeds. */
  seed: string | null;
}

export type KeywordIdeasRouted = { ideas: KeywordIdea[]; notes?: string[] } & ProviderMeta;

export interface KeywordGapRequest {
  /** Normalised competitor domains (bare hosts), 1..5. */
  competitors: string[];
  /** Rows per competitor, 1..500. */
  limit: number;
  minVolume: number;
}

export interface KeywordGapRow {
  keyword: string;
  volume: number | null;
  difficulty: { metric: DifficultyMetric; value: number | null };
  competitors: { domain: string; position: number | null; url: string | null }[];
  clientPosition: number | null;
  /** How "the client doesn't rank" was decided: by the provider, or by the client's own Search Console (Ahrefs, B-D3). */
  clientCheck: "provider" | "gsc";
}

export type KeywordGapRouted = { gaps: KeywordGapRow[]; perCompetitor: { domain: string; returned: number }[]; notes?: string[] } & ProviderMeta;

/** What the Ahrefs gap needs to know about Search Console (B-D3); the other providers ignore it. */
export interface GapContext {
  /** True when the client has a Search Console property and Google is set up. */
  gscAvailable: boolean;
  /** The client's queries with impressions in the last 90 days, normalised (free). */
  clientQueries(): Promise<Set<string>>;
}

/**
 * A paid operation's pre-flight plan (no request): the cache key parts (the provider's own call uses the
 * same ones) and the cost of the whole operation as a function of `limit`, in USD (DataForSEO) or units.
 */
export interface PaidPlan {
  keyParts: Record<string, unknown>;
  /** The cache key the call itself uses, when it isn't cacheKey("seo", provider, capability, keyParts) (Phase 13 B). */
  cacheKey?: string;
  unit: "usd" | "units";
  requests: number;
  cost(limit: number): number;
  breakdown(limit: number): string;
}

// ------------------------------------------------------------------ Phase 13 B: visibility, history, competitors

/** Backlink figures one snapshot stores (spec 13.5.1): counts only, never link lists. */
export interface BacklinksFigures {
  backlinks: number | null;
  referringDomains: number | null;
  authority: { metric: AuthorityMetric; value: number | null };
  newBacklinks: number | null;
  lostBacklinks: number | null;
  newReferringDomains: number | null;
  lostReferringDomains: number | null;
}

/** Visibility figures one snapshot stores (spec 13.5.1, D6): counts per band and the provider's own traffic estimate. */
export interface VisibilityFigures {
  keywords: number | null;
  top3: number | null;
  pos4_10: number | null;
  pos11_20: number | null;
  pos21_100: number | null;
  traffic: number | null;
  trafficLabel: string;
  /** Competitor snapshots only: keywords shared with the client (null when the provider didn't list the competitor). */
  commonKeywords?: number | null;
}

/** One competitor as a provider reports it (counts only). */
export interface ProviderCompetitor {
  domain: string;
  commonKeywords: number | null;
  keywords: number | null;
  traffic: number | null;
  /** False for a saved competitor the provider's list didn't include (looked up on its own). */
  inProviderList: boolean;
}

export interface CompetitorOverviewRequest {
  /** Saved competitors (bare domains, normalised), in saved order; looked up on their own when the provider's list misses them. */
  saved: string[];
  /** Rows wanted, 1..10. */
  limit: number;
}

export type OrganicOverviewRouted = { figures: VisibilityFigures; market: string } & ProviderMeta;
export type OrganicHistoryRouted = { points: ({ day: string } & VisibilityFigures)[]; market: string } & ProviderMeta;
export type BacklinksHistoryRouted = { points: ({ day: string } & BacklinksFigures)[] } & ProviderMeta;
export type CompetitorOverviewRouted = { rows: ProviderCompetitor[]; providerListSize: number; market: string } & ProviderMeta;

export interface SeoDataProvider {
  id: ProviderId;
  capabilities: ReadonlySet<Capability>;
  /** Key/login present (no network). */
  configured(): boolean;
  keywordVolume?(client: Client, keywords: string[], opts?: CallOpts): Promise<KeywordVolumeResult>;
  rankedKeywords?(client: Client, target: string, limit: number, opts?: CallOpts): Promise<RankedKeywordsRouted>;
  competitorDomains?(client: Client, limit: number, opts?: CallOpts): Promise<CompetitorsRouted>;
  backlinksSummary?(client: Client, target: string, opts?: CallOpts): Promise<BacklinksRouted>;
  /** Pure: throws ProviderUnavailableError when the client's market can't be served (e.g. no country). */
  planKeywordIdeas?(client: Client, req: KeywordIdeasRequest): PaidPlan;
  keywordIdeas?(client: Client, req: KeywordIdeasRequest, opts?: CallOpts): Promise<KeywordIdeasRouted>;
  planKeywordGap?(client: Client, req: KeywordGapRequest, ctx: Pick<GapContext, "gscAvailable">): PaidPlan;
  keywordGap?(client: Client, req: KeywordGapRequest, ctx: GapContext, opts?: CallOpts): Promise<KeywordGapRouted>;
  /** Phase 13 B. Plans are pure (no request); a plan's `cost` ignores its argument. */
  planBacklinksSummary?(client: Client, target: string): PaidPlan;
  planOrganicOverview?(client: Client, target: string): PaidPlan;
  organicOverview?(client: Client, target: string, opts?: CallOpts): Promise<OrganicOverviewRouted>;
  planOrganicHistory?(client: Client, target: string, months: number): PaidPlan;
  organicHistory?(client: Client, target: string, months: number, opts?: CallOpts): Promise<OrganicHistoryRouted>;
  /** DataForSEO and Ahrefs; Semrush has no backlink history (local snapshots only). */
  planBacklinksHistory?(client: Client, target: string, months: number): PaidPlan;
  backlinksHistory?(client: Client, target: string, months: number, opts?: CallOpts): Promise<BacklinksHistoryRouted>;
  planCompetitorOverview?(client: Client, req: CompetitorOverviewRequest): PaidPlan;
  competitorOverview?(client: Client, req: CompetitorOverviewRequest, opts?: CallOpts): Promise<CompetitorOverviewRouted>;
  /** The market string snapshots are keyed by (location code, country or database); throws ProviderUnavailableError when there is none. */
  market?(client: Client, capability: "organicOverview" | "competitorOverview"): string;
}

// ------------------------------------------------------------------ resolution (pure)

export interface ProviderEnv {
  defaultProvider: ProviderId | { invalid: string };
  configured: Record<ProviderId, boolean>;
  /** How to run the CLI here, for the invalid-default message (default `crawlmark-cli`). */
  cli?: string;
  /** The invalid default's message (resolveDefaultProvider); defaults to a generic one. */
  invalidMessage?: string;
}

const ONLY_LABEL: Record<(typeof DFS_ONLY)[number], string> = {
  serpLive: "Live SERP checks",
  onPageInstant: "On-page checks",
  siteCrawl: "Site crawls",
  localProfile: "Google Business Profile lookups",
  localPack: "Map pack positions",
  localReviews: "Google reviews",
  aiVisibility: "AI-search visibility checks",
};

const KEY_VAR: Record<ProviderId, string> = { dataforseo: "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD", ahrefs: "AHREFS_API_KEY", semrush: "SEMRUSH_API_KEY" };

/** Today's wording when DataForSEO has no login (rule 6). */
export const DFS_NOT_SET = "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set. See .env.example.";

const isDfsOnly = (c: Capability): c is (typeof DFS_ONLY)[number] => (DFS_ONLY as readonly string[]).includes(c);

/**
 * Pure: which provider serves `capability` for `client`, or why none can (9.5 rules 1-6).
 * 1. chosen = client.dataProvider ?? default; an invalid default with no override is unavailable
 *    for the routed capabilities (DataForSEO-only ones are unaffected).
 * 2. chosen has the capability and is configured: it serves.
 * 3. chosen lacks it: DataForSEO serves with fallbackFrom when configured, else unavailable.
 * 4. chosen has it but no key: unavailable (never falls back, D2).
 * 6. DataForSEO chosen and not configured: unavailable with today's wording.
 */
export function resolveProvider(
  client: Pick<Client, "slug" | "dataProvider">,
  capability: Capability,
  e: ProviderEnv,
): { provider: ProviderId; fallbackFrom?: ProviderId } | { unavailable: string } {
  const override = client.dataProvider;
  let chosen: ProviderId;
  if (override) chosen = override;
  else if (typeof e.defaultProvider === "string") chosen = e.defaultProvider;
  else if (isDfsOnly(capability)) chosen = "dataforseo";
  else {
    const base = e.invalidMessage ?? invalidProviderMessage(displayProviderValue(e.defaultProvider.invalid));
    return { unavailable: `${base} Change it with: ${e.cli ?? "crawlmark-cli"} setup --step provider, or in Claude Desktop's extension settings.` };
  }

  if (!CAPABILITIES[chosen].has(capability)) {
    if (e.configured.dataforseo) return { provider: "dataforseo", fallbackFrom: chosen };
    const what = isDfsOnly(capability) ? ONLY_LABEL[capability] : capability;
    return { unavailable: `${what} need DataForSEO; ${chosen} (the provider for ${client.slug}) doesn't offer them. Run setup --step dataforseo.` };
  }
  if (e.configured[chosen]) return { provider: chosen };
  if (chosen === "dataforseo") return { unavailable: DFS_NOT_SET };
  return {
    unavailable: override
      ? `${client.slug} uses dataProvider ${chosen} (clients.yaml) but ${KEY_VAR[chosen]} is not set. Run setup --step ${chosen}, or change it with clients set ${client.slug} --provider <dataforseo|ahrefs|semrush|none>.`
      : `SEO_DATA_PROVIDER is ${chosen} but ${KEY_VAR[chosen]} is not set. Run setup --step ${chosen}, or setup --step provider to pick another default.`,
  };
}

// ------------------------------------------------------------------ environment

/** True when the DataForSEO login and password are set (no network). Read from config, not dataforseo.ts, so test doubles of that module don't need it. */
export const dataForSeoConfigured = (): boolean => Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD);

/** The provider environment from config: the default (or its invalid value) and which providers have keys. */
export function providerEnv(): ProviderEnv {
  const d = seoDefaultProvider;
  return {
    defaultProvider: d.ok ? d.provider : { invalid: d.invalidValue },
    configured: { dataforseo: dataForSeoConfigured(), ahrefs: Boolean(env.AHREFS_API_KEY), semrush: Boolean(env.SEMRUSH_API_KEY) },
    ...(d.ok ? {} : { invalidMessage: d.message }),
  };
}

/** The CLI prefix for the invalid-default message (loaded lazily: status-providers pulls in a lot). */
async function cliForMessage(): Promise<string> {
  try {
    return (await import("../setup/status-providers.js")).cliPrefix();
  } catch {
    return "crawlmark-cli";
  }
}

async function choose(client: Client, capability: Capability): Promise<{ provider: ProviderId; fallbackFrom?: ProviderId }> {
  const e = providerEnv();
  let r = resolveProvider(client, capability, e);
  if ("unavailable" in r && typeof e.defaultProvider !== "string" && !client.dataProvider) {
    r = resolveProvider(client, capability, { ...e, cli: await cliForMessage() });
  }
  if ("unavailable" in r) throw new ProviderUnavailableError(capability, client.dataProvider ?? (typeof e.defaultProvider === "string" ? e.defaultProvider : null), r.unavailable);
  return r;
}

// ------------------------------------------------------------------ providers

const authority = (summary: BacklinksSummary | null): RoutedBacklinksSummary | null =>
  summary ? { ...summary, authority: { metric: "dataforseo_rank", value: summary.rank } } : null;

/** DataForSEO behind the provider interface: dataforseo.ts unchanged, plus provider and units (null). */
const dataforseoProvider: SeoDataProvider = {
  id: "dataforseo",
  capabilities: CAPABILITIES.dataforseo,
  configured: dataForSeoConfigured,
  planKeywordIdeas: (client, req) => dfs.planLabsKeywordIdeas(client, req),
  keywordIdeas: (client, req, opts) => dfs.labsKeywordIdeas(client, req, opts),
  planKeywordGap: (client, req) => dfs.planLabsKeywordGap(client, req),
  keywordGap: (client, req, _ctx, opts) => dfs.labsKeywordGap(client, req, opts),
  async keywordVolume(client, keywords) {
    return { ...(await dfs.searchVolume(client, keywords)), provider: "dataforseo", units: null };
  },
  async rankedKeywords(client, target, limit) {
    return { ...(await dfs.rankedKeywords(client, target, limit)), provider: "dataforseo", units: null };
  },
  async competitorDomains(client, limit) {
    return { ...(await dfs.competitorDomains(client, limit)), provider: "dataforseo", units: null };
  },
  async backlinksSummary(client, target) {
    const r = await dfs.backlinksSummary(client, target);
    return { ...r, summary: authority(r.summary), provider: "dataforseo", units: null };
  },
  // Phase 13 B
  planBacklinksSummary: (_c, t) => dfs.planBacklinksSummaryDfs(t),
  planOrganicOverview: (c, t) => dfs.planRankOverview(c, t),
  organicOverview: (c, t, o) => dfs.rankOverview(c, t, o),
  planOrganicHistory: (c, t, m) => dfs.planRankHistory(c, t, m),
  organicHistory: (c, t, m, o) => dfs.rankHistory(c, t, m, o),
  planBacklinksHistory: (c, t, m) => dfs.planBacklinksHistoryDfs(c, t, m),
  backlinksHistory: (c, t, m, o) => dfs.backlinksHistoryDfs(c, t, m, o),
  planCompetitorOverview: (c, r) => dfs.planCompetitorOverviewDfs(c, r),
  competitorOverview: (c, r, o) => dfs.competitorOverviewDfs(c, r, o),
  market: (c) => dfs.dfsMarket(c),
};

const registry: Partial<Record<ProviderId, SeoDataProvider>> = { dataforseo: dataforseoProvider, ahrefs: ahrefsProvider, semrush: semrushProvider };

function impl(id: ProviderId): SeoDataProvider {
  const p = registry[id];
  if (!p) throw new Error(`${PROVIDER_LABELS[id]} is not available in this build.`);
  return p;
}

/** Phase 13 B: a provider's implementation (provider sections plan and call it directly after routing). */
export const providerImpl = (id: ProviderId): SeoDataProvider => impl(id);

/**
 * Phase 13 B: which provider serves `capability` for this client (routed, D2: a missing key is ProviderUnavailableError,
 * never another provider). Provider history follows the provider this returns and is never routed on its own.
 */
export async function routeProvider(client: Client, capability: Capability): Promise<{ provider: ProviderId; fallbackFrom?: ProviderId }> {
  return choose(client, capability);
}

function withFallback<T extends object>(r: T, fallbackFrom: ProviderId | undefined): T {
  return fallbackFrom ? { ...r, fallbackFrom } : r;
}

// ------------------------------------------------------------------ routed entry points

/** Search volume, CPC and competition for keywords in the client's market. */
export async function searchVolume(client: Client, keywords: string[]): Promise<KeywordVolumeResult> {
  const { provider, fallbackFrom } = await choose(client, "keywordVolume");
  // Normalised once for every provider: the estimate, batches and cache key all see the same list.
  const list = normalizeKeywordList(keywords);
  if (list.length === 0) throw new Error("No keywords to look up after removing empty entries.");
  return withFallback(await impl(provider).keywordVolume!(client, list), fallbackFrom);
}

/** Keywords a domain ranks for (default: the client's own). */
export async function rankedKeywords(client: Client, target = client.domain, limit = 100): Promise<RankedKeywordsRouted> {
  const { provider, fallbackFrom } = await choose(client, "rankedKeywords");
  return withFallback(await impl(provider).rankedKeywords!(client, target, limit), fallbackFrom);
}

/** Organic competitors of the client's domain. */
export async function competitorDomains(client: Client, limit = 20): Promise<CompetitorsRouted> {
  const { provider, fallbackFrom } = await choose(client, "competitorDomains");
  return withFallback(await impl(provider).competitorDomains!(client, limit), fallbackFrom);
}

/** Backlink and referring-domain counts (plus a labelled authority metric). */
export async function backlinksSummary(client: Client, target = client.domain): Promise<BacklinksRouted> {
  const { provider, fallbackFrom } = await choose(client, "backlinksSummary");
  return withFallback(await impl(provider).backlinksSummary!(client, target), fallbackFrom);
}

/**
 * Throws ProviderUnavailableError unless DataForSEO can serve a DataForSEO-only
 * capability for this client. Returns `fallbackFrom` when the client's provider is
 * another one. Never makes a request.
 */
export function requireDataForSeo(capability: Capability, client: Pick<Client, "slug" | "dataProvider">): { fallbackFrom?: ProviderId } {
  const r = resolveProvider(client, capability, providerEnv());
  if ("unavailable" in r) throw new ProviderUnavailableError(capability, client.dataProvider ?? null, r.unavailable);
  return r.fallbackFrom ? { fallbackFrom: r.fallbackFrom } : {};
}

/** dataforseo.ts serp, gated by requireDataForSeo, plus `provider` (and `fallbackFrom`). */
export async function serp(client: Client, keyword: string, depth?: number, opts: { refresh?: boolean } = {}) {
  const { fallbackFrom } = requireDataForSeo("serpLive", client);
  return withFallback({ ...(await dfs.serp(client, keyword, depth, opts)), provider: "dataforseo" as const }, fallbackFrom);
}

/** dataforseo.ts serpOrganic, gated by requireDataForSeo. */
export async function serpOrganic(client: Client, keyword: string, opts: { depth?: number; locationName?: string } = {}) {
  const { fallbackFrom } = requireDataForSeo("serpLive", client);
  return withFallback({ ...(await dfs.serpOrganic(client, keyword, opts)), provider: "dataforseo" as const }, fallbackFrom);
}

/** dataforseo.ts instantPage, gated by requireDataForSeo. */
export async function instantPage(client: Client, url: string, opts: { refresh?: boolean } = {}) {
  requireDataForSeo("onPageInstant", client);
  return dfs.instantPage(client, url, opts);
}

/** dataforseo.ts onPageStartCrawl, gated by requireDataForSeo. */
export async function onPageStartCrawl(client: Client, maxPages?: number) {
  requireDataForSeo("siteCrawl", client);
  return dfs.onPageStartCrawl(client, maxPages);
}


// ------------------------------------------------------------------ keyword ideas and gap (Phase 12 B)

/** Limits tried, largest first, when an estimate doesn't fit: round numbers people recognise. */
const FIT_STEPS = [500, 250, 200, 100, 50, 25, 10, 5, 1];

export interface PaidEstimate {
  provider: ProviderId;
  requests: number;
  /** USD for DataForSEO, else 0. */
  usd: number;
  /** API units for Ahrefs/Semrush, else null. */
  units: number | null;
  breakdown: string;
  /** The same request ran within the cache window, so running it again costs nothing. */
  cached: boolean;
}

export interface EstimateResult {
  estimateOnly: true;
  provider: ProviderId;
  fallbackFrom?: ProviderId;
  estimate: PaidEstimate;
  /** What is left this month: USD (DataForSEO) or units (Ahrefs/Semrush), for the client and for everyone. */
  remaining: { unit: "usd" | "units"; client: number; global: number };
  wouldExceed: boolean;
  /** When it would exceed: the largest round limit that fits, and its cost. */
  fits?: { limit: number; cost: number } | null;
  message: string;
}

const fmtCost = (unit: "usd" | "units", n: number) => (unit === "usd" ? `$${n.toFixed(4)}` : `${Math.round(n).toLocaleString("en-US")} units`);
const capName = (provider: ProviderId) =>
  provider === "dataforseo" ? "monthlyBudgetUsd (or DEFAULT_CLIENT_MONTHLY_BUDGET_USD)" : `monthlyUnits.${provider} (or DEFAULT_CLIENT_MONTHLY_${provider.toUpperCase()}_UNITS)`;

function remainingFor(client: Client, provider: ProviderId): { unit: "usd" | "units"; client: number; global: number } {
  if (provider === "dataforseo") {
    const r = remainingUsd(client);
    return { unit: "usd", client: r.clientUsd, global: r.globalUsd };
  }
  const r = remainingUnits(client, provider as UnitProvider);
  return { unit: "units", client: r.client, global: r.global };
}

/** The whole operation's estimate against what's left, and the largest round limit that fits when it doesn't. Pure apart from reading the ledger. */
function estimateFor(client: Client, provider: ProviderId, capability: Capability, plan: PaidPlan, limit: number, fallbackFrom: ProviderId | undefined, refresh: boolean): EstimateResult {
  const cachedAlready = !refresh && peekCache(plan.cacheKey ?? cacheKey("seo", provider, capability, plan.keyParts)) !== undefined;
  const cost = cachedAlready ? 0 : plan.cost(limit);
  const remaining = remainingFor(client, provider);
  const left = Math.min(remaining.client, remaining.global);
  const wouldExceed = cost > left;
  let fits: EstimateResult["fits"];
  if (wouldExceed) {
    const l = FIT_STEPS.find((n) => n < limit && plan.cost(n) <= left);
    fits = l === undefined ? null : { limit: l, cost: plan.cost(l) };
  }
  const label = PROVIDER_LABELS[provider];
  const who = remaining.client <= remaining.global ? `${client.domain} has` : "the global cap has";
  const message = cachedAlready
    ? `${label}: already fetched within the last 7 days, so this comes from the cache and costs nothing.`
    : wouldExceed
      ? `That needs ${fmtCost(plan.unit, cost)} of ${label} (${plan.breakdown(limit)}) but ${who} ${fmtCost(plan.unit, left)} left this month. ` +
        (fits ? `Use limit ${fits.limit} (${fmtCost(plan.unit, fits.cost)}), or raise ${capName(provider)}.` : `Raise ${capName(provider)} to continue.`)
      : `${label}: ${plan.breakdown(limit)} = ${fmtCost(plan.unit, cost)} (an estimate; the actual cost is recorded). ${client.domain} has ${fmtCost(plan.unit, remaining.client)} left this month (global: ${fmtCost(plan.unit, remaining.global)}).`;
  return {
    estimateOnly: true,
    provider,
    ...(fallbackFrom ? { fallbackFrom } : {}),
    estimate: { provider, requests: cachedAlready ? 0 : plan.requests, usd: plan.unit === "usd" ? cost : 0, units: plan.unit === "units" ? cost : null, breakdown: plan.breakdown(limit), cached: cachedAlready },
    remaining,
    wouldExceed,
    ...(wouldExceed ? { fits: fits ?? null } : {}),
    message,
  };
}

export interface PaidCallOpts {
  estimateOnly?: boolean | undefined;
  refresh?: boolean | undefined;
}

/** Seeds for keyword_ideas: split on `;` and line breaks, trimmed, de-duplicated, 1..20. */
export function normalizeSeeds(seeds: readonly string[]): string[] {
  const list = normalizeKeywordList(seeds);
  if (list.length === 0) throw new Error("keyword_ideas needs at least one seed keyword.");
  if (list.length > 20) throw new Error(`keyword_ideas takes at most 20 seeds (got ${list.length}).`);
  return list;
}

/**
 * Keyword ideas from seed keywords through the client's provider (routed, D2: no silent fallback). The whole
 * call's estimate is checked against the caps before the first request; `estimateOnly` makes no request.
 */
export async function keywordIdeas(client: Client, req: KeywordIdeasRequest, opts: PaidCallOpts = {}): Promise<KeywordIdeasRouted | EstimateResult> {
  const { provider, fallbackFrom } = await choose(client, "keywordIdeas");
  const p = impl(provider);
  if (!p.planKeywordIdeas || !p.keywordIdeas) throw new Error(`Keyword ideas from ${PROVIDER_LABELS[provider]} are not available in this build.`);
  const r: KeywordIdeasRequest = { ...req, seeds: normalizeSeeds(req.seeds) };
  const plan = p.planKeywordIdeas(client, r);
  const est = estimateFor(client, provider, "keywordIdeas", plan, r.limit, fallbackFrom, opts.refresh === true);
  if (opts.estimateOnly) return est;
  // Refused before any request, naming a limit that fits (B-D5); the provider re-checks its own cap too.
  if (est.wouldExceed) throw new BudgetExceededError(est.message);
  return withFallback(await p.keywordIdeas(client, r, { refresh: opts.refresh ?? false }), fallbackFrom);
}

/** Competitor domains for keyword_gap: the ones passed (normalised, not the client's own), else the client's first 3 saved. */
export function gapCompetitors(client: Pick<Client, "domain" | "competitors">, passed: readonly string[] | undefined): string[] {
  const own = client.domain.replace(/^www\./, "");
  const norm = (d: string) => normalizeHost(d)?.replace(/^www\./, "");
  if (passed?.length) {
    const out: string[] = [];
    for (const d of passed) {
      const h = norm(d);
      if (!h || !isPlainDomain(h)) throw new Error(`"${d}" isn't a domain.`);
      if (h === own || h.endsWith(`.${own}`)) throw new Error(`${h} is ${client.domain} itself; pass competitors' domains.`);
      if (!out.includes(h)) out.push(h);
    }
    if (out.length > 5) throw new Error("keyword_gap compares at most 5 competitors at a time.");
    return out;
  }
  const saved = client.competitors.map((d) => norm(d)).filter((d): d is string => Boolean(d) && isPlainDomain(d!));
  if (saved.length === 0) {
    throw new Error(`${client.domain} has no saved competitors and none were passed. Find some with suggest_competitors (and save them with add_competitors), or pass competitors.`);
  }
  return [...new Set(saved)].slice(0, 3);
}

/** The Search Console side of the Ahrefs gap (B-D3): free, loaded only when needed. */
async function gapContext(client: Client): Promise<GapContext> {
  const google = await import("./google.js");
  const gscAvailable = google.googleConfigured() && Boolean(client.gscProperty);
  return {
    gscAvailable,
    clientQueries: async () => {
      const { gscQuery } = await import("./gsc.js");
      const rows = await gscQuery(client, { ...lastDays(90, 3), dimensions: ["query"], rowLimit: 25_000 });
      return new Set(rows.filter((r) => r.impressions > 0).map((r) => normalizeKeyword(r.keys[0] ?? "")).filter((k): k is string => Boolean(k)));
    },
  };
}

/**
 * Keywords competitors rank for and the client doesn't, through the client's provider (routed, no silent
 * fallback). One pre-flight check for every request in the call (all competitors, and Ahrefs' client call
 * when Search Console isn't available) before the first; `estimateOnly` makes no request.
 */
export async function keywordGap(client: Client, req: KeywordGapRequest, opts: PaidCallOpts & { ctx?: GapContext } = {}): Promise<KeywordGapRouted | EstimateResult> {
  const { provider, fallbackFrom } = await choose(client, "keywordGap");
  const p = impl(provider);
  if (!p.planKeywordGap || !p.keywordGap) throw new Error(`Keyword gap from ${PROVIDER_LABELS[provider]} is not available in this build.`);
  const ctx = opts.ctx ?? (await gapContext(client));
  const plan = p.planKeywordGap(client, req, ctx);
  const est = estimateFor(client, provider, "keywordGap", plan, req.limit, fallbackFrom, opts.refresh === true);
  if (opts.estimateOnly) return est;
  if (est.wouldExceed) throw new BudgetExceededError(est.message);
  return withFallback(await p.keywordGap(client, req, ctx, { refresh: opts.refresh ?? false }), fallbackFrom);
}
