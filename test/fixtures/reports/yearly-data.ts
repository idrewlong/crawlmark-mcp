/**
 * Release 0.5.0 fixture data (Y0): one typed value per yearly section (channel_yoy, page_groups, content_by_year,
 * wins_misses) and `yearlyReport()`, a TemplateReport of the builtin `yearly` template (2025 against 2024) with all
 * four yearly sections `ok`, for the renderer, deck and export tests. Pure data, no network; example.com only.
 * The search, pages and page-movers sections come from the same fixture Search Console data the other tests use
 * (data.ts: 2025 is scale 1, 2024 is 0.75), so the numbers agree across sections.
 */
import { pctChange } from "../../../src/lib/dates.js";
import { computeHighlights } from "../../../src/reports/highlights.js";
import { compare, movers } from "../../../src/reports/monthly.js";
import type {
  ChannelRow,
  ChannelYoyData,
  ContentByYearData,
  ContentYearRow,
  DailySearchPoint,
  PageGroupRow,
  PageGroupsData,
  SearchOverviewData,
  SectionResult,
  TemplateReport,
  TopRowsData,
  MoversData,
  WinsMissesData,
} from "../../../src/reports/report-types.js";
import { SECTION_TITLES } from "../../../src/reports/templates/schema.js";
import * as d from "./data.js";

export const YEAR_2025 = { startDate: "2025-01-01", endDate: "2025-12-31" };
export const YEAR_2024 = { startDate: "2024-01-01", endDate: "2024-12-31" };
const r1 = (n: number) => Number(n.toFixed(1));

// ------------------------------------------------------------------------------------------------ channel_yoy

/** One channel row from current and previous figures (null previous: the channel had no row last year). */
export function channelRow(channel: string, cur: { sessions: number; users: number; engagedSessions: number; keyEvents: number }, prev: { sessions: number; users: number; keyEvents: number } | null): ChannelRow {
  const p = prev ?? { sessions: 0, users: 0, keyEvents: 0 };
  return {
    channel,
    sessions: cur.sessions,
    users: cur.users,
    keyEvents: cur.keyEvents,
    engagementRate: cur.sessions > 0 ? r1((cur.engagedSessions / cur.sessions) * 100) : null,
    previous: prev,
    change: { sessions: pctChange(cur.sessions, p.sessions), users: pctChange(cur.users, p.users), keyEvents: pctChange(cur.keyEvents, p.keyEvents) },
  };
}

function channelYoyFixture(): ChannelYoyData {
  const cur = d.ga4ChannelReport(null, YEAR_2025);
  const prev = d.ga4ChannelReport(null, YEAR_2024);
  const names = [...new Set([...cur, ...prev].map((r) => r.channel))];
  const zero = { sessions: 0, users: 0, engagedSessions: 0, keyEvents: 0 };
  const rows = names
    .map((n) => {
      const p = prev.find((r) => r.channel === n);
      return channelRow(n, cur.find((r) => r.channel === n) ?? zero, p ? { sessions: p.sessions, users: p.users, keyEvents: p.keyEvents } : null);
    })
    .sort((a, b) => b.sessions - a.sessions || a.channel.localeCompare(b.channel));
  const sum = (list: typeof cur) => list.reduce((a, r) => ({ sessions: a.sessions + r.sessions, users: a.users + r.users, engagedSessions: a.engagedSessions + r.engagedSessions, keyEvents: a.keyEvents + r.keyEvents }), zero);
  const pt = sum(prev);
  return {
    current: YEAR_2025,
    previous: YEAR_2024,
    metric: "sessions",
    // 8 channels (Affiliates only in 2024, so 0 now) and the default limit 8: no "Other channels" row.
    rows,
    other: null,
    totals: channelRow("Total", sum(cur), { sessions: pt.sessions, users: pt.users, keyEvents: pt.keyEvents }),
    previousEmpty: false,
  };
}
export const CHANNEL_YOY: ChannelYoyData = channelYoyFixture();

// ------------------------------------------------------------------------------------------------ page_groups

function groupRow(name: string, cur: { clicks: number; impressions: number; position: number | null }, prev: { clicks: number; impressions: number }, totalClicks: number): PageGroupRow {
  return {
    name,
    clicks: cur.clicks,
    impressions: cur.impressions,
    ctr: cur.impressions ? Number(((cur.clicks / cur.impressions) * 100).toFixed(2)) : 0,
    position: cur.impressions ? cur.position : null,
    share: totalClicks ? r1((cur.clicks / totalClicks) * 100) : 0,
    previous: prev,
    change: { clicks: pctChange(cur.clicks, prev.clicks), clicksAbs: cur.clicks - prev.clicks },
  };
}

/** The default groups over the fixture pages (/, /services/emergency, /blog/water-heaters, /contact), 2025 against 2024. */
export const PAGE_GROUPS: PageGroupsData = {
  comparedWith: "previous_year",
  method: "filtered",
  groupsSource: "default",
  rows: [
    groupRow("Home", { clicks: 420, impressions: 6000, position: 3.1 }, { clicks: 315, impressions: 4500 }, 770),
    groupRow("Blog", { clicks: 110, impressions: 4100, position: 9.2 }, { clicks: 83, impressions: 3075 }, 770),
    groupRow("Services", { clicks: 200, impressions: 5100, position: 6 }, { clicks: 150, impressions: 3825 }, 770),
    groupRow("Locations", { clicks: 0, impressions: 0, position: null }, { clicks: 0, impressions: 0 }, 770),
    groupRow("Other", { clicks: 40, impressions: 800, position: 5.5 }, { clicks: 30, impressions: 600 }, 770),
  ],
  unattributed: null,
};

// ------------------------------------------------------------------------------------------------ content_by_year

function yearRow(year: string, pages: number, clicks: number, impressions: number, totalClicks: number): ContentYearRow {
  return { year, pages, clicks, impressions, clicksShare: r1((clicks / totalClicks) * 100), clicksPerPage: r1(clicks / pages) };
}

export const CONTENT_BY_YEAR: ContentByYearData = {
  crawlId: "crawl_20261011T060000000Z-1a2b3c4d",
  crawledAt: "2026-10-11T06:00:00.000Z",
  group: null,
  pagesConsidered: 20,
  rows: [
    yearRow("2025", 4, 300, 6000, 970),
    yearRow("2024", 6, 420, 7400, 970),
    yearRow("2023", 3, 150, 3100, 970),
    yearRow("2022 and earlier", 2, 30, 900, 970),
    yearRow("Unknown", 5, 70, 1500, 970),
  ],
  sources: { jsonld: 9, meta: 3, url: 3, none: 5 },
  staleDays: null,
};

// ------------------------------------------------------------------------------------------------ wins_misses

export const WINS_MISSES: WinsMissesData = {
  comparedWith: "previous_year",
  goals: [
    { kind: "win", rule: "goal", text: "Goal met: Search clicks 1120 (target 1000)", metric: "clicks", current: 1120, previous: 840, target: 1000 },
    { kind: "miss", rule: "goal", text: "Goal missed: sessions 1500 of 2000 (75%)", metric: "sessions", current: 1500, previous: 1125, target: 2000 },
  ],
  wins: [
    { kind: "win", rule: "kpi", text: "Search clicks rose 33.3% (1120 against 840)", metric: "clicks", current: 1120, previous: 840 },
    { kind: "win", rule: "page", text: "https://example.com/ gained 105 clicks", metric: "clicks", current: 420, previous: 315 },
    { kind: "win", rule: "page_new", text: "https://example.com/blog/water-heaters is new, with 110 clicks", metric: "clicks", current: 110, previous: null },
    { kind: "win", rule: "query_top3", text: "\"leak detection\" moved into the top 3", metric: "position", current: 2.4, previous: 4.9 },
  ],
  misses: [
    { kind: "miss", rule: "kpi", text: "Average position slipped from 7.0 to 8.2", metric: "position", current: 8.2, previous: 7 },
    { kind: "miss", rule: "page_lost", text: "https://example.com/old-offer lost its 45 clicks", metric: "clicks", current: 0, previous: 45 },
    { kind: "miss", rule: "query_top10", text: "\"water heater repair\" dropped out of the top 10", metric: "position", current: 11.4, previous: 8.1 },
  ],
  skippedGoals: [],
};

// ------------------------------------------------------------------------------------------------ the report

const daily = (r: { startDate: string; endDate: string }): DailySearchPoint[] => {
  const t = d.gscTotals(null, r);
  const clicks = d.dailySplit(r.startDate, r.endDate, t.clicks);
  const impressions = d.dailySplit(r.startDate, r.endDate, t.impressions);
  return clicks.map((c, i) => ({ date: c.date, clicks: c.value, impressions: impressions[i]!.value }));
};

function searchFixture(): SearchOverviewData {
  const cur = d.gscTotals(null, YEAR_2025);
  const prev = d.gscTotals(null, YEAR_2024);
  return {
    metrics: ["clicks", "impressions", "ctr", "position"],
    current: cur,
    vsPreviousPeriod: null,
    vsPreviousYear: compare(cur, prev),
    // 365 and 366 days: long enough for the "by month" fallback tables (C6).
    daily: { current: daily(YEAR_2025), previous: daily(YEAR_2024), comparedWith: "previous_year" },
  };
}

const pageRows = (r: { startDate: string; endDate: string }) => d.gscQuery(null, { ...r, dimensions: ["page"], rowLimit: 200 });

const ok = (id: string, type: keyof typeof SECTION_TITLES, data: unknown): SectionResult => ({ id, type, title: SECTION_TITLES[type], status: "ok", data });

/** The yearly sections, by section id of the builtin `yearly` template. */
export const YEARLY_SECTION_DATA = {
  channels: CHANNEL_YOY,
  "page-types": PAGE_GROUPS,
  "content-years": CONTENT_BY_YEAR,
  wins: WINS_MISSES,
} as const;

/**
 * The builtin `yearly` template's report for example.com, 2025 against 2024, with `content-years` included (it is
 * optional) and `issues` left out. Fixed id and time. `over` replaces top-level fields (e.g. sections, template).
 */
export function yearlyReport(over: Partial<TemplateReport> = {}): TemplateReport {
  const sections: SectionResult[] = [
    ok("search", "search_overview", searchFixture()),
    ok("channels", "channel_yoy", CHANNEL_YOY),
    ok("page-types", "page_groups", PAGE_GROUPS),
    ok("pages", "top_pages", { rows: pageRows(YEAR_2025).slice(0, 15) } satisfies TopRowsData),
    ok("page-movers", "page_movers", { comparedWith: "previous_year", ...movers(pageRows(YEAR_2025), pageRows(YEAR_2024), 10) } satisfies MoversData),
    ok("content-years", "content_by_year", CONTENT_BY_YEAR),
    ok("wins", "wins_misses", WINS_MISSES),
  ];
  const report: TemplateReport = {
    reportId: `rpt_01JYEARLY${"0".repeat(17)}`,
    client: { slug: d.CLIENT.slug, name: d.CLIENT.name, domain: d.CLIENT.domain },
    template: { id: "yearly", title: "Yearly SEO review", source: "builtin", contents: true },
    period: { current: YEAR_2025, label: "2025", folderMonth: "2025-12", comparisons: { previous_year: YEAR_2024 } },
    generatedAt: "2026-10-13T09:00:00.000Z",
    sections,
    highlights: [],
    notes: [],
    spend: { usd: 0, units: { ahrefs: 0, semrush: 0 } },
    ...over,
  };
  if (!over.highlights) report.highlights = computeHighlights(report);
  return report;
}
