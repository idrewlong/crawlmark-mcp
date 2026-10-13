/**
 * Pure competitor-suggestion logic (no I/O): pick seed keywords, merge the
 * organic-overlap and local-SERP evidence per domain, drop domains that
 * shouldn't be suggested, and rank the rest with a documented score.
 * src/competitors.ts fetches the data and calls these.
 */
import { normalizeCompetitorDomain } from "../lib/clients.js";
import { isOwnDomain } from "../lib/client-lists.js";
import { isDenied, type Denylist } from "../lib/competitor-denylist.js";

// ---------------------------------------------------------------- seeds

export type SeedSource = "niche" | "tracked" | "gsc" | "ranked";

export interface Seed {
  keyword: string;
  from: SeedSource;
}

export const DEFAULT_SEED_CAP = 5;

const squash = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

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

/**
 * Rough branded-query check until Phase 3's isBranded: the query contains the
 * domain stem or the client name, ignoring case, spaces and punctuation.
 * Terms shorter than 4 characters are ignored to avoid false positives.
 */
export function looksBranded(query: string, client: { domain: string; name: string }): boolean {
  const q = squash(query);
  const terms = [squash(domainStem(client.domain)), squash(client.name)].filter((t) => t.length >= 4);
  return terms.some((t) => q.includes(t));
}

export interface SeedInputs {
  niche?: string | undefined;
  tracked?: string[];
  /** Search Console queries, highest impressions first. */
  gsc?: string[];
  /** DataForSEO ranked keywords for the client's domain, highest volume first. */
  ranked?: string[];
}

/**
 * Seeds in priority order: the niche, tracked keywords, then Search Console
 * queries and ranked keywords (both with branded queries removed). Lower-cased,
 * de-duplicated and capped. Niche and tracked keywords are taken as given:
 * the user chose them.
 */
export function pickSeeds(inputs: SeedInputs, client: { domain: string; name: string }, cap = DEFAULT_SEED_CAP): Seed[] {
  const out: Seed[] = [];
  const seen = new Set<string>();
  const push = (raw: string, from: SeedSource) => {
    const keyword = raw.replace(/\s+/g, " ").trim().toLowerCase();
    if (!keyword || seen.has(keyword) || out.length >= cap) return;
    if ((from === "gsc" || from === "ranked") && looksBranded(keyword, client)) return;
    seen.add(keyword);
    out.push({ keyword, from });
  };
  if (inputs.niche) push(inputs.niche, "niche");
  for (const k of inputs.tracked ?? []) push(k, "tracked");
  for (const k of inputs.gsc ?? []) push(k, "gsc");
  for (const k of inputs.ranked ?? []) push(k, "ranked");
  return out;
}

// ---------------------------------------------------------------- merge

export interface OverlapRow {
  domain: string;
  intersectingKeywords: number | null;
  avgPosition: number | null;
  estimatedTraffic: number | null;
}

export interface SerpHit {
  domain: string;
  /** Organic rank, 1 = first organic result. */
  position: number;
  url: string | null;
}

export interface SeedSerp {
  seed: string;
  hits: SerpHit[];
}

export type CandidateSource = "organic-overlap" | "local-serp";

export interface CandidateEvidence {
  /** From DataForSEO competitors_domain: keywords both sites rank for, and this domain's average position on them. */
  intersectingKeywords: number | null;
  avgPosition: number | null;
  estimatedTraffic: number | null;
  /** Number of seed SERPs this domain appeared in (once per seed). */
  serpAppearances: number;
  /** Best organic position across those SERPs. */
  bestSerpPosition: number | null;
  /** Seeds whose SERP included this domain, in seed order, with its best position there. */
  seeds: { keyword: string; position: number }[];
  /** A ranking URL from its best SERP result, if any. */
  sampleUrl: string | null;
}

export interface Candidate {
  domain: string;
  sources: CandidateSource[];
  evidence: CandidateEvidence;
}

export interface ScoredCandidate extends Candidate {
  /** 0-100; see SCORE_METHOD. */
  score: number;
}

/**
 * Merge both sources per normalised domain (`www.` and URL forms collapse).
 * A domain that appears several times in one SERP counts once for that seed,
 * at its best position.
 */
export function mergeCandidates(overlap: OverlapRow[], serps: SeedSerp[]): Candidate[] {
  const byDomain = new Map<string, Candidate>();
  const get = (domain: string) => {
    let c = byDomain.get(domain);
    if (!c) {
      c = {
        domain,
        sources: [],
        evidence: {
          intersectingKeywords: null,
          avgPosition: null,
          estimatedTraffic: null,
          serpAppearances: 0,
          bestSerpPosition: null,
          seeds: [],
          sampleUrl: null,
        },
      };
      byDomain.set(domain, c);
    }
    return c;
  };

  for (const row of overlap) {
    const domain = normalizeCompetitorDomain(row.domain);
    if (!domain) continue;
    const c = get(domain);
    if (c.sources.includes("organic-overlap")) continue; // first row wins
    c.sources.push("organic-overlap");
    c.evidence.intersectingKeywords = row.intersectingKeywords;
    c.evidence.avgPosition = row.avgPosition;
    c.evidence.estimatedTraffic = row.estimatedTraffic;
  }

  for (const { seed, hits } of serps) {
    const best = new Map<string, SerpHit>();
    for (const hit of hits) {
      const domain = normalizeCompetitorDomain(hit.domain);
      if (!domain) continue;
      const prior = best.get(domain);
      if (!prior || hit.position < prior.position) best.set(domain, hit);
    }
    for (const [domain, hit] of best) {
      const c = get(domain);
      const e = c.evidence;
      if (!c.sources.includes("local-serp")) c.sources.push("local-serp");
      if (e.seeds.some((s) => s.keyword === seed)) continue;
      e.seeds.push({ keyword: seed, position: hit.position });
      e.serpAppearances++;
      if (e.bestSerpPosition === null || hit.position < e.bestSerpPosition) {
        e.bestSerpPosition = hit.position;
        e.sampleUrl = hit.url ?? e.sampleUrl;
      } else if (!e.sampleUrl && hit.url) {
        e.sampleUrl = hit.url;
      }
    }
  }
  return [...byDomain.values()];
}

// ---------------------------------------------------------------- filter

export type ExclusionReason = "own-domain" | "already-competitor" | "ignored" | "denylist";

export interface Exclusions {
  ownDomain: string;
  /** Current competitor domains. */
  competitors: string[];
  /** Domains marked ignore: true in clients.yaml. */
  ignored: string[];
  denylist: Denylist;
}

export interface FilterResult {
  kept: Candidate[];
  excluded: { domain: string; reason: ExclusionReason }[];
}

/** Drop the client's own site, current competitors and ignored domains (each with subdomains), and denylisted platforms. */
export function filterCandidates(candidates: Candidate[], x: Exclusions): FilterResult {
  const out: FilterResult = { kept: [], excluded: [] };
  for (const c of candidates) {
    const reason: ExclusionReason | undefined = isOwnDomain(c.domain, x.ownDomain)
      ? "own-domain"
      : x.competitors.some((d) => isOwnDomain(c.domain, d))
        ? "already-competitor"
        : x.ignored.some((d) => isOwnDomain(c.domain, d))
          ? "ignored"
          : isDenied(c.domain, x.denylist)
            ? "denylist"
            : undefined;
    if (reason) out.excluded.push({ domain: c.domain, reason });
    else out.kept.push(c);
  }
  out.excluded.sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------- score

export const SCORE_METHOD =
  "score = 100 × (wOverlap × overlap + wSerp × serp). " +
  "overlap = this domain's intersecting keywords ÷ the most intersecting keywords of any candidate (0 if not in the overlap list). " +
  "serp = sum over seed SERPs it appeared in of (21 − position) ÷ 20 (position 1 = 1.0, 20 = 0.05, below 20 = 0), divided by the number of seeds searched. " +
  "Weights are 0.5 each when both sources contributed (a remaining candidate has intersecting keywords, and at least one seed was searched), " +
  "otherwise 1.0 for the one that did. " +
  "Ties break on SERP appearances, then intersecting keywords, then domain name.";

/** Weight of one SERP appearance: position 1 → 1.0, 20 → 0.05, worse than 20 → 0. */
export function positionWeight(position: number): number {
  return Math.max(0, 21 - position) / 20;
}

export interface ScoreContext {
  /** Seed SERPs that were actually fetched. */
  seedsSearched: number;
}

/** Deterministic score and order; see SCORE_METHOD. */
export function rankCandidates(candidates: Candidate[], ctx: ScoreContext): ScoredCandidate[] {
  const serpRan = ctx.seedsSearched > 0;
  // Overlap counts only if a candidate left after filtering has intersecting keywords:
  // a call that succeeded with no rows (or only filtered-out rows) contributes nothing.
  const maxIntersections = Math.max(0, ...candidates.map((c) => c.evidence.intersectingKeywords ?? 0));
  const overlapRan = maxIntersections > 0;
  const wOverlap = overlapRan ? (serpRan ? 0.5 : 1) : 0;
  const wSerp = serpRan ? (overlapRan ? 0.5 : 1) : 0;

  return candidates
    .map((c) => {
      const overlap = maxIntersections > 0 ? (c.evidence.intersectingKeywords ?? 0) / maxIntersections : 0;
      const serp = serpRan ? c.evidence.seeds.reduce((sum, s) => sum + positionWeight(s.position), 0) / ctx.seedsSearched : 0;
      const score = Math.round(100 * (wOverlap * overlap + wSerp * serp) * 10) / 10;
      return { ...c, score };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.evidence.serpAppearances - a.evidence.serpAppearances ||
        (b.evidence.intersectingKeywords ?? 0) - (a.evidence.intersectingKeywords ?? 0) ||
        (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0),
    );
}
