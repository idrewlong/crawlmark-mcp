import type { Client } from "../config.js";
import {
  analyzeRobots,
  hasNoindex,
  hreflangFlags,
  keyPagesMissingFromSitemaps,
  orphanFlags,
  orphanUrls,
  sampleFlags,
  schemaFlags,
  type HygieneFlag,
  type SampleResult,
  type SiteHygiene,
} from "../analysis/hygiene.js";
import { extractHygieneIsolated, parseSitemapIsolated } from "../analysis/extract-isolated.js";
import { checkHreflang, type HreflangEntry } from "../analysis/hreflang.js";
import { normalizeUrl } from "../analysis/findings.js";
import { validateJsonLd } from "../analysis/structured-data.js";
import { cacheKey, peekCache, putCache, TTL } from "../lib/cache.js";
import { latestCrawlTask } from "../lib/audits.js";
import { mapLimit } from "../lib/concurrency.js";
import { hostInDomains, restrictToClientDomains } from "../lib/url-guard.js";
import { onPageCrawlUrls, type CrawlUrls } from "../providers/dataforseo.js";
import { gscSitemaps } from "../providers/gsc.js";
import { fetchRaw, fetchRendered, type RawFetch } from "../providers/render.js";

/** Everything site_hygiene does stops after this long; sub-checks that did not finish are reported as not checked. */
export const HYGIENE_BUDGET_MS = 120_000;
export const SITEMAP_MAX_DEPTH = 2;
export const SITEMAP_MAX_CHILDREN = 50;
export const SITEMAP_SAMPLE = 50;
const SITEMAP_ROOT_LIMIT = 10;
const SITEMAP_URL_LIMIT = 200_000;
const CONCURRENCY = 4;
const HREFLANG_FETCH_LIMIT = 20;
const PAGE_LIMIT = 20;
/** A stored crawl older than this no longer describes the site, so orphans are not judged from it. */
export const ORPHAN_MAX_CRAWL_AGE_DAYS = 30;

export interface HygieneOptions {
  /** Pages to treat as key pages. Default: the client's keyPages. */
  urls?: string[];
  /** Skip the response cache. */
  fresh?: boolean;
  signal?: AbortSignal;
  /** GSC sitemap listing the audit already fetched; fetched here if omitted. */
  gscSitemapPaths?: string[];
  /** Key pages whose rendered DOM to use for JSON-LD/hreflang (read from the cache the render check filled); the rest use raw HTML. */
  renderedUrls?: Iterable<string>;
  /** Test hook: the site origin (default https://<client domain>). */
  origin?: string;
}

const isHtml = (ct: string | null) => ct == null || /html/i.test(ct);

/** Pick `n` URLs spread evenly over the list, so the same sitemap gives the same sample. */
export function evenSample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]!);
}

export async function siteHygiene(client: Client, opts: HygieneOptions = {}): Promise<SiteHygiene> {
  const budget = AbortSignal.timeout(HYGIENE_BUDGET_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, budget]) : budget;
  const refresh = opts.fresh ?? true;
  const get = (url: string): Promise<RawFetch> => fetchRaw(url, { refresh, signal });
  const keyPages = (opts.urls?.length ? opts.urls : client.keyPages).slice(0, PAGE_LIMIT);
  const origin = opts.origin ?? `https://${client.domain}`;
  const restricted = restrictToClientDomains();
  const onClientHost = (u: string) => {
    try {
      return hostInDomains(new URL(u).hostname, [client.domain]);
    } catch {
      return false;
    }
  };

  const flags: HygieneFlag[] = [];
  const checked: string[] = [];
  const notes: string[] = [
    "Every fetch goes through the guarded fetch (GET, size-capped); sitemap URLs are checked with GET, not HEAD.",
    "Structured data validation is basic (a small table of required properties), not Google's Rich Results Test.",
  ];

  // ---------------------------------------------------------------- robots.txt
  let robots: SiteHygiene["robots"];
  let siteOrigin = origin;
  let robotsSitemaps: string[] = [];
  try {
    const r = await get(`${origin}/robots.txt`);
    siteOrigin = new URL(r.finalUrl).origin;
    const a = analyzeRobots(r.finalUrl, { status: r.status, contentType: r.contentType, text: r.html }, keyPages);
    robots = a.robots;
    robotsSitemaps = a.robots.sitemaps;
    flags.push(...a.flags);
    checked.push("site:robots");
    if (r.truncated) notes.push("robots.txt was cut at the 5 MB cap.");
  } catch (err) {
    robots = { error: (err as Error).message };
  }

  // ------------------------------------------------------------------ sitemaps
  let gscPaths = opts.gscSitemapPaths;
  if (!gscPaths) {
    try {
      gscPaths = (await gscSitemaps(client)).flatMap((s) => (s.path ? [s.path] : []));
    } catch {
      gscPaths = []; // GSC not configured or failed: robots.txt is the other source
    }
  }
  const sitemapUrlSet = new Set<string>();
  const lastmods = new Map<string, number>();
  let sitemaps: SiteHygiene["sitemaps"];
  let sitemapsComplete = false;
  try {
    const seen = new Set<string>();
    let roots = [...robotsSitemaps, ...gscPaths].filter((u) => {
      const k = normalizeUrl(u);
      if (seen.has(k) || !onClientHost(u)) return false;
      seen.add(k);
      return true;
    });
    let fallback: string | null = null;
    if (roots.length === 0) {
      fallback = `${siteOrigin}/sitemap.xml`;
      roots = [fallback];
      notes.push("No sitemap listed in robots.txt or Search Console; tried /sitemap.xml.");
    }
    if (roots.length > SITEMAP_ROOT_LIMIT) notes.push(`Only the first ${SITEMAP_ROOT_LIMIT} listed sitemaps were followed.`);

    const files: { url: string; kind?: "index" | "urlset"; urls?: number; error?: string }[] = [];
    let complete = true;
    let totalLocs = 0;
    let children = 0;
    let level = roots.slice(0, SITEMAP_ROOT_LIMIT).map((u) => ({ url: u }));
    if (roots.length > SITEMAP_ROOT_LIMIT) complete = false;
    for (let depth = 0; depth <= SITEMAP_MAX_DEPTH && level.length; depth++) {
      const next: { url: string }[] = [];
      const results = await mapLimit(level, CONCURRENCY, async (f) => {
        try {
          const r = await get(f.url);
          if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
          if (r.truncated) throw new Error("larger than the 5 MB cap (after decompression)");
          return { f, parsed: await parseSitemapIsolated(r.html) };
        } catch (err) {
          return { f, error: (err as Error).message };
        }
      });
      for (const r of results) {
        if ("error" in r) {
          files.push({ url: r.f.url, error: r.error });
          complete = false;
        } else if (r.parsed.kind === "index") {
          files.push({ url: r.f.url, kind: "index", urls: r.parsed.locs.length });
          for (const loc of r.parsed.locs) {
            if (!onClientHost(loc)) continue;
            if (depth === SITEMAP_MAX_DEPTH || children >= SITEMAP_MAX_CHILDREN) {
              complete = false;
              continue;
            }
            children++;
            next.push({ url: loc });
          }
        } else {
          files.push({ url: r.f.url, kind: "urlset", urls: r.parsed.locs.length });
          totalLocs += r.parsed.locs.length;
          for (const [loc, ms] of Object.entries(r.parsed.lastmods)) lastmods.set(loc, ms);
          for (const loc of r.parsed.locs) {
            if (sitemapUrlSet.size >= SITEMAP_URL_LIMIT) {
              complete = false;
              break;
            }
            sitemapUrlSet.add(loc);
          }
        }
      }
      level = next;
    }
    if (!complete) notes.push("The sitemap URL set is partial (a cap was reached or a sitemap could not be read), so 'key page not in sitemap' and orphan checks were skipped.");
    const anyUrlset = files.some((f) => f.kind === "urlset");
    sitemapsComplete = complete && anyUrlset;

    const candidates = [...sitemapUrlSet].filter(onClientHost);
    const sampled: SampleResult[] = [];
    const sampleErrors: { url: string; error: string }[] = [];
    await mapLimit(evenSample(candidates, SITEMAP_SAMPLE), CONCURRENCY, async (url) => {
      try {
        const r = await get(url);
        let noindex = hasNoindex(r.xRobotsTag);
        let parsed = true;
        let noindexSource: SampleResult["noindexSource"] = noindex ? "x-robots-tag" : undefined;
        if (!noindex && r.status === 200 && isHtml(r.contentType)) {
          try {
            const page = await extractHygieneIsolated(r.html, r.finalUrl);
            if (hasNoindex(page.robots)) {
              noindex = true;
              noindexSource = "meta robots";
            }
          } catch {
            parsed = false; // the status and redirect flags stand, but the noindex check did not run
          }
        }
        sampled.push({ url, status: r.status, finalUrl: r.finalUrl, redirects: r.redirects, noindex, ...(noindexSource ? { noindexSource } : {}) });
        // A 200 HTML page whose markup could not be parsed was not checked for meta noindex, so it cannot clear a sitemap-noindex finding.
        if (parsed || noindex) checked.push(normalizeUrl(url));
        else sampleErrors.push({ url, error: "HTML could not be parsed; meta robots not checked" });
      } catch (err) {
        sampleErrors.push({ url, error: (err as Error).message });
      }
    });
    sampled.sort((a, b) => a.url.localeCompare(b.url));
    flags.push(...sampleFlags(sampled));

    if (sitemapsComplete) {
      flags.push(...keyPagesMissingFromSitemaps(keyPages, sitemapUrlSet));
      checked.push("site:sitemap-urls");
    } else if (!anyUrlset && fallback) {
      notes.push("No sitemap was found at all; 'key page not in sitemap' was not evaluated.");
    }
    sitemaps = {
      sources: { robots: robotsSitemaps, gsc: gscPaths, fallback },
      files,
      totalUrls: totalLocs,
      complete: sitemapsComplete,
      sampled,
      sampleErrors,
    };
  } catch (err) {
    sitemaps = { error: (err as Error).message };
  }

  // ----------------------------------------------- structured data and hreflang
  const rendered = new Set([...(opts.renderedUrls ?? [])].map(normalizeUrl));
  const sdPages: Extract<SiteHygiene["structuredData"], { pages: unknown }>["pages"] = [];
  const sdErrors: { url: string; error: string }[] = [];
  const hlPages: Extract<SiteHygiene["hreflang"], { pages: unknown }>["pages"] = [];
  const hlErrors: { url: string; error: string }[] = [];
  const alternateCache = new Map<string, HreflangEntry[] | null>();

  await mapLimit(keyPages, CONCURRENCY, async (url) => {
    let source: "rendered" | "raw" = "raw";
    let html: string | undefined;
    let finalUrl = url;
    if (rendered.has(normalizeUrl(url))) {
      try {
        const r = await fetchRendered(url, { refresh: false, signal });
        if (r.status == null || r.status < 400) {
          html = r.html;
          finalUrl = r.finalUrl;
          source = "rendered";
        }
      } catch {
        /* fall back to the raw HTML below */
      }
    }
    try {
      if (html === undefined) {
        const r = await get(url);
        if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
        if (!isHtml(r.contentType)) throw new Error(`not HTML (${r.contentType})`);
        html = r.html;
        finalUrl = r.finalUrl;
      }
      const page = await extractHygieneIsolated(html, finalUrl);

      const sd = validateJsonLd(page.jsonLd);
      sdPages.push({ url, source, blocks: sd.blocks, types: sd.types, issues: sd.issues });
      flags.push(...schemaFlags(url, sd));
      checked.push(`site:schema ${normalizeUrl(url)}`);

      // hreflang: fetch each distinct alternate other than the page itself (max 20), read its own hreflang set.
      const selfKeys = new Set([normalizeUrl(url), normalizeUrl(finalUrl), ...(page.canonical ? [normalizeUrl(page.canonical)] : [])]);
      const targets = [...new Set(page.hreflang.map((e) => normalizeUrl(e.href)))].filter((k) => !selfKeys.has(k));
      const hrefByKey = new Map(page.hreflang.map((e) => [normalizeUrl(e.href), e.href]));
      const toFetch = targets.slice(0, HREFLANG_FETCH_LIMIT);
      let complete = targets.length <= HREFLANG_FETCH_LIMIT;
      for (const k of toFetch) {
        const href = hrefByKey.get(k)!;
        if (alternateCache.has(k)) {
          if (alternateCache.get(k) === null) complete = false;
          continue;
        }
        if (restricted && !onClientHost(href)) {
          alternateCache.set(k, null);
          complete = false;
          continue;
        }
        try {
          const r = await get(href);
          if (r.status >= 400 || !isHtml(r.contentType)) throw new Error(`HTTP ${r.status}`);
          alternateCache.set(k, (await extractHygieneIsolated(r.html, r.finalUrl)).hreflang);
        } catch {
          alternateCache.set(k, null);
          complete = false;
        }
      }
      const alternates = new Map(toFetch.map((k) => [k, alternateCache.get(k) ?? null]));
      const issues = checkHreflang([url, finalUrl, ...(page.canonical ? [page.canonical] : [])], page.hreflang, alternates);
      hlPages.push({ url, alternates: page.hreflang.length, issues: issues.map((i) => i.rule) });
      flags.push(...hreflangFlags(url, issues));
      // A page whose alternates could not all be read cannot clear a reciprocity finding.
      if (complete) checked.push(`site:hreflang ${normalizeUrl(url)}`);
    } catch (err) {
      sdErrors.push({ url, error: (err as Error).message });
      hlErrors.push({ url, error: (err as Error).message });
    }
  });
  if (rendered.size) notes.push("Key pages with a rendering result were read from their rendered DOM; the others from raw HTML.");
  else notes.push("JSON-LD and hreflang were read from raw HTML (no rendering section in this run).");

  // -------------------------------------------------------------------- orphans
  let orphans: SiteHygiene["orphans"] = { available: false, reason: "not available: no full crawl" };
  const task = latestCrawlTask(client.slug);
  if (task) {
    try {
      const key = cacheKey("crawl-urls", task.taskId);
      const ageDays = (Date.now() - task.ranAt) / 86_400_000;
      if (!sitemapsComplete) {
        orphans = { available: false, reason: "not available: the sitemap URL set is incomplete" };
      } else if (ageDays > ORPHAN_MAX_CRAWL_AGE_DAYS) {
        orphans = { available: false, reason: `not available: the stored crawl is ${Math.floor(ageDays)} days old (limit ${ORPHAN_MAX_CRAWL_AGE_DAYS}); run a new full crawl` };
      } else {
        let crawl = peekCache<CrawlUrls>(key);
        if (!crawl) {
          crawl = await onPageCrawlUrls(client.slug, task.taskId, { signal }); // reads an existing task only; starts no crawl
          putCache(key, TTL.week, crawl);
        }
        if (!crawl.exhaustive) {
          orphans = { available: false, reason: "not available: the stored crawl hit its page cap, so unreached URLs cannot be called orphans" };
        } else {
          const list = orphanUrls(sitemapUrlSet, crawl.urls, { crawlAtMs: task.ranAt, lastmods });
          orphans = { available: true, crawlTaskId: task.taskId, crawledUrls: crawl.urls.length, orphanCount: list.length, orphans: list.slice(0, 100) };
          flags.push(...orphanFlags(list));
          checked.push("site:orphans");
          notes.push("Sitemap URLs with a <lastmod> after the crawl started were not counted as orphans.");
        }
      }
    } catch (err) {
      orphans = { available: false, reason: `not available: the stored crawl could not be read (${(err as Error).message})` };
    }
  }

  opts.signal?.throwIfAborted();
  if (budget.aborted) notes.push(`The ${HYGIENE_BUDGET_MS / 1000}s hygiene budget ran out; unfinished sub-checks are not counted as checked.`);
  return {
    origin: siteOrigin,
    robots,
    sitemaps,
    structuredData: { pages: sdPages.sort((a, b) => a.url.localeCompare(b.url)), errors: sdErrors },
    hreflang: { pages: hlPages.sort((a, b) => a.url.localeCompare(b.url)), errors: hlErrors },
    orphans,
    flags,
    checked: [...new Set(checked)],
    notes,
  };
}
