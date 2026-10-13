/**
 * Opportunity tools over Search Console (I/O side). The maths lives in
 * src/analysis/opportunities.ts; this fetches rows and wraps results.
 *
 * Dimensions and API calls per tool:
 * - striking_distance, quick_wins, low_ctr, cannibalization: one call, [query, page] rows.
 *   Query and page totals are aggregated from those rows (positions impression-weighted).
 * - declining_pages: two calls (current, previous window). Page totals come from
 *   [page] rows when branded queries are included (they include anonymized queries,
 *   so they are the true page totals), else from [query, page] rows with branded
 *   queries dropped; the same [query, page] rows give the queries that lost clicks.
 *   That is up to four calls when includeBranded is set.
 * All [query, page] rows leave out anonymized queries, so totals are a bit under the site's.
 */
import type { Client } from "../config.js";
import {
  cannibalization,
  decliningPages,
  lowCtr,
  pagesFromPageRows,
  pagesFromQueryPageRows,
  quickWins,
  strikingDistance,
  type OppContext,
  type OppRow,
} from "../analysis/opportunities.js";
import { lastDays, previousRange, rangeDays, type DateRange } from "../lib/dates.js";
import { gscQuery } from "../providers/gsc.js";

/** Search Console returns at most 25,000 rows per request. */
export const OPP_ROW_LIMIT = 25_000;
export const DEFAULT_DAYS = 28;
export const DEFAULT_LIMIT = 25;

export interface CommonOptions {
  startDate?: string | undefined;
  endDate?: string | undefined;
  includeBranded?: boolean | undefined;
  limit?: number | undefined;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Both dates or neither. Default: the last 28 days ending 3 days ago (Search Console lags 2-3 days). */
export function resolveWindow(opts: Pick<CommonOptions, "startDate" | "endDate">, today = new Date()): DateRange {
  const { startDate, endDate } = opts;
  if (!startDate && !endDate) return lastDays(DEFAULT_DAYS, 3, today);
  if (!startDate || !endDate) throw new Error("Give both startDate and endDate (YYYY-MM-DD), or neither for the last 28 complete days.");
  if (!DAY.test(startDate) || !DAY.test(endDate) || Number.isNaN(Date.parse(startDate)) || Number.isNaN(Date.parse(endDate))) {
    throw new Error("startDate and endDate must be real dates in YYYY-MM-DD form.");
  }
  if (startDate > endDate) throw new Error("startDate must not be after endDate.");
  return { startDate, endDate };
}

export const fetchQueryPage = (client: Client, range: DateRange): Promise<OppRow[]> =>
  gscQuery(client, { ...range, dimensions: ["query", "page"], rowLimit: OPP_ROW_LIMIT });

const brandNote = (includeBranded: boolean) => (includeBranded ? "Branded queries are included." : "Branded queries are excluded (pass includeBranded to keep them).");

function wrap<T>(client: Client, window: DateRange, includeBranded: boolean, method: string, all: T[], limit: number, rowsAnalysed: number) {
  return {
    client: client.domain,
    window: { ...window, days: rangeDays(window) },
    includeBranded,
    method: `${method} ${brandNote(includeBranded)} Positions are impression-weighted averages. Estimates use an editable industry-average CTR curve, so treat them as a ranking signal, not a forecast.`,
    ...(rowsAnalysed >= OPP_ROW_LIMIT ? { warning: `Search Console returned its ${OPP_ROW_LIMIT}-row limit, so the long tail is missing.` } : {}),
    total: all.length,
    returned: Math.min(all.length, limit),
    results: all.slice(0, limit),
  };
}

export interface Thresholds {
  minPosition?: number | undefined;
  maxPosition?: number | undefined;
  minImpressions?: number | undefined;
}

const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const ctxOf = (client: Client, o: CommonOptions): OppContext => ({ client, includeBranded: o.includeBranded ?? false });

export async function runStrikingDistance(client: Client, o: CommonOptions & Thresholds) {
  const window = resolveWindow(o);
  const rows = await fetchQueryPage(client, window);
  const t = { minPosition: o.minPosition ?? 5, maxPosition: o.maxPosition ?? 20, minImpressions: o.minImpressions ?? 100 };
  return wrap(
    client, window, o.includeBranded ?? false,
    `Queries averaging position ${t.minPosition}-${t.maxPosition} with at least ${t.minImpressions} impressions. Estimated extra clicks = impressions x (expected CTR at position 3 - current CTR), floored at 0. Sorted by that, then impressions.`,
    strikingDistance(rows, ctxOf(client, o), t), o.limit ?? DEFAULT_LIMIT, rows.length,
  );
}

export async function runQuickWins(client: Client, o: CommonOptions & Thresholds) {
  const window = resolveWindow(o);
  const rows = await fetchQueryPage(client, window);
  const t = { minPosition: o.minPosition ?? 11, maxPosition: o.maxPosition ?? 20, minImpressions: o.minImpressions ?? 100 };
  return wrap(
    client, window, o.includeBranded ?? false,
    `Pages averaging position ${t.minPosition}-${t.maxPosition} (just off page one) with at least ${t.minImpressions} impressions, totalled over their queries. Sorted by impressions.`,
    quickWins(rows, ctxOf(client, o), t), o.limit ?? DEFAULT_LIMIT, rows.length,
  );
}

export async function runLowCtr(client: Client, o: CommonOptions & Thresholds & { ctrRatio?: number | undefined }) {
  const window = resolveWindow(o);
  const rows = await fetchQueryPage(client, window);
  const t = { minPosition: o.minPosition ?? 1, maxPosition: o.maxPosition ?? 5, ctrRatio: o.ctrRatio ?? 0.6, minImpressions: o.minImpressions ?? 100 };
  return wrap(
    client, window, o.includeBranded ?? false,
    `Queries averaging position ${t.minPosition}-${t.maxPosition} with at least ${t.minImpressions} impressions whose CTR is below ${Math.round(t.ctrRatio * 100)}% of the expected CTR for that position: title and meta description rewrite candidates. Estimated extra clicks = impressions x (expected CTR - CTR). Sorted by that, then impressions.`,
    lowCtr(rows, ctxOf(client, o), t), o.limit ?? DEFAULT_LIMIT, rows.length,
  );
}

export async function runCannibalization(client: Client, o: CommonOptions & { minImpressions?: number | undefined; minShare?: number | undefined }) {
  const window = resolveWindow(o);
  const rows = await fetchQueryPage(client, window);
  const t = { minImpressions: o.minImpressions ?? 100, minShare: o.minShare ?? 0.1 };
  return wrap(
    client, window, o.includeBranded ?? false,
    `Queries with at least ${t.minImpressions} total impressions where 2 or more pages each hold at least ${Math.round(t.minShare * 100)}% of the query's impressions. Page URLs are normalised (fragment and trailing slash ignored) so variants of one URL do not count as competing. Sorted by total impressions.`,
    cannibalization(rows, ctxOf(client, o), t), o.limit ?? DEFAULT_LIMIT, rows.length,
  );
}

export async function runDecliningPages(client: Client, o: CommonOptions & { minDropPct?: number | undefined; minClickLoss?: number | undefined }) {
  const window = resolveWindow(o);
  const prevWindow = previousRange(window);
  const includeBranded = o.includeBranded ?? false;
  const ctx = ctxOf(client, o);
  const [curQP, prevQP] = await Promise.all([fetchQueryPage(client, window), fetchQueryPage(client, prevWindow)]);
  let cur;
  let prev;
  if (includeBranded) {
    const [c, p] = await Promise.all([
      gscQuery(client, { ...window, dimensions: ["page"], rowLimit: OPP_ROW_LIMIT }),
      gscQuery(client, { ...prevWindow, dimensions: ["page"], rowLimit: OPP_ROW_LIMIT }),
    ]);
    cur = pagesFromPageRows(c);
    prev = pagesFromPageRows(p);
  } else {
    cur = pagesFromQueryPageRows(curQP, ctx);
    prev = pagesFromQueryPageRows(prevQP, ctx);
  }
  const t = { minDropPct: o.minDropPct ?? 30, minClickLoss: o.minClickLoss ?? 10 };
  const out = wrap(
    client, window, includeBranded,
    `Pages whose clicks dropped by at least ${t.minDropPct}% and at least ${t.minClickLoss} clicks versus the previous period of equal length (${prevWindow.startDate} to ${prevWindow.endDate}). A page with no clicks now counts as 0. topLostQueries are the queries that lost the most clicks on each flagged page. Sorted by clicks lost.`,
    decliningPages(cur, prev, curQP, prevQP, ctx, t), o.limit ?? DEFAULT_LIMIT, Math.max(curQP.length, prevQP.length),
  );
  return { ...out, previousWindow: { ...prevWindow, days: rangeDays(prevWindow) } };
}

/** monthly_report's `opportunities` section: top `n` of striking_distance, low_ctr and cannibalization for one month, from a single call. */
export async function opportunitiesForMonth(client: Client, range: DateRange, n = 5) {
  const rows = await fetchQueryPage(client, range);
  const ctx: OppContext = { client, includeBranded: false };
  const sd = strikingDistance(rows, ctx);
  const lc = lowCtr(rows, ctx);
  const cn = cannibalization(rows, ctx);
  return {
    window: range,
    ...(rows.length >= OPP_ROW_LIMIT ? { warning: `Search Console returned its ${OPP_ROW_LIMIT}-row limit, so the long tail is missing.` } : {}),
    method:
      "Non-branded queries only, default thresholds (at least 100 impressions in the month). striking_distance: position 5-20, upside vs position 3 CTR. " +
      "low_ctr: position 1-5 with CTR under 60% of expected. cannibalization: 2+ pages each with at least 10% of a query's impressions. " +
      "Run the individual tools for other windows, lower thresholds or more rows.",
    strikingDistance: { total: sd.length, top: sd.slice(0, n) },
    lowCtr: { total: lc.length, top: lc.slice(0, n) },
    cannibalization: { total: cn.length, top: cn.slice(0, n) },
  };
}
