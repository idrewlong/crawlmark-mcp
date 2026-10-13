/**
 * local_crawl / crawlmark-cli crawl / run_audit { localCrawl } (Phase 12 C1): run
 * the bounded crawler, analyse the pages, judge orphans against the sitemaps when
 * the crawl was exhaustive, and save it (newest 10 per client). Free: the only
 * requests go to the client's own site.
 */
import type { Client } from "../config.js";
import { analyzeCrawl, crawledUrls, topFindings, type CrawlAnalysis, type CrawlPage } from "../analysis/crawl.js";
import type { Finding } from "../analysis/findings.js";
import { orphanUrls } from "../analysis/hygiene.js";
import { newCrawlId, saveCrawl, type StoredCrawl } from "../lib/crawls.js";
import { CRAWL_LIMITS, CRAWL_TIME_LIMIT_MS, crawlSite, inCrawlScope, type CrawlDeps, type CrawlRun, type CrawlUserAgent } from "../providers/crawler.js";
import type { Hop, HopOptions, RawFetch } from "../providers/render.js";
import type { CollectedSitemaps } from "./site-hygiene.js";

/** Sitemap files are read up to the same 5 MB (after decompression) as site_hygiene. */
const SITEMAP_MAX_BYTES = 5 * 1024 * 1024;

export interface LocalCrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  concurrency?: number;
  userAgent?: CrawlUserAgent;
  includeSubdomains?: boolean;
  /** Default: the homepage plus the client's key pages. */
  startUrls?: string[];
  signal?: AbortSignal;
  timeLimitMs?: number;
}

export interface LocalCrawlDeps {
  crawl: CrawlDeps;
  /** The site's sitemaps (robots.txt Sitemap lines, Search Console, else /sitemap.xml), fetched with the crawl's user agent, or throws. Only called for an exhaustive crawl. */
  sitemaps(client: Client, robotsSitemaps: string[], opts: { userAgent: string; signal?: AbortSignal | undefined }): Promise<CollectedSitemaps>;
  save(c: StoredCrawl): void;
  version: string;
}

export type OrphanSummary = { available: true; count: number; urls: string[] } | { available: false; reason: string };

export interface LocalCrawlResult {
  crawlId: string;
  client: string;
  ranAt: string;
  durationMs: number;
  exhaustive: boolean;
  stoppedBy: CrawlRun["stoppedBy"];
  pages: number;
  summary: CrawlAnalysis["summary"] & { fetched: number; orphans: OrphanSummary };
  topIssues: Finding[];
  findingCount: number;
  settings: { maxPages: number; maxDepth: number; concurrency: number; userAgent: CrawlUserAgent; includeSubdomains: boolean; startUrls: string[]; seededFromHomepage: boolean };
  robots: CrawlRun["robots"];
  notes: string[];
}

export const TOP_ISSUES = 50;

/** What run_audit keeps as site.localCrawl: the result without the short list, plus every finding and checked key (they feed the audit diff). */
export type LocalCrawlAuditData = Omit<LocalCrawlResult, "topIssues"> & { findings: Finding[]; checked: string[] };

export function toAuditData(r: { result: LocalCrawlResult; findings: Finding[]; checked: string[] }): LocalCrawlAuditData {
  const { topIssues: _top, ...rest } = r.result;
  return { ...rest, findings: r.findings, checked: r.checked };
}
const clamp = (v: number | undefined, l: { min: number; max: number; default: number }) => Math.min(l.max, Math.max(l.min, Math.trunc(v ?? l.default)));

/** The crawl's settings with defaults and limits applied. Start URLs out of scope are dropped (the tool refuses them first). */
export function crawlSettings(client: Pick<Client, "domain" | "keyPages">, o: LocalCrawlOptions): LocalCrawlResult["settings"] {
  const includeSubdomains = o.includeSubdomains ?? false;
  const starts = o.startUrls?.length ? o.startUrls : [`https://${client.domain}/`, ...client.keyPages];
  const startUrls = [...new Set(starts)].filter((u) => inCrawlScope(u, client.domain, includeSubdomains, "any")).slice(0, 50);
  return {
    maxPages: clamp(o.maxPages, CRAWL_LIMITS.maxPages),
    maxDepth: clamp(o.maxDepth, CRAWL_LIMITS.maxDepth),
    concurrency: clamp(o.concurrency, CRAWL_LIMITS.concurrency),
    userAgent: o.userAgent ?? "crawlmark",
    includeSubdomains,
    startUrls,
    // Orphans are judged only from a crawl that started at the homepage: other seeds can't reach the whole site.
    seededFromHomepage: startUrls.some((u) => {
      try {
        return new URL(u).pathname === "/";
      } catch {
        return false;
      }
    }),
  };
}

export async function runLocalCrawl(client: Client, o: LocalCrawlOptions, deps: LocalCrawlDeps): Promise<{ result: LocalCrawlResult; findings: Finding[]; checked: string[] }> {
  const settings = crawlSettings(client, o);
  if (!settings.startUrls.length) throw new Error(`No start URL is on ${client.domain}; pass startUrls on the client's own host.`);
  const run = await crawlSite(client.domain, settings, deps.crawl, { signal: o.signal, timeLimitMs: o.timeLimitMs ?? CRAWL_TIME_LIMIT_MS, version: deps.version });
  const analysis = analyzeCrawl(run.pages, { exhaustive: run.exhaustive });
  const notes = [...run.notes];

  let orphans: OrphanSummary;
  if (!settings.seededFromHomepage) {
    orphans = { available: false, reason: "not available: the crawl didn't start at the homepage, so unreached URLs can't be called orphans" };
  } else if (!run.exhaustive) {
    orphans = { available: false, reason: `not available: the crawl was not exhaustive (${run.stoppedBy ? `stopped by ${run.stoppedBy}` : "some URLs could not be read"}), so unreached URLs can't be called orphans` };
  } else {
    try {
      const robotsSitemaps = run.robots.flatMap((r) => r.sitemaps);
      const sm = await deps.sitemaps(client, robotsSitemaps, { userAgent: run.userAgent, signal: o.signal });
      if (!sm.complete) orphans = { available: false, reason: "not available: the sitemap URL set is incomplete" };
      else {
        const list = orphanUrls(sm.urls, crawledUrls(run.pages), { crawlAtMs: run.ranAt, lastmods: sm.lastmods });
        orphans = { available: true, count: list.length, urls: list.slice(0, 50) };
        notes.push("Orphans are sitemap URLs the crawl never reached through links. site_hygiene and run_audit report them as findings from this crawl.");
      }
    } catch (err) {
      o.signal?.throwIfAborted();
      orphans = { available: false, reason: `not available: the sitemaps could not be read (${(err as Error).message})` };
    }
  }

  const fetched = run.pages.filter((p: CrawlPage) => p.status !== null).length;
  const crawlId = newCrawlId(run.ranAt);
  const summary = { ...analysis.summary, fetched, orphans };
  deps.save({ id: crawlId, client: client.slug, ranAt: run.ranAt, settings: { ...settings, userAgentString: run.userAgent }, summary, exhaustive: run.exhaustive, pages: run.pages });
  return {
    result: {
      crawlId,
      client: client.slug,
      ranAt: new Date(run.ranAt).toISOString(),
      durationMs: run.durationMs,
      exhaustive: run.exhaustive,
      stoppedBy: run.stoppedBy,
      pages: run.pages.length,
      summary,
      topIssues: topFindings(analysis.findings, TOP_ISSUES),
      findingCount: analysis.findings.length,
      settings,
      robots: run.robots,
      notes,
    },
    findings: analysis.findings,
    checked: analysis.checked,
  };
}

/**
 * GET a sitemap with the crawl's own user agent and the same guard per hop as the crawl (not fetchRaw,
 * which sends Googlebot's). Every hop must stay on the client's host (SEC-3) and pass the domain allowlist.
 */
export function sitemapFetcher(o: {
  fetchHop: (url: string, opts: HopOptions) => Promise<Hop>;
  userAgent: string;
  signal?: AbortSignal | undefined;
  onClientHost: (url: string) => boolean;
  assertAllowed: (url: string) => unknown;
}): (url: string) => Promise<RawFetch> {
  return async (start) => {
    let url = start;
    for (let redirects = 0; ; redirects++) {
      if (!o.onClientHost(url)) throw new Error(`the sitemap ${start} redirects off the client's site`);
      o.assertAllowed(url);
      const r = await o.fetchHop(url, { userAgent: o.userAgent, signal: o.signal, body: "any", maxBytes: SITEMAP_MAX_BYTES, timeoutMs: 30_000 });
      if (!r.location) return { status: r.status, finalUrl: url, redirects, contentType: r.contentType, xRobotsTag: r.xRobotsTag, truncated: r.truncated, html: r.body ?? "" };
      if (redirects >= 5) throw new Error(`Too many redirects fetching ${start}`);
      url = new URL(r.location, url).toString();
    }
  };
}

/** The real dependencies: guarded fetchHop, the extraction worker, RESTRICT_TO_CLIENT_DOMAINS, sitemaps via the guarded raw fetch. */
export async function loadLocalCrawlDeps(): Promise<LocalCrawlDeps> {
  const [{ fetchHop }, { extractCrawlIsolated }, guard, { loadRegistry }, { packageVersion }, hygiene, { gscSitemaps }] = await Promise.all([
    import("../providers/render.js"),
    import("../analysis/extract-isolated.js"),
    import("../lib/url-guard.js"),
    import("../clients.js"),
    import("../lib/entry.js"),
    import("./site-hygiene.js"),
    import("../providers/gsc.js"),
  ]);
  // Read once per crawl: with RESTRICT_TO_CLIENT_DOMAINS on, every URL (start, link, redirect hop) must be on a client domain.
  const domains = guard.restrictToClientDomains() ? (await loadRegistry()).clients.map((c) => c.domain) : null;
  return {
    crawl: {
      fetchHop,
      extract: (html, url) => extractCrawlIsolated(html, url),
      assertAllowed: (url) => {
        if (domains) guard.assertOnClientDomain(new URL(url).hostname, domains);
      },
    },
    sitemaps: async (client, robotsSitemaps, { userAgent, signal }) => {
      let gsc: string[] = [];
      try {
        gsc = (await gscSitemaps(client)).flatMap((s) => (s.path ? [s.path] : []));
      } catch {
        /* Google not set up: robots.txt and /sitemap.xml are the sources */
      }
      const onClientHost = (u: string) => {
        try {
          return guard.hostInDomains(new URL(u).hostname, [client.domain]) && (!domains || guard.hostInDomains(new URL(u).hostname, domains));
        } catch {
          return false;
        }
      };
      const get = sitemapFetcher({ fetchHop, userAgent, signal, onClientHost, assertAllowed: (u) => domains && guard.assertOnClientDomain(new URL(u).hostname, domains) });
      return hygiene.collectSitemaps({ roots: [...robotsSitemaps, ...gsc], siteOrigin: `https://${client.domain}`, get, onClientHost, notes: [] });
    },
    save: saveCrawl,
    // packageVersion wants a module directly in src/ or dist/; this file is one level down.
    version: packageVersion(new URL("../index.js", import.meta.url).href),
  };
}
