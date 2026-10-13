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

export { PROVIDER_IDS, PROVIDER_LABELS, ProviderUnavailableError, resolveDefaultProvider, isProviderId } from "../lib/provider-ids.js";
export type { DefaultProvider, DefaultProviderSource, ProviderId } from "../lib/provider-ids.js";
export type { KeywordVolume } from "./dataforseo.js";

export type Capability = "keywordVolume" | "rankedKeywords" | "competitorDomains" | "backlinksSummary" | "serpLive" | "onPageInstant" | "siteCrawl";

/** The four capabilities that route to the client's provider. */
export const ROUTED_CAPABILITIES = ["keywordVolume", "rankedKeywords", "competitorDomains", "backlinksSummary"] as const satisfies readonly Capability[];
const DFS_ONLY = ["serpLive", "onPageInstant", "siteCrawl"] as const satisfies readonly Capability[];

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

export interface SeoDataProvider {
  id: ProviderId;
  capabilities: ReadonlySet<Capability>;
  /** Key/login present (no network). */
  configured(): boolean;
  keywordVolume?(client: Client, keywords: string[], opts?: CallOpts): Promise<KeywordVolumeResult>;
  rankedKeywords?(client: Client, target: string, limit: number, opts?: CallOpts): Promise<RankedKeywordsRouted>;
  competitorDomains?(client: Client, limit: number, opts?: CallOpts): Promise<CompetitorsRouted>;
  backlinksSummary?(client: Client, target: string, opts?: CallOpts): Promise<BacklinksRouted>;
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
};

const registry: Partial<Record<ProviderId, SeoDataProvider>> = { dataforseo: dataforseoProvider, ahrefs: ahrefsProvider, semrush: semrushProvider };

function impl(id: ProviderId): SeoDataProvider {
  const p = registry[id];
  if (!p) throw new Error(`${PROVIDER_LABELS[id]} is not available in this build.`);
  return p;
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
export async function serp(client: Client, keyword: string, depth?: number) {
  const { fallbackFrom } = requireDataForSeo("serpLive", client);
  return withFallback({ ...(await dfs.serp(client, keyword, depth)), provider: "dataforseo" as const }, fallbackFrom);
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
