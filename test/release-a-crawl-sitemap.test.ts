/**
 * Release A, D6: the sitemap phase of the local crawl. An in-memory site (fake fetchHop, no network): a sitemap lists
 * 3 pages no link reaches, one of them disallowed by robots.txt.
 */
import { describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import { analyzeCrawl, crawledUrls, type CrawlPage } from "../src/analysis/crawl.js";
import { extractCrawlPage } from "../src/analysis/crawl-parse.js";
import { getCrawl, saveCrawl } from "../src/lib/crawls.js";
import { crawlSite, type CrawlDeps, type CrawlSettings } from "../src/providers/crawler.js";
import type { Hop, HopOptions } from "../src/providers/render.js";
import { runLocalCrawl, type LocalCrawlDeps } from "../src/reports/local-crawl.js";
import { registerCrawlTools } from "../src/tools/crawl.js";

const E = "https://example.com";
type Res = { status: number; body?: string; type?: string };
const doc = (title: string, links: string[] = [], desc = `About ${title}`) =>
  `<!doctype html><html><head><title>${title}</title>${desc ? `<meta name="description" content="${desc}">` : ""}</head><body><h1>${title}</h1>${links.map((l) => `<a href="${l}">x</a>`).join("")}</body></html>`;

const SITE: Record<string, Res> = {
  [`${E}/robots.txt`]: { status: 200, type: "text/plain", body: "User-agent: *\nDisallow: /private\n" },
  [`${E}/`]: { status: 200, body: doc("Home", ["/a"]) },
  [`${E}/a`]: { status: 200, body: doc("A") },
  // Unlinked sitemap pages. u1 has no description; u2 links to /only-from-u2, which must not be followed.
  [`${E}/u1`]: { status: 200, body: doc("U1", [], "") },
  [`${E}/u2`]: { status: 200, body: doc("U2", ["/only-from-u2", "/a"]) },
  [`${E}/only-from-u2`]: { status: 200, body: doc("Only from u2") },
  [`${E}/private/u3`]: { status: 200, body: doc("Private") },
};
const SITEMAP_URLS = [`${E}/`, `${E}/a`, `${E}/u1`, `${E}/u2`, `${E}/private/u3`];

function fakeSite(site = SITE) {
  const requests: string[] = [];
  const sleeps: number[] = [];
  const fetchHop = async (url: string, o: HopOptions): Promise<Hop> => {
    requests.push(url);
    const r = site[url] ?? { status: 404, body: doc("Not found") };
    const type = r.type ?? "text/html";
    return { url, status: r.status, location: null, contentType: type, xRobotsTag: null, body: o.body === "any" || /html/.test(type) ? (r.body ?? "") : null, truncated: false };
  };
  const deps: CrawlDeps = { fetchHop, extract: async (h, u) => extractCrawlPage(h, u), assertAllowed: () => undefined, sleep: async (ms) => void sleeps.push(ms) };
  return { deps, requests, sleeps };
}
const S = (o: Partial<CrawlSettings> = {}): CrawlSettings => ({ maxPages: 300, maxDepth: 10, concurrency: 1, userAgent: "crawlmark", includeSubdomains: false, startUrls: [`${E}/`], ...o });
const at = (pages: CrawlPage[], path: string) => pages.find((p) => p.url === `${E}${path}`);

const client = { slug: "example.com", domain: "example.com", name: "Example Co", keyPages: [], brandTerms: [] } as unknown as Client;
function localDeps(crawl: CrawlDeps, sitemapUrls = SITEMAP_URLS) {
  const calls: string[][] = [];
  const saved: { pages: CrawlPage[]; summary: unknown }[] = [];
  const deps: LocalCrawlDeps = {
    crawl,
    sitemaps: async (_c, roots) => {
      calls.push(roots);
      return { urls: new Set(sitemapUrls), lastmods: new Map(), hreflang: new Map(), hreflangCapped: false, readFailed: false, complete: true, anyUrlset: true, files: [], totalLocs: sitemapUrls.length, fallback: null };
    },
    save: (c) => void saved.push({ pages: c.pages, summary: c.summary }),
    version: "1.0.0",
  };
  return { deps, calls, saved };
}

describe("the sitemap phase (crawlSite)", () => {
  it("fetches unlinked sitemap pages with fromSitemap, depth null and on-page findings; robots-blocked ones are skipped", async () => {
    const { deps, requests } = fakeSite();
    let seen: ReadonlySet<string> | undefined;
    const run = await crawlSite("example.com", S(), deps, {
      extraUrls: async (reached) => {
        seen = reached;
        return SITEMAP_URLS;
      },
    });
    expect([...seen!].sort()).toEqual([E, `${E}/a`].sort()); // normalised: no trailing slash
    expect(at(run.pages, "/u1")).toMatchObject({ fromSitemap: true, depth: null, status: 200, inlinks: 0 });
    expect(at(run.pages, "/u2")).toMatchObject({ fromSitemap: true, depth: null, status: 200, outlinks: 2 });
    expect(at(run.pages, "/private/u3")).toMatchObject({ fromSitemap: true, skipped: "robots", status: null });
    expect(requests).not.toContain(`${E}/private/u3`);
    // Links on sitemap-phase pages are parsed but not followed, and add no inlinks.
    expect(requests).not.toContain(`${E}/only-from-u2`);
    expect(at(run.pages, "/a")!.inlinks).toBe(1);
    expect(run.sitemapPhase).toEqual({ listed: 5, unreached: 3, fetched: 2, notFetched: 0 });
    expect(run.notes).toContain("Fetched 2 sitemap URLs that links didn't reach.");
    expect(run.exhaustive).toBe(true);
    expect(run.stoppedBy).toBe(null);
    const an = analyzeCrawl(run.pages, { exhaustive: run.exhaustive });
    expect(an.findings.map((f) => `${f.rule} ${f.url.replace(E, "")}`)).toEqual(["missing-description /u1"]);
    // Depth-based output skips null depth.
    expect(an.summary.depthHistogram).toEqual({ "0": 1, "1": 1 });
  });

  it("respects the page cap and says how many were left out", async () => {
    const { deps } = fakeSite();
    const run = await crawlSite("example.com", S({ maxPages: 3 }), deps, { extraUrls: async () => SITEMAP_URLS });
    expect(run.pages.filter((p) => p.status !== null)).toHaveLength(3);
    expect(run.sitemapPhase).toMatchObject({ unreached: 3, fetched: 1, notFetched: 1 });
    expect(run.notes.join(" ")).toMatch(/1 more sitemap URL weren't fetched \(page cap or time limit\)/);
    // The cap reached in the sitemap phase doesn't change the link phase's outcome.
    expect(run.stoppedBy).toBe(null);
  });

  it("with the link phase already at the cap, fetches nothing and reports them all as not fetched", async () => {
    const { deps, requests } = fakeSite();
    const run = await crawlSite("example.com", S({ maxPages: 1 }), deps, { extraUrls: async () => SITEMAP_URLS });
    expect(run.stoppedBy).toBe("maxPages");
    expect(run.sitemapPhase).toMatchObject({ fetched: 0, notFetched: 3 }); // /a, /u1 and /u2 (the robots-blocked one has a record)
    expect(requests).not.toContain(`${E}/u1`);
  });

  it("skips the phase after an abort or the time limit", async () => {
    const { deps } = fakeSite();
    const c = new AbortController();
    c.abort();
    let called = false;
    const run = await crawlSite("example.com", S(), deps, { signal: c.signal, extraUrls: async () => ((called = true), SITEMAP_URLS) });
    expect(called).toBe(false);
    expect(run.sitemapPhase).toBe(null);
    expect(run.stoppedBy).toBe("aborted");
  });

  it("a failing sitemap read adds a note and leaves the crawl as it was", async () => {
    const { deps } = fakeSite();
    const run = await crawlSite("example.com", S(), deps, {
      extraUrls: async () => {
        throw new Error("sitemap down");
      },
    });
    expect(run.notes.join(" ")).toMatch(/Sitemap URLs weren't fetched: the sitemaps could not be read \(sitemap down\)/);
    expect(run.exhaustive).toBe(true);
    expect(run.pages).toHaveLength(2);
  });

  it("keeps the per-host spacing (Crawl-delay) for sitemap-phase requests", async () => {
    const site = { ...SITE, [`${E}/robots.txt`]: { status: 200, type: "text/plain", body: "User-agent: crawlmark\nCrawl-delay: 2\nDisallow: /private\n" } };
    const without = fakeSite(site);
    await crawlSite("example.com", S(), without.deps);
    const withPhase = fakeSite(site);
    await crawlSite("example.com", S(), withPhase.deps, { extraUrls: async () => SITEMAP_URLS });
    expect(withPhase.sleeps.length).toBeGreaterThan(without.sleeps.length);
    expect(Math.max(...withPhase.sleeps)).toBeGreaterThanOrEqual(1900);
    // every wait is a whole multiple of the 2 s Crawl-delay (the fake clock doesn't advance)
    expect(withPhase.sleeps.every((ms) => ms % 2000 <= 100 || ms % 2000 >= 1900)).toBe(true);
  });
});

describe("the sitemap phase (runLocalCrawl)", () => {
  it("fetches the unlinked pages, still counts all 3 as orphans, and reads the sitemaps once", async () => {
    const { deps: crawl, requests } = fakeSite();
    const { deps, calls, saved } = localDeps(crawl);
    const { result } = await runLocalCrawl(client, {}, deps);
    expect(calls).toHaveLength(1);
    expect(result.summary.sitemapPhase).toEqual({ listed: 5, unreached: 3, fetched: 2, notFetched: 0 });
    expect(result.summary.orphans).toMatchObject({ available: true, count: 3 });
    expect((result.summary.orphans as { urls: string[] }).urls.sort()).toEqual([`${E}/private/u3`, `${E}/u1`, `${E}/u2`].sort());
    expect(requests).toContain(`${E}/u1`);
    expect(result.summary.missingDescriptions).toBe(1);
    expect(result.exhaustive).toBe(true);
    expect(saved[0]!.pages.filter((p) => p.fromSitemap)).toHaveLength(3);
    expect(crawledUrls(saved[0]!.pages)).not.toContain(`${E}/u1`);
  });

  it("includeSitemapUrls false fetches none of them, and orphans still read the sitemaps", async () => {
    const { deps: crawl, requests } = fakeSite();
    const { deps, calls } = localDeps(crawl);
    const { result } = await runLocalCrawl(client, { includeSitemapUrls: false }, deps);
    expect(requests).not.toContain(`${E}/u1`);
    expect(result.summary.sitemapPhase).toBe(null);
    expect(result.summary.orphans).toMatchObject({ available: true, count: 3 });
    expect(calls).toHaveLength(1);
  });

  it("doesn't widen a crawl the user narrowed with their own start URLs", async () => {
    const { deps: crawl, requests } = fakeSite();
    const { deps, calls } = localDeps(crawl);
    const { result } = await runLocalCrawl(client, { startUrls: [`${E}/a`] }, deps);
    expect(result.summary.sitemapPhase).toBe(null);
    expect(requests).not.toContain(`${E}/u1`);
    expect(calls).toHaveLength(0);
  });

  it("a sitemap that can't be read leaves the crawl intact and orphans unavailable", async () => {
    const { deps: crawl } = fakeSite();
    const { deps } = localDeps(crawl);
    deps.sitemaps = async () => {
      throw new Error("boom");
    };
    const { result } = await runLocalCrawl(client, {}, deps);
    expect(result.summary.orphans).toMatchObject({ available: false, reason: expect.stringMatching(/sitemaps could not be read \(boom\)/) });
    expect(result.notes.join(" ")).toMatch(/Sitemap URLs weren't fetched/);
    expect(result.pages).toBe(2);
  });
});

describe("local_crawl_pages and stored crawls", () => {
  type Cb = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  const tools = new Map<string, { def: { inputSchema: Record<string, unknown> }; cb: Cb }>();
  registerCrawlTools({ registerTool: (name: string, def: { inputSchema: Record<string, unknown> }, cb: Cb) => void tools.set(name, { def, cb }) } as never);
  const page = (url: string, o: Partial<CrawlPage>): CrawlPage => ({ url, depth: 1, status: 200, finalUrl: url, finalStatus: 200, redirectChain: [], contentType: "text/html", title: "T", description: "d", canonical: null, robots: null, noindex: false, h1Count: 1, inlinks: 1, outlinks: 0, firstLinkedFrom: null, parsed: true, issues: [], ...o });

  it("shows a sitemap-phase page's depth as \"sitemap\" and still loads a 0.1.3 crawl with numeric depths", async () => {
    saveCrawl({
      id: "crawl_relA_mixed",
      client: "example.com",
      ranAt: Date.UTC(2026, 10, 1),
      settings: {},
      summary: {},
      exhaustive: true,
      pages: [page(`${E}/`, { depth: 0 }), page(`${E}/u1`, { depth: null, fromSitemap: true, inlinks: 0 })],
    });
    // A crawl stored by 0.1.3: numeric depths only, no fromSitemap, no sitemapPhase in its summary.
    saveCrawl({ id: "crawl_relA_old", client: "example.com", ranAt: Date.UTC(2026, 9, 1), settings: {}, summary: { fetched: 1 }, exhaustive: true, pages: [page(`${E}/old`, { depth: 3 })] });
    const call = async (crawlId: string) => JSON.parse((await tools.get("local_crawl_pages")!.cb({ crawlId })).content[0]!.text);
    expect((await call("crawl_relA_mixed")).pages.map((p: { url: string; depth: unknown }) => [p.url.replace(E, ""), p.depth])).toEqual([["/", 0], ["/u1", "sitemap"]]);
    expect((await call("crawl_relA_old")).pages[0]).toMatchObject({ depth: 3 });
    expect(getCrawl("crawl_relA_old")!.pages[0]!.depth).toBe(3);
  });

  it("local_crawl takes includeSitemapUrls", () => {
    expect(Object.keys(tools.get("local_crawl")!.def.inputSchema)).toContain("includeSitemapUrls");
  });
});
