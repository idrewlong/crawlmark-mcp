/**
 * Release 0.5.0: Wins and misses (C4 wins_misses; Y1). Fetches the figures; the rules are in
 * src/analysis/wins-misses.ts. Search Console pages and queries are read once per range (1000 rows, memo keys
 * `wp:` / `wq:`); GA4 only when the client has a property.
 */
import { winsAndMisses, type GoalMetric } from "../../analysis/wins-misses.js";
import type { DateRange } from "../../lib/dates.js";
import { isBranded } from "../../lib/brand.js";
import type { GscRow } from "../../providers/gsc.js";
import type { Ga4Summary, PeriodTotals } from "../monthly.js";
import type { Comparison, WinsMissesData } from "../report-types.js";
import type { SectionSpec } from "../templates/schema.js";
import { SectionUnavailableError } from "../templates/run.js";
import type { YearlyCtx } from "./context.js";

const DEFAULT_LIMIT = 5;
const ROW_LIMIT = 1000;
const GA4_METRICS = new Set<GoalMetric>(["sessions", "keyEvents"]);
const GSC_METRICS = new Set<GoalMetric>(["clicks", "impressions"]);

const asRow = (t: PeriodTotals): GscRow => ({ keys: [], clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position });

export async function winsMissesSection(s: Extract<SectionSpec, { type: "wins_misses" }>, ctx: YearlyCtx): Promise<WinsMissesData> {
  const limit = s.limit ?? DEFAULT_LIMIT;
  // Search Console reads its own range (the labelled partial range on C2a); GA4 always the whole period.
  const current = ctx.gscPeriod.current;
  const ga4Current = ctx.period.current;
  // C2a: on a labelled partial range, Search Console goals are left out (a whole-period target against part of the
  // period would read as a miss); GA4 goals still run on the whole period.
  const gscSkipped = ctx.gscPartial ? (s.goals ?? []).filter((g) => GSC_METRICS.has(g.metric)).map((g) => g.label ?? g.metric) : [];
  const goals = ctx.gscPartial ? (s.goals ?? []).filter((g) => !GSC_METRICS.has(g.metric)) : (s.goals ?? []);
  // Year over year first, else the previous period; only comparisons Search Console can answer in full.
  const cmp: { which: Comparison; range: DateRange } | undefined = ctx.gscPeriod.comparisons.previous_year
    ? { which: "previous_year", range: ctx.gscPeriod.comparisons.previous_year }
    : ctx.gscPeriod.comparisons.previous_period
      ? { which: "previous_period", range: ctx.gscPeriod.comparisons.previous_period }
      : undefined;
  if (!cmp && goals.length === 0) throw new SectionUnavailableError("needs a comparison period or goals");

  const rows = (r: DateRange, dimension: "page" | "query", prefix: "wp" | "wq") =>
    ctx.once(`${prefix}:${r.startDate}:${r.endDate}`, () => ctx.deps.gscQuery(ctx.client, { ...r, dimensions: [dimension], rowLimit: ROW_LIMIT }));

  // GA4 is read when the client has a property and something needs it (a comparison, or a traffic goal).
  const needsGa4 = Boolean(cmp) || goals.some((g) => GA4_METRICS.has(g.metric));
  const trafficGoals = goals.filter((g) => GA4_METRICS.has(g.metric)).map((g) => g.label ?? g.metric);
  let ga4: { cur: Ga4Summary; prev: Ga4Summary | null } | undefined;
  if (needsGa4 && ctx.client.ga4PropertyId) {
    const read = (r: DateRange) => ctx.once(`g:${r.startDate}:${r.endDate}`, () => ctx.deps.ga4OrganicSummary(ctx.client, r));
    try {
      const [c, p] = await Promise.all([read(ga4Current), cmp ? read(cmp.range) : Promise.resolve(null)]);
      ga4 = { cur: c, prev: p };
    } catch {
      ctx.note("Google Analytics couldn't be read, so session and key-event figures are left out.");
    }
  } else if (trafficGoals.length) {
    ctx.note(`Goals left out because Google Analytics isn't connected for this client: ${trafficGoals.join(", ")}.`);
  }

  const [curTotals, prevTotals] = await Promise.all([ctx.totals(current), cmp ? ctx.totals(cmp.range) : Promise.resolve(null)]);
  const [curPages, prevPages, curQueries, prevQueries] = cmp
    ? await Promise.all([rows(current, "page", "wp"), rows(cmp.range, "page", "wp"), rows(current, "query", "wq"), rows(cmp.range, "query", "wq")])
    : [[], [], [], []];

  const result = winsAndMisses({
    totals: { cur: asRow(curTotals), prev: prevTotals ? asRow(prevTotals) : null },
    ...(ga4 ? { ga4 } : {}),
    pages: { cur: curPages, prev: prevPages },
    queries: { cur: curQueries, prev: prevQueries },
    goals,
    limit,
    isBranded: (q) => isBranded(q, ctx.client),
  });
  if (gscSkipped.length) return { comparedWith: cmp?.which ?? null, ...result, skippedGoals: [...gscSkipped, ...result.skippedGoals], gscSkippedGoals: gscSkipped };
  return { comparedWith: cmp?.which ?? null, ...result };
}
