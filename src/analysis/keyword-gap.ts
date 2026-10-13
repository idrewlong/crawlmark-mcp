/**
 * Shared, pure helpers for keyword ideas and keyword gap (Phase 12 B), used by every provider so
 * the three produce the same shape: de-duplication across seeds and competitors, the minimum
 * volume filter and the sort (volume, highest first; unknown volume last).
 */
import type { DifficultyMetric, KeywordGapRow, KeywordIdea } from "../providers/seo-data.js";

const key = (k: string) => k.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** Ideas from several requests, first occurrence wins, at most `limit`. */
export function mergeIdeas(lists: readonly (readonly KeywordIdea[])[], limit: number): KeywordIdea[] {
  const seen = new Set<string>();
  const out: KeywordIdea[] = [];
  for (const list of lists) {
    for (const idea of list) {
      const k = key(idea.keyword);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(idea);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export interface CompetitorGapRows {
  domain: string;
  rows: { keyword: string; volume: number | null; difficulty: number | null; position: number | null; url: string | null }[];
}

/**
 * One row per keyword across competitors (each competitor that ranks for it listed), keywords in
 * `exclude` (the client already ranks) dropped, then the minimum volume and the sort applied.
 * `perCompetitor.returned` counts what each competitor's request returned, before any filtering.
 */
export function mergeGaps(
  perCompetitor: readonly CompetitorGapRows[],
  o: { metric: DifficultyMetric; clientCheck: "provider" | "gsc"; minVolume: number; exclude?: ReadonlySet<string> },
): { gaps: KeywordGapRow[]; perCompetitor: { domain: string; returned: number }[]; excluded: number } {
  const byKey = new Map<string, KeywordGapRow>();
  let excluded = 0;
  for (const c of perCompetitor) {
    for (const r of c.rows) {
      const k = key(r.keyword);
      if (!k) continue;
      if (o.exclude?.has(k)) {
        excluded++;
        continue;
      }
      const cur = byKey.get(k);
      if (!cur) {
        byKey.set(k, {
          keyword: r.keyword,
          volume: r.volume,
          difficulty: { metric: o.metric, value: r.difficulty },
          competitors: [{ domain: c.domain, position: r.position, url: r.url }],
          clientPosition: null,
          clientCheck: o.clientCheck,
        });
        continue;
      }
      if (r.volume !== null && (cur.volume === null || r.volume > cur.volume)) cur.volume = r.volume;
      if (cur.difficulty.value === null && r.difficulty !== null) cur.difficulty = { metric: o.metric, value: r.difficulty };
      if (!cur.competitors.some((x) => x.domain === c.domain)) cur.competitors.push({ domain: c.domain, position: r.position, url: r.url });
    }
  }
  const gaps = [...byKey.values()]
    .filter((g) => o.minVolume <= 0 || (g.volume ?? 0) >= o.minVolume)
    .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1) || a.keyword.localeCompare(b.keyword));
  return { gaps, perCompetitor: perCompetitor.map((c) => ({ domain: c.domain, returned: c.rows.length })), excluded };
}
