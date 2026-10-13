/**
 * CrUX History (Phase 12 A, D11/D12): parse a queryHistoryRecord response into
 * per-metric p75 series with ratings and a trend, and turn the latest period
 * into audit findings. Pure. Missing data is null (the API sends null p75s and
 * "NaN" densities); CLS p75 values arrive as strings.
 */
import type { CruxHistoryResult, CwvMetric, CwvRating, CwvSeries } from "../reports/report-types.js";
import type { Finding } from "./findings.js";

export const CRUX_METRICS: Record<CwvMetric, { api: string; unit: "ms" | "score"; good: number; poor: number; name: string }> = {
  lcp: { api: "largest_contentful_paint", unit: "ms", good: 2500, poor: 4000, name: "Largest Contentful Paint" },
  inp: { api: "interaction_to_next_paint", unit: "ms", good: 200, poor: 500, name: "Interaction to Next Paint" },
  cls: { api: "cumulative_layout_shift", unit: "score", good: 0.1, poor: 0.25, name: "Cumulative Layout Shift" },
  fcp: { api: "first_contentful_paint", unit: "ms", good: 1800, poor: 3000, name: "First Contentful Paint" },
  ttfb: { api: "experimental_time_to_first_byte", unit: "ms", good: 800, poor: 1800, name: "Time to First Byte" },
};
export const ALL_CRUX_METRICS = Object.keys(CRUX_METRICS) as CwvMetric[];
/** Trend: the mean of the last 4 non-null periods against the first 4; within ±5% is flat. */
export const TREND_WINDOW = 4;
export const TREND_FLAT_PCT = 5;

interface ApiDate {
  year?: number;
  month?: number;
  day?: number;
}
export interface CruxHistoryResponse {
  record?: {
    key?: { origin?: string; url?: string; formFactor?: string };
    metrics?: Record<string, { percentilesTimeseries?: { p75s?: (number | string | null)[] } }>;
    collectionPeriods?: { firstDate?: ApiDate; lastDate?: ApiDate }[];
  };
}

const pad = (n: number | undefined) => String(n ?? 0).padStart(2, "0");
const isoDate = (d: ApiDate | undefined) => `${d?.year ?? 0}-${pad(d?.month)}-${pad(d?.day)}`;

/** A p75 value as a number, or null for null, "NaN" and anything unparsable. */
export function p75Value(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function rate(metric: CwvMetric, v: number | null): CwvRating | null {
  if (v === null) return null;
  const t = CRUX_METRICS[metric];
  return v <= t.good ? "good" : v <= t.poor ? "needs-improvement" : "poor";
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function trendOf(values: (number | null)[]): CwvSeries["trend"] {
  const nn = values.filter((v): v is number => v !== null);
  if (nn.length < 2) return "insufficient-data";
  const k = Math.min(TREND_WINDOW, Math.floor(nn.length / 2));
  const first = mean(nn.slice(0, k));
  const last = mean(nn.slice(-k));
  if (first === 0) return last === 0 ? "flat" : "worsening";
  const pct = ((last - first) / first) * 100;
  // Lower is better for every Core Web Vital.
  return pct <= -TREND_FLAT_PCT ? "improving" : pct >= TREND_FLAT_PCT ? "worsening" : "flat";
}

const round = (metric: CwvMetric, v: number) => (CRUX_METRICS[metric].unit === "score" ? Number(v.toFixed(3)) : Math.round(v));

export function seriesOf(metric: CwvMetric, raw: (number | string | null)[] | undefined, periods: number): CwvSeries {
  const p75 = Array.from({ length: periods }, (_, i) => {
    const v = p75Value(raw?.[i]);
    return v === null ? null : round(metric, v);
  });
  const nn = p75.filter((v): v is number => v !== null);
  const first = nn[0] ?? null;
  const latest = nn.at(-1) ?? null;
  return {
    unit: CRUX_METRICS[metric].unit,
    p75,
    latest,
    first,
    change: first !== null && latest !== null ? round(metric, latest - first) : null,
    rating: p75.map((v) => rate(metric, v)),
    trend: trendOf(p75),
  };
}

/** The available result for a response (key fields come from the request, not the response). */
export function parseCruxHistory(
  res: CruxHistoryResponse,
  req: { origin?: string; url?: string; formFactor: string; metrics: CwvMetric[] },
  keySource: "CRUX_API_KEY" | "PSI_API_KEY",
): Extract<CruxHistoryResult, { available: true }> {
  const periods = (res.record?.collectionPeriods ?? []).map((p) => ({ start: isoDate(p.firstDate), end: isoDate(p.lastDate) }));
  const metrics: Partial<Record<CwvMetric, CwvSeries>> = {};
  for (const m of req.metrics) {
    const raw = res.record?.metrics?.[CRUX_METRICS[m].api];
    if (raw) metrics[m] = seriesOf(m, raw.percentilesTimeseries?.p75s, periods.length);
  }
  return {
    key: { ...(req.origin ? { origin: req.origin } : {}), ...(req.url ? { url: req.url } : {}), formFactor: req.formFactor },
    keySource,
    available: true,
    periods,
    metrics,
    fromCache: false,
  };
}

/** The checked-pair key for a CrUX origin (D12). */
export const cruxCheckUrl = (origin: string) => `site:crux ${origin}`;

const FINDING_METRICS: CwvMetric[] = ["lcp", "inp", "cls"];

/**
 * Findings from the latest period (D12): poor is high, needs improvement is medium, for LCP, INP and CLS.
 * Source "crux", recorded at the origin.
 */
export function cruxFindings(result: CruxHistoryResult): Omit<Finding, "id">[] {
  if (!result.available) return [];
  const where = result.key.origin ?? result.key.url ?? "";
  const lastEnd = result.periods.at(-1)?.end;
  const out: Omit<Finding, "id">[] = [];
  for (const m of FINDING_METRICS) {
    const s = result.metrics[m];
    const i = s ? s.p75.length - 1 : -1;
    const v = s && i >= 0 ? s.p75[i]! : null;
    const r = s && i >= 0 ? s.rating[i]! : null;
    if (!s || v === null || r === null || r === "good") continue;
    const shown = s.unit === "score" ? v.toFixed(2) : `${Math.round(v).toLocaleString("en-US")} ms`;
    out.push({
      source: "crux",
      rule: `field-${m}-${r === "poor" ? "poor" : "needs-improvement"}`,
      url: where,
      severity: r === "poor" ? "high" : "medium",
      title: `Real-user ${m.toUpperCase()} ${r === "poor" ? "is poor" : "needs improvement"} (75th percentile, ${result.key.formFactor.toLowerCase()})`,
      evidence: `${shown}${lastEnd ? ` in the 28 days to ${lastEnd}` : ""}`,
    });
  }
  return out;
}
