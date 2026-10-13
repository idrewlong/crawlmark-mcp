/**
 * suggest_competitors: gathers candidate competitors from DataForSEO's
 * organic overlap and from live SERPs for a few seed keywords in the client's
 * area, then filters and ranks them with the pure functions in
 * src/analysis/competitor-suggestions.ts. Read-only: it never writes
 * clients.yaml; the caller confirms with the user and calls add_competitors.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_SEED_CAP,
  filterCandidates,
  mergeCandidates,
  brandToken,
  pickSeeds,
  rankCandidates,
  SCORE_METHOD,
  type ExclusionReason,
  type OverlapRow,
  type ScoredCandidate,
  type Seed,
  type SeedSerp,
} from "./analysis/competitor-suggestions.js";
import { loadOverrides, resolveClient } from "./clients.js";
import { env } from "./config.js";
import { normalizeArea, type Client } from "./lib/clients.js";
import { BUILTIN_DENYLIST, buildDenylist, parseRules, type Denylist } from "./lib/competitor-denylist.js";
import { mapLimit } from "./lib/concurrency.js";
import { lastDays } from "./lib/dates.js";
import { competitorDomains, rankedKeywords, serpOrganic } from "./providers/dataforseo.js";
import { googleConfigured } from "./providers/google.js";
import { gscQuery } from "./providers/gsc.js";

/** How many organic-overlap rows to fetch, and how deep each seed SERP goes. */
const OVERLAP_LIMIT = 50;
const SERP_DEPTH = 20;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Built-in rules plus COMPETITOR_DENYLIST_FILE (if it exists) and COMPETITOR_DENYLIST. */
export function loadDenylist(): { denylist: Denylist; notes: string[] } {
  const rules = [...BUILTIN_DENYLIST];
  const path = env.COMPETITOR_DENYLIST_FILE;
  if (existsSync(path)) rules.push(...parseRules(readFileSync(path, "utf8")));
  if (env.COMPETITOR_DENYLIST) rules.push(...parseRules(env.COMPETITOR_DENYLIST));
  const { denylist, invalid } = buildDenylist(rules);
  const notes = invalid.length ? [`Ignored unusable denylist rules: ${invalid.join(", ")}`] : [];
  return { denylist, notes };
}

export interface SuggestOptions {
  /** Overrides the client's area for this call (not saved). */
  area?: string | undefined;
  /** Overrides the client's niche for this call (not saved). */
  niche?: string | undefined;
  /** Non-branded service keywords from the caller (up to 5); searched first. */
  seeds?: string[] | undefined;
  limit?: number | undefined;
}

export interface Spend {
  costUsd: number;
  /** fromCache flag of every paid call made. */
  flags: boolean[];
}

const track = <T extends { costUsd: number; fromCache: boolean }>(spend: Spend, r: T): T => {
  spend.costUsd += r.costUsd;
  spend.flags.push(r.fromCache);
  return r;
};

/** Seeds: explicit seeds, niche, tracked keywords, then free GSC queries; paid ranked keywords only if there are none. */
export async function gatherSeeds(client: Client, niche: string | undefined, spend: Spend, notes: string[], explicit: string[] = []): Promise<Seed[]> {
  const inputs = { seeds: explicit, niche, tracked: client.trackedKeywords, gsc: [] as string[], ranked: [] as string[] };
  let seeds = pickSeeds(inputs, client);
  if (seeds.length < DEFAULT_SEED_CAP && googleConfigured() && client.gscProperty) {
    try {
      const rows = await gscQuery(client, { ...lastDays(28), dimensions: ["query"], rowLimit: 100 });
      inputs.gsc = [...rows].sort((a, b) => b.impressions - a.impressions).map((r) => r.keys[0] ?? "");
      seeds = pickSeeds(inputs, client);
    } catch (err) {
      notes.push(`Search Console queries unavailable for seeds: ${errText(err)}`);
    }
  }
  if (seeds.length === 0) {
    try {
      const ranked = track(spend, await rankedKeywords(client, client.domain, 20));
      inputs.ranked = ranked.items.map((k) => k.keyword);
      seeds = pickSeeds(inputs, client);
    } catch (err) {
      notes.push(`Ranked keywords unavailable for seeds: ${errText(err)}`);
    }
  }
  return seeds;
}

export async function suggestCompetitors(idOrDomain: string, opts: SuggestOptions = {}) {
  const client = await resolveClient(idOrDomain);
  let area = client.area;
  if (opts.area !== undefined && opts.area.trim() !== "") {
    area = normalizeArea(opts.area);
    if (!area) throw new Error(`"${opts.area}" is not a location name. Use DataForSEO's form, e.g. "Austin,Texas,United States".`);
  }
  const niche = opts.niche?.trim() || client.niche;
  const limit = opts.limit ?? 10;
  const spend: Spend = { costUsd: 0, flags: [] };
  const notes: string[] = [];

  // (a) Organic overlap.
  let overlap: OverlapRow[] = [];
  let overlapStatus: { ok: true; rows: number } | { ok: false; error: string };
  try {
    const r = track(spend, await competitorDomains(client, OVERLAP_LIMIT));
    overlap = r.items;
    overlapStatus = { ok: true, rows: r.items.length };
  } catch (err) {
    overlapStatus = { ok: false, error: errText(err) };
  }

  // (b) Local SERP presence.
  const seeds = await gatherSeeds(client, niche, spend, notes, opts.seeds);
  const failedSeeds: { keyword: string; error: string }[] = [];
  const serps = (
    await mapLimit(seeds, 2, async (seed): Promise<SeedSerp | undefined> => {
      try {
        const r = track(spend, await serpOrganic(client, seed.keyword, { depth: SERP_DEPTH, locationName: area }));
        return { seed: seed.keyword, hits: r.items };
      } catch (err) {
        failedSeeds.push({ keyword: seed.keyword, error: errText(err) });
        return undefined;
      }
    })
  ).filter((s): s is SeedSerp => s !== undefined);

  if (!overlapStatus.ok && serps.length === 0) {
    const why = [
      `organic overlap: ${overlapStatus.error}`,
      seeds.length ? `SERPs: ${failedSeeds.map((f) => f.error).join("; ")}` : "no seed keywords (set a niche or tracked keywords)",
      ...notes,
    ];
    throw new Error(`No competitor data for ${client.domain}. ${why.join(". ")}`);
  }
  if (seeds.length === 0) notes.push("No seed keywords, so no SERPs were searched. Set a niche (set_client_profile) or add tracked keywords.");

  // Merge, filter, rank.
  const { denylist, notes: denyNotes } = loadDenylist();
  notes.push(...denyNotes);
  const { kept, excluded } = filterCandidates(mergeCandidates(overlap, serps), {
    ownDomain: client.domain,
    competitors: client.competitors,
    ignored: loadOverrides().filter((o) => o.ignore).map((o) => o.domain),
    denylist,
    brandToken: brandToken(client),
  });
  const ranked: ScoredCandidate[] = rankCandidates(kept, { seedsSearched: serps.length, localArea: Boolean(area) });
  const excludedCounts = excluded.reduce<Partial<Record<ExclusionReason, number>>>((acc, e) => {
    acc[e.reason] = (acc[e.reason] ?? 0) + 1;
    return acc;
  }, {});

  return {
    client: client.domain,
    area: area ?? null,
    market: area ? { locationName: area, languageCode: client.languageCode } : { locationCode: client.locationCode, languageCode: client.languageCode },
    niche: niche ?? null,
    seeds,
    candidates: ranked.slice(0, limit),
    totalCandidates: ranked.length,
    excluded: { counts: excludedCounts, domains: excluded.slice(0, 30) },
    sources: {
      organicOverlap: overlapStatus,
      localSerp: { searched: serps.length, failed: failedSeeds },
    },
    method: SCORE_METHOD,
    notes,
    costUsd: Number(spend.costUsd.toFixed(4)),
    fromCache: spend.flags.length > 0 && spend.flags.every(Boolean),
    next:
      "Nothing was saved. Show these candidates and their evidence to the user, ask which to add, and only then call " +
      'add_competitors with the chosen domains and source: "suggested".',
  };
}
