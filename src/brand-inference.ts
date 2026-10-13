/**
 * Fetches one client's query rows and runs brand-term inference on them
 * (src/analysis/brand-terms.ts). Search Console first (free). DataForSEO ranked
 * keywords for the client's own domain (paid) only when Search Console isn't
 * usable at all (Google not set up, or no property), or when it returned under
 * MIN_GSC_ROWS rows and the caller explicitly allowed paid calls. A Search
 * Console error never falls back to paid. Never writes anything; callers decide what to
 * save. Takes a resolved Client so discovery can call it without a cycle
 * through src/clients.ts.
 */
import {
  inferBrandTerms,
  mergeCandidates,
  METHOD,
  type BrandCandidate,
  type BrandQueryRow,
  type EvidenceQuery,
  type ExcludedTerm,
  type InferResult,
} from "./analysis/brand-terms.js";
import type { BrandClient } from "./lib/brand.js";
import type { Client } from "./lib/clients.js";
import { lastDays } from "./lib/dates.js";
import { rankedKeywords, type ProviderId } from "./providers/seo-data.js";
import { googleConfigured } from "./providers/google.js";
import { gscQuery } from "./providers/gsc.js";

/** Search Console window and row cap. */
export const GSC_DAYS = 90;
const GSC_ROW_LIMIT = 1000;
/** Fewer Search Console query rows than this is "sparse": DataForSEO is used only with an explicit allowPaid: true. */
export const MIN_GSC_ROWS = 20;
/** Ranked keywords fetched for the fallback (cached 7 days by the provider). */
const RANKED_LIMIT = 100;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface SourceStatus {
  /** True when the source was queried. */
  used: boolean;
  /** The paid source's data provider (Phase 9); the source keeps its "dataforseo" key for compatibility. */
  provider?: ProviderId;
  rows?: number;
  error?: string;
  /** Why it wasn't queried. */
  skipped?: string;
}

export interface BrandInference {
  client: string;
  candidates: BrandCandidate[];
  excluded: ExcludedTerm[];
  nonBrandedQueries: (EvidenceQuery & { source: "gsc" | "dataforseo" })[];
  genericWords: string[];
  sources: { gsc: SourceStatus; dataforseo: SourceStatus };
  method: string;
  notes: string[];
  costUsd: number;
  /** Ahrefs/Semrush API units used (Phase 9); present only when one was used. */
  units?: Partial<Record<"ahrefs" | "semrush", number>>;
  /** True when every paid call was served from the cache; false when none was made. */
  fromCache: boolean;
}

/** What another client is known by, for the other-client-brand exclusion. */
export const brandIdentity = (c: Client): BrandClient => ({ domain: c.domain, name: c.name, ga4Name: c.ga4Name, brandTerms: c.brandTerms });

/**
 * Infer brand-term candidates for one client from its own data only.
 * `others` are every other client (their names are never proposed for this one).
 */
export interface InferPaidOptions {
  /**
   * Paid DataForSEO fallback. Unset (default): only when Search Console isn't usable (no Google, or no property).
   * true: also when Search Console returned under MIN_GSC_ROWS rows. false: never.
   * A Search Console error never falls back to paid either way.
   */
  allowPaid?: boolean | undefined;
}

export async function inferClientBrandTerms(client: Client, others: Client[], opts: InferPaidOptions = {}): Promise<BrandInference> {
  const ctx = { ...brandIdentity(client), niche: client.niche, area: client.area };
  const otherClients = others.filter((o) => o.domain !== client.domain).map(brandIdentity);
  const notes: string[] = [];
  const results: InferResult[] = [];
  const sources: BrandInference["sources"] = { gsc: { used: false }, dataforseo: { used: false } };
  let costUsd = 0;
  let units: BrandInference["units"];
  const cacheFlags: boolean[] = [];

  let gscRows = 0;
  if (!googleConfigured()) sources.gsc.skipped = "Google isn't set up.";
  else if (!client.gscProperty) sources.gsc.skipped = "The client has no Search Console property.";
  else {
    sources.gsc.used = true;
    try {
      const rows = await gscQuery(client, { ...lastDays(GSC_DAYS), dimensions: ["query"], rowLimit: GSC_ROW_LIMIT });
      gscRows = rows.length;
      sources.gsc.rows = rows.length;
      const input: BrandQueryRow[] = rows.map((r) => ({ query: r.keys[0] ?? "", clicks: r.clicks, impressions: r.impressions, position: r.position }));
      results.push(inferBrandTerms(input, ctx, { source: "gsc", otherClients }));
    } catch (err) {
      sources.gsc.error = errText(err);
    }
  }

  const gscUnusable = !sources.gsc.used;
  const gscSparse = sources.gsc.used && sources.gsc.error === undefined && gscRows < MIN_GSC_ROWS;
  if (sources.gsc.error !== undefined) sources.dataforseo.skipped = "Search Console failed; a Search Console error never falls back to the paid source.";
  else if (!gscUnusable && !gscSparse) sources.dataforseo.skipped = `Search Console returned ${gscRows} query rows (>= ${MIN_GSC_ROWS}), so no fallback was needed.`;
  else if (opts.allowPaid === false) sources.dataforseo.skipped = "Paid calls are off for this run.";
  else if (gscSparse && opts.allowPaid !== true) {
    sources.dataforseo.skipped = `Search Console returned only ${gscRows} query rows. The DataForSEO fallback (paid, about $0.02) runs for sparse data only with allowPaid: true.`;
  } else {
    sources.dataforseo.used = true;
    try {
      const r = await rankedKeywords(client, client.domain, RANKED_LIMIT);
      costUsd += r.costUsd;
      cacheFlags.push(r.fromCache);
      if (r.provider) sources.dataforseo.provider = r.provider;
      if ((r.provider === "ahrefs" || r.provider === "semrush") && typeof r.units === "number") units = { [r.provider]: r.units };
      sources.dataforseo.rows = r.items.length;
      const input: BrandQueryRow[] = r.items.map((k) => ({ query: k.keyword, position: k.position, searchVolume: k.searchVolume, estimatedTraffic: k.estimatedTraffic }));
      results.push(inferBrandTerms(input, ctx, { source: "dataforseo", otherClients }));
    } catch (err) {
      sources.dataforseo.error = errText(err);
    }
  }

  if (results.length === 0) {
    const why = [
      sources.gsc.error && `Search Console: ${sources.gsc.error}`,
      sources.dataforseo.error && `DataForSEO: ${sources.dataforseo.error}`,
    ].filter(Boolean);
    if (why.length) throw new Error(`No query data for ${client.domain}. ${why.join(" ")}`);
    notes.push(`No query data for ${client.domain}: ${sources.gsc.skipped ?? ""} ${sources.dataforseo.skipped ?? ""}`.trim());
  }

  const candidates = mergeCandidates(results.map((r) => r.candidates));
  const excluded = [...new Map(results.flatMap((r) => r.excluded).map((e) => [e.term, e])).values()];
  return {
    client: client.domain,
    candidates,
    excluded,
    nonBrandedQueries: (results[0]?.nonBrandedQueries ?? []).map((q) => ({ ...q, source: results[0]!.source })),
    genericWords: results[0]?.genericWords ?? [],
    sources,
    method: METHOD,
    notes,
    costUsd: Number(costUsd.toFixed(4)),
    ...(units ? { units } : {}),
    fromCache: cacheFlags.length > 0 && cacheFlags.every(Boolean),
  };
}
