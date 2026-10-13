/**
 * Computed highlights (D3): deterministic facts from a TemplateReport, never
 * interpretation. At most 8, in rule order. Every percent sits next to the
 * absolute numbers it comes from; position changes say "lower is better".
 * No highlight when a comparison is missing.
 */
import type {
  AuditChangesData,
  BrandedSplitData,
  CruxHistoryResult,
  Highlight,
  MoversData,
  OrganicTrafficData,
  SearchOverviewData,
  SectionResult,
  TemplateReport,
  TrackedKeywordsData,
} from "./report-types.js";
import { periodName } from "./templates/period.js";

export const MAX_HIGHLIGHTS = 8;
export const MIN_CHANGE_PCT = 5;
export const MIN_DELTA = 20;
export const MIN_POSITION_MOVE = 3;

const int = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (n: number) => `${Math.abs(n).toFixed(1)}%`;
const CWV_NAMES: Record<string, string> = { lcp: "LCP", inp: "INP", cls: "CLS", fcp: "FCP", ttfb: "TTFB" };
const RATING_TEXT = { good: "good", "needs-improvement": "needs improvement", poor: "poor" } as const;

function okData<T>(sections: SectionResult[], type: string): { id: string; data: T } | undefined {
  const s = sections.find((x) => x.type === type && x.status === "ok");
  return s && s.status === "ok" ? { id: s.id, data: s.data as T } : undefined;
}

/** "rose 12.0% (from 1,000 to 1,120)" when the change clears both thresholds, else undefined. */
function changeSentence(cur: number, prev: number | null | undefined, change: number | null | undefined): string | undefined {
  if (prev === null || prev === undefined || change === null || change === undefined) return undefined;
  if (Math.abs(change) < MIN_CHANGE_PCT || Math.abs(cur - prev) < MIN_DELTA) return undefined;
  return `${change > 0 ? "rose" : "fell"} ${pct(change)} (from ${int(prev)} to ${int(cur)})`;
}

const fmtCwv = (metric: string, v: number) => (metric === "cls" ? v.toFixed(2) : `${int(v)} ms`);

export function computeHighlights(report: Pick<TemplateReport, "sections" | "period">): Highlight[] {
  const out: Highlight[] = [];
  const { sections, period } = report;
  const name = (which: "previous_period" | "previous_year") => {
    const r = period.comparisons[which];
    return r ? periodName(r) : which === "previous_period" ? "the previous period" : "the previous year";
  };

  // (1), (2) clicks vs previous period / previous year.
  const search = okData<SearchOverviewData>(sections, "search_overview");
  if (search) {
    for (const [which, vs] of [["previous_period", search.data.vsPreviousPeriod], ["previous_year", search.data.vsPreviousYear]] as const) {
      if (!vs || !vs.previous) continue;
      const s = changeSentence(vs.clicks.value, vs.previous.clicks, vs.clicks.change);
      if (s) out.push({ kind: which === "previous_period" ? "clicks-vs-previous-period" : "clicks-vs-previous-year", sectionId: search.id, text: `Clicks ${s} vs ${name(which)}.`, value: vs.clicks.change! });
    }
  }

  // (3) non-branded clicks.
  const split = okData<BrandedSplitData>(sections, "branded_split");
  if (split && split.data.comparedWith) {
    const nb = split.data.nonBranded;
    const s = changeSentence(nb.current.clicks, nb.previous.clicks, nb.change.clicks);
    if (s) out.push({ kind: "non-branded-clicks", sectionId: split.id, text: `Non-branded clicks ${s} vs ${name(split.data.comparedWith)}.`, value: nb.change.clicks! });
  }

  // (4) GA4 organic sessions.
  const traffic = okData<OrganicTrafficData>(sections, "organic_traffic");
  if (traffic && traffic.data.comparedWith && traffic.data.previous) {
    const s = changeSentence(traffic.data.sessions.value, traffic.data.previous.sessions, traffic.data.sessions.change);
    if (s) out.push({ kind: "organic-sessions", sectionId: traffic.id, text: `Organic sessions (GA4) ${s} vs ${name(traffic.data.comparedWith)}.`, value: traffic.data.sessions.change! });
  }

  // (5) top gaining and losing query by clicks, non-branded first.
  const movers = okData<MoversData>(sections, "query_movers");
  if (movers) {
    const pick = (list: MoversData["gainers"]) => list.find((m) => m.branded === false) ?? list[0];
    const g = pick(movers.data.gainers);
    if (g) out.push({ kind: "top-gaining-query", sectionId: movers.id, text: `Top gaining query: "${g.key}" (+${int(g.clicksDelta)} clicks, from ${int(g.clicks - g.clicksDelta)} to ${int(g.clicks)}).`, value: g.clicksDelta });
    const l = pick(movers.data.losers);
    if (l) out.push({ kind: "top-losing-query", sectionId: movers.id, text: `Top losing query: "${l.key}" (${int(l.clicksDelta)} clicks, from ${int(l.clicks - l.clicksDelta)} to ${int(l.clicks)}).`, value: l.clicksDelta });
  }

  // (6) audit: resolved, and new critical/high. Unverified findings are never counted as fixed.
  const audit = okData<AuditChangesData>(sections, "audit_changes");
  const diff = audit?.data.comparison?.diff;
  if (audit && diff) {
    const resolved = diff.resolved.length;
    const severe = diff.new.filter((f) => f.severity === "critical" || f.severity === "high").length;
    out.push({
      kind: "audit-changes",
      sectionId: audit.id,
      text: `${resolved} audit issue${resolved === 1 ? "" : "s"} resolved, ${severe} new critical or high-severity issue${severe === 1 ? "" : "s"} since the last audit.`,
      value: severe,
    });
  }

  // (7) tracked keywords that moved at least 3 places (Search Console average position).
  const tracked = okData<TrackedKeywordsData>(sections, "tracked_keywords");
  for (const k of tracked?.data.keywords ?? []) {
    if (k.positionChange === null || k.gscPositionPrevious === null || k.gscPosition === null || Math.abs(k.positionChange) < MIN_POSITION_MOVE) continue;
    out.push({
      kind: "tracked-keyword-move",
      sectionId: tracked!.id,
      text: `Tracked keyword "${k.keyword}": average position went from ${k.gscPositionPrevious.toFixed(1)} to ${k.gscPosition.toFixed(1)} (lower is better).`,
      value: k.positionChange,
    });
  }

  // (8) CrUX: a metric whose latest rating differs from the first period's.
  const cwv = okData<CruxHistoryResult>(sections, "core_web_vitals_history");
  if (cwv && cwv.data.available) {
    for (const [metric, series] of Object.entries(cwv.data.metrics)) {
      if (!series) continue;
      const idx = series.p75.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
      if (idx.length < 2) continue;
      const a = idx[0]!;
      const b = idx.at(-1)!;
      const ra = series.rating[a];
      const rb = series.rating[b];
      if (!ra || !rb || ra === rb) continue;
      out.push({
        kind: "cwv-rating-change",
        sectionId: cwv.id,
        text: `${CWV_NAMES[metric] ?? metric} for real users (75th percentile) went from ${fmtCwv(metric, series.p75[a]!)} (${RATING_TEXT[ra]}) to ${fmtCwv(metric, series.p75[b]!)} (${RATING_TEXT[rb]}).`,
        value: series.p75[b]! - series.p75[a]!,
      });
    }
  }

  return out.slice(0, MAX_HIGHLIGHTS);
}
