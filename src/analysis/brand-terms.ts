/**
 * Brand-term inference (pure, no I/O): find the names people search a client
 * by, from its own search queries, so nobody has to type brand terms in.
 *
 * Input is one client's query rows, either from Search Console (clicks,
 * impressions, CTR, position) or from DataForSEO ranked keywords (position and
 * search volume only). Output is scored candidates with their evidence.
 * src/brand-terms.ts fetches the rows and writes accepted terms.
 *
 * Scoping: a candidate is only ever proposed for the client whose rows were
 * passed in, and a candidate that names any *other* client (its domain stem,
 * name or brand terms) is excluded with reason `other-client-brand`.
 */
import { expectedCtr } from "./ctr-curve.js";
import { ARTICLES, COMPANY_SUFFIXES, distinctiveRemainder, LOCATION_WORDS } from "../lib/name-parts.js";
import { brandTokens, domainStem, isBranded, squash, type BrandClient } from "../lib/brand.js";

export { distinctiveRemainder };

export type BrandSource = "gsc" | "dataforseo";
export type Confidence = "high" | "medium" | "low";

export interface BrandQueryRow {
  query: string;
  /** Average (Search Console) or current (DataForSEO) position; null when unknown. */
  position: number | null;
  clicks?: number | null;
  impressions?: number | null;
  /** DataForSEO only: monthly search volume. */
  searchVolume?: number | null;
  /** DataForSEO only: estimated monthly traffic to the site from this keyword. */
  estimatedTraffic?: number | null;
}

export interface InferContext extends BrandClient {
  /** What the client does, e.g. "pizza restaurant"; its words are trade words, never brand terms. */
  niche?: string | undefined;
  /** DataForSEO location name, e.g. "Austin,Texas,United States"; its words are locations. */
  area?: string | undefined;
}

export interface InferOptions {
  source: BrandSource;
  /** Every other client in the registry. A candidate naming one of them is excluded. */
  otherClients?: BrandClient[];
  /** Most candidates to return (default 25). */
  limit?: number;
  /** Most remaining non-branded queries to return (default 20). */
  queryLimit?: number;
}

export interface EvidenceQuery {
  query: string;
  position: number | null;
  clicks?: number;
  impressions?: number;
  /** Percent, like Search Console reports it. */
  ctr?: number;
  searchVolume?: number;
}

export interface BrandCandidate {
  /** The term as it would be saved: lowercase words, single spaces. */
  term: string;
  confidence: Confidence;
  /** 0-100. */
  score: number;
  source: BrandSource;
  signals: {
    nameSimilarity: { fired: boolean; score: number; against: string | null };
    /** Always { fired: false } for DataForSEO rows: there is no CTR to judge. */
    navigational: { fired: boolean; avgPosition: number | null; ctr: number | null; expectedCtr: number | null; ctrRatio: number | null };
    concentration: { fired: boolean; queries: number; share: number };
  };
  /** Up to 10 of the queries containing the term, best first. */
  queries: EvidenceQuery[];
  /**
   * True when the term has a distinctive word matching the distinctive part of the client's name
   * (the name minus trade words, places and company suffixes). Only such terms are ever saved
   * automatically (discovery, apply); everything else is a suggestion for review.
   */
  autoQualified: boolean;
  /** Why a person should review it instead of it being saved automatically; null when it qualifies at high confidence. */
  reviewReason: "needs-review: generic-name-match" | "needs-review: no-distinctive-name" | "needs-review: confidence" | null;
}

export type ExclusionReason = "other-client-brand";

export interface ExcludedTerm {
  term: string;
  reason: ExclusionReason;
  /** The other client's domain. */
  client: string;
  detail: string;
}

export interface InferResult {
  source: BrandSource;
  candidates: BrandCandidate[];
  excluded: ExcludedTerm[];
  /** Top non-branded queries that no candidate covers, for the caller to judge. */
  nonBrandedQueries: EvidenceQuery[];
  /** Words treated as generic (trade words, locations, modifiers) that appeared in the queries; first 30. */
  genericWords: string[];
  stats: { rows: number; alreadyBranded: number; analysed: number };
}

// ---------------------------------------------------------------- thresholds

export const SIM_WEAK = 0.6;
export const SIM_STRONG = 0.75;
export const SIM_VERY_STRONG = 0.85;
/** Cap for a phrase that is only the end of a name. */
const SIM_ONLY_END = 0.7;
/** Search Console impressions a name-similarity-only candidate needs to be medium rather than low. */
const MIN_SIMILARITY_ONLY_IMPRESSIONS = 10;
/** Navigational: impression-weighted position at or better than this... */
const NAV_MAX_POSITION = 2;
/** ...and CTR at least this multiple of the curve's expected CTR at that position... */
const NAV_MIN_CTR_RATIO = 1.5;
/** ...over at least this many clicks. */
const NAV_MIN_CLICKS = 3;
const MIN_TERM_CHARS = 4;
const DEFAULT_LIMIT = 25;
const DEFAULT_QUERY_LIMIT = 20;

export const METHOD =
  "Candidates are 1-3 word phrases from the client's own queries that its current brand matching (isBranded) does not already cover. " +
  "Generic words never start or end a candidate: stop words, intent words (near, best, how...), navigational modifiers (menu, hours, reviews...), " +
  "the niche, the area and US state names, and trade words seen in the queries (words in 'near me'/'best'-style queries, or words whose queries mostly rank worse than position 3), " +
  "unless the phrase strongly resembles the client's name (similarity >= 0.75). A phrase made only of generic words is dropped unless it strongly resembles a name with a distinctive part; " +
  "Name similarity is measured against each name's distinctive part: the name minus trade words, places and company suffixes (co, inc, llc, services, pros...); without a known area, a segment next to a trade word counts as a place. " +
  "An exact-match domain such as austinplumbing.example has no distinctive part, so 'austin plumber' is never a strong match there. " +
  "Niche, area and discovery-search words also match their plurals and word endings (plumber/plumbing). Phrases under 4 letters are skipped. " +
  "Signals: (a) name similarity to the domain stem, client name or GA4 name: the better of whole-string edit-distance similarity and similarity to the start of the name, " +
  "scaled down when the phrase covers under 70% of the name, and capped at 0.7 when the phrase is only the end of the name ('building systems' in 'AB Building Systems'); fires at >= 0.6, strong >= 0.75, very strong >= 0.85. " +
  "(b) navigational (Search Console only): the phrase's queries, excluding 'near me'/'best'-style ones, average position <= 2 and CTR >= 1.5x the expected CTR for that position, over 3+ clicks. " +
  "(c) concentration: 2+ distinct queries carrying >= 5% of the site's clicks (else impressions; DataForSEO: estimated traffic, else volume), or 4+ queries carrying >= 1%, at an average position <= 10. " +
  "Score = 100 x (0.5 similarity + 0.3 navigational + 0.2 concentration) for Search Console, 100 x (0.7 similarity + 0.3 concentration) for DataForSEO. " +
  "Confidence (Search Console): high = strong similarity plus navigational or concentration, at an average position <= 3; medium = strong similarity at position <= 10 over 10+ impressions, weak similarity plus a behaviour signal, or navigational plus concentration with no similarity; low = any one signal. " +
  "Confidence (DataForSEO, no CTR): high only with very strong similarity at position <= 3; medium = strong similarity at position <= 10, or weak similarity plus concentration at position <= 3; low = weak similarity, or concentration at position <= 2. " +
  "A similar name the site ranks poorly for is usually another business, hence the position limits. " +
  "High always needs name similarity to this client. Phrases that match another client's domain, name or brand terms are excluded (other-client-brand), " +
  "including fragments and misspellings: every distinctive word within one edit of a word of the other client's names or terms, or a fuzzy substring of them (ratio >= 0.75), unless the phrase is clearly closer to this client's own name. " +
  "Strict auto-add: a term is saved automatically (discovery, apply) only when one of its words (4+ letters; not the niche, area, a place, a suffix or a filler) fuzzily matches the distinctive part of the name (ratio >= 0.75); " +
  "otherwise it is a suggestion with reviewReason needs-review: generic-name-match (or no-distinctive-name when the name has no distinctive part) and never above medium. " +
  "On equal scores the longer phrase is preferred, and a shorter phrase is dropped when an accepted one already contains it and covers the same queries.";

// ---------------------------------------------------------------- word lists

const FUNCTION_WORDS = new Set([
  "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "from", "by", "with", "is", "are", "was", "do", "does", "can", "i", "you", "your",
  "my", "me", "our", "it", "its", "this", "that", "vs", "versus", "near", "nearby", "around", "s", "not", "no", "get", "find",
]);

/** Words that make a query a discovery search, not a search for one business. */
const INTENT_WORDS = new Set([
  "near", "nearby", "nearest", "closest", "best", "top", "cheap", "cheapest", "affordable", "how", "what", "why", "when", "where", "who", "which",
  "vs", "versus", "rated", "good", "great", "popular", "famous",
]);

/** Words that accompany brand searches but are never part of the brand. */
const NAV_MODIFIERS = new Set([
  "menu", "menus", "hours", "phone", "number", "address", "location", "locations", "directions", "map", "reviews", "review", "login", "sign",
  "coupon", "coupons", "promo", "code", "careers", "jobs", "job", "hiring", "contact", "website", "site", "official", "app", "order", "online",
  "delivery", "takeout", "reservation", "reservations", "book", "booking", "specials", "special", "deals", "deal", "price", "prices", "pricing",
  "cost", "costs", "open", "today", "now", "tonight", "email", "instagram", "facebook", "yelp", "tiktok", "youtube", "linkedin", "owner",
  "owners", "salary", "photos", "pictures", "video", "videos", "gift", "card", "cards", "catering", "happy", "hour", "brunch", "lunch",
  "dinner", "breakfast", "store", "shop", "inc", "llc", "co", "company", "com", "www", "net", "org", "usa", "us",
]);

// ---------------------------------------------------------------- similarity

/** Levenshtein distance. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const ratio = (a: string, b: string) => 1 - editDistance(a, b) / Math.max(a.length, b.length);

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * How much a squashed phrase looks like a squashed name (0-1): the better of
 * whole-string similarity and similarity to the start of the name, the latter
 * scaled down when the phrase covers under 70% of the name (so "pizza" against
 * "pizzaplace" is only weak). "laforna" against "lafornina" gives 0.86.
 */
export function nameSimilarity(phrase: string, name: string): number {
  if (phrase.length < MIN_TERM_CHARS || name.length < MIN_TERM_CHARS) return 0;
  // Only the end of the name ("buildingsystems" in "abbuildingsystems"): it drops the distinctive start, so weak at most.
  if (name.includes(phrase) && !name.startsWith(phrase)) return Math.min(SIM_ONLY_END, Math.round(ratio(phrase, name) * 100) / 100);
  let best = ratio(phrase, name);
  if (phrase.length >= 5 && commonPrefix(phrase, name) >= 3) {
    const coverage = Math.min(1, phrase.length / name.length / 0.7);
    for (let len = Math.max(1, phrase.length - 2); len <= Math.min(name.length, phrase.length + 2); len++) {
      best = Math.max(best, ratio(phrase, name.slice(0, len)) * coverage);
    }
  }
  return Math.round(best * 100) / 100;
}

/** The squashed names a client is known by: domain stem, name and GA4 name, plus brand terms when asked. */
function nameTargets(c: BrandClient, withTerms = false): { squashed: string; label: string }[] {
  const out = new Map<string, string>();
  const add = (s: string, label: string) => {
    if (s.length >= MIN_TERM_CHARS && !out.has(s)) out.set(s, label);
  };
  add(squash(domainStem(c.domain)), domainStem(c.domain));
  for (const n of [c.name, c.ga4Name]) {
    if (!n || n === c.domain) continue;
    add(brandTokens(n).join(""), n);
    add(squash(n), n);
  }
  if (withTerms) for (const t of c.brandTerms ?? []) add(squash(t), t);
  return [...out].map(([squashed, label]) => ({ squashed, label }));
}

function bestSimilarity(phrase: string, targets: { squashed: string; label: string }[]): { score: number; against: string | null; target: string | null } {
  let best = { score: 0, against: null as string | null, target: null as string | null };
  for (const t of targets) {
    const s = nameSimilarity(phrase, t.squashed);
    if (s > best.score) best = { score: s, against: t.label, target: t.squashed };
  }
  return best;
}

/** Best edit-distance ratio of `phrase` against windows of `text` within 2 characters of its length. */
export function fuzzySubstring(phrase: string, text: string): number {
  let best = 0;
  for (let len = Math.max(1, phrase.length - 2); len <= Math.min(text.length, phrase.length + 2); len++) {
    for (let i = 0; i + len <= text.length; i++) best = Math.max(best, ratio(phrase, text.slice(i, i + len)));
  }
  return best;
}

/** Fuzzy match (other-client check, distinctive-name check): ratio >= 0.75 counts. */
const OTHER_FUZZY_RATIO = 0.75;

/**
 * Does this phrase name another client? Exact: that client's brand matching,
 * or the phrase containing or being part of its names or terms, or strong
 * similarity to them. Fuzzy (fragments and misspellings, "bela", "fornos",
 * "belaforno"): every distinctive word is within one edit of a word of its
 * names or terms (4+ letters; shorter words must match exactly) or a fuzzy
 * substring of them, unless the phrase is clearly closer to this client's own name.
 */
function otherClientMatch(term: string, squashed: string, distinctive: string[], ownSim: number, others: BrandClient[]): BrandClient | undefined {
  return others.find((o) => {
    const targets = nameTargets(o, true);
    if (isBranded(term, o) || targets.some((t) => squashed.includes(t.squashed) || t.squashed.includes(squashed) || nameSimilarity(squashed, t.squashed) >= SIM_STRONG)) return true;
    const otherSim = Math.max(0, ...targets.map((t) => Math.max(nameSimilarity(squashed, t.squashed), fuzzySubstring(squashed, t.squashed))));
    if (ownSim >= SIM_STRONG && ownSim > otherSim) return false;
    const words = new Set([...brandTokens(o.name), ...(o.ga4Name ? brandTokens(o.ga4Name) : []), ...(o.brandTerms ?? []).flatMap((b) => brandTokens(b)), squash(domainStem(o.domain))]);
    const near = (w: string) =>
      words.has(w) ||
      (w.length >= 4 && [...words].some((x) => x.length >= 4 && editDistance(w, x) <= 1)) ||
      (w.length >= 4 && targets.some((t) => fuzzySubstring(w, t.squashed) >= OTHER_FUZZY_RATIO));
    return distinctive.length > 0 && distinctive.every(near);
  });
}

// ---------------------------------------------------------------- extraction

interface Row {
  query: string;
  tokens: string[];
  position: number | null;
  clicks: number;
  impressions: number;
  /** Weight for position averages and shares: impressions (GSC) or volume (DataForSEO). */
  weight: number;
  /** Share numerator: clicks (GSC) or estimated traffic (DataForSEO). */
  value: number;
  generic: boolean;
  raw: BrandQueryRow;
}

const num = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

function toRow(r: BrandQueryRow, source: BrandSource): Row {
  const tokens = brandTokens(r.query);
  const clicks = num(r.clicks);
  const impressions = num(r.impressions);
  const weight = source === "gsc" ? impressions : num(r.searchVolume) || 1;
  const value = source === "gsc" ? clicks : num(r.estimatedTraffic);
  return {
    query: r.query.replace(/\s+/g, " ").trim().toLowerCase(),
    tokens,
    position: typeof r.position === "number" && r.position > 0 ? r.position : null,
    clicks,
    impressions,
    weight,
    value,
    generic: tokens.some((t) => INTENT_WORDS.has(t)),
    raw: r,
  };
}

function evidence(r: Row, source: BrandSource): EvidenceQuery {
  const e: EvidenceQuery = { query: r.query, position: r.position };
  if (source === "gsc") {
    e.clicks = r.clicks;
    e.impressions = r.impressions;
    e.ctr = r.impressions ? Number(((r.clicks / r.impressions) * 100).toFixed(2)) : 0;
  } else if (r.raw.searchVolume != null) {
    e.searchVolume = r.raw.searchVolume;
  }
  return e;
}

const byStrength = (a: Row, b: Row) => b.value - a.value || b.weight - a.weight || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0);

const impressionsOf = (rows: Row[]) => rows.reduce((s, r) => s + r.impressions, 0);

function weightedPosition(rows: Row[]): number | null {
  const ranked = rows.filter((r) => r.position !== null);
  const w = ranked.reduce((s, r) => s + (r.weight || 1), 0);
  if (!w) return null;
  return Math.round((ranked.reduce((s, r) => s + r.position! * (r.weight || 1), 0) / w) * 10) / 10;
}

interface GenericWords {
  /** Niche, area and words from discovery searches: trade words and places. Matched loosely (plurals, word endings). */
  hard: Set<string>;
  /** Words whose queries mostly rank worse than position 3. Matched exactly. */
  soft: Set<string>;
}

/** Word endings stripped before comparing trade words, longest first. */
const ENDINGS = ["ings", "ists", "ers", "ing", "ies", "ist", "er", "es", "ed", "y", "s"];

const wordStem = (w: string): string => {
  for (const e of ENDINGS) if (w.endsWith(e) && w.length - e.length >= 4) return w.slice(0, -e.length);
  return w;
};

/** Same word ignoring common endings: "plumber"/"plumbing", "roofers"/"roofing", "bakery"/"bakers". */
export function sameStem(a: string, b: string): boolean {
  return a === b || (a.length >= 4 && b.length >= 4 && wordStem(a) === wordStem(b));
}

/** Words seen in the queries that are generic for this client. */
function genericWordSet(rows: Row[], ctx: InferContext, targets: { squashed: string; label: string }[]): GenericWords {
  const hard = new Set<string>();
  for (const t of brandTokens(ctx.niche ?? "")) hard.add(t);
  for (const t of brandTokens((ctx.area ?? "").replace(/,/g, " "))) hard.add(t);
  // Words in discovery searches ("pizza near me", "best pizza") are trade words or places, unless the
  // search names the client itself ("bella forno near me"), whose words are the brand.
  const namesClient = (r: Row) => ngrams(r.tokens).some((g) => bestSimilarity(g.join(""), targets).score >= SIM_STRONG && !g.every((t) => isFiller(t) || ARTICLES.has(t)));
  for (const r of rows) if (r.generic && !namesClient(r)) for (const t of r.tokens) hard.add(t);
  const out = new Set<string>();
  // Words whose queries mostly rank worse than position 3: the site competes for them, it isn't their answer.
  const tally = new Map<string, { worse: number; total: number }>();
  for (const r of rows) {
    if (r.position === null) continue;
    for (const t of new Set(r.tokens)) {
      const x = tally.get(t) ?? { worse: 0, total: 0 };
      x.total += r.weight || 1;
      if (r.position > 3) x.worse += r.weight || 1;
      tally.set(t, x);
    }
  }
  for (const [t, x] of tally) if (x.total > 0 && x.worse / x.total >= 0.5) out.add(t);
  return { hard, soft: out };
}

/** Classify a name segment for distinctiveRemainder: a trade word (niche or discovery-search word), a place, or neither. */
function segmentKind(g: GenericWords, ctx: InferContext): (piece: string) => "trade" | "place" | null {
  const area = new Set(brandTokens((ctx.area ?? "").replace(/,/g, " ")));
  const hard = [...g.hard].filter((h) => h.length >= 3 && !FUNCTION_WORDS.has(h) && !INTENT_WORDS.has(h) && !NAV_MODIFIERS.has(h));
  const memo = new Map<string, "trade" | "place" | null>();
  return (piece) => {
    if (memo.has(piece)) return memo.get(piece)!;
    let kind: "trade" | "place" | null = null;
    if (area.has(piece) || LOCATION_WORDS.has(piece)) kind = "place";
    else if (hard.some((h) => h === piece || sameStem(piece, h))) kind = "trade";
    memo.set(piece, kind);
    return kind;
  };
}

/** Words that can never make a term distinctive: the niche, the area, places, company suffixes and fillers. */
function declaredGenericTest(ctx: InferContext): (t: string) => boolean {
  const niche = brandTokens(ctx.niche ?? "");
  const area = new Set(brandTokens((ctx.area ?? "").replace(/,/g, " ")));
  return (t) => isFiller(t) || ARTICLES.has(t) || COMPANY_SUFFIXES.has(t) || LOCATION_WORDS.has(t) || area.has(t) || niche.some((w) => sameStem(t, w));
}

/** Generic-word test; `hardOnly` ignores the rank-based tier (a client's own name can rank poorly when others share it). */
function genericTest(g: GenericWords, hardOnly = false): (t: string) => boolean {
  const memo = new Map<string, boolean>();
  const hard = [...g.hard];
  return (t) => {
    let v = memo.get(t);
    if (v === undefined) {
      v = g.hard.has(t) || (!hardOnly && g.soft.has(t)) || LOCATION_WORDS.has(t) || hard.some((h) => sameStem(t, h));
      memo.set(t, v);
    }
    return v;
  };
}

const isFiller = (t: string) => FUNCTION_WORDS.has(t) || INTENT_WORDS.has(t) || NAV_MODIFIERS.has(t) || LOCATION_WORDS.has(t) || /^\d+$/.test(t);

function ngrams(tokens: string[]): string[][] {
  const out: string[][] = [];
  for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n));
  return out;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** Does the phrase (squashed) appear in the query, the way isBranded matches a brand term of 4+ characters? */
const covers = (squashedTerm: string, r: Row) => squash(r.query).includes(squashedTerm);

/**
 * Infer brand-term candidates from one client's query rows. Rows the client's
 * current brand matching already covers are left out; the rest are split into
 * 1-3 word phrases and scored on name similarity, navigational behaviour
 * (Search Console only) and concentration. See METHOD.
 */
export function inferBrandTerms(input: BrandQueryRow[], ctx: InferContext, opts: InferOptions): InferResult {
  const { source } = opts;
  const all = input.filter((r) => typeof r.query === "string" && r.query.trim()).map((r) => toRow(r, source));
  const rows = all.filter((r) => !isBranded(r.query, ctx) && r.tokens.length > 0);
  const totalValue = all.reduce((s, r) => s + r.value, 0);
  const totalWeight = all.reduce((s, r) => s + r.weight, 0);
  const share = (rs: Row[]) =>
    totalValue > 0 ? rs.reduce((s, r) => s + r.value, 0) / totalValue : totalWeight > 0 ? rs.reduce((s, r) => s + r.weight, 0) / totalWeight : 0;

  const targets = nameTargets(ctx);
  const genericWords = genericWordSet(rows, ctx, targets);
  const isGeneric = genericTest(genericWords);
  // Similarity is measured against each name's distinctive part, so a generic phrase can't match the
  // generic part of an exact-match domain ("austin plumber" against "austinplumbing").
  const kindOf = segmentKind(genericWords, ctx);
  const remainders = [...new Set(targets.map((t) => distinctiveRemainder(t.squashed, kindOf, Boolean(ctx.area?.trim()))).filter(Boolean))];
  const scoreTargets = remainders.map((r) => ({ squashed: r, label: targets.find((t) => t.squashed === r)?.label ?? r }));
  const declaredGeneric = declaredGenericTest(ctx);
  const others = opts.otherClients ?? [];

  // Phrase -> the rows containing it.
  const phrases = new Map<string, { tokens: string[]; rows: Set<Row> }>();
  for (const r of rows) {
    for (const g of ngrams(r.tokens)) {
      const key = g.join(" ");
      const p = phrases.get(key) ?? { tokens: g, rows: new Set<Row>() };
      p.rows.add(r);
      phrases.set(key, p);
    }
  }

  const scored: (BrandCandidate & { squashed: string; rowSet: Set<Row> })[] = [];
  const excluded = new Map<string, ExcludedTerm>();
  for (const [term, { tokens, rows: rowSet }] of phrases) {
    const squashed = tokens.join("");
    if (squashed.length < MIN_TERM_CHARS) continue;
    const first = tokens[0]!;
    const last = tokens[tokens.length - 1]!;
    // Fillers never start or end a phrase (a leading article may start a 2-3 word one).
    if (isFiller(last) || (isFiller(first) && !(tokens.length > 1 && ARTICLES.has(first))) || (tokens.length === 1 && ARTICLES.has(first))) continue;
    if (tokens.every((t) => isFiller(t) || ARTICLES.has(t))) continue;

    // A phrase made only of generic words is a brand only when it strongly resembles the distinctive part
    // of a name ("la forna" for lafornina). An exact-match domain (austinplumbing.example) has none.
    const distinctive = tokens.filter((t) => !ARTICLES.has(t) && !isFiller(t) && !isGeneric(t));
    const sim = bestSimilarity(squashed, scoreTargets);
    if (distinctive.length === 0 && sim.score < SIM_STRONG) continue;
    // With a distinctive word, a strong name match may still start or end with a generic one.
    const edgeGeneric = (isGeneric(first) && !ARTICLES.has(first)) || isGeneric(last);
    if (edgeGeneric && sim.score < SIM_STRONG) continue;

    const qs = [...rowSet].sort(byStrength);
    const navRows = qs.filter((r) => !r.generic);
    const avgPosition = weightedPosition(qs);

    let nav: BrandCandidate["signals"]["navigational"] = { fired: false, avgPosition: null, ctr: null, expectedCtr: null, ctrRatio: null };
    let navStrength = 0;
    if (source === "gsc" && navRows.length) {
      const clicks = navRows.reduce((s, r) => s + r.clicks, 0);
      const impressions = navRows.reduce((s, r) => s + r.impressions, 0);
      const pos = weightedPosition(navRows);
      if (impressions > 0 && pos !== null) {
        const ctr = clicks / impressions;
        const expected = expectedCtr(pos);
        const r = ctr / expected;
        const fired = pos <= NAV_MAX_POSITION && r >= NAV_MIN_CTR_RATIO && clicks >= NAV_MIN_CLICKS;
        nav = { fired, avgPosition: pos, ctr: Number((ctr * 100).toFixed(2)), expectedCtr: Number((expected * 100).toFixed(2)), ctrRatio: Number(r.toFixed(2)) };
        navStrength = fired ? Math.min(1, r / 3) : 0;
      }
    }

    const n = qs.length;
    const s = share(qs);
    const concFired = ((n >= 2 && s >= 0.05) || (n >= 4 && s >= 0.01)) && avgPosition !== null && avgPosition <= 10;
    const conc = concFired ? Math.min(1, n / 5) * 0.4 + Math.min(1, s / 0.25) * 0.6 : 0;

    const simEff = sim.score >= SIM_WEAK ? sim.score : 0;
    const score = Math.round(100 * (source === "gsc" ? 0.5 * simEff + 0.3 * navStrength + 0.2 * conc : 0.7 * simEff + 0.3 * conc));

    let confidence: Confidence | undefined;
    const strong = sim.score >= SIM_STRONG;
    const weak = sim.score >= SIM_WEAK;
    // A similar name the site ranks poorly for is usually another business with a similar name.
    const top3 = avgPosition !== null && avgPosition <= 3;
    const page1 = avgPosition !== null && avgPosition <= 10;
    if (source === "gsc") {
      if (strong && (nav.fired || concFired) && top3) confidence = "high";
      else if ((strong && page1 && impressionsOf(qs) >= MIN_SIMILARITY_ONLY_IMPRESSIONS) || (weak && (nav.fired || concFired)) || (nav.fired && concFired)) confidence = "medium";
      else if (weak || nav.fired || (concFired && avgPosition !== null && avgPosition <= 3)) confidence = "low";
    } else {
      if (sim.score >= SIM_VERY_STRONG && top3) confidence = "high";
      else if ((strong && page1) || (weak && concFired && top3)) confidence = "medium";
      else if (weak || (concFired && avgPosition !== null && avgPosition <= 2)) confidence = "low";
    }
    if (!confidence) continue;

    // Strict auto-add: a word of the term (not the niche, area, a place, a suffix or a filler) must match
    // the distinctive part of the client's name. Anything else is for review, and never above medium.
    const autoQualified = tokens.some((t) => t.length >= 4 && !declaredGeneric(t) && remainders.some((r) => fuzzySubstring(t, r) >= OTHER_FUZZY_RATIO));
    let reviewReason: BrandCandidate["reviewReason"] = null;
    if (!autoQualified) {
      reviewReason = remainders.length === 0 ? "needs-review: no-distinctive-name" : "needs-review: generic-name-match";
      if (confidence === "high") confidence = "medium";
    } else if (confidence !== "high") {
      reviewReason = "needs-review: confidence";
    }

    const other = otherClientMatch(term, squashed, distinctive, sim.score, others);
    if (other) {
      if (!excluded.has(term)) {
        excluded.set(term, {
          term,
          reason: "other-client-brand",
          client: other.domain,
          detail: `"${term}" names another client (${other.domain}), so it is never a brand term for ${ctx.domain}.`,
        });
      }
      continue;
    }

    scored.push({
      term,
      confidence,
      score,
      source,
      signals: { nameSimilarity: { fired: weak, score: sim.score, against: sim.against }, navigational: nav, concentration: { fired: concFired, queries: n, share: Number(s.toFixed(3)) } },
      queries: qs.slice(0, 10).map((r) => evidence(r, source)),
      autoQualified,
      reviewReason,
      squashed,
      rowSet,
    });
  }

  scored.sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] || b.score - a.score || b.term.length - a.term.length || (a.term < b.term ? -1 : 1));

  // Drop phrases an accepted candidate already covers (it contains them... or they add no queries).
  const accepted: typeof scored = [];
  for (const c of scored) {
    const redundant = accepted.some(
      (a) => c.squashed.includes(a.squashed) || (a.squashed.includes(c.squashed) && [...c.rowSet].every((r) => a.rowSet.has(r))),
    );
    if (!redundant) accepted.push(c);
  }

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const candidates = accepted.slice(0, limit);
  const nonBrandedQueries = rows
    .filter((r) => !candidates.some((c) => covers(c.squashed, r)))
    .sort(byStrength)
    .slice(0, opts.queryLimit ?? DEFAULT_QUERY_LIMIT)
    .map((r) => evidence(r, source));

  return {
    source,
    candidates: candidates.map(({ squashed: _s, rowSet: _r, ...c }) => c),
    excluded: [...excluded.values()],
    nonBrandedQueries,
    genericWords: [...new Set([...genericWords.hard, ...genericWords.soft])].filter((t) => t.length > 1 && !/^\d+$/.test(t)).sort().slice(0, 30),
    stats: { rows: all.length, alreadyBranded: all.length - rows.length, analysed: rows.length },
  };
}

/** Merge per-source results: one candidate per term (ignoring spacing), keeping the stronger. */
export function mergeCandidates(lists: BrandCandidate[][]): BrandCandidate[] {
  const best = new Map<string, BrandCandidate>();
  for (const c of lists.flat()) {
    const key = squash(c.term);
    const prior = best.get(key);
    if (!prior || CONFIDENCE_RANK[c.confidence] > CONFIDENCE_RANK[prior.confidence] || (c.confidence === prior.confidence && c.score > prior.score)) best.set(key, c);
  }
  return [...best.values()].sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] || b.score - a.score);
}

/** Candidates that may be saved automatically: at or above a confidence level and matching the name's distinctive part. */
export function autoAddable(candidates: BrandCandidate[], min: "high" | "medium"): BrandCandidate[] {
  return atLeast(candidates, min).filter((c) => c.autoQualified);
}

/** Candidates at or above a confidence level. */
export function atLeast(candidates: BrandCandidate[], min: "high" | "medium"): BrandCandidate[] {
  return candidates.filter((c) => CONFIDENCE_RANK[c.confidence] >= CONFIDENCE_RANK[min]);
}
