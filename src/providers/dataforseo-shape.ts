/**
 * Pure mappers from raw DataForSEO v3 results to compact, typed objects.
 * No I/O here so they can be tested against recorded payloads.
 * Every field is read defensively: DataForSEO omits or nulls fields freely.
 */

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
/** Like str, with runs of whitespace (including newlines) collapsed to one space. */
const text = (v: unknown): string | null => {
  const s = str(v)?.replace(/\s+/g, " ").trim();
  return s ? s : null;
};
const round = (v: number | null, digits = 2): number | null =>
  v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits;

// ---------------------------------------------------------- ranked keywords

export interface RankedKeyword {
  keyword: string;
  position: number | null;
  searchVolume: number | null;
  url: string | null;
  estimatedTraffic: number | null;
}

export interface RankedKeywordsResult {
  target: string | null;
  totalCount: number | null;
  items: RankedKeyword[];
}

export interface RawRankedKeywords {
  target?: string | null;
  total_count?: number | null;
  items?: {
    keyword_data?: { keyword?: string | null; keyword_info?: { search_volume?: number | null } | null } | null;
    ranked_serp_element?: {
      serp_item?: { type?: string | null; rank_group?: number | null; url?: string | null; etv?: number | null } | null;
    } | null;
  }[] | null;
}

export function mapRankedKeywords(raw: RawRankedKeywords | undefined): RankedKeywordsResult {
  const items: RankedKeyword[] = [];
  for (const i of raw?.items ?? []) {
    const keyword = str(i.keyword_data?.keyword);
    if (!keyword) continue;
    const serp = i.ranked_serp_element?.serp_item;
    // Ad slots and other non-organic items must not leak into position.
    if (serp?.type && serp.type !== "organic") continue;
    items.push({
      keyword,
      position: num(serp?.rank_group),
      searchVolume: num(i.keyword_data?.keyword_info?.search_volume),
      url: str(serp?.url),
      estimatedTraffic: round(num(serp?.etv)),
    });
  }
  return { target: str(raw?.target), totalCount: num(raw?.total_count), items };
}

// -------------------------------------------------------------- competitors

export interface Competitor {
  domain: string;
  intersectingKeywords: number | null;
  avgPosition: number | null;
  estimatedTraffic: number | null;
}

export interface CompetitorsResult {
  target: string | null;
  totalCount: number | null;
  items: Competitor[];
}

export interface RawCompetitors {
  target?: string | null;
  total_count?: number | null;
  items?: {
    domain?: string | null;
    avg_position?: number | null;
    intersections?: number | null;
    metrics?: { organic?: { etv?: number | null } | null } | null;
  }[] | null;
}

export function mapCompetitors(raw: RawCompetitors | undefined): CompetitorsResult {
  const items: Competitor[] = [];
  for (const i of raw?.items ?? []) {
    const domain = str(i.domain);
    if (!domain) continue;
    items.push({
      domain,
      intersectingKeywords: num(i.intersections),
      avgPosition: round(num(i.avg_position)),
      // Traffic the competitor gets from the keywords it shares with the target.
      estimatedTraffic: round(num(i.metrics?.organic?.etv)),
    });
  }
  return { target: str(raw?.target), totalCount: num(raw?.total_count), items };
}

// ---------------------------------------------------------------- backlinks

export interface BacklinksSummary {
  target: string | null;
  backlinks: number | null;
  referringDomains: number | null;
  rank: number | null;
  spamScore: number | null;
  /** Not in the summary endpoint; reserved for a later timeseries call. */
  newBacklinks: number | null;
  lostBacklinks: number | null;
}

export interface RawBacklinksSummary {
  target?: string | null;
  rank?: number | null;
  backlinks?: number | null;
  backlinks_spam_score?: number | null;
  referring_domains?: number | null;
  new_backlinks?: number | null;
  lost_backlinks?: number | null;
}

/** Returns null when DataForSEO returned no result at all. */
export function mapBacklinksSummary(raw: RawBacklinksSummary | undefined): BacklinksSummary | null {
  if (!raw) return null;
  return {
    target: str(raw.target),
    backlinks: num(raw.backlinks),
    referringDomains: num(raw.referring_domains),
    rank: num(raw.rank),
    spamScore: num(raw.backlinks_spam_score),
    newBacklinks: num(raw.new_backlinks),
    lostBacklinks: num(raw.lost_backlinks),
  };
}

// ------------------------------------------------------------- instant page

export interface InstantPage {
  url: string | null;
  status: number | null;
  title: string | null;
  description: string | null;
  h1: string | null;
  canonical: string | null;
  wordCount: number | null;
  /** Known problem checks that came back true (e.g. no_title, flash). */
  failedChecks: string[];
}

export interface RawInstantPages {
  items?: {
    url?: string | null;
    status_code?: number | null;
    meta?: {
      title?: string | null;
      description?: string | null;
      canonical?: string | null;
      htags?: { h1?: string[] | null } | null;
      content?: { plain_text_word_count?: number | null } | null;
    } | null;
    checks?: Record<string, boolean | null> | null;
  }[] | null;
}

/**
 * Allow-list of instant_pages checks where `true` means a problem (per the
 * DataForSEO docs). Healthy or informational flags (is_https, canonical,
 * has_html_doctype, seo_friendly_url*, high_content_rate, ...) are excluded, and
 * so are checks DataForSEO adds later: those are missed rather than misreported.
 */
const PROBLEM_CHECKS = new Set([
  "no_content_encoding",
  "high_loading_time",
  "is_redirect",
  "is_4xx_code",
  "is_5xx_code",
  "is_broken",
  "high_waiting_time",
  "has_micromarkup_errors",
  "no_doctype",
  "no_encoding_meta_tag",
  "no_h1_tag",
  "https_to_http_links",
  "size_greater_than_3mb",
  "meta_charset_consistency",
  "has_meta_refresh_redirect",
  "has_render_blocking_resources",
  "low_content_rate",
  "low_character_count",
  "high_character_count",
  "small_page_size",
  "large_page_size",
  "low_readability_rate",
  "irrelevant_description",
  "irrelevant_title",
  "irrelevant_meta_keywords",
  "title_too_long",
  "title_too_short",
  "deprecated_html_tags",
  "duplicate_meta_tags",
  "duplicate_title_tag",
  "no_image_alt",
  "no_image_title",
  "no_description",
  "no_title",
  "no_favicon",
  "flash",
  "frame",
  "lorem_ipsum",
  "has_misspelling",
]);

export function mapInstantPage(raw: RawInstantPages | undefined): InstantPage | null {
  const item = raw?.items?.[0];
  if (!item) return null;
  const failedChecks = Object.entries(item.checks ?? {})
    .filter(([name, value]) => value === true && PROBLEM_CHECKS.has(name))
    .map(([name]) => name)
    .sort();
  return {
    url: str(item.url),
    status: num(item.status_code),
    title: text(item.meta?.title),
    description: text(item.meta?.description),
    h1: text(item.meta?.htags?.h1?.[0]),
    canonical: str(item.meta?.canonical),
    wordCount: num(item.meta?.content?.plain_text_word_count),
    failedChecks,
  };
}

// --------------------------------------------------------------------- SERP

export interface SerpOrganicItem {
  /** Organic rank (DataForSEO rank_group): 1 is the first organic result. */
  position: number;
  /** Host as returned, e.g. `www.example.com`. */
  domain: string;
  url: string | null;
  title: string | null;
}

export interface SerpOrganicResult {
  keyword: string | null;
  /** DataForSEO's resolved location code (also set when the request used location_name). */
  locationCode: number | null;
  items: SerpOrganicItem[];
}

export interface RawSerp {
  keyword?: string | null;
  location_code?: number | null;
  items?: {
    type?: string | null;
    rank_group?: number | null;
    domain?: string | null;
    url?: string | null;
    title?: string | null;
  }[] | null;
}

/** Organic results only (local packs, ads and other features are dropped), in rank order. */
export function mapSerpOrganic(raw: RawSerp | undefined): SerpOrganicResult {
  const items: SerpOrganicItem[] = [];
  for (const i of raw?.items ?? []) {
    if (i.type !== "organic") continue;
    const domain = str(i.domain);
    const position = num(i.rank_group);
    if (!domain || position === null) continue;
    items.push({ position, domain, url: str(i.url), title: str(i.title) });
  }
  items.sort((a, b) => a.position - b.position);
  return { keyword: str(raw?.keyword), locationCode: num(raw?.location_code), items };
}
