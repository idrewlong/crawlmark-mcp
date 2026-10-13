/**
 * Branded-query classification (pure, no I/O). One implementation shared by the
 * monthly report, tracked-keyword output and competitor-suggestion seeding.
 *
 * `isBranded` checks the client's explicit `brandTerms` AND the default
 * heuristics (domain stem, the client name, the GA4 name, spaced initials,
 * generic company suffixes, the standalone short brand token). Explicit brand
 * terms add to the heuristics; they never replace them.
 */

/** Lowercase, accents stripped (NFKD, then marks removed), everything but a-z0-9 dropped. */
export const squash = (s: string): string =>
  s.toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^a-z0-9]/g, "");

/**
 * The distinctive part of a domain: the last label before the public suffix,
 * where any trailing labels of 3 characters or fewer count as suffix
 * (`shop.example.co.uk` gives `example`).
 */
export function domainStem(domain: string): string {
  const labels = domain.split(".");
  labels.pop();
  while (labels.length > 1 && labels[labels.length - 1]!.length <= 3) labels.pop();
  return labels[labels.length - 1] ?? domain;
}

const GENERIC_SUFFIXES = new Set(["inc", "llc", "co", "company", "corp", "corporation", "ltd", "limited", "group", "solutions"]);

/** Lowercase, punctuation to spaces, spaced-out initials collapsed ("a b building" gives ["ab", "building"]), generic company suffixes dropped. */
export function brandTokens(text: string): string[] {
  const raw = text.toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const merged: string[] = [];
  let run = "";
  for (const t of raw) {
    if (t.length === 1) {
      run += t;
      continue;
    }
    if (run) merged.push(run);
    run = "";
    merged.push(t);
  }
  if (run) merged.push(run);
  const kept = merged.filter((t) => !GENERIC_SUFFIXES.has(t));
  return kept.length ? kept : merged;
}

const BRAND_STOPLIST = new Set([
  "the", "a", "an", "and", "best", "top", "pro", "pros", "home", "homes", "my", "our", "your", "new", "all", "first", "one",
  "general", "american", "national", "local", "premier", "quality", "express", "united", "city", "great", "good", "better",
]);

/**
 * The client's distinctive brand token: the first name token (after generic
 * suffixes and leading stop words), when it is a 2-letter initialism or the
 * domain stem starts with it. Null when there is none or it is a common word.
 */
export function brandToken(client: { domain: string; name: string }): string | null {
  const stem = squash(domainStem(client.domain));
  const tokens = brandTokens(client.name);
  const first = tokens.find((t) => !BRAND_STOPLIST.has(t));
  if (!first || first.length < 2 || BRAND_STOPLIST.has(first)) return null;
  // A 2-letter initialism is distinctive on its own; longer tokens must also start the domain stem, so a common word like "sun" isn't taken for a brand.
  if (first.length === 2 || stem.startsWith(first)) return first;
  return null;
}

/** Longest brand term accepted. */
export const MAX_BRAND_TERM_LENGTH = 100;

/** A brand term with single spaces, as typed otherwise (case kept for display; matching ignores it). Undefined when it has no letters or digits, or is too long. */
export function normalizeBrandTerm(input: string): string | undefined {
  const t = input.normalize("NFC").replace(/\s+/g, " ").trim();
  return squash(t) && t.length <= MAX_BRAND_TERM_LENGTH ? t : undefined;
}

/** Normalised, de-duplicated (ignoring case, spacing and punctuation) brand terms. */
export function toBrandTerms(items: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items ?? []) {
    const t = normalizeBrandTerm(item);
    if (!t || seen.has(squash(t))) continue;
    seen.add(squash(t));
    out.push(t);
  }
  return out;
}

/** What isBranded needs from a client. */
export interface BrandClient {
  domain: string;
  name: string;
  /** The GA4 property's display name, when it differs from `name`. */
  ga4Name?: string | undefined;
  /** Explicit brand terms; they add to the default heuristics. */
  brandTerms?: string[] | undefined;
}

/** A term of 4+ characters matches anywhere in the de-spaced query; a shorter one (an initialism) only as a whole token, so "ab" doesn't match "about". */
function matchesTerm(term: string, squashedQuery: string, queryTokens: string[]): boolean {
  const t = squash(term);
  if (!t) return false;
  if (t.length >= 4) return squashedQuery.includes(t);
  return queryTokens.includes(t);
}

/**
 * Is this search query about the client's brand?
 *
 * Case, spacing, punctuation and accents are ignored ("example-plumbing",
 * "Example Plumbing" and "exampleplumbing" are the same). A query is branded when:
 * - it contains one of `brandTerms` (4+ characters anywhere; shorter as a whole word); or
 * - its de-spaced form (4+ characters) is a prefix of the domain stem or the
 *   de-spaced client or GA4 name (so a truncated brand like "exampl" matches, but a
 *   trade word inside the name, like "plumbing", does not), or contains the stem or a name; or
 * - it contains the client's short brand token (e.g. "ab" in "ab construction"); or
 * - its first tokens match the client name's leading tokens (two, or the whole
 *   query when shorter), which catches initialisms like "a b building".
 * Spaced initials ("a b building") and generic suffixes (inc, llc, co ...) are normalised first.
 */
export function isBranded(query: string, client: BrandClient): boolean {
  const q = brandTokens(query);
  if (q.length === 0) return false;
  const squashed = squash(query);
  for (const term of client.brandTerms ?? []) if (matchesTerm(term, squashed, q)) return true;

  const despaced = q.join("");
  const stem = squash(domainStem(client.domain));
  const names = [client.name, ...(client.ga4Name && client.ga4Name !== client.name ? [client.ga4Name] : [])];
  const nameTokens = brandTokens(client.name);
  if (despaced.length >= 4 && (stem.startsWith(despaced) || names.some((n) => brandTokens(n).join("").startsWith(despaced)))) return true;
  if ([stem, ...names.map(squash)].some((t) => t.length >= 4 && squashed.includes(t))) return true;
  const brand = brandToken(client);
  if (brand && q.includes(brand)) return true;
  if (nameTokens.length === 0) return false;
  const k = Math.min(2, nameTokens.length, q.length);
  return q.slice(0, k).every((t, i) => t === nameTokens[i]) && q.slice(0, k).join("").length >= 2;
}
