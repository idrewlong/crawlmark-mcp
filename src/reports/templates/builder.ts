/**
 * The template builder's backend (Phase 13 C): the section catalogue grouped and labelled free / paid,
 * default section specs, and per-client cost estimates for paid sections. Estimates reuse each paid
 * section's own plan (stored snapshots and caches honoured) and never make a provider request.
 */
import type { Client } from "../../lib/clients.js";
import { resolvePeriod } from "./period.js";
import { estimatePaidSections, providerWindow, type RunDeps, type SectionEstimate } from "./run.js";
import {
  COMPARISONS,
  PAID_SECTION_TYPES,
  SECTION_CATALOGUE,
  SECTION_TITLES,
  SECTION_TYPES,
  type Comparison,
  type Period,
  type SectionCost,
  type SectionGroup,
  type SectionSpec,
  type SectionType,
} from "./schema.js";

export const GROUP_LABELS: Record<SectionGroup, string> = {
  search: "Search Console",
  analytics: "Analytics",
  site: "Site health",
  seo_data: "SEO data (paid)",
  local: "Local search",
  ai: "AI search",
  other: "Other",
};
export const GROUP_ORDER: SectionGroup[] = ["search", "analytics", "site", "seo_data", "local", "ai", "other"];

/** Section ids the builder gives each type (the builtin templates' ids where they have one). */
export const DEFAULT_SECTION_IDS: Record<SectionType, string> = {
  search_overview: "search",
  branded_split: "brand",
  organic_traffic: "traffic",
  top_queries: "queries",
  query_movers: "query-movers",
  page_movers: "page-movers",
  top_pages: "pages",
  landing_pages: "landing",
  tracked_keywords: "tracked",
  opportunities: "opportunities",
  audit_changes: "audit",
  core_web_vitals_history: "cwv",
  tag_manager: "gtm",
  data_spend: "spend",
  rank_trend: "ranks",
  keyword_gap: "gap",
  site_crawl: "crawl",
  bing_overview: "bing",
  ai_readiness: "ai",
  local_profile: "local",
  ai_visibility: "ai-visibility",
  technical_issues: "issues",
  indexing_issues: "indexing",
  backlinks: "backlinks",
  organic_visibility: "visibility",
  competitor_overview: "competitors",
  text: "note",
  block: "block",
};

export interface CatalogueEntry {
  type: SectionType;
  title: string;
  group: SectionGroup;
  groupLabel: string;
  cost: SectionCost;
  /** Always costs money (needs paid: true and --paid / allowPaid). Types that are paid only with an option are false. */
  paid: boolean;
  needs?: string;
  summary: string;
  defaultId: string;
}

/** Every section type, in group order then schema order. get_report_template's `catalogue` field and the CLI builder. */
export function templateCatalogue(): CatalogueEntry[] {
  const entries = (SECTION_TYPES as SectionType[]).map((type): CatalogueEntry => {
    const c = SECTION_CATALOGUE[type];
    return {
      type,
      title: SECTION_TITLES[type],
      group: c.group,
      groupLabel: GROUP_LABELS[c.group],
      cost: c.cost,
      paid: PAID_SECTION_TYPES.has(type),
      ...(c.needs ? { needs: c.needs } : {}),
      summary: c.summary,
      defaultId: DEFAULT_SECTION_IDS[type],
    };
  });
  return GROUP_ORDER.flatMap((g) => entries.filter((e) => e.group === g));
}

/**
 * A section of `type` with the builder's defaults: its default id, `paid: true` for paid types, `optional: true`
 * for Tag Manager (opt-in by rule). Options that cost money (live ranks, provider site-audit sources) are never set.
 */
export function defaultSection(type: SectionType, opts: { id?: string; text?: string; block?: string } = {}): SectionSpec {
  const id = opts.id ?? DEFAULT_SECTION_IDS[type];
  if (type === "text") return { id, type, text: opts.text ?? "Notes for this report." };
  // A block section needs a block in the file's `blocks` library; "notes" is only a placeholder name.
  if (type === "block") return { id, type, block: opts.block ?? "notes" };
  const s: Record<string, unknown> = { id, type };
  if (type === "tag_manager") s.optional = true;
  if (PAID_SECTION_TYPES.has(type)) s.paid = true;
  return s as SectionSpec;
}

/**
 * Price paid sections for one client with no provider request (D17's estimate functions): one entry per
 * section id (null for free ones). The window is the template period's (default last month).
 */
export async function estimateSectionsFor(
  client: Client,
  sections: readonly SectionSpec[],
  deps: RunDeps,
  opts: { period?: Period | undefined; compare?: readonly Comparison[] | undefined; today?: Date } = {},
): Promise<Map<string, SectionEstimate[]>> {
  const period = resolvePeriod(opts.period ?? { range: "last_month" }, opts.compare ?? COMPARISONS, {}, opts.today ?? new Date());
  const paid = sections.filter((s) => PAID_SECTION_TYPES.has(s.type) || s.paid === true);
  const out = new Map<string, SectionEstimate[]>();
  if (!paid.length) return out;
  for (const e of await estimatePaidSections(client, [...paid], deps, { window: providerWindow(period) })) {
    out.set(e.id, [...(out.get(e.id) ?? []), e]);
  }
  return out;
}

const PROVIDER_LABEL = { dataforseo: "DataForSEO", ahrefs: "Ahrefs", semrush: "Semrush" } as const;

/** "$0.025" (four decimals under a cent). */
export const usdText = (usd: number) => `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(3)}`;

/** "about $0.025 (DataForSEO)" or "about 250 Ahrefs units", or null when nothing would be bought. */
export function estimateText(estimates: readonly SectionEstimate[] | undefined): string | null {
  if (!estimates?.length) return null;
  const parts: string[] = [];
  for (const e of estimates) {
    if (!e.provider) continue;
    if (e.provider === "dataforseo" && e.usd > 0) parts.push(`about ${usdText(e.usd)} (DataForSEO)`);
    else if (e.provider !== "dataforseo" && e.units > 0) parts.push(`about ${e.units.toLocaleString("en-US")} ${PROVIDER_LABEL[e.provider]} units`);
  }
  return parts.length ? parts.join(" + ") : null;
}

/**
 * The builder's label suffix for a section: "(free)", "(free - needs CRUX_API_KEY or PSI_API_KEY)",
 * "(paid - DataForSEO - ~$0.025 per run for example.com)", "(paid - ~250 Ahrefs units per run for example.com)",
 * or "(paid)" without a client.
 */
export function costLabel(entry: Pick<CatalogueEntry, "cost" | "needs" | "paid">, estimates: readonly SectionEstimate[] | undefined, domain: string | undefined): string {
  if (!entry.paid) return entry.cost === "free_key" && entry.needs ? `(free \u00b7 needs ${entry.needs})` : "(free)";
  if (!domain || !estimates) return "(paid)";
  const e = estimates[0];
  if (!e) return "(paid)";
  if (!e.provider) return `(paid \u00b7 can't run for ${domain} yet)`;
  const usd = estimates.reduce((a, x) => a + (x.provider === "dataforseo" ? x.usd : 0), 0);
  const units = estimates.reduce((a, x) => a + (x.provider !== "dataforseo" ? x.units : 0), 0);
  if (usd > 0) return `(paid \u00b7 DataForSEO \u00b7 ~${usdText(usd)} per run for ${domain})`;
  if (units > 0) return `(paid \u00b7 ~${units.toLocaleString("en-US")} ${PROVIDER_LABEL[e.provider]} units per run for ${domain})`;
  return `(paid \u00b7 ${PROVIDER_LABEL[e.provider]} \u00b7 nothing to buy right now for ${domain}: stored figures cover it)`;
}
