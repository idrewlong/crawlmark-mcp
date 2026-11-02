/**
 * The free, bounded local crawler (Phase 12 C1). Breadth-first from the start
 * URLs over the client's own host (plus subdomains when asked), politely:
 * robots.txt for the chosen user-agent group, Crawl-delay up to 10 s, else one
 * request per 250 ms per host; an honest user agent. Every request, including
 * each redirect hop, goes through the URL guard (fetchHop: DNS-pinned, private
 * addresses refused) and the RESTRICT_TO_CLIENT_DOMAINS check. HTML only, 2 MB
 * body cap, 15 s per request, page/depth/time caps. No JavaScript rendering.
 *
 * Network, parsing and the domain allowlist are injected (CrawlDeps), so tests
 * run it over an in-memory site.
 */
import { normalizeUrl } from "../analysis/findings.js";
import type { CrawlPage } from "../analysis/crawl.js";
import type { CrawlPageExtract } from "../analysis/crawl-parse.js";
import { hasNoindex } from "../analysis/hygiene.js";
import { crawlDelayFor, isAllowed, parseRobots, pathOf, rulesFor, type RobotsRule } from "../analysis/robots.js";
import { mapLimit } from "../lib/concurrency.js";
import { createLimiter, type Limiter } from "../lib/rate.js";
import { stripControl } from "../lib/terminal-text.js";
import { hostInDomains, UrlRefusedError } from "../lib/url-guard.js";
import { GOOGLEBOT_UA, type Hop, type HopOptions } from "./render.js";

export const CRAWL_LIMITS = {
  maxPages: { min: 1, max: 2000, default: 300 },
  maxDepth: { min: 1, max: 20, default: 10 },
  concurrency: { min: 1, max: 8, default: 4 },
} as const;
/** A whole crawl stops after this long (the pages fetched so far are kept; the crawl is then not exhaustive). */
export const CRAWL_TIME_LIMIT_MS = 10 * 60_000;
/** Spacing between requests to one host when robots.txt sets no Crawl-delay. */
export const MIN_SPACING_MS = 250;
/** Crawl-delay is honoured up to this many seconds. */
export const MAX_CRAWL_DELAY_S = 10;
export const MAX_REDIRECT_HOPS = 5;
/** Most URLs remembered from links; past this the crawl stops discovering and is not exhaustive (bounded memory). */
export const MAX_DISCOVERED = 50_000;
const MAX_TEXT = 300;
const ROBOTS_MAX_BYTES = 512 * 1024;

export type CrawlUserAgent = "crawlmark" | "googlebot";

export interface CrawlSettings {
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  userAgent: CrawlUserAgent;
  includeSubdomains: boolean;
  startUrls: string[];
}

export interface CrawlDeps {
  /** One guarded GET, no redirect following (src/providers/render.ts fetchHop). */
  fetchHop(url: string, opts: HopOptions): Promise<Hop>;
  /** Parse one HTML page (in the extraction worker in production). */
  extract(html: string, url: string): Promise<CrawlPageExtract>;
  /** Throws (UrlRefusedError) when RESTRICT_TO_CLIENT_DOMAINS refuses the URL; called for every URL before it is requested. */
  assertAllowed(url: string): void;
  /** Injectable for tests (the per-host spacing). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RobotsInfo {
  origin: string;
  /** HTTP status of robots.txt, or null when it couldn't be fetched. */
  status: number | null;
  /** "allow-all" (no file), "rules" (parsed), "blocked" (5xx or unreachable: nothing on this host is crawled, RFC 9309). */
  mode: "allow-all" | "rules" | "blocked";
  group: string;
  crawlDelaySeconds: number | null;
  sitemaps: string[];
}

/** What the sitemap phase did: URLs listed (in scope), those links hadn't reached, and how many were fetched or left out by the page cap or time. */
export interface SitemapPhase {
  listed: number;
  unreached: number;
  fetched: number;
  notFetched: number;
}

/** Context handed to the sitemap callback so it can find the site's sitemaps. */
export interface SitemapContext {
  robots: RobotsInfo[];
  userAgent: string;
}

export interface CrawlRun {
  ranAt: number;
  durationMs: number;
  exhaustive: boolean;
  stoppedBy: null | "maxPages" | "time" | "aborted";
  /** The sitemap phase (null when it didn't run: no sitemap URLs asked for, or the link phase ended by time or abort). */
  sitemapPhase: SitemapPhase | null;
  pages: CrawlPage[];
  robots: RobotsInfo[];
  notes: string[];
  userAgent: string;
}

export function crawlerUserAgent(version: string): string {
  return `crawlmark/${version} (+https://github.com/idrewlong/crawlmark-mcp)`;
}

/** The robots.txt group token for each user-agent choice. */
const ROBOTS_TOKEN: Record<CrawlUserAgent, string> = { crawlmark: "crawlmark", googlebot: "googlebot" };

const bareHost = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");

/**
 * In scope: the client's host (with or without www.), or any subdomain when includeSubdomains, on the
 * default port or one of `ports` (the start URLs' ports), so a link to example.com:6379 is never fetched.
 * `ports: "any"` skips the port check (used for the user's own start URLs, which the URL guard still checks).
 */
export function inCrawlScope(url: string, domain: string, includeSubdomains: boolean, ports: ReadonlySet<string> | "any" = new Set([""])): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (ports !== "any" && u.port !== "" && !ports.has(u.port)) return false;
    host = bareHost(u.hostname);
  } catch {
    return false;
  }
  const base = bareHost(domain).replace(/^www\./, "");
  if (includeSubdomains) return hostInDomains(host, [base]);
  return host === base || host === `www.${base}`;
}

const withoutHash = (u: string) => {
  const x = new URL(u);
  x.hash = "";
  return x.toString();
};
const text = (s: string | null | undefined) => {
  if (s == null) return null;
  const t = stripControl(s);
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t;
};
const errorText = (err: unknown) => stripControl(err instanceof Error ? err.message : String(err)).slice(0, 300);

interface RobotsState extends RobotsInfo {
  rules: RobotsRule[];
}

interface QueueItem {
  url: string;
  key: string;
  /** null: fetched in the sitemap phase. */
  depth: number | null;
}

export async function crawlSite(domain: string, settings: CrawlSettings, deps: CrawlDeps, opts: {
    signal?: AbortSignal;
    timeLimitMs?: number;
    version?: string;
    /**
     * Sitemap URLs to fetch after the link phase (runs unless that phase ended by time or abort). Gets the normalised URLs the links
     * reached. The returned URLs are fetched under the crawl's own robots rules, limits and guards; their links are not followed.
     */
    extraUrls?: (reached: ReadonlySet<string>, ctx: SitemapContext) => Promise<string[]>;
  } = {},
): Promise<CrawlRun> {
  const now = deps.now ?? Date.now;
  const started = now();
  const ua = settings.userAgent === "googlebot" ? GOOGLEBOT_UA : crawlerUserAgent(opts.version ?? "0.0.0");
  const token = ROBOTS_TOKEN[settings.userAgent];
  const timeLimit = AbortSignal.timeout(opts.timeLimitMs ?? CRAWL_TIME_LIMIT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeLimit]) : timeLimit;
  const notes: string[] = [];
  // The default port, plus whatever port the start URLs use (e.g. a local dev server).
  const ports = new Set<string>([""]);
  for (const u of settings.startUrls) {
    try {
      ports.add(new URL(u).port);
    } catch {
      /* not a URL: dropped below */
    }
  }
  const inScope = (u: string) => inCrawlScope(u, domain, settings.includeSubdomains, ports);

  let stoppedBy: CrawlRun["stoppedBy"] = null;
  let incomplete = false; // something was not read (error, parse failure, cap), so unreached URLs can't be judged
  const stopReason = (): CrawlRun["stoppedBy"] => (opts.signal?.aborted ? "aborted" : "time");
  const checkStop = () => {
    if (signal.aborted && !stoppedBy) stoppedBy = stopReason();
    return stoppedBy !== null;
  };

  // ------------------------------------------------------------------ robots.txt and per-host spacing
  const robots = new Map<string, Promise<RobotsState>>();
  const limiters = new Map<string, Limiter>();
  const limiterFor = (origin: string, delayS: number | null) => {
    let l = limiters.get(origin);
    if (!l) {
      const spacing = Math.max(MIN_SPACING_MS, Math.min(delayS ?? 0, MAX_CRAWL_DELAY_S) * 1000);
      l = createLimiter({ maxInFlight: settings.concurrency, minSpacingMs: spacing, ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.now ? { now: deps.now } : {}) });
      limiters.set(origin, l);
    }
    return l;
  };

  async function loadRobots(origin: string): Promise<RobotsState> {
    const base: RobotsState = { origin, status: null, mode: "allow-all", group: "none", crawlDelaySeconds: null, sitemaps: [], rules: [] };
    let url = `${origin}/robots.txt`;
    try {
      for (let hop = 0; ; hop++) {
        deps.assertAllowed(url);
        const r = await deps.fetchHop(url, { userAgent: ua, signal, body: "any", maxBytes: ROBOTS_MAX_BYTES });
        if (r.location) {
          if (hop >= MAX_REDIRECT_HOPS) throw new Error("robots.txt redirects more than 5 times");
          url = withoutHash(new URL(r.location, url).toString());
          continue;
        }
        base.status = r.status;
        if (r.status >= 500) {
          notes.push(`${origin}/robots.txt returned HTTP ${r.status}, so nothing on that host was crawled (RFC 9309 treats a server error as "disallow all").`);
          incomplete = true;
          return { ...base, mode: "blocked" };
        }
        if (r.status >= 400 || r.body === null) return base; // no robots.txt: everything allowed
        const file = parseRobots(r.body);
        const picked = rulesFor(file, token);
        const delay = crawlDelayFor(file, token);
        if (delay !== null && delay > MAX_CRAWL_DELAY_S) notes.push(`${origin}/robots.txt asks for a ${delay}s Crawl-delay; crawlmark waited ${MAX_CRAWL_DELAY_S}s between requests (its maximum).`);
        return { ...base, mode: "rules", group: picked.matched, crawlDelaySeconds: delay, sitemaps: file.sitemaps.map((s) => stripControl(s)).slice(0, 50), rules: picked.rules };
      }
    } catch (err) {
      // Aborted, or the guard refused the host: the caller records it (a refused host is never "blocked by robots").
      if (signal.aborted || err instanceof UrlRefusedError) throw err;
      notes.push(`${origin}/robots.txt couldn't be read (${errorText(err)}), so nothing on that host was crawled.`);
      incomplete = true;
      return { ...base, mode: "blocked" };
    }
  }
  const robotsFor = (url: string): Promise<RobotsState> => {
    const origin = new URL(url).origin;
    let p = robots.get(origin);
    if (!p) robots.set(origin, (p = loadRobots(origin)));
    return p;
  };
  const allowedByRobots = async (url: string) => {
    const r = await robotsFor(url);
    return r.mode === "allow-all" || (r.mode === "rules" && isAllowed(r.rules, pathOf(url)));
  };
  const get = async (url: string): Promise<Hop> => {
    const r = await robotsFor(url);
    return limiterFor(r.origin, r.crawlDelaySeconds).run(() => {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
      return deps.fetchHop(url, { userAgent: ua, signal });
    });
  };

  // ------------------------------------------------------------------ the breadth-first crawl
  const pages = new Map<string, CrawlPage>();
  /** Inlinks and the first linking page for every in-scope URL seen in a link. */
  const linkInfo = new Map<string, { inlinks: number; firstFrom: string }>();
  const queued = new Set<string>();
  let fetched = 0;
  let notFetched = 0;
  let depthCut = 0;
  let discoveryCapped = false;

  const blank = (url: string, depth: number | null): CrawlPage => ({
    url,
    depth,
    status: null,
    finalUrl: null,
    finalStatus: null,
    redirectChain: [],
    contentType: null,
    title: null,
    description: null,
    canonical: null,
    robots: null,
    noindex: false,
    h1Count: null,
    inlinks: 0,
    outlinks: 0,
    firstLinkedFrom: null,
    parsed: false,
    issues: [],
  });

  /** Read a final (non-redirect) response into `page` and queue its in-scope links at depth + 1. */
  async function readContent(page: CrawlPage, hop: Hop, next: QueueItem[], follow = true): Promise<void> {
    page.contentType = text(hop.contentType);
    const xrt = hop.xRobotsTag ? text(hop.xRobotsTag) : null;
    page.noindex = hasNoindex(xrt);
    if (xrt) page.robots = `x-robots-tag: ${xrt}`;
    const html = hop.contentType == null || /html/i.test(hop.contentType);
    // A server error or rate limit means the page wasn't really read: its links are unknown.
    if (hop.status >= 500 || hop.status === 429) {
      incomplete = true;
      notes.push(`Some pages answered with a server error or 429 (rate limited), so links on them weren't read and the crawl isn't complete.`);
      return;
    }
    if (!(hop.status >= 200 && hop.status < 300) || !html || hop.body === null) return;
    if (hop.truncated) {
      incomplete = true;
      notes.push(`${page.url} is larger than the 2 MB cap; only its first 2 MB were read.`);
    }
    let x: CrawlPageExtract;
    try {
      x = await deps.extract(hop.body, hop.url);
    } catch (err) {
      incomplete = true;
      page.error = `HTML could not be parsed (${errorText(err)})`;
      return;
    }
    page.parsed = true;
    page.title = text(x.title);
    page.description = text(x.description);
    page.canonical = text(x.canonical);
    if (x.robots) page.robots = [text(x.robots), page.robots].filter(Boolean).join("; ");
    page.noindex = page.noindex || hasNoindex(x.robots);
    page.h1Count = x.h1Count;
    page.outlinks = x.links.length;
    if (x.linksCapped) {
      incomplete = true;
      notes.push(`${page.url} has more links than crawlmark reads from one page (2,000).`);
    }
    // A sitemap-phase page is checked on its own: its links are neither followed nor counted as inlinks.
    for (const link of follow ? x.links : []) {
      if (!inScope(link)) continue;
      const key = normalizeUrl(link);
      const info = linkInfo.get(key);
      if (info) info.inlinks++;
      else if (linkInfo.size < MAX_DISCOVERED) linkInfo.set(key, { inlinks: 1, firstFrom: page.url });
      else {
        discoveryCapped = true;
        continue;
      }
      if (pages.has(key) || queued.has(key)) continue;
      const childDepth = (page.depth ?? 0) + 1;
      if (childDepth > settings.maxDepth) {
        depthCut++;
        continue;
      }
      queued.add(key);
      next.push({ url: link, key, depth: childDepth });
    }
  }

  async function visit(item: QueueItem, next: QueueItem[], sitemap = false): Promise<void> {
    if (pages.has(item.key) || checkStop()) return;
    const page = blank(item.url, item.depth);
    if (sitemap) page.fromSitemap = true;
    let allowed: boolean;
    try {
      deps.assertAllowed(item.url);
      allowed = await allowedByRobots(item.url);
    } catch (err) {
      if (signal.aborted) return void checkStop();
      incomplete = true;
      page.error = errorText(err);
      pages.set(item.key, page);
      return;
    }
    if (!allowed) {
      page.skipped = "robots";
      pages.set(item.key, page);
      notes.push(sitemap ? "robots.txt blocked some sitemap URLs; they were not fetched." : "robots.txt blocked some linked URLs; they were not fetched, so links that appear only on them were not seen.");
      return;
    }
    if (fetched >= settings.maxPages) {
      // Sitemap phase: counted by the caller as not fetched; the link phase's cap outcome is not changed.
      if (sitemap) return;
      notFetched++;
      if (!stoppedBy) stoppedBy = "maxPages";
      return;
    }
    fetched++;
    pages.set(item.key, page);
    let current = item.url;
    try {
      for (let hop = 0; ; hop++) {
        deps.assertAllowed(current);
        const r = await get(current);
        if (hop === 0) page.status = r.status;
        if (!r.location) {
          page.finalUrl = current;
          page.finalStatus = r.status;
          if (hop === 0) return await readContent(page, r, next, !sitemap);
          // The redirect target's own record holds its content (unless it was already crawled).
          const key = normalizeUrl(current);
          // Same normalised URL (e.g. /about → /about/): this record stands for both, so it holds the content.
          if (key === item.key) return await readContent(page, r, next, !sitemap);
          if (!pages.has(key)) {
            const target = blank(current, item.depth);
            target.status = r.status;
            target.finalUrl = current;
            target.finalStatus = r.status;
            target.fromRedirect = item.url;
            if (sitemap) target.fromSitemap = true;
            pages.set(key, target);
            queued.add(key);
            await readContent(target, r, next, !sitemap);
          }
          return;
        }
        if (hop >= MAX_REDIRECT_HOPS) throw new Error(`more than ${MAX_REDIRECT_HOPS} redirects`);
        const target = withoutHash(new URL(r.location, current).toString());
        page.redirectChain.push(text(target)!);
        current = target;
        if (!inScope(current)) {
          page.skipped = "off-site-redirect";
          return;
        }
        if (!(await allowedByRobots(current))) {
          page.skipped = "redirect-blocked-by-robots";
          return;
        }
      }
    } catch (err) {
      if (signal.aborted) {
        // Cut off by the time limit or a cancel: not a result for this URL.
        pages.delete(item.key);
        fetched--;
        checkStop();
        return;
      }
      incomplete = true;
      page.error = errorText(err);
    }
  }

  // Start URLs: de-duplicated, in scope only (the tool refuses others before the crawl starts).
  let level: QueueItem[] = [];
  for (const u of settings.startUrls) {
    const url = withoutHash(u);
    const key = normalizeUrl(url);
    if (!inScope(url) || queued.has(key)) continue;
    queued.add(key);
    level.push({ url, key, depth: 0 });
  }

  try {
    while (level.length && !checkStop()) {
      const next: QueueItem[] = [];
      await mapLimit(level, settings.concurrency, (item) => visit(item, next));
      if (stoppedBy === "maxPages") notFetched += next.length;
      if (stoppedBy) break;
      level = next;
    }
  } catch (err) {
    if (!signal.aborted) throw err;
    checkStop();
  }

  // ------------------------------------------------------------------ the sitemap phase
  // "exhaustive" describes the link phase only, so it is fixed before this phase runs.
  const exhaustive = stoppedBy === null && !incomplete && depthCut === 0 && !discoveryCapped;
  let sitemapPhase: SitemapPhase | null = null;
  if (opts.extraUrls && (stoppedBy === null || stoppedBy === "maxPages")) {
    const linkStop = stoppedBy;
    stoppedBy = null; // so checkStop() reflects only abort or time during this phase; restored below
    const reached = new Set<string>();
    for (const [key, p] of pages) {
      reached.add(key);
      if (p.finalUrl) reached.add(normalizeUrl(p.finalUrl));
      for (const u of p.redirectChain) reached.add(normalizeUrl(u));
    }
    const robotsNow = (await Promise.all([...robots.values()].map((r) => r.catch(() => null)))).filter((r): r is RobotsState => r !== null).map(({ rules: _rules, ...info }) => info);
    let listedUrls: string[] = [];
    try {
      listedUrls = await opts.extraUrls(reached, { robots: robotsNow, userAgent: ua });
    } catch (err) {
      if (!signal.aborted) notes.push(`Sitemap URLs weren't fetched: the sitemaps could not be read (${errorText(err)}).`);
    }
    if (!checkStop()) {
      const candidates: QueueItem[] = [];
      const seen = new Set<string>();
      for (const raw of listedUrls) {
        let url: string;
        try {
          url = withoutHash(raw);
        } catch {
          continue;
        }
        if (!inScope(url)) continue;
        const key = normalizeUrl(url);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ url, key, depth: null });
      }
      const unreached = candidates.filter((c) => !reached.has(c.key));
      const before = fetched;
      try {
        await mapLimit(unreached, settings.concurrency, (item) => visit(item, [], true));
      } catch (err) {
        if (!signal.aborted) throw err;
      }
      checkStop();
      const sitemapFetched = fetched - before;
      // A robots-blocked URL has a record but isn't "not fetched"; whatever has no record was left out by the page cap or time.
      const notFetched = unreached.filter((c) => !pages.has(c.key)).length;
      sitemapPhase = { listed: candidates.length, unreached: unreached.length, fetched: sitemapFetched, notFetched };
      if (sitemapFetched) notes.push(`Fetched ${sitemapFetched} sitemap URL${sitemapFetched === 1 ? "" : "s"} that links didn't reach.`);
      if (notFetched) notes.push(`${notFetched} more sitemap URL${notFetched === 1 ? "" : "s"} weren't fetched (page cap or time limit).`);
    }
    // A time limit reached in this phase leaves the link phase's outcome as it was; an abort is kept.
    if (stoppedBy !== "aborted") stoppedBy = linkStop;
  }

  // Inlinks and first linking page onto each record (a start URL has none unless something links to it).
  const list = [...pages.values()];
  for (const p of list) {
    const info = linkInfo.get(normalizeUrl(p.url));
    if (info) {
      p.inlinks = info.inlinks;
      p.firstLinkedFrom = info.firstFrom;
    }
  }
  list.sort((a, b) => (a.depth ?? Infinity) - (b.depth ?? Infinity) || a.url.localeCompare(b.url));

  if (stoppedBy === "maxPages") notes.push(`Stopped at the ${settings.maxPages}-page cap; ${notFetched} more URL${notFetched === 1 ? " was" : "s were"} found but not fetched.`);
  if (stoppedBy === "time") notes.push(`Stopped at the ${Math.round((opts.timeLimitMs ?? CRAWL_TIME_LIMIT_MS) / 1000)}s time limit.`);
  if (depthCut) notes.push(`${depthCut} link${depthCut === 1 ? "" : "s"} deeper than maxDepth ${settings.maxDepth} were not followed.`);
  if (discoveryCapped) notes.push(`More than ${MAX_DISCOVERED.toLocaleString("en-US")} distinct internal URLs were found; the rest were not followed.`);
  const robotsList = await Promise.all([...robots.values()].map((p) => p.catch(() => null)));
  return {
    ranAt: started,
    durationMs: now() - started,
    exhaustive,
    stoppedBy,
    sitemapPhase,
    pages: list,
    robots: robotsList.filter((r): r is RobotsState => r !== null).map(({ rules: _rules, ...info }) => info),
    notes: [...new Set(notes)],
    userAgent: ua,
  };
}
