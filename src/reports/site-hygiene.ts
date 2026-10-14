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
  type LlmsFileInfo,
  type LlmsTxtResult,
  type SampleResult,
  type SiteHygiene,
} from "../analysis/hygiene.js";
import { extractHygieneIsolated, parseSitemapIsolated } from "../analysis/extract-isolated.js";
import { checkHreflang, mergeHreflang, parseLinkHeader, type HreflangEntry, type HreflangSource } from "../analysis/hreflang.js";
import { analyzeAiCrawlers } from "../analysis/ai-crawlers.js";
import { LLMS_TXT_KEY, llmsLinkKey, normalizeUrl } from "../analysis/findings.js";
import { parseLlmsTxt } from "../analysis/llms-txt.js";
import { validateJsonLd } from "../analysis/structured-data.js";
import { stripControl } from "../lib/terminal-text.js";
import { cacheKey, peekCache, putCache, TTL } from "../lib/cache.js";
import { latestCrawlTask } from "../lib/audits.js";
import { crawledUrls } from "../analysis/crawl.js";
import { latestCrawl, type StoredCrawl } from "../lib/crawls.js";
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
/** Most sitemap `xhtml:link` entries kept in memory per run; the rest are dropped and the run says so. */
export const SITEMAP_HREFLANG_LIMIT = 50_000;
const PAGE_LIMIT = 20;
/** Most same-host llms.txt links fetched to check for non-200s. */
export const LLMS_LINK_SAMPLE = 10;
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
  /** Test hook: cap on sitemap hreflang entries kept (default SITEMAP_HREFLANG_LIMIT). */
  sitemapHreflangLimit?: number;
  /** Test hook: the site origin (default https://<client domain>). */
  origin?: string;
}

const isHtml = (ct: string | null) => ct == null || /html/i.test(ct);

/** Pick `n` URLs spread evenly over the list, so the same sitemap gives the same sample. */
export function evenSample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]!);
}

export interface CollectedSitemaps {
  /** Every <loc> of every urlset read (up to the URL cap). */
  urls: Set<string>;
  lastmods: Map<string, number>;
  /** hreflang declared in sitemaps (`xhtml:link`), by normalized page URL. */
  hreflang: Map<string, HreflangEntry[]>;
  hreflangCapped: boolean;
  /** A sitemap file could not be read for a reason other than 404/410. */
  readFailed: boolean;
  /** Every listed sitemap was read within the caps and at least one urlset was found. */
  complete: boolean;
  anyUrlset: boolean;
  files: { url: string; kind?: "index" | "urlset"; urls?: number; error?: string }[];
  totalLocs: number;
  /** The /sitemap.xml tried when no sitemap was listed, else null. */
  fallback: string | null;
}

/**
 * Read the site's sitemaps: the listed roots (robots.txt and Search Console, on the client's host only),
 * else /sitemap.xml; indexes followed to SITEMAP_MAX_DEPTH and SITEMAP_MAX_CHILDREN. Shared by site_hygiene
 * and the local crawl's orphan check (Phase 12 C1). Notes are appended to `notes`.
 */
export async function collectSitemaps(o: {
  roots: string[];
  siteOrigin: string;
  get: (url: string) => Promise<RawFetch>;
  onClientHost: (url: string) => boolean;
  hreflangLimit?: number;
  notes: string[];
}): Promise<CollectedSitemaps> {
  const { get, onClientHost, notes } = o;
  const hreflangLimit = o.hreflangLimit ?? SITEMAP_HREFLANG_LIMIT;
  const sitemapUrlSet = new Set<string>();
  const lastmods = new Map<string, number>();
  const sitemapHreflang = new Map<string, HreflangEntry[]>();
  let sitemapHreflangCount = 0;
  let sitemapHreflangCapped = false;
  let sitemapReadFailed = false;
  const seen = new Set<string>();
  let roots = o.roots.filter((u) => {
    const k = normalizeUrl(u);
    if (seen.has(k) || !onClientHost(u)) return false;
    seen.add(k);
    return true;
  });
  let fallback: string | null = null;
  if (roots.length === 0) {
    fallback = `${o.siteOrigin}/sitemap.xml`;
    roots = [fallback];
    notes.push("No sitemap listed in robots.txt or Search Console; tried /sitemap.xml.");
  }
  if (roots.length > SITEMAP_ROOT_LIMIT) notes.push(`Only the first ${SITEMAP_ROOT_LIMIT} listed sitemaps were followed.`);

  const files: CollectedSitemaps["files"] = [];
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
        // A 404/410 means the file doesn't exist, which is the same every run (stale sitemaps listed in
        // robots.txt or Search Console are common). Only transient failures leave hreflang unverified.
        if (!/^HTTP (404|410)$/.test(r.error ?? "")) sitemapReadFailed = true;
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
        for (const [loc, list] of Object.entries(r.parsed.alternates ?? {})) {
          const k = normalizeUrl(loc);
          let kept = sitemapHreflang.get(k);
          for (const entry of list) {
            if (sitemapHreflangCount >= hreflangLimit) {
              sitemapHreflangCapped = true;
              break;
            }
            if (!kept) sitemapHreflang.set(k, (kept = []));
            kept.push(entry);
            sitemapHreflangCount++;
          }
        }
        for (const loc of r.parsed.locs) {
          // URLs on other hosts are never the client's pages (and never get fetched or inspected from here).
          if (!onClientHost(loc)) continue;
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
  if (sitemapHreflangCapped) notes.push(`Sitemap hreflang entries were capped at ${hreflangLimit}; hreflang findings that depend on sitemap declarations are not counted as checked.`);
  if (sitemapReadFailed) notes.push("A sitemap could not be read, so hreflang findings that depend on sitemap declarations are not counted as checked.");
  if (!complete) notes.push("The sitemap URL set is partial (a cap was reached or a sitemap could not be read), so 'key page not in sitemap' and orphan checks were skipped.");
  const anyUrlset = files.some((f) => f.kind === "urlset");
  return { urls: sitemapUrlSet, lastmods, hreflang: sitemapHreflang, hreflangCapped: sitemapHreflangCapped, readFailed: sitemapReadFailed, complete: complete && anyUrlset, anyUrlset, files, totalLocs, fallback };
}

export async function siteHygiene(client: Client, opts: HygieneOptions = {}): Promise<SiteHygiene> {
  const budget = AbortSignal.timeout(HYGIENE_BUDGET_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, budget]) : budget;
  const refresh = opts.fresh ?? true;
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
  // With RESTRICT_TO_CLIENT_DOMAINS, every hygiene fetch and each of its redirect hops stays on the client's domain.
  const get = (url: string, allowUrl?: (u: string) => boolean): Promise<RawFetch> =>
    fetchRaw(url, { refresh, signal, ...(allowUrl ? { allowUrl } : restricted ? { allowUrl: onClientHost } : {}) });

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
  let aiCrawlers: SiteHygiene["aiCrawlers"];
  try {
    const r = await get(`${origin}/robots.txt`);
    siteOrigin = new URL(r.finalUrl).origin;
    const fetched = { status: r.status, contentType: r.contentType, text: r.html };
    const a = analyzeRobots(r.finalUrl, fetched, keyPages);
    robots = a.robots;
    robotsSitemaps = a.robots.sitemaps;
    flags.push(...a.flags);
    const ai = analyzeAiCrawlers(r.finalUrl, a.file, a.robots, `${siteOrigin}/`, keyPages);
    aiCrawlers = ai.aiCrawlers;
    flags.push(...ai.flags);
    checked.push("site:robots");
    if (a.robots.truncated) notes.push("robots.txt is larger than 500 KiB; like Google (RFC 9309), only the first 500 KiB was read.");
  } catch (err) {
    robots = { error: (err as Error).message };
    aiCrawlers = { error: (err as Error).message };
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
  let sitemapUrlSet = new Set<string>();
  let lastmods = new Map<string, number>();
  /** hreflang declared in sitemaps (`xhtml:link`), by normalized page URL. Filled by the sitemap pass above; no extra fetches. */
  let sitemapHreflang = new Map<string, HreflangEntry[]>();
  let sitemapHreflangCapped = false;
  /** A sitemap file could not be read or parsed, so sitemap-declared hreflang may be missing from this run. */
  let sitemapReadFailed = false;
  let sitemaps: SiteHygiene["sitemaps"];
  let sitemapsComplete = false;
  try {
    const collected = await collectSitemaps({ roots: [...robotsSitemaps, ...gscPaths], siteOrigin, get, onClientHost, hreflangLimit: opts.sitemapHreflangLimit ?? SITEMAP_HREFLANG_LIMIT, notes });
    ({ urls: sitemapUrlSet, lastmods, hreflang: sitemapHreflang, hreflangCapped: sitemapHreflangCapped, readFailed: sitemapReadFailed, complete: sitemapsComplete } = collected);
    const { files, totalLocs, fallback, anyUrlset } = collected;

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
    sitemapReadFailed = true;
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
    let headerEntries: HreflangEntry[] = [];
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
        headerEntries = parseLinkHeader(r.link, r.finalUrl);
      }
      const page = await extractHygieneIsolated(html, finalUrl);

      const sd = validateJsonLd(page.jsonLd);
      sdPages.push({ url, source, blocks: sd.blocks, types: sd.types, issues: sd.issues });
      flags.push(...schemaFlags(url, sd));
      checked.push(`site:schema ${normalizeUrl(url)}`);

      // hreflang: fetch each distinct alternate other than the page itself (max 20), read its own hreflang set.
      const selfKeys = new Set([normalizeUrl(url), normalizeUrl(finalUrl), ...(page.canonical ? [normalizeUrl(page.canonical)] : [])]);
      const sitemapOf = (urls: string[]) => [...new Set(urls.map(normalizeUrl))].flatMap((k) => sitemapHreflang.get(k) ?? []);
      const { entries: own, conflicts } = mergeHreflang([
        { source: "html", entries: page.hreflang },
        { source: "sitemap", entries: sitemapOf([url, finalUrl, ...(page.canonical ? [page.canonical] : [])]) },
        { source: "header", entries: headerEntries },
      ]);
      const targets = [...new Set(own.map((e) => normalizeUrl(e.href)))].filter((k) => !selfKeys.has(k));
      const hrefByKey = new Map(own.map((e) => [normalizeUrl(e.href), e.href]));
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
          // The alternate's own set merges its HTML and Link header; the sitemap's entries for it are added below.
          alternateCache.set(k, [...(await extractHygieneIsolated(r.html, r.finalUrl)).hreflang, ...parseLinkHeader(r.link, r.finalUrl)]);
        } catch {
          alternateCache.set(k, null);
          complete = false;
        }
      }
      const alternates = new Map(
        toFetch.map((k) => {
          const fetched = alternateCache.get(k);
          return [k, fetched ? [...fetched, ...(sitemapHreflang.get(k) ?? [])] : null] as const;
        }),
      );
      const issues = checkHreflang([url, finalUrl, ...(page.canonical ? [page.canonical] : [])], own, alternates, conflicts);
      const sources: Partial<Record<HreflangSource, number>> = {};
      for (const e of own) for (const src of e.sources ?? []) sources[src] = (sources[src] ?? 0) + 1;
      hlPages.push({ url, alternates: own.length, issues: issues.map((i) => i.rule), sources });
      flags.push(...hreflangFlags(url, issues));
      // A page whose alternates could not all be read cannot clear a reciprocity finding.
      if (complete && !sitemapHreflangCapped && !sitemapReadFailed) checked.push(`site:hreflang ${normalizeUrl(url)}`);
    } catch (err) {
      sdErrors.push({ url, error: (err as Error).message });
      hlErrors.push({ url, error: (err as Error).message });
    }
  });
  if (rendered.size) notes.push("Key pages with a rendering result were read from their rendered DOM; the others from raw HTML.");
  else notes.push("JSON-LD and hreflang were read from raw HTML (no rendering section in this run).");
  notes.push("hreflang is merged from page HTML, sitemap xhtml:link entries and HTTP Link headers (headers are read from the raw fetch, so not for pages read from their rendered DOM).");

  // ------------------------------------------------------------------- llms.txt
  // Informational: llms.txt is a proposal Google says it doesn't use. A missing file is not a finding.
  let llmsTxt: SiteHygiene["llmsTxt"];
  if (!onClientHost(siteOrigin)) {
    // robots.txt redirected off the client's domain: llms.txt there isn't the client's file.
    llmsTxt = { error: `not checked: robots.txt redirected to ${new URL(siteOrigin).host}, which isn't on ${client.domain}` };
  } else {
    try {
      llmsTxt = await checkLlmsTxt({ siteOrigin, get, onClientHost, flags, checked, notes });
    } catch (err) {
      llmsTxt = { error: (err as Error).message };
    }
  }

  // -------------------------------------------------------------------- orphans
  // The newest exhaustive crawl within ORPHAN_MAX_CRAWL_AGE_DAYS decides: a local crawl (Phase 12 C1, free)
  // or the stored DataForSEO crawl. Neither is ever started here.
  let orphans: SiteHygiene["orphans"] = { available: false, reason: "not available: no full crawl" };
  const task = latestCrawlTask(client.slug);
  // Only a complete crawl that started at the homepage can say a sitemap URL is unlinked.
  const local = latestCrawl(client.slug, { exhaustiveOnly: true, seededFromHomepageOnly: true });
  const ageOf = (ranAt: number) => (Date.now() - ranAt) / 86_400_000;
  const useLocal = (crawl: StoredCrawl): SiteHygiene["orphans"] => {
    const ageDays = ageOf(crawl.ranAt);
    if (!sitemapsComplete) return { available: false, reason: "not available: the sitemap URL set is incomplete" };
    if (ageDays > ORPHAN_MAX_CRAWL_AGE_DAYS) {
      return { available: false, reason: `not available: the newest complete local crawl is ${Math.floor(ageDays)} days old (limit ${ORPHAN_MAX_CRAWL_AGE_DAYS}); run local_crawl again` };
    }
    const list = orphanUrls(sitemapUrlSet, crawledUrls(crawl.pages), { crawlAtMs: crawl.ranAt, lastmods });
    flags.push(...orphanFlags(list));
    checked.push("site:orphans");
    notes.push(`Orphans were judged from the local crawl ${crawl.id} (${new Date(crawl.ranAt).toISOString().slice(0, 10)}, complete).`);
    notes.push("Sitemap URLs with a <lastmod> after the crawl started were not counted as orphans.");
    return { available: true, source: "local", crawlId: crawl.id, crawledUrls: crawl.pages.length, orphanCount: list.length, orphans: list.slice(0, 100) };
  };
  if (local && (!task || local.ranAt >= task.ranAt)) {
    orphans = useLocal(local);
  } else if (task) {
    try {
      const key = cacheKey("crawl-urls", task.taskId);
      const ageDays = ageOf(task.ranAt);
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
    // The DataForSEO crawl couldn't be used, but an older complete local crawl can.
    if (!orphans.available && local && sitemapsComplete && ageOf(local.ranAt) <= ORPHAN_MAX_CRAWL_AGE_DAYS) {
      notes.push(`The stored DataForSEO crawl couldn't be used for orphans (${orphans.reason.replace(/^not available: /, "")}), so the local crawl was.`);
      orphans = useLocal(local);
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
    llmsTxt,
    aiCrawlers,
    flags,
    checked: [...new Set(checked)],
    notes,
  };
}

/** What a fetch says about an llms file: present, missing, or an error (thrown) for any other status. */
function llmsFileInfo(url: string, r: RawFetch): LlmsFileInfo {
  const base = { url, status: r.status, contentType: r.contentType ? stripControl(r.contentType).slice(0, 100) : null, bytes: Buffer.byteLength(r.html), truncated: r.truncated };
  if (r.status === 404 || r.status === 410) return { ...base, present: false };
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  // A site's catch-all page served at /llms.txt is not the file.
  if (/html/i.test(r.contentType ?? "") || /^\s*<(!doctype|html)/i.test(r.html)) return { ...base, present: false, note: "The URL returns an HTML page, not a text file." };
  return { ...base, present: true };
}

/**
 * The llms.txt check: /llms.txt (format against the llmstxt.org proposal, and up to LLMS_LINK_SAMPLE
 * same-host links checked for non-200s) and /llms-full.txt (presence only). Low findings only:
 * `llms-txt-malformed` and `llms-txt-broken-link`. Throws when /llms.txt can't be read (not checked).
 */
async function checkLlmsTxt(o: {
  siteOrigin: string;
  get: (url: string, allowUrl?: (u: string) => boolean) => Promise<RawFetch>;
  onClientHost: (url: string) => boolean;
  flags: HygieneFlag[];
  checked: string[];
  notes: string[];
}): Promise<LlmsTxtResult> {
  const url = `${o.siteOrigin}/llms.txt`;
  const r = await o.get(url);
  const info = llmsFileInfo(url, r);
  let fullTxt: LlmsTxtResult["llmsFullTxt"];
  const fullUrl = `${o.siteOrigin}/llms-full.txt`;
  try {
    fullTxt = llmsFileInfo(fullUrl, await o.get(fullUrl));
  } catch (err) {
    fullTxt = { url: fullUrl, error: (err as Error).message };
  }
  o.notes.push("llms.txt is a proposed standard (llmstxt.org) that Google says it doesn't use; it is reported for information, not scored.");
  if (!info.present) {
    o.checked.push(LLMS_TXT_KEY);
    return { llmsTxt: info, llmsFullTxt: fullTxt };
  }

  const { links, ...format } = parseLlmsTxt(r.html, r.finalUrl);
  if (r.truncated) o.notes.push("llms.txt was cut at the 5 MB cap, so its format was checked on the first 5 MB only.");
  if (format.issues.length) {
    o.flags.push({ rule: "llms-txt-malformed", url, severity: "low", title: "llms.txt does not follow the llmstxt.org format (informational)", evidence: format.issues.join(" ") });
  }
  o.checked.push(LLMS_TXT_KEY);

  const host = new URL(r.finalUrl).hostname.toLowerCase();
  // Links, and every redirect hop they take, stay on llms.txt's own host on the client's domain.
  const sameHostOnClient = (u: string) => {
    try {
      return new URL(u).hostname.toLowerCase() === host && o.onClientHost(u);
    } catch {
      return false;
    }
  };
  const sameHost = links.filter(sameHostOnClient);
  const sampled: { url: string; status: number; finalUrl: string }[] = [];
  const errors: { url: string; error: string }[] = [];
  await mapLimit(sameHost.slice(0, LLMS_LINK_SAMPLE), CONCURRENCY, async (link) => {
    try {
      const l = await o.get(link, sameHostOnClient);
      sampled.push({ url: link, status: l.status, finalUrl: l.finalUrl });
      if (l.status !== 200) o.flags.push({ rule: "llms-txt-broken-link", url: link, severity: "low", title: "llms.txt links to a URL that does not return 200 (informational)", evidence: `HTTP ${l.status}` });
      o.checked.push(llmsLinkKey(link));
    } catch (err) {
      errors.push({ url: link, error: (err as Error).message });
    }
  });
  sampled.sort((a, b) => a.url.localeCompare(b.url));
  if (sameHost.length > LLMS_LINK_SAMPLE) o.notes.push(`Only the first ${LLMS_LINK_SAMPLE} of ${sameHost.length} same-host llms.txt links were checked.`);
  return { llmsTxt: { ...info, format }, llmsFullTxt: fullTxt, links: { total: links.length, sameHost: sameHost.length, sampled, errors } };
}
