/**
 * Branded vs non-branded totals from Search Console query rows (pure, no I/O).
 */
import { isBranded, type BrandClient } from "../lib/brand.js";
import { pctChange } from "../lib/dates.js";

/** A Search Console row; for query-dimension rows `keys[0]` is the query. */
export interface QueryRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SplitTotals {
  queries: number;
  clicks: number;
  impressions: number;
  /** Percent, 2 decimals (clicks / impressions), the same unit as the other CTR values in the report. */
  ctr: number;
  /** Average position weighted by impressions, 1 decimal. Null when there are no impressions. */
  position: number | null;
}

export interface BrandSplit {
  branded: SplitTotals;
  nonBranded: SplitTotals;
}

function totals(rows: QueryRow[]): SplitTotals {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    weighted += r.position * r.impressions;
  }
  return {
    queries: rows.length,
    clicks,
    impressions,
    ctr: impressions ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
    position: impressions ? Number((weighted / impressions).toFixed(1)) : null,
  };
}

/** Split query-dimension rows into branded and non-branded totals. */
export function splitBranded(rows: QueryRow[], client: BrandClient): BrandSplit {
  const branded: QueryRow[] = [];
  const nonBranded: QueryRow[] = [];
  for (const r of rows) (isBranded(r.keys[0] ?? "", client) ? branded : nonBranded).push(r);
  return { branded: totals(branded), nonBranded: totals(nonBranded) };
}

export interface SplitComparison {
  current: SplitTotals;
  previous: SplitTotals;
  change: {
    clicks: number | null;
    impressions: number | null;
    /** Percentage-point difference. Null when either month has no impressions. */
    ctr: number | null;
    /** Lower is better, so a negative delta is an improvement. Null when either month has no impressions. */
    position: number | null;
  };
}

export function compareSplit(current: SplitTotals, previous: SplitTotals): SplitComparison {
  return {
    current,
    previous,
    change: {
      clicks: pctChange(current.clicks, previous.clicks),
      impressions: pctChange(current.impressions, previous.impressions),
      ctr: current.impressions && previous.impressions ? Number((current.ctr - previous.ctr).toFixed(2)) : null,
      position: current.position !== null && previous.position !== null ? Number((current.position - previous.position).toFixed(1)) : null,
    },
  };
}

export const QUERY_TOTALS_NOTE =
  "Branded and non-branded totals are built from Search Console query rows, which leave out anonymized queries (rare queries Google withholds), " +
  "so branded + non-branded will not add up to the site totals in vsPreviousMonth. Use them for the split, not as site totals.";

/** Add `branded` to each query row. */
export function markBranded<T extends { keys: string[] }>(rows: T[], client: BrandClient): (T & { branded: boolean })[] {
  return rows.map((r) => ({ ...r, branded: isBranded(r.keys[0] ?? "", client) }));
}
