/**
 * Release 0.5.0: Content by publish year (C4 content_by_year; Y2). Pages from the newest saved local crawl (never a new
 * crawl) grouped by the year each page says it was published, with the Search Console clicks and impressions the page
 * earned in the report's current range. A sitemap lastmod is not a publish date (decision C-D2).
 */
import type { CrawlPage } from "../../analysis/crawl.js";
import { cliHint } from "../../lib/cli-hint.js";
import { groupOf } from "../../lib/page-groups.js";
import type { ContentByYearData, ContentYearRow } from "../report-types.js";
import type { SectionSpec } from "../templates/schema.js";
import { SectionUnavailableError } from "../templates/run.js";
import type { YearlyCtx } from "./context.js";

/** Search Console rows asked for: the API's per-request maximum, so every crawled page can find its row. */
const PAGE_ROW_LIMIT = 25_000;
const DEFAULT_MAX_YEARS = 10;
const STALE_AFTER_DAYS = 90;
const DAY_MS = 86_400_000;
const UNKNOWN = "Unknown";

const r1 = (n: number) => Number(n.toFixed(1));

/** A key that lets a crawled URL and a Search Console URL meet: no scheme, no `www.`, lower-case host, no trailing slash or fragment. */
function joinKey(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.host.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return raw.trim().replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

interface Acc {
  pages: number;
  clicks: number;
  impressions: number;
}
const empty = (): Acc => ({ pages: 0, clicks: 0, impressions: 0 });
const add = (a: Acc, b: Acc) => {
  a.pages += b.pages;
  a.clicks += b.clicks;
  a.impressions += b.impressions;
};

export async function contentByYear(s: Extract<SectionSpec, { type: "content_by_year" }>, ctx: YearlyCtx): Promise<ContentByYearData> {
  const { client } = ctx;
  const crawl = ctx.deps.latestLocalCrawl(client.slug);
  if (!crawl) throw new SectionUnavailableError(`no saved local crawl for ${client.domain} yet (run ${cliHint()} crawl, free)`);

  // Parsed HTML pages that answered 200, once per address (a crawl can hold /a and /a/).
  const seen = new Set<string>();
  const counted: CrawlPage[] = [];
  for (const p of crawl.pages) {
    if (!p.parsed || p.status !== 200) continue;
    const key = joinKey(p.url);
    if (seen.has(key)) continue;
    seen.add(key);
    counted.push(p);
  }
  if (counted.length && !counted.some((p) => p.published !== undefined)) {
    throw new SectionUnavailableError(`the newest saved crawl was made before publish dates were collected; run ${cliHint()} crawl again`);
  }

  const wanted = s.group?.trim().toLowerCase();
  const considered = wanted === undefined ? counted : counted.filter((p) => groupOf(p.url, client.pageGroups).toLowerCase() === wanted);

  // Search Console clicks for the current range, joined by address. Stored history answers this itself when it covers the range.
  const cur = ctx.period.current;
  const gscRows = considered.length
    ? await ctx.once(`cby:pages:${cur.startDate}:${cur.endDate}`, () => ctx.deps.gscQuery(client, { ...cur, dimensions: ["page"], rowLimit: PAGE_ROW_LIMIT }))
    : [];
  const byKey = new Map<string, { clicks: number; impressions: number }>();
  for (const r of gscRows) {
    const url = r.keys[0];
    if (!url) continue;
    const key = joinKey(url);
    const had = byKey.get(key) ?? { clicks: 0, impressions: 0 };
    byKey.set(key, { clicks: had.clicks + r.clicks, impressions: had.impressions + r.impressions });
  }

  const sources = { jsonld: 0, meta: 0, url: 0, none: 0 };
  const years = new Map<string, Acc>();
  for (const p of considered) {
    const published = p.published ?? null;
    sources[published ? published.source : "none"]++;
    const year = published ? published.date.slice(0, 4) : UNKNOWN;
    if (published && s.minYear !== undefined && Number(year) < s.minYear) continue;
    const hit = byKey.get(joinKey(p.url));
    add(years.get(year) ?? years.set(year, empty()).get(year)!, { pages: 1, clicks: hit?.clicks ?? 0, impressions: hit?.impressions ?? 0 });
  }

  // Newest first; years past the newest maxYears - 1 fold into "<oldest kept - 1> and earlier".
  const dated = [...years.keys()].filter((y) => y !== UNKNOWN).sort((a, b) => Number(b) - Number(a));
  const maxYears = s.maxYears ?? DEFAULT_MAX_YEARS;
  const built: { year: string; acc: Acc }[] = [];
  if (dated.length <= maxYears) {
    for (const y of dated) built.push({ year: y, acc: years.get(y)! });
  } else {
    const kept = dated.slice(0, maxYears - 1);
    for (const y of kept) built.push({ year: y, acc: years.get(y)! });
    const folded = empty();
    for (const y of dated.slice(maxYears - 1)) add(folded, years.get(y)!);
    built.push({ year: `${Number(kept[kept.length - 1]) - 1} and earlier`, acc: folded });
  }
  if (years.has(UNKNOWN)) built.push({ year: UNKNOWN, acc: years.get(UNKNOWN)! });

  const totalClicks = built.reduce((a, r) => a + r.acc.clicks, 0);
  const rows: ContentYearRow[] = built.map(({ year, acc }) => ({
    year,
    pages: acc.pages,
    clicks: acc.clicks,
    impressions: acc.impressions,
    clicksShare: totalClicks > 0 ? r1((acc.clicks / totalClicks) * 100) : 0,
    clicksPerPage: r1(acc.clicks / acc.pages),
  }));

  const ageDays = Math.floor((ctx.today.getTime() - crawl.ranAt) / DAY_MS);
  return {
    crawlId: crawl.id,
    crawledAt: new Date(crawl.ranAt).toISOString(),
    group: s.group?.trim() || null,
    pagesConsidered: considered.length,
    rows,
    sources,
    staleDays: ageDays > STALE_AFTER_DAYS ? ageDays : null,
  };
}
