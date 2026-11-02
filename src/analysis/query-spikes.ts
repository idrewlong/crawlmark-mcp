/**
 * Release A / D4: flag days whose Search Console impressions jump while clicks stay flat and a handful of
 * zero-click queries explain the jump (rank trackers and bots show up this way). Pure: the caller supplies the
 * daily series and, for the few candidate days, the query rows. Nothing is excluded automatically; the report
 * suggests exclusions and the user adds them.
 */
import type { GscRow } from "../providers/gsc.js";
import { stripControl } from "../lib/terminal-text.js";

export interface DailyPoint {
  date: string;
  clicks: number;
  impressions: number;
}

export interface SpikeDay {
  date: string;
  impressions: number;
  clicks: number;
  baselineImpressions: number;
  baselineClicks: number;
  excess: number;
}

export interface QuerySpike extends SpikeDay {
  queries: { query: string; impressions: number }[];
  /** Those queries' impressions as a share of the excess (2 dp). */
  share: number;
}

const MS_DAY = 86_400_000;
const BASELINE_DAYS = 28;
const MIN_BASELINE_DAYS = 14;
const MAX_CHECKED_DAYS = 3;
const MAX_QUERIES = 5;

const day = (s: string) => Date.parse(`${s}T00:00:00Z`);

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** The days in `period` that are candidates, largest excess first (every candidate; the caller checks at most 3). */
export function spikeDays(series: DailyPoint[], period: { startDate: string; endDate: string }): SpikeDay[] {
  const byDate = new Map(series.map((p) => [p.date, p]));
  const out: SpikeDay[] = [];
  for (const p of series) {
    if (p.date < period.startDate || p.date > period.endDate) continue;
    const t = day(p.date);
    const base: DailyPoint[] = [];
    for (let i = 1; i <= BASELINE_DAYS; i++) {
      const b = byDate.get(new Date(t - i * MS_DAY).toISOString().slice(0, 10));
      if (b) base.push(b);
    }
    if (base.length < MIN_BASELINE_DAYS) continue;
    const baselineImpressions = median(base.map((b) => b.impressions));
    const baselineClicks = median(base.map((b) => b.clicks));
    const excess = p.impressions - baselineImpressions;
    if (p.impressions >= 3 * Math.max(baselineImpressions, 1) && excess >= 200 && p.clicks <= 1.5 * baselineClicks + 5) {
      out.push({ date: p.date, impressions: p.impressions, clicks: p.clicks, baselineImpressions, baselineClicks, excess });
    }
  }
  return out.sort((a, b) => b.excess - a.excess || a.date.localeCompare(b.date));
}

/** A candidate day is flagged when at most 5 zero-click queries hold at least half of its excess impressions. */
export function concentrate(d: SpikeDay, queryRows: GscRow[]): QuerySpike | null {
  if (d.excess <= 0) return null;
  const zero = queryRows.filter((r) => r.clicks === 0).sort((a, b) => b.impressions - a.impressions);
  let sum = 0;
  for (let i = 0; i < Math.min(MAX_QUERIES, zero.length); i++) {
    sum += zero[i]!.impressions;
    if (sum >= 0.5 * d.excess) {
      return {
        ...d,
        queries: zero.slice(0, i + 1).map((r) => ({ query: r.keys[0] ?? "", impressions: r.impressions })),
        share: Number((sum / d.excess).toFixed(2)),
      };
    }
  }
  return null;
}

/**
 * The flagged days of a period. At most 3 candidate days (largest excess first) get a query breakdown through
 * `queriesForDay`; a failed breakdown leaves that day unflagged rather than failing the report.
 */
export async function findQuerySpikes(
  series: DailyPoint[],
  period: { startDate: string; endDate: string },
  queriesForDay: (date: string) => Promise<GscRow[]>,
): Promise<QuerySpike[]> {
  const found: QuerySpike[] = [];
  for (const d of spikeDays(series, period).slice(0, MAX_CHECKED_DAYS)) {
    try {
      const spike = concentrate(d, await queriesForDay(d.date));
      if (spike) found.push(spike);
    } catch {
      /* the breakdown is extra: skip this day */
    }
  }
  return found.sort((a, b) => a.date.localeCompare(b.date));
}

/** Days before a period's start the daily series must reach for the baseline. */
export const SPIKE_LOOKBACK_DAYS = BASELINE_DAYS;

/** `YYYY-MM-DD` shifted by whole days. */
export function shiftDay(date: string, days: number): string {
  return new Date(day(date) + days * MS_DAY).toISOString().slice(0, 10);
}

/** The report note for one flagged day (queries are text from Search Console: control characters stripped, 80 characters each). */
export function spikeNote(s: QuerySpike): string {
  const qs = s.queries.map((q) => stripControl(q.query).slice(0, 80));
  const n = qs.length;
  return (
    `Possible automated queries on ${s.date}: ${n} zero-click quer${n === 1 ? "y" : "ies"} (${qs.join(", ")}) added ${Math.round(s.excess)} impressions ` +
    `(baseline ${Math.round(s.baselineImpressions)}/day). If they aren't real searches, exclude them with set_client_profile gscExcludeQueries.`
  );
}
