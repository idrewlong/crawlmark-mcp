import type { Client } from "../config.js";
import { compareSplit, markBranded, QUERY_TOTALS_NOTE, splitBranded } from "../analysis/branded.js";
import { monthlyAuditSection } from "../analysis/diff.js";
import { latestAudit, latestAuditBefore } from "../lib/audits.js";
import { spentThisMonth } from "../lib/budget.js";
import { spendKeys } from "../lib/spend.js";
import { lastCompleteMonth, monthRange, pctChange, previousMonth, sameMonthLastYear } from "../lib/dates.js";
import { serp } from "../providers/dataforseo.js";
import { ga4OrganicSummary, ga4TopLandingPages } from "../providers/ga4.js";
import { gscQuery, gscTotals, type GscRow } from "../providers/gsc.js";
import { isBranded } from "../lib/brand.js";
import { dataOf, section } from "./section.js";

/** Query rows fetched per month. The branded split sums these, so the limit is well above the old 500 (Search Console allows up to 25,000). */
const QUERY_ROW_LIMIT = 5000;

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
function movers(cur: GscRow[], prev: GscRow[], n = 10, branded?: (key: string) => boolean) {
  const prevMap = new Map(prev.map((r) => [r.keys[0], r]));
  const deltas = cur.map((r) => {
    const p = prevMap.get(r.keys[0]);
    return {
      key: r.keys[0]!,
      clicks: r.clicks,
      clicksDelta: r.clicks - (p?.clicks ?? 0),
      position: r.position,
      positionDelta: p ? Number((r.position - p.position).toFixed(1)) : null,
      ...(branded ? { branded: branded(r.keys[0]!) } : {}),
    };
  });
  const sorted = [...deltas].sort((a, b) => b.clicksDelta - a.clicksDelta);
  return {
    gainers: sorted.slice(0, n).filter((d) => d.clicksDelta > 0),
    losers: sorted.reverse().slice(0, n).filter((d) => d.clicksDelta < 0),
  };
}

/** `search.branded` / `search.nonBranded` / the note, or an error shape under `brandedSplit` when the query rows were unavailable. */
function brandSplitFields(split: { error: string } | { branded: unknown; nonBranded: unknown; [k: string]: unknown }) {
  if ("error" in split) return { brandedSplit: split };
  const { branded, nonBranded, ...rest } = split;
  return { branded, nonBranded, ...rest };
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
      section(() => gscQuery(client, { ...cur, dimensions: ["query"], rowLimit: QUERY_ROW_LIMIT })),
      section(() => gscQuery(client, { ...prev, dimensions: ["query"], rowLimit: QUERY_ROW_LIMIT })),
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
          branded: isBranded(kw, client),
          gscPosition: row?.position ?? null,
          gscClicks: row?.clicks ?? 0,
          gscImpressions: row?.impressions ?? 0,
          liveRank: live?.clientRank ?? null,
          liveUrl: live?.clientUrl ?? null,
        };
      }),
    ),
  );

  // Latest saved audit, diffed against the most recent one from before the report month.
  const audit = await section(async () => {
    return monthlyAuditSection(
      latestAudit(client.slug),
      latestAuditBefore(client.slug, Date.parse(`${cur.startDate}T00:00:00Z`)),
    );
  });

  const gc = dataOf(gscCur);
  const gp = dataOf(gscPrev);
  const gy = dataOf(gscYoy);
  const qPrev = dataOf(queriesPrev);
  const brandSplit =
    qPrev && queriesCur.ok
      ? (() => {
          const c = splitBranded(qCur, client);
          const p = splitBranded(qPrev, client);
          return {
            branded: compareSplit(c.branded, p.branded),
            nonBranded: compareSplit(c.nonBranded, p.nonBranded),
            brandedShareOfClicks: {
              current: c.branded.clicks + c.nonBranded.clicks ? Number(((c.branded.clicks / (c.branded.clicks + c.nonBranded.clicks)) * 100).toFixed(1)) : null,
              previous: p.branded.clicks + p.nonBranded.clicks ? Number(((p.branded.clicks / (p.branded.clicks + p.nonBranded.clicks)) * 100).toFixed(1)) : null,
            },
            queryRows: { current: qCur.length, previous: qPrev.length, limit: QUERY_ROW_LIMIT },
            note:
              QUERY_TOTALS_NOTE +
              (qCur.length >= QUERY_ROW_LIMIT || qPrev.length >= QUERY_ROW_LIMIT ? ` Search Console returned the row limit (${QUERY_ROW_LIMIT}) of queries for a month, so the long tail is missing too.` : ""),
            brandTerms: client.brandTerms,
          };
        })()
      : { error: !queriesCur.ok ? queriesCur.error : !queriesPrev.ok ? queriesPrev.error : "unknown" };
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
          ...brandSplitFields(brandSplit),
        }
      : { error: !gscCur.ok ? gscCur.error : !gscPrev.ok ? gscPrev.error : "unknown", ...brandSplitFields(brandSplit) },
    organicTraffic: ac && ap
      ? {
          sessions: { value: ac.sessions, change: pctChange(ac.sessions, ap.sessions) },
          users: { value: ac.users, change: pctChange(ac.users, ap.users) },
          engagementRate: { value: ac.engagementRate, change: Number((ac.engagementRate - ap.engagementRate).toFixed(1)) },
          keyEvents: { value: ac.keyEvents, change: pctChange(ac.keyEvents, ap.keyEvents) },
        }
      : { error: !gaCur.ok ? gaCur.error : !gaPrev.ok ? gaPrev.error : "unknown" },
    topQueries: markBranded(qCur.slice(0, 20), client),
    queryMovers: queriesCur.ok && queriesPrev.ok ? movers(queriesCur.data, queriesPrev.data, 10, (q) => isBranded(q, client)) : null,
    topPages: (dataOf(pagesCur) ?? []).slice(0, 15),
    pageMovers: pagesCur.ok && pagesPrev.ok ? movers(pagesCur.data, pagesPrev.data) : null,
    topLandingPages: landing,
    trackedKeywords: tracked,
    audit: audit.ok ? audit.data : { error: audit.error },
    dataSpendThisMonthUsd: Number(spentThisMonth(spendKeys(client)).toFixed(4)),
  };
}
