/**
 * Rank history rules (Phase 12 B, pure, no I/O): series summaries for rank_history and
 * reports, the change between two checks, and which live SERP changes alert. Positions
 * are ranks, so lower is better and a negative change is an improvement.
 */

export interface RankPoint {
  day: string;
  rank: number | null;
}

export interface RankSummary {
  /** Latest and first ranks with data (null ranks, "not found" or "no impressions", are skipped). */
  latest: number | null;
  first: number | null;
  latestDay: string | null;
  firstDay: string | null;
  /** Lowest (best) and highest (worst) rank in the range. */
  best: number | null;
  worst: number | null;
  /** latest - first; negative is better. Null with fewer than two ranks. */
  change: number | null;
  /** latest - the newest rank at least 30 (90) days older than the latest; null when there is none. */
  change30d: number | null;
  change90d: number | null;
  /** Points stored in the range, and how many had no rank. */
  checks: number;
  noRank: number;
}

const DAY_MS = 86_400_000;
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Rank change from `previous` to `current` (negative is better); null when either is missing. */
export function rankChange(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  return round1(current - previous);
}

/** Summary of one keyword's series for one source. `points` may be in any order and may have gaps. */
export function summarizeRanks(points: readonly RankPoint[]): RankSummary {
  const sorted = [...points].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const ranked = sorted.filter((p): p is { day: string; rank: number } => p.rank !== null && Number.isFinite(p.rank));
  const last = ranked.at(-1);
  const firstP = ranked[0];
  const back = (days: number): number | null => {
    if (!last) return null;
    const cutoff = dayMs(last.day) - days * DAY_MS;
    const older = ranked.filter((p) => dayMs(p.day) <= cutoff).at(-1);
    return older ? round1(last.rank - older.rank) : null;
  };
  return {
    latest: last?.rank ?? null,
    first: firstP?.rank ?? null,
    latestDay: last?.day ?? null,
    firstDay: firstP?.day ?? null,
    best: ranked.length ? Math.min(...ranked.map((p) => p.rank)) : null,
    worst: ranked.length ? Math.max(...ranked.map((p) => p.rank)) : null,
    change: ranked.length >= 2 ? round1(last!.rank - firstP!.rank) : null,
    change30d: back(30),
    change90d: back(90),
    checks: sorted.length,
    noRank: sorted.length - ranked.length,
  };
}

/** The top-10 boundary used by the rank-drop alert (page one of Google). */
export const TOP_RANKS = 10;

export interface RankDrop {
  keyword: string;
  previousRank: number | null;
  currentRank: number | null;
}

/**
 * Whether a live SERP change alerts (B-D2): the keyword was in the top 10 and is now outside it, or it
 * worsened by at least `threshold` places. "Not found" (a null rank) counts as worse than any rank, so a
 * keyword that was found and no longer is always alerts. Needs an earlier live check with a rank
 * (`previous` null or undefined never alerts); improvements never alert. Pure.
 */
export function rankDropAlert(keyword: string, previous: number | null | undefined, current: number | null, threshold: number): RankDrop | null {
  if (previous === null || previous === undefined) return null;
  const now = current ?? Number.POSITIVE_INFINITY;
  const leftTop = previous <= TOP_RANKS && now > TOP_RANKS;
  const fell = now - previous >= threshold;
  return leftTop || fell ? { keyword, previousRank: previous, currentRank: current } : null;
}
