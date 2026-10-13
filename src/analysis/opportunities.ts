/**
 * Search Console opportunity analysis (pure, no I/O).
 *
 * Input is rows with dimensions ["query", "page"] (keys[0] = query, keys[1] = page),
 * except where a function says otherwise. Rows are aggregated per query or per
 * page with impressions-weighted positions. Page URLs are normalised first
 * (fragment dropped, trailing slash dropped, host lowercased) so variants of one
 * URL merge. Branded queries are dropped unless `includeBranded` is set.
 *
 * CTR values in outputs are percentages with 2 decimals, like the rest of the
 * report; positions have 1 decimal. Thresholds are inclusive unless noted.
 */
import { isBranded, type BrandClient } from "../lib/brand.js";
import { expectedCtr } from "./ctr-curve.js";

export interface OppRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface OppContext {
  client: BrandClient;
  /** Keep branded queries. Default false. */
  includeBranded?: boolean | undefined;
}

const round = (n: number, d: number) => Number(n.toFixed(d));
const pct = (fraction: number) => round(fraction * 100, 2);

/** Drop the fragment and trailing slash(es), lowercase the host. The root keeps its "/". */
export function normalizePageUrl(url: string): string {
  const trimmed = url.trim().split("#")[0]!;
  try {
    const u = new URL(trimmed);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

interface Acc {
  clicks: number;
  impressions: number;
  weighted: number;
}
const newAcc = (): Acc => ({ clicks: 0, impressions: 0, weighted: 0 });
function add(a: Acc, r: OppRow) {
  a.clicks += r.clicks;
  a.impressions += r.impressions;
  a.weighted += r.position * r.impressions;
}
const posOf = (a: Acc, rows: number, fallback: number) => (a.impressions ? a.weighted / a.impressions : rows ? fallback : 0);

function keep(query: string, ctx: OppContext): boolean {
  return ctx.includeBranded || !isBranded(query, ctx.client);
}

export interface PageShare {
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

interface QueryAgg {
  query: string;
  acc: Acc;
  pages: Map<string, Acc>;
}

/** Aggregate query+page rows per query, merging normalised page URLs. Rows missing a query or page are skipped. */
function byQuery(rows: OppRow[], ctx: OppContext): QueryAgg[] {
  const map = new Map<string, QueryAgg>();
  for (const r of rows) {
    const query = r.keys[0];
    const pageRaw = r.keys[1];
    if (!query || !pageRaw || !keep(query, ctx)) continue;
    let q = map.get(query);
    if (!q) map.set(query, (q = { query, acc: newAcc(), pages: new Map() }));
    add(q.acc, r);
    const page = normalizePageUrl(pageRaw);
    let p = q.pages.get(page);
    if (!p) q.pages.set(page, (p = newAcc()));
    add(p, r);
  }
  return [...map.values()];
}

function pageShares(q: QueryAgg): PageShare[] {
  return [...q.pages].map(([page, a]) => ({ page, clicks: a.clicks, impressions: a.impressions, position: posOf(a, 1, 0) }));
}

/** The page with the most clicks, then impressions, then URL order. */
function topPage(shares: PageShare[]): PageShare | undefined {
  return [...shares].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.page.localeCompare(b.page))[0];
}

// ---------------------------------------------------------------- striking_distance

export interface StrikingDistanceOptions {
  minPosition?: number; // 5
  maxPosition?: number; // 20
  minImpressions?: number; // 100
}

export interface StrikingDistanceRow {
  query: string;
  topPage: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  estimatedExtraClicks: number;
}

/** Queries ranking in positions minPosition..maxPosition with enough impressions; upside = impressions x (expected CTR at 3 - current CTR), floored at 0. */
export function strikingDistance(rows: OppRow[], ctx: OppContext, opts: StrikingDistanceOptions = {}): StrikingDistanceRow[] {
  const { minPosition = 5, maxPosition = 20, minImpressions = 100 } = opts;
  const target = expectedCtr(3);
  const out: StrikingDistanceRow[] = [];
  for (const q of byQuery(rows, ctx)) {
    const position = posOf(q.acc, 1, 0);
    if (q.acc.impressions < minImpressions || position < minPosition || position > maxPosition) continue;
    const ctr = q.acc.clicks / q.acc.impressions;
    out.push({
      query: q.query,
      topPage: topPage(pageShares(q))!.page,
      position: round(position, 1),
      impressions: q.acc.impressions,
      clicks: q.acc.clicks,
      ctr: pct(ctr),
      estimatedExtraClicks: round(Math.max(0, q.acc.impressions * (target - ctr)), 1),
    });
  }
  return out.sort((a, b) => b.estimatedExtraClicks - a.estimatedExtraClicks || b.impressions - a.impressions || a.query.localeCompare(b.query));
}

// ---------------------------------------------------------------- quick_wins

export interface QuickWinsOptions {
  minPosition?: number; // 11
  maxPosition?: number; // 20
  minImpressions?: number; // 100
}

export interface QuickWinRow {
  page: string;
  position: number;
  impressions: number;
  clicks: number;
  topQueries: { query: string; impressions: number; clicks: number; position: number }[];
}

/** Pages just off page one (position minPosition..maxPosition, impression-weighted over their queries). */
export function quickWins(rows: OppRow[], ctx: OppContext, opts: QuickWinsOptions = {}): QuickWinRow[] {
  const { minPosition = 11, maxPosition = 20, minImpressions = 100 } = opts;
  const pages = new Map<string, { acc: Acc; queries: Map<string, Acc> }>();
  for (const r of rows) {
    const query = r.keys[0];
    const pageRaw = r.keys[1];
    if (!query || !pageRaw || !keep(query, ctx)) continue;
    const page = normalizePageUrl(pageRaw);
    let p = pages.get(page);
    if (!p) pages.set(page, (p = { acc: newAcc(), queries: new Map() }));
    add(p.acc, r);
    let q = p.queries.get(query);
    if (!q) p.queries.set(query, (q = newAcc()));
    add(q, r);
  }
  const out: QuickWinRow[] = [];
  for (const [page, p] of pages) {
    const position = posOf(p.acc, 1, 0);
    if (p.acc.impressions < minImpressions || position < minPosition || position > maxPosition) continue;
    const topQueries = [...p.queries]
      .map(([query, a]) => ({ query, impressions: a.impressions, clicks: a.clicks, position: round(posOf(a, 1, 0), 1) }))
      .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.query.localeCompare(b.query))
      .slice(0, 3);
    out.push({ page, position: round(position, 1), impressions: p.acc.impressions, clicks: p.acc.clicks, topQueries });
  }
  return out.sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page));
}

// ---------------------------------------------------------------- low_ctr

export interface LowCtrOptions {
  minPosition?: number; // 1
  maxPosition?: number; // 5
  /** Flag when CTR < ctrRatio x expected CTR (strictly). Default 0.6. */
  ctrRatio?: number;
  minImpressions?: number; // 100
}

export interface LowCtrRow {
  query: string;
  page: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  expectedCtr: number;
  estimatedExtraClicks: number;
}

/** Top-of-page queries whose CTR is well under the curve: title and meta description rewrite candidates. Upside = impressions x (expected CTR - CTR). */
export function lowCtr(rows: OppRow[], ctx: OppContext, opts: LowCtrOptions = {}): LowCtrRow[] {
  const { minPosition = 1, maxPosition = 5, ctrRatio = 0.6, minImpressions = 100 } = opts;
  const out: LowCtrRow[] = [];
  for (const q of byQuery(rows, ctx)) {
    const position = posOf(q.acc, 1, 0);
    if (q.acc.impressions < minImpressions || position < minPosition || position > maxPosition) continue;
    const ctr = q.acc.clicks / q.acc.impressions;
    const expected = expectedCtr(position);
    if (!(ctr < ctrRatio * expected)) continue;
    out.push({
      query: q.query,
      page: topPage(pageShares(q))!.page,
      position: round(position, 1),
      impressions: q.acc.impressions,
      clicks: q.acc.clicks,
      ctr: pct(ctr),
      expectedCtr: pct(expected),
      estimatedExtraClicks: round(q.acc.impressions * (expected - ctr), 1),
    });
  }
  return out.sort((a, b) => b.estimatedExtraClicks - a.estimatedExtraClicks || b.impressions - a.impressions || a.query.localeCompare(b.query));
}

// ---------------------------------------------------------------- cannibalization

export interface CannibalizationOptions {
  minImpressions?: number; // 100, query total
  /** Each competing page needs at least this fraction of the query's impressions. Default 0.1. */
  minShare?: number;
  /** Fewest competing pages. Default 2. */
  minPages?: number;
}

export interface CannibalizationRow {
  query: string;
  totalImpressions: number;
  totalClicks: number;
  pages: { page: string; impressionShare: number; impressions: number; clicks: number; position: number }[];
}

/** Queries where 2+ pages each hold at least `minShare` of the query's impressions. Pages with a smaller share are left out of `pages`. */
export function cannibalization(rows: OppRow[], ctx: OppContext, opts: CannibalizationOptions = {}): CannibalizationRow[] {
  const { minImpressions = 100, minShare = 0.1, minPages = 2 } = opts;
  const out: CannibalizationRow[] = [];
  for (const q of byQuery(rows, ctx)) {
    const total = q.acc.impressions;
    if (total < minImpressions || total === 0) continue;
    const competing = pageShares(q)
      .filter((p) => p.impressions / total >= minShare)
      .sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page));
    if (competing.length < minPages) continue;
    out.push({
      query: q.query,
      totalImpressions: total,
      totalClicks: q.acc.clicks,
      pages: competing.map((p) => ({
        page: p.page,
        impressionShare: pct(p.impressions / total),
        impressions: p.impressions,
        clicks: p.clicks,
        position: round(p.position, 1),
      })),
    });
  }
  return out.sort((a, b) => b.totalImpressions - a.totalImpressions || a.query.localeCompare(b.query));
}

// ---------------------------------------------------------------- declining_pages

export interface PageStat {
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

/** Per-page totals from page-dimension rows (keys[0] = page), merging normalised URLs. Cannot exclude branded queries. */
export function pagesFromPageRows(rows: OppRow[]): PageStat[] {
  const map = new Map<string, Acc>();
  for (const r of rows) {
    if (!r.keys[0]) continue;
    const page = normalizePageUrl(r.keys[0]);
    let a = map.get(page);
    if (!a) map.set(page, (a = newAcc()));
    add(a, r);
  }
  return [...map].map(([page, a]) => ({ page, clicks: a.clicks, impressions: a.impressions, position: round(posOf(a, 1, 0), 1) }));
}

/** Per-page totals from query+page rows, honouring branded exclusion. */
export function pagesFromQueryPageRows(rows: OppRow[], ctx: OppContext): PageStat[] {
  const map = new Map<string, Acc>();
  for (const r of rows) {
    const query = r.keys[0];
    const pageRaw = r.keys[1];
    if (!query || !pageRaw || !keep(query, ctx)) continue;
    const page = normalizePageUrl(pageRaw);
    let a = map.get(page);
    if (!a) map.set(page, (a = newAcc()));
    add(a, r);
  }
  return [...map].map(([page, a]) => ({ page, clicks: a.clicks, impressions: a.impressions, position: round(posOf(a, 1, 0), 1) }));
}

export interface DecliningPagesOptions {
  /** Minimum click drop as a percent of the previous clicks. Default 30. */
  minDropPct?: number;
  /** Minimum absolute click loss. Default 10. */
  minClickLoss?: number;
  /** Queries listed per page. Default 5. */
  topQueries?: number;
}

export interface DecliningPageRow {
  page: string;
  clicksBefore: number;
  clicksAfter: number;
  change: number;
  changePct: number;
  positionBefore: number | null;
  positionAfter: number | null;
  topLostQueries: { query: string; clicksBefore: number; clicksAfter: number; change: number }[];
}

/**
 * Pages whose clicks fell by >= minDropPct and >= minClickLoss versus the previous period.
 * A page with no rows now counts as 0 clicks. `curQP`/`prevQP` are query+page rows,
 * used only to list the queries that lost the most clicks on each flagged page.
 */
export function decliningPages(
  cur: PageStat[],
  prev: PageStat[],
  curQP: OppRow[],
  prevQP: OppRow[],
  ctx: OppContext,
  opts: DecliningPagesOptions = {},
): DecliningPageRow[] {
  const { minDropPct = 30, minClickLoss = 10, topQueries = 5 } = opts;
  const curMap = new Map(cur.map((p) => [p.page, p]));
  const flagged: DecliningPageRow[] = [];
  for (const p of prev) {
    if (p.clicks <= 0) continue;
    const now = curMap.get(p.page);
    const after = now?.clicks ?? 0;
    const loss = p.clicks - after;
    const dropPct = (loss / p.clicks) * 100;
    if (loss < minClickLoss || dropPct < minDropPct) continue;
    flagged.push({
      page: p.page,
      clicksBefore: p.clicks,
      clicksAfter: after,
      change: -loss,
      changePct: round(-dropPct, 1),
      positionBefore: p.impressions ? p.position : null,
      positionAfter: now && now.impressions ? now.position : null,
      topLostQueries: [],
    });
  }
  if (flagged.length) {
    const names = new Set(flagged.map((f) => f.page));
    const clicksBy = (rows: OppRow[]) => {
      const m = new Map<string, Map<string, number>>();
      for (const r of rows) {
        const query = r.keys[0];
        const pageRaw = r.keys[1];
        if (!query || !pageRaw || !keep(query, ctx)) continue;
        const page = normalizePageUrl(pageRaw);
        if (!names.has(page)) continue;
        const qm = m.get(page) ?? new Map<string, number>();
        qm.set(query, (qm.get(query) ?? 0) + r.clicks);
        m.set(page, qm);
      }
      return m;
    };
    const before = clicksBy(prevQP);
    const after = clicksBy(curQP);
    for (const f of flagged) {
      const b = before.get(f.page) ?? new Map<string, number>();
      const a = after.get(f.page) ?? new Map<string, number>();
      f.topLostQueries = [...b]
        .map(([query, clicksBefore]) => ({ query, clicksBefore, clicksAfter: a.get(query) ?? 0, change: (a.get(query) ?? 0) - clicksBefore }))
        .filter((q) => q.change < 0)
        .sort((x, y) => x.change - y.change || x.query.localeCompare(y.query))
        .slice(0, topQueries);
    }
  }
  return flagged.sort((a, b) => a.change - b.change || a.page.localeCompare(b.page));
}
