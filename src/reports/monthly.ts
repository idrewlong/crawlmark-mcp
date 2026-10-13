import type { Client } from "../config.js";
import { spentThisMonth } from "../lib/budget.js";
import { spendKeys } from "../lib/spend.js";
import { lastCompleteMonth, monthRange, pctChange, previousMonth, sameMonthLastYear } from "../lib/dates.js";
import { serp } from "../providers/dataforseo.js";
import { ga4OrganicSummary, ga4TopLandingPages } from "../providers/ga4.js";
import { gscQuery, gscTotals, type GscRow } from "../providers/gsc.js";
import { dataOf, section } from "./section.js";

export interface MonthlyReportOptions {
  month?: string;
  /** Also check live SERP rank for tracked keywords via DataForSEO (paid). Default: GSC average position only (free). */
  liveRanks?: boolean;
}

function compare(cur: { clicks: number; impressions: number; ctr: number; position: number }, prev: typeof cur) {
  return {
    clicks: { value: cur.clicks, change: pctChange(cur.clicks, prev.clicks) },
    impressions: { value: cur.impressions, change: pctChange(cur.impressions, prev.impressions) },
    ctr: { value: cur.ctr, change: Number((cur.ctr - prev.ctr).toFixed(2)) },
    // Lower is better for position, so a negative delta is an improvement.
    position: { value: cur.position, change: Number((cur.position - prev.position).toFixed(1)) },
  };
}

/** Rows that gained or lost the most clicks between two periods. */
function movers(cur: GscRow[], prev: GscRow[], n = 10) {
  const prevMap = new Map(prev.map((r) => [r.keys[0], r]));
  const deltas = cur.map((r) => {
    const p = prevMap.get(r.keys[0]);
    return {
      key: r.keys[0]!,
      clicks: r.clicks,
      clicksDelta: r.clicks - (p?.clicks ?? 0),
      position: r.position,
      positionDelta: p ? Number((r.position - p.position).toFixed(1)) : null,
    };
  });
  const sorted = [...deltas].sort((a, b) => b.clicksDelta - a.clicksDelta);
  return {
    gainers: sorted.slice(0, n).filter((d) => d.clicksDelta > 0),
    losers: sorted.reverse().slice(0, n).filter((d) => d.clicksDelta < 0),
  };
}

export async function monthlyReport(client: Client, opts: MonthlyReportOptions = {}) {
  const month = opts.month ?? lastCompleteMonth();
  const cur = monthRange(month);
  const prev = monthRange(previousMonth(month));
  const yoy = monthRange(sameMonthLastYear(month));

  const [gscCur, gscPrev, gscYoy, queriesCur, queriesPrev, pagesCur, pagesPrev, gaCur, gaPrev, landing] =
    await Promise.all([
      section(() => gscTotals(client, cur)),
      section(() => gscTotals(client, prev)),
      section(() => gscTotals(client, yoy)),
      section(() => gscQuery(client, { ...cur, dimensions: ["query"], rowLimit: 500 })),
      section(() => gscQuery(client, { ...prev, dimensions: ["query"], rowLimit: 500 })),
      section(() => gscQuery(client, { ...cur, dimensions: ["page"], rowLimit: 200 })),
      section(() => gscQuery(client, { ...prev, dimensions: ["page"], rowLimit: 200 })),
      section(() => ga4OrganicSummary(client, cur)),
      section(() => ga4OrganicSummary(client, prev)),
      section(() => ga4TopLandingPages(client, cur, 15)),
    ]);

  // Tracked keywords: free GSC average position, optionally a paid live SERP check.
  const qCur = dataOf(queriesCur) ?? [];
  const tracked = await section(async () =>
    Promise.all(
      client.trackedKeywords.map(async (kw) => {
        const row = qCur.find((r) => r.keys[0]?.toLowerCase() === kw.toLowerCase());
        const live = opts.liveRanks ? await serp(client, kw) : undefined;
        return {
          keyword: kw,
          gscPosition: row?.position ?? null,
          gscClicks: row?.clicks ?? 0,
          gscImpressions: row?.impressions ?? 0,
          liveRank: live?.clientRank ?? null,
          liveUrl: live?.clientUrl ?? null,
        };
      }),
    ),
  );

  const gc = dataOf(gscCur);
  const gp = dataOf(gscPrev);
  const gy = dataOf(gscYoy);
  const ac = dataOf(gaCur);
  const ap = dataOf(gaPrev);

  return {
    client: { slug: client.slug, name: client.name, domain: client.domain },
    month,
    periods: { current: cur, previous: prev, yearAgo: yoy },
    search: gc && gp
      ? {
          vsPreviousMonth: compare(gc, gp),
          vsLastYear: gy ? compare(gc, gy) : null,
        }
      : { error: !gscCur.ok ? gscCur.error : !gscPrev.ok ? gscPrev.error : "unknown" },
    organicTraffic: ac && ap
      ? {
          sessions: { value: ac.sessions, change: pctChange(ac.sessions, ap.sessions) },
          users: { value: ac.users, change: pctChange(ac.users, ap.users) },
          engagementRate: { value: ac.engagementRate, change: Number((ac.engagementRate - ap.engagementRate).toFixed(1)) },
          keyEvents: { value: ac.keyEvents, change: pctChange(ac.keyEvents, ap.keyEvents) },
        }
      : { error: !gaCur.ok ? gaCur.error : !gaPrev.ok ? gaPrev.error : "unknown" },
    topQueries: qCur.slice(0, 20),
    queryMovers: queriesCur.ok && queriesPrev.ok ? movers(queriesCur.data, queriesPrev.data) : null,
    topPages: (dataOf(pagesCur) ?? []).slice(0, 15),
    pageMovers: pagesCur.ok && pagesPrev.ok ? movers(pagesCur.data, pagesPrev.data) : null,
    topLandingPages: landing,
    trackedKeywords: tracked,
    dataSpendThisMonthUsd: Number(spentThisMonth(spendKeys(client)).toFixed(4)),
  };
}
