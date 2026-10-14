/**
 * Pure mappers from raw DataForSEO v3 results to compact, typed objects.
 * No I/O here so they can be tested against recorded payloads.
 * Every field is read defensively: DataForSEO omits or nulls fields freely.
 */
import { stripControl } from "../lib/terminal-text.js";

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

// ------------------------------------------------------------ account status

export interface DataForSeoStatus {
  /** From the base URL: `sandbox` hosts return canned data and cost nothing, anything else is live and billed. */
  mode: "sandbox" | "live";
  /** Hostname of the API the server is pointed at (never includes credentials). */
  apiHost: string;
  /** The account's remaining balance in USD. In sandbox mode this is the account balance, not spend. */
  balanceUsd: number | null;
  /** The account's lifetime deposits in USD, when reported. */
  totalUsd: number | null;
  /** The account's own timezone, when reported. */
  timezone: string | null;
}

export interface RawUserData {
  timezone?: string | null;
  money?: { balance?: number | null; total?: number | null } | null;
}

/** `sandbox` when the API host is a sandbox host, else `live`. */
export function dataForSeoMode(baseUrl: string): "sandbox" | "live" {
  try {
    return new URL(baseUrl).hostname.split(".").includes("sandbox") ? "sandbox" : "live";
  } catch {
    return "live";
  }
}

/** Map the `/appendix/user_data` result. Only mode, balance and timezone are kept; the login, rates and limits are dropped. */
export function mapUserData(raw: RawUserData | undefined, baseUrl: string): DataForSeoStatus {
  let apiHost = "";
  try {
    apiHost = new URL(baseUrl).hostname;
  } catch {
    /* leave empty */
  }
  return {
    mode: dataForSeoMode(baseUrl),
    apiHost,
    balanceUsd: num(raw?.money?.balance),
    totalUsd: num(raw?.money?.total),
    timezone: str(raw?.timezone),
  };
}

/** Did DataForSEO reject the login (HTTP 401/403 or a 4010x task code)? Anything else (network, 5xx, 429, timeout) says nothing about the credentials. */
export function isAuthRejection(message: string): boolean {
  return /HTTP 40[13]\b|\b4010\d\b/.test(message);
}

// ------------------------------------------------- Labs: keyword ideas and keyword gap (Phase 12 B)

/** Difficulty is DataForSEO's own 0-100 Labs score (B-D4: labelled, never mixed with Ahrefs' or Semrush's). */
export interface LabsIdea {
  keyword: string;
  volume: number | null;
  cpc: number | null;
  competition: number | null;
  difficulty: { metric: "dataforseo_kd"; value: number | null };
  intent: string | null;
  seed: string | null;
}

export interface RawLabsKeywordItem {
  keyword?: string | null;
  keyword_info?: { search_volume?: number | null; cpc?: number | null; competition?: number | null } | null;
  keyword_properties?: { keyword_difficulty?: number | null } | null;
  search_intent_info?: { main_intent?: string | null } | null;
}

export interface RawLabsKeywords {
  total_count?: number | null;
  items?: RawLabsKeywordItem[] | null;
}

/** keyword_ideas / keyword_suggestions items -> ideas (same item shape). Keywords are whitespace-collapsed; rows with none are dropped. */
export function mapLabsKeywordIdeas(raw: RawLabsKeywords | undefined, seed: string | null): LabsIdea[] {
  const out: LabsIdea[] = [];
  for (const i of raw?.items ?? []) {
    const keyword = text(i.keyword);
    if (!keyword) continue;
    out.push({
      keyword,
      volume: num(i.keyword_info?.search_volume),
      cpc: round(num(i.keyword_info?.cpc)),
      competition: round(num(i.keyword_info?.competition)),
      difficulty: { metric: "dataforseo_kd", value: num(i.keyword_properties?.keyword_difficulty) },
      intent: text(i.search_intent_info?.main_intent),
      seed,
    });
  }
  return out;
}

export interface LabsGapRow {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  position: number | null;
  url: string | null;
}

export interface RawDomainIntersection {
  total_count?: number | null;
  items?: {
    keyword_data?: { keyword?: string | null; keyword_info?: { search_volume?: number | null } | null; keyword_properties?: { keyword_difficulty?: number | null } | null } | null;
    first_domain_serp_element?: { type?: string | null; rank_group?: number | null; rank_absolute?: number | null; url?: string | null } | null;
  }[] | null;
}

/**
 * domain_intersection with `intersections: false` -> keywords target1 (the competitor) ranks for and target2
 * (the client) doesn't. Position is the competitor's organic position (rank_group, else rank_absolute).
 */
export function mapDomainIntersection(raw: RawDomainIntersection | undefined): LabsGapRow[] {
  const out: LabsGapRow[] = [];
  for (const i of raw?.items ?? []) {
    const keyword = text(i.keyword_data?.keyword);
    if (!keyword) continue;
    const el = i.first_domain_serp_element;
    if (el?.type && el.type !== "organic") continue;
    out.push({
      keyword,
      volume: num(i.keyword_data?.keyword_info?.search_volume),
      difficulty: num(i.keyword_data?.keyword_properties?.keyword_difficulty),
      position: num(el?.rank_group) ?? num(el?.rank_absolute),
      url: str(el?.url),
    });
  }
  return out;
}

// ------------------------------------------------ local SEO: Business Data and Maps (Phase 12 C4)

/** Untrusted text from Google listings and reviews: control and format characters removed, whitespace collapsed, capped. */
export const cleanText = (v: unknown, max = 300): string | null => {
  if (typeof v !== "string") return null;
  const s = stripControl(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
const ratingValue = (r: { value?: number | null; rating_max?: number | null } | null | undefined): number | null => {
  const v = num(r?.value);
  if (v === null) return null;
  // Max5 is the norm; a rating on another scale is converted to 5 so values compare.
  const max = num(r?.rating_max);
  return max && max !== 5 ? round((v / max) * 5, 2) : v;
};
/** Bare host, lowercase, without www. */
const hostOf = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

export type RatingDistribution = { "1": number; "2": number; "3": number; "4": number; "5": number };

function distribution(raw: Record<string, unknown> | null | undefined): RatingDistribution | null {
  if (!raw || typeof raw !== "object") return null;
  const out = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } as RatingDistribution;
  let any = false;
  for (const k of ["1", "2", "3", "4", "5"] as const) {
    const n = num(raw[k]);
    if (n !== null) {
      out[k] = n;
      any = true;
    }
  }
  return any ? out : null;
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const hhmm = (t: { hour?: number | null; minute?: number | null } | null | undefined) => {
  const h = num(t?.hour);
  const m = num(t?.minute);
  return h === null ? null : `${String(h).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}`;
};

export interface BusinessHours {
  day: (typeof WEEKDAYS)[number];
  /** "09:00-17:00" ranges, comma-separated; "closed" when the day has none. */
  hours: string;
}

/** A Google Business Profile as DataForSEO's my_business_info returns it, reduced to business facts (no reviewer or visitor data). */
export interface LocalBusiness {
  title: string | null;
  address: string | null;
  phone: string | null;
  url: string | null;
  /** Bare host of the listing's website (no www.). */
  domain: string | null;
  category: string | null;
  additionalCategories: string[];
  rating: number | null;
  votes: number | null;
  ratingDistribution: RatingDistribution | null;
  isClaimed: boolean | null;
  placeId: string | null;
  cid: string | null;
  totalPhotos: number | null;
  workHours: BusinessHours[] | null;
  /** opened, closed, temporarily_closed or closed_forever, as Google reported it when fetched. */
  currentStatus: string | null;
}

type RawTime = { hour?: number | null; minute?: number | null } | null;
export interface RawBusinessItem {
  type?: string | null;
  title?: string | null;
  address?: string | null;
  phone?: string | null;
  url?: string | null;
  domain?: string | null;
  category?: string | null;
  additional_categories?: (string | null)[] | null;
  rating?: { value?: number | null; votes_count?: number | null; rating_max?: number | null } | null;
  rating_distribution?: Record<string, unknown> | null;
  is_claimed?: boolean | null;
  place_id?: string | null;
  cid?: string | number | null;
  total_photos?: number | null;
  work_time?: { work_hours?: { timetable?: Record<string, { open?: RawTime; close?: RawTime }[] | null> | null; current_status?: string | null } | null } | null;
}
export interface RawBusinessInfo {
  items?: RawBusinessItem[] | null;
}

const idText = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) ? String(v) : cleanText(v, 200));

function workHours(raw: RawBusinessItem["work_time"]): BusinessHours[] | null {
  const tt = raw?.work_hours?.timetable;
  if (!tt || typeof tt !== "object") return null;
  return WEEKDAYS.map((day) => {
    const ranges = (tt[day] ?? [])
      .map((r) => {
        const o = hhmm(r?.open);
        const c = hhmm(r?.close);
        return o && c ? `${o}-${c}` : null;
      })
      .filter((r): r is string => r !== null);
    return { day, hours: ranges.length ? ranges.join(", ") : "closed" };
  });
}

export function mapBusiness(i: RawBusinessItem): LocalBusiness {
  return {
    title: cleanText(i.title),
    address: cleanText(i.address),
    phone: cleanText(i.phone, 50),
    url: cleanText(i.url, 2000),
    domain: hostOf(i.domain) ?? hostOf(i.url),
    category: cleanText(i.category, 120),
    additionalCategories: (i.additional_categories ?? []).map((c) => cleanText(c, 120)).filter((c): c is string => c !== null).slice(0, 20),
    rating: ratingValue(i.rating),
    votes: num(i.rating?.votes_count),
    ratingDistribution: distribution(i.rating_distribution),
    isClaimed: typeof i.is_claimed === "boolean" ? i.is_claimed : null,
    placeId: idText(i.place_id),
    cid: idText(i.cid),
    totalPhotos: num(i.total_photos),
    workHours: workHours(i.work_time),
    currentStatus: cleanText(i.work_time?.work_hours?.current_status, 40),
  };
}

/** my_business_info items (google_business_info), in DataForSEO's order. Directory listings and "people also search" are dropped. */
export function mapBusinessInfo(raw: RawBusinessInfo | undefined): LocalBusiness[] {
  return (raw?.items ?? []).filter((i) => !i.type || i.type === "google_business_info").map(mapBusiness);
}

export interface MapsResult {
  rank: number;
  title: string | null;
  domain: string | null;
  rating: number | null;
  votes: number | null;
  placeId: string | null;
  cid: string | null;
}
export interface RawMapsSerp {
  keyword?: string | null;
  items?: { type?: string | null; rank_group?: number | null; rank_absolute?: number | null; title?: string | null; domain?: string | null; url?: string | null; rating?: { value?: number | null; votes_count?: number | null; rating_max?: number | null } | null; place_id?: string | null; cid?: string | number | null }[] | null;
}

/** Google Maps results (maps_search) in rank order. */
export function mapMapsSerp(raw: RawMapsSerp | undefined): MapsResult[] {
  const out: MapsResult[] = [];
  for (const i of raw?.items ?? []) {
    if (i.type && i.type !== "maps_search") continue;
    const rank = num(i.rank_group) ?? num(i.rank_absolute);
    if (rank === null) continue;
    out.push({ rank, title: cleanText(i.title), domain: hostOf(i.domain) ?? hostOf(i.url), rating: ratingValue(i.rating), votes: num(i.rating?.votes_count), placeId: idText(i.place_id), cid: idText(i.cid) });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** One review, without the reviewer: no name, profile, photo, review id or URL, and the owner's reply only as yes/no. */
export interface LocalReview {
  rating: number | null;
  /** YYYY-MM-DD (UTC), from the review's timestamp. */
  date: string | null;
  /** The review's text: third-party content (stripControl'd, whitespace collapsed, at most 500 characters); null when it has none. */
  reviewText: string | null;
  ownerReplied: boolean;
}
export interface LocalReviews {
  /** The listing's overall rating and vote count as reported with the reviews. */
  rating: number | null;
  votes: number | null;
  /** Star counts among the reviews fetched (not the whole listing; see local_profile for that). */
  distribution: RatingDistribution;
  reviews: LocalReview[];
}
export interface RawReviews {
  rating?: { value?: number | null; votes_count?: number | null; rating_max?: number | null } | null;
  reviews_count?: number | null;
  items?: { type?: string | null; rating?: { value?: number | null; rating_max?: number | null } | null; timestamp?: string | null; review_text?: string | null; owner_answer?: string | null }[] | null;
}

/** "2019-11-15 12:57:46 +00:00" (DataForSEO's UTC timestamp) -> "2019-11-15". */
export function reviewDate(v: unknown): string | null {
  const s = str(v);
  const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isNaN(t) || !new Date(t).toISOString().startsWith(d) ? null : d;
}

export function mapReviews(raw: RawReviews | undefined): LocalReviews {
  const dist = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } as RatingDistribution;
  const reviews: LocalReview[] = [];
  for (const i of raw?.items ?? []) {
    if (i.type && i.type !== "google_reviews_search") continue;
    const rating = ratingValue(i.rating);
    if (rating !== null) {
      const k = String(Math.min(5, Math.max(1, Math.round(rating)))) as keyof RatingDistribution;
      dist[k] += 1;
    }
    reviews.push({ rating, date: reviewDate(i.timestamp), reviewText: cleanText(i.review_text, 500), ownerReplied: Boolean(cleanText(i.owner_answer, 10)) });
  }
  return { rating: ratingValue(raw?.rating), votes: num(raw?.rating?.votes_count) ?? num(raw?.reviews_count), distribution: dist, reviews };
}

// ------------------------------------------------ AI Optimization: LLM Mentions (Phase 12 C5)

/** One AI answer that cites the client: the question, where, its AI search volume, the cited URL and an excerpt. */
export interface LlmMention {
  /** The question asked (stripControl'd, at most 300 characters). */
  question: string | null;
  /** google (AI Overviews) or chat_gpt. */
  platform: string | null;
  aiSearchVolume: number | null;
  /** The first source on the client's domain, and its position among the answer's sources. */
  citedUrl: string | null;
  position: number | null;
  /** The start of the answer (markdown as returned, stripControl'd, whitespace collapsed, at most 500 characters). */
  answerExcerpt: string | null;
}
export interface RawLlmMentions {
  total_count?: number | null;
  items?: {
    platform?: string | null;
    question?: string | null;
    answer?: string | null;
    ai_search_volume?: number | null;
    sources?: { domain?: string | null; url?: string | null; position?: number | null }[] | null;
  }[] | null;
}

/** search_mentions items, keeping only the answer's own text and the client's citation (no other sources, brands or fan-out queries). */
export function mapLlmMentions(raw: RawLlmMentions | undefined, clientDomain: string): { items: LlmMention[]; total: number | null } {
  const own = clientDomain.toLowerCase().replace(/^www\./, "");
  const onDomain = (d: unknown) => {
    const h = hostOf(d);
    return h !== null && (h === own || h.endsWith(`.${own}`));
  };
  const items = (raw?.items ?? []).map((i): LlmMention => {
    const src = (i.sources ?? []).find((s) => onDomain(s.domain) || onDomain(s.url));
    return {
      question: cleanText(i.question, 300),
      platform: cleanText(i.platform, 40),
      aiSearchVolume: num(i.ai_search_volume),
      citedUrl: src ? cleanText(src.url, 2000) : null,
      position: src ? num(src.position) : null,
      answerExcerpt: cleanText(i.answer, 500),
    };
  });
  return { items, total: num(raw?.total_count) };
}

export interface LlmMetricRow {
  /** The group's key: a platform, location code, language or cited domain (stripControl'd). */
  key: string;
  mentions: number | null;
  aiSearchVolume: number | null;
}
/** target_metrics' aggregated_metrics (documented shape, research D17); only the groups below are kept. */
export interface LlmTargetMetrics {
  total: { mentions: number | null; aiSearchVolume: number | null };
  platform: LlmMetricRow[];
  location: LlmMetricRow[];
  language: LlmMetricRow[];
  /** Domains the answers cite as sources alongside the client (at most 10). */
  sourcesDomain: LlmMetricRow[];
}
type RawMetricRow = { key?: string | number | null; mentions?: number | null; ai_search_volume?: number | null };
export interface RawLlmTargetMetrics {
  aggregated_metrics?: {
    total?: { mentions?: number | null; ai_search_volume?: number | null } | null;
    platform?: RawMetricRow[] | null;
    location?: RawMetricRow[] | null;
    language?: RawMetricRow[] | null;
    sources_domain?: RawMetricRow[] | null;
  } | null;
}

const metricRows = (rows: RawMetricRow[] | null | undefined, max = 10): LlmMetricRow[] =>
  (rows ?? [])
    .map((r) => ({ key: typeof r.key === "number" && Number.isFinite(r.key) ? String(r.key) : (cleanText(r.key, 200) ?? ""), mentions: num(r.mentions), aiSearchVolume: num(r.ai_search_volume) }))
    .filter((r) => r.key !== "")
    .slice(0, max);

export function mapLlmTargetMetrics(raw: RawLlmTargetMetrics | undefined): LlmTargetMetrics {
  const a = raw?.aggregated_metrics;
  return {
    total: { mentions: num(a?.total?.mentions), aiSearchVolume: num(a?.total?.ai_search_volume) },
    platform: metricRows(a?.platform),
    location: metricRows(a?.location),
    language: metricRows(a?.language),
    sourcesDomain: metricRows(a?.sources_domain),
  };
}
