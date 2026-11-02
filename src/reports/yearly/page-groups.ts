/**
 * Release 0.5.0: Search clicks by page type (C4 page_groups; Y1).
 * Filtered mode (the range is inside Google's window): one Search Console totals request per group plus one for
 * "Other", with disjoint page regexes (group i excludes groups 1..i-1; Other excludes all). Stored mode (the range is
 * served from saved monthly history): the saved top pages are grouped locally with the same expressions.
 */
import type { DateRange } from "../../lib/dates.js";
import { pctChange } from "../../lib/dates.js";
import { readMonths, mergeRows, wholeMonths } from "../../lib/gsc-monthly.js";
import { defaultPageGroups, groupOf, groupRegex, groupsRegex, OTHER_GROUP, type PageGroup } from "../../lib/page-groups.js";
import type { Comparison, PageGroupRow, PageGroupsData } from "../report-types.js";
import type { SectionSpec } from "../templates/schema.js";
import { periodName } from "../templates/period.js";
import { SectionUnavailableError } from "../templates/run.js";
import type { YearlyCtx } from "./context.js";

interface Agg {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}
interface RangeResult {
  method: "filtered" | "stored_top_pages";
  /** One per group in order, then Other. */
  aggs: Agg[];
  unattributed: { clicks: number; impressions: number } | null;
}

const FILTER_NOTE = "Search Console counts by page when you filter by page, so the page types can add up to more than the site's total clicks.";

const r1 = (n: number) => Number(n.toFixed(1));
const ctrOf = (clicks: number, impressions: number) => (impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0);

async function filtered(ctx: YearlyCtx, range: DateRange, groups: readonly PageGroup[]): Promise<Agg[]> {
  const requests = [...groups.map((g, i) => ({ pageRegex: groupRegex(g), pageExcludeRegex: i > 0 ? groupsRegex(groups.slice(0, i)) : undefined })), { pageRegex: undefined, pageExcludeRegex: groupsRegex(groups) }];
  return Promise.all(
    requests.map(async (q) => {
      const rows = await ctx.once(`pg:${range.startDate}:${range.endDate}:${q.pageRegex ?? ""}:${q.pageExcludeRegex ?? ""}`, () =>
        ctx.deps.gscQuery(ctx.client, {
          ...range,
          dimensions: [],
          ...(q.pageRegex !== undefined ? { pageRegex: q.pageRegex } : {}),
          ...(q.pageExcludeRegex !== undefined ? { pageExcludeRegex: q.pageExcludeRegex } : {}),
        }),
      );
      const t = rows[0];
      if (!t || t.impressions <= 0) return { clicks: t?.clicks ?? 0, impressions: t?.impressions ?? 0, ctr: 0, position: null };
      return { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: r1(t.position) };
    }),
  );
}

function stored(ctx: YearlyCtx, range: DateRange, groups: readonly PageGroup[]): { aggs: Agg[]; unattributed: RangeResult["unattributed"] } {
  const property = ctx.client.gscProperty;
  const months = wholeMonths(range);
  if (!property || !months) throw new SectionUnavailableError(`Search Console's saved history can't answer ${periodName(range)} by page type`);
  const pages = mergeRows([...readMonths(ctx.client.slug, property, months, "page").values()].flat());
  const names = [...groups.map((g) => g.name.trim()), OTHER_GROUP];
  const acc = names.map(() => ({ clicks: 0, impressions: 0, weighted: 0 }));
  for (const p of pages) {
    const idx = names.indexOf(groupOf(p.keys[0] ?? "", groups));
    const a = acc[idx < 0 ? names.length - 1 : idx]!;
    a.clicks += p.clicks;
    a.impressions += p.impressions;
    a.weighted += p.position * p.impressions;
  }
  const aggs = acc.map((a) => ({ clicks: a.clicks, impressions: a.impressions, ctr: ctrOf(a.clicks, a.impressions), position: a.impressions > 0 ? r1(a.weighted / a.impressions) : null }));
  const totalRows = [...readMonths(ctx.client.slug, property, months, "totals").values()].flat();
  let unattributed: RangeResult["unattributed"] = null;
  if (totalRows.length) {
    const tc = totalRows.reduce((a, r) => a + r.clicks, 0);
    const ti = totalRows.reduce((a, r) => a + r.impressions, 0);
    unattributed = { clicks: Math.max(0, tc - aggs.reduce((a, r) => a + r.clicks, 0)), impressions: Math.max(0, ti - aggs.reduce((a, r) => a + r.impressions, 0)) };
  }
  return { aggs, unattributed };
}

async function readRange(ctx: YearlyCtx, range: DateRange, groups: readonly PageGroup[]): Promise<RangeResult> {
  const cov = ctx.coverage(range);
  if (!cov.complete) throw new SectionUnavailableError(`Search Console doesn't cover ${periodName(range)}`);
  if (cov.source === "stored") return { method: "stored_top_pages", ...stored(ctx, range, groups) };
  return { method: "filtered", aggs: await filtered(ctx, range, groups), unattributed: null };
}

export async function pageGroupsSection(s: Extract<SectionSpec, { type: "page_groups" }>, ctx: YearlyCtx): Promise<PageGroupsData> {
  const fromTemplate = Boolean(s.groups?.length);
  const groups: PageGroup[] = s.groups?.length ? s.groups : ctx.client.pageGroups?.length ? ctx.client.pageGroups : defaultPageGroups();
  const groupsSource: PageGroupsData["groupsSource"] = fromTemplate ? "template" : ctx.client.pageGroupsSource === "yaml" ? "yaml" : "default";
  const names = [...groups.map((g) => g.name.trim()), OTHER_GROUP];

  // Search Console's range and first comparison, as the other Search Console sections use them (period before year);
  // on a labelled partial range (C2a) that is the partial range with no comparison.
  const cmp: { which: Comparison; range: DateRange } | undefined = ctx.gscPeriod.comparisons.previous_period
    ? { which: "previous_period", range: ctx.gscPeriod.comparisons.previous_period }
    : ctx.gscPeriod.comparisons.previous_year
      ? { which: "previous_year", range: ctx.gscPeriod.comparisons.previous_year }
      : undefined;

  const [cur, prev] = await Promise.all([readRange(ctx, ctx.gscPeriod.current, groups), cmp ? readRange(ctx, cmp.range, groups) : Promise.resolve(undefined)]);

  const total = cur.aggs.reduce((a, r) => a + r.clicks, 0);
  const rows: PageGroupRow[] = cur.aggs.map((a, i) => {
    const p = prev?.aggs[i];
    return {
      name: names[i]!,
      clicks: a.clicks,
      impressions: a.impressions,
      ctr: a.ctr,
      position: a.position,
      share: total > 0 ? r1((a.clicks / total) * 100) : 0,
      previous: p ? { clicks: p.clicks, impressions: p.impressions } : null,
      change: p ? { clicks: pctChange(a.clicks, p.clicks), clicksAbs: a.clicks - p.clicks } : null,
    };
  });

  ctx.note(FILTER_NOTE);
  if (cur.method === "stored_top_pages" && cur.unattributed) {
    const all = total + cur.unattributed.clicks;
    const pct = all > 0 ? r1((cur.unattributed.clicks / all) * 100) : 0;
    ctx.note(`From saved monthly history, which keeps each month's top 250 pages; ${pct}% of clicks couldn't be assigned to a page type.`);
  }
  return { comparedWith: cmp?.which ?? null, method: cur.method, groupsSource, rows, unattributed: cur.unattributed };
}
