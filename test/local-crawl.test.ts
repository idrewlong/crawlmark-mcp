/**
 * Phase 12 C1: the bounded local crawler over an in-memory site (fake fetchHop, no network),
 * its analysis, storage retention, and one end-to-end run against a local HTTP server
 * (ALLOW_PRIVATE_URLS only inside that block).
 */
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import { analyzeCrawl, crawledUrls, CRAWL_COMPLETE_KEY, CRAWL_SITE_KEY, type CrawlPage } from "../src/analysis/crawl.js";
import { extractCrawlPage } from "../src/analysis/crawl-parse.js";
import { crawlDelayFor, parseRobots } from "../src/analysis/robots.js";
import { CRAWLS_KEPT, getCrawl, latestCrawl, listCrawls, saveCrawl } from "../src/lib/crawls.js";
import { UrlRefusedError } from "../src/lib/url-guard.js";
import { crawlSite, crawlerUserAgent, inCrawlScope, type CrawlDeps, type CrawlSettings } from "../src/providers/crawler.js";
import { fetchHop, type Hop, type HopOptions } from "../src/providers/render.js";
import { runLocalCrawl, sitemapFetcher, type LocalCrawlDeps } from "../src/reports/local-crawl.js";

type Res = { status: number; body?: string; type?: string; location?: string; xRobotsTag?: string; truncated?: boolean };
const html = (head: string, body = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const a = (...hrefs: string[]) => hrefs.map((h) => `<a href="${h}">x</a>`).join("");
const page = (title: string | null, desc: string | null, links: string[], extra = "") =>
  ({ status: 200, body: html(`${title ? `<title>${title}</title>` : ""}${desc ? `<meta name="description" content="${desc}">` : ""}${extra}`, a(...links)) }) satisfies Res;

/** An in-memory site keyed by absolute URL, plus a request log. */
function fakeSite(site: Record<string, Res>, opts: { refuse?: (url: string) => boolean; delay?: (url: string, signal?: AbortSignal) => Promise<void> } = {}) {
  const requests: { url: string; ua: string }[] = [];
  const sleeps: number[] = [];
  const fetchHopFake = async (url: string, o: HopOptions): Promise<Hop> => {
    if (opts.refuse?.(url)) throw new UrlRefusedError(`Refusing ${new URL(url).hostname}: it does not resolve to a public address.`);
    requests.push({ url, ua: o.userAgent });
    await opts.delay?.(url, o.signal);
    const r = site[url] ?? { status: 404, body: html("<title>Not found</title>") };
    const type = r.type ?? (r.body !== undefined && url.endsWith(".txt") ? "text/plain" : "text/html");
    const wanted = !r.location && (o.body === "any" || /html/.test(type));
    return { url, status: r.status, location: r.location ?? null, contentType: type, xRobotsTag: r.xRobotsTag ?? null, body: wanted ? (r.body ?? "") : null, truncated: r.truncated ?? false };
  };
  const deps: CrawlDeps = { fetchHop: fetchHopFake, extract: async (h, u) => extractCrawlPage(h, u), assertAllowed: () => undefined, sleep: async (ms) => void sleeps.push(ms) };
  return { deps, requests, sleeps };
}

const S = (o: Partial<CrawlSettings> = {}): CrawlSettings => ({ maxPages: 300, maxDepth: 10, concurrency: 4, userAgent: "crawlmark", includeSubdomains: false, startUrls: ["https://example.com/"], ...o });
const E = "https://example.com";

const SITE: Record<string, Res> = {
  [`${E}/robots.txt`]: { status: 200, type: "text/plain", body: "User-agent: *\nDisallow: /private\nSitemap: https://example.com/sitemap.xml\n" },
  [`${E}/`]: page("Home", "Welcome", ["/a", "/b", "/private/x", "/old", "https://other.example.org/x", "/missing", "mailto:hi@example.com", "/noidx", "/away", "/d1", "#top"]),
  [`${E}/a`]: page("Same title", null, ["/", "/b"]),
  [`${E}/b`]: page("Same Title ", "Desc b", ["/a"], '<link rel="canonical" href="/a">'),
  [`${E}/old`]: { status: 301, location: "/mid" },
  [`${E}/mid`]: { status: 302, location: "/c" },
  [`${E}/c`]: page("C", "Desc c", ["/missing"]),
  [`${E}/noidx`]: page("No index", "n", [], '<meta name="robots" content="noindex, follow">'),
  [`${E}/away`]: { status: 301, location: "https://other.example.org/landing" },
  [`${E}/d1`]: page("D1", "d1", ["/d2"]),
  [`${E}/d2`]: page("D2", "d2", ["/d3"]),
  [`${E}/d3`]: page("D3", "d3", ["/d4"]),
  [`${E}/d4`]: page("D4", "d4", ["/d5"]),
  [`${E}/d5`]: page("D5", "d5", []),
};

const byUrl = (pages: CrawlPage[], path: string) => pages.find((p) => p.url === `${E}${path}`);

describe("robots crawl-delay and scope", () => {
  it("reads Crawl-delay per group, falling back to *", () => {
    const f = parseRobots("User-agent: *\nCrawl-delay: 3\n\nUser-agent: crawlmark\nDisallow: /x\nCrawl-delay: 1.5\n\nUser-agent: other\nCrawl-delay: nope\n");
    expect(crawlDelayFor(f, "crawlmark")).toBe(1.5);
    expect(crawlDelayFor(f, "googlebot")).toBe(3);
    expect(crawlDelayFor(f, "other")).toBe(null);
  });
  it("keeps to the client's host (www. too), subdomains only when asked", () => {
    expect(inCrawlScope("https://www.example.com/a", "example.com", false)).toBe(true);
    expect(inCrawlScope("https://blog.example.com/a", "example.com", false)).toBe(false);
    expect(inCrawlScope("https://blog.example.com/a", "example.com", true)).toBe(true);
    expect(inCrawlScope("https://example.org/a", "example.com", true)).toBe(false);
    expect(inCrawlScope("ftp://example.com/a", "example.com", true)).toBe(false);
    // SEC-2: other ports are out of scope unless a start URL uses them.
    expect(inCrawlScope("https://example.com:6379/", "example.com", false)).toBe(false);
    expect(inCrawlScope("https://example.com:443/a", "example.com", false)).toBe(true);
    expect(inCrawlScope("http://example.com:8080/a", "example.com", false, new Set(["", "8080"]))).toBe(true);
    expect(inCrawlScope("http://example.com:6379/a", "example.com", false, "any")).toBe(true);
  });
  it("the honest user agent names crawlmark and the project", () => {
    expect(crawlerUserAgent("1.2.3")).toBe("crawlmark/1.2.3 (+https://github.com/idrewlong/crawlmark-mcp)");
  });
});

describe("crawlSite over an in-memory site", () => {
  it("crawls breadth-first, obeys robots.txt, ignores off-host links and records redirects", async () => {
    const { deps, requests } = fakeSite(SITE);
    const run = await crawlSite("example.com", S(), deps, { version: "9.9.9" });
    const fetched = requests.map((r) => r.url.replace(E, ""));
    expect(fetched).not.toContain("/private/x");
    expect(fetched.some((u) => u.includes("other.example.org"))).toBe(false);
    expect(requests.every((r) => r.ua === "crawlmark/9.9.9 (+https://github.com/idrewlong/crawlmark-mcp)")).toBe(true);
    expect(byUrl(run.pages, "/private/x")).toMatchObject({ skipped: "robots", status: null });
    expect(byUrl(run.pages, "/a")).toMatchObject({ depth: 1, status: 200, title: "Same title", inlinks: 2 });
    expect(byUrl(run.pages, "/old")).toMatchObject({ status: 301, finalStatus: 200, redirectChain: [`${E}/mid`, `${E}/c`] });
    expect(byUrl(run.pages, "/c")).toMatchObject({ fromRedirect: `${E}/old`, depth: 1, title: "C" });
    expect(byUrl(run.pages, "/away")).toMatchObject({ skipped: "off-site-redirect", redirectChain: ["https://other.example.org/landing"] });
    expect(byUrl(run.pages, "/d5")).toMatchObject({ depth: 5 });
    expect(run.stoppedBy).toBe(null);
    expect(run.exhaustive).toBe(true);
    expect(run.robots[0]).toMatchObject({ origin: E, status: 200, mode: "rules", group: "*", sitemaps: ["https://example.com/sitemap.xml"] });
  });

  it("produces findings, page issues and checked keys", async () => {
    const { deps } = fakeSite(SITE);
    const run = await crawlSite("example.com", S(), deps);
    const an = analyzeCrawl(run.pages, { exhaustive: run.exhaustive });
    const got = an.findings.map((f) => `${f.rule} ${f.url.replace(E, "")}`).sort();
    expect(got).toEqual(
      [
        "broken-internal-link /missing",
        "redirect-chain /old",
        "internal-link-to-redirect /old",
        "internal-link-to-redirect /away",
        "missing-description /a",
        "duplicate-title /a",
        "duplicate-title /b",
        "canonical-elsewhere /b",
        "deep-page /d5",
        "noindex-linked /noidx",
      ].sort(),
    );
    expect(an.findings.every((f) => f.source === "crawl")).toBe(true);
    expect(an.findings.find((f) => f.rule === "broken-internal-link")!.evidence).toMatch(/HTTP 404; 2 internal links, first from https:\/\/example.com\//);
    expect(an.checked).toEqual(expect.arrayContaining([CRAWL_SITE_KEY, CRAWL_COMPLETE_KEY, `${E}`, `${E}/a`, `${E}/missing`]));
    expect(an.checked).not.toContain(`${E}/private/x`);
    expect(an.summary).toMatchObject({ brokenLinks: 1, duplicateTitles: 2, missingTitles: 0, missingDescriptions: 1, canonicalIssues: 1, noindex: 1, redirects: 2 });
    expect(an.summary.byStatus["skipped:robots"]).toBe(1);
    expect(byUrl(run.pages, "/a")!.issues).toEqual(["duplicate-title", "missing-description"]);
    // A capped crawl can't clear duplicate findings: no complete key.
    expect(analyzeCrawl(run.pages, { exhaustive: false }).checked).not.toContain(CRAWL_COMPLETE_KEY);
    expect(crawledUrls(run.pages)).toEqual(expect.arrayContaining([`${E}/old`, `${E}/c`, `${E}/private/x`]));
  });

  it("flags canonical-to-non-200 when the canonical target was crawled and fails", async () => {
    const { deps } = fakeSite({
      [`${E}/`]: page("Home", "h", ["/x", "/gone"]),
      [`${E}/x`]: page("X", "x", [], '<link rel="canonical" href="https://example.com/gone">'),
      [`${E}/gone`]: { status: 410, body: "gone" },
    });
    const run = await crawlSite("example.com", S(), deps);
    const rules = analyzeCrawl(run.pages, { exhaustive: true }).findings.map((f) => `${f.rule} ${f.url.replace(E, "")}`);
    expect(rules).toContain("canonical-to-non-200 /x");
    expect(rules).not.toContain("canonical-elsewhere /x");
  });

  it("stops at maxPages and maxDepth, and is then not exhaustive", async () => {
    const capped = await crawlSite("example.com", S({ maxPages: 3 }), fakeSite(SITE).deps);
    expect(capped.stoppedBy).toBe("maxPages");
    expect(capped.exhaustive).toBe(false);
    expect(capped.pages.filter((p) => p.status !== null)).toHaveLength(3);
    expect(capped.notes.join(" ")).toMatch(/3-page cap/);

    const shallow = await crawlSite("example.com", S({ maxDepth: 1 }), fakeSite(SITE).deps);
    expect(shallow.stoppedBy).toBe(null);
    expect(shallow.exhaustive).toBe(false);
    expect(byUrl(shallow.pages, "/d2")).toBeUndefined();
    expect(shallow.notes.join(" ")).toMatch(/deeper than maxDepth 1/);
  });

  it("stops at the time limit with the pages fetched so far", async () => {
    const { deps } = fakeSite(SITE, {
      delay: (url, signal) =>
        url.endsWith("/a") ? new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) : Promise.resolve(),
    });
    const run = await crawlSite("example.com", S({ concurrency: 1 }), deps, { timeLimitMs: 200 });
    expect(run.stoppedBy).toBe("time");
    expect(run.exhaustive).toBe(false);
    expect(byUrl(run.pages, "/")).toMatchObject({ status: 200 });
    expect(byUrl(run.pages, "/a")).toBeUndefined(); // cut off mid-request: not a result
  });

  it("honours Crawl-delay (capped at 10 s) and spaces requests 250 ms otherwise", async () => {
    const site = (delay: string) => ({
      [`${E}/robots.txt`]: { status: 200, type: "text/plain", body: `User-agent: crawlmark\nCrawl-delay: ${delay}\n` },
      [`${E}/`]: page("Home", "h", ["/a", "/b"]),
      [`${E}/a`]: page("A", "a", []),
      [`${E}/b`]: page("B", "b", []),
    });
    const slow = fakeSite(site("2"));
    await crawlSite("example.com", S({ concurrency: 1 }), slow.deps);
    expect(Math.max(...slow.sleeps)).toBeGreaterThanOrEqual(1900);
    expect(slow.sleeps.every((ms) => ms % 2000 <= 100 || ms % 2000 >= 1900)).toBe(true);

    const capped = fakeSite(site("60"));
    const run = await crawlSite("example.com", S({ concurrency: 1 }), capped.deps);
    expect(Math.min(...capped.sleeps)).toBeGreaterThan(9000);
    expect(Math.max(...capped.sleeps)).toBeLessThanOrEqual(20_000);
    expect(run.notes.join(" ")).toMatch(/60s Crawl-delay; crawlmark waited 10s/);

    const plain = fakeSite({ [`${E}/`]: page("Home", "h", ["/a", "/b"]), [`${E}/a`]: page("A", "a", []), [`${E}/b`]: page("B", "b", []) });
    await crawlSite("example.com", S({ concurrency: 1 }), plain.deps);
    expect(Math.max(...plain.sleeps)).toBeLessThanOrEqual(1000);
    expect(plain.sleeps.some((ms) => ms > 0)).toBe(true);
  });

  it("uses the Googlebot group and user agent in googlebot mode", async () => {
    const { deps, requests } = fakeSite({
      [`${E}/robots.txt`]: { status: 200, type: "text/plain", body: "User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /star\n" },
      [`${E}/`]: page("Home", "h", ["/g", "/star"]),
      [`${E}/star`]: page("S", "s", []),
    });
    const run = await crawlSite("example.com", S({ userAgent: "googlebot" }), deps);
    expect(requests[0]!.ua).toMatch(/Googlebot\/2\.1/);
    expect(byUrl(run.pages, "/g")).toMatchObject({ skipped: "robots" });
    expect(byUrl(run.pages, "/star")).toMatchObject({ status: 200 });
  });

  it("a robots.txt server error means nothing on that host is crawled", async () => {
    const { deps, requests } = fakeSite({ [`${E}/robots.txt`]: { status: 503, body: "" }, [`${E}/`]: page("Home", "h", []) });
    const run = await crawlSite("example.com", S(), deps);
    expect(requests.map((r) => r.url)).toEqual([`${E}/robots.txt`]);
    expect(run.exhaustive).toBe(false);
    expect(run.notes.join(" ")).toMatch(/HTTP 503/);
  });

  it("refuses a private-address hop (guard) and a URL RESTRICT_TO_CLIENT_DOMAINS doesn't allow, without fetching them", async () => {
    const site = {
      [`${E}/`]: page("Home", "h", ["/rebind", "https://blog.example.com/"]),
      [`${E}/rebind`]: { status: 302, location: "https://www.example.com/internal" },
      "https://blog.example.com/": page("Blog", "b", []),
    };
    const { deps, requests } = fakeSite(site, { refuse: (u) => u.startsWith("https://www.example.com/") });
    deps.assertAllowed = (u) => {
      if (new URL(u).hostname === "blog.example.com") throw new UrlRefusedError("Refusing blog.example.com: RESTRICT_TO_CLIENT_DOMAINS=true and it is not a client domain");
    };
    const run = await crawlSite("example.com", S({ includeSubdomains: true }), deps);
    expect(byUrl(run.pages, "/rebind")).toMatchObject({ status: 302, error: expect.stringMatching(/does not resolve to a public address/) });
    expect(run.pages.find((p) => p.url === "https://blog.example.com/")).toMatchObject({ status: null, error: expect.stringMatching(/RESTRICT_TO_CLIENT_DOMAINS/) });
    expect(requests.map((r) => r.url)).not.toContain("https://blog.example.com/");
    expect(requests.map((r) => r.url)).not.toContain("https://www.example.com/internal");
    expect(run.exhaustive).toBe(false);
  });

  it("a body cut at the size cap makes the crawl non-exhaustive, with a note", async () => {
    const { deps } = fakeSite({ [`${E}/`]: { ...page("Home", "h", ["/a"]), truncated: true }, [`${E}/a`]: page("A", "a", []) });
    const run = await crawlSite("example.com", S(), deps);
    expect(run.exhaustive).toBe(false);
    expect(run.notes.join(" ")).toMatch(/larger than the 2 MB cap/);
  });

  it("reads a redirect target that differs only by a trailing slash, so its links are followed (R-1)", async () => {
    const { deps } = fakeSite({
      [`${E}/`]: page("Home", "h", ["/about"]),
      [`${E}/about`]: { status: 301, location: "/about/" },
      [`${E}/about/`]: page("About", null, ["/team/"]),
      [`${E}/team/`]: page("Team", "t", []),
    });
    const run = await crawlSite("example.com", S(), deps);
    expect(byUrl(run.pages, "/about")).toMatchObject({ status: 301, finalStatus: 200, parsed: true, title: "About", redirectChain: [`${E}/about/`] });
    expect(byUrl(run.pages, "/team/")).toMatchObject({ status: 200, depth: 2 });
    expect(run.exhaustive).toBe(true);
    const an = analyzeCrawl(run.pages, { exhaustive: true });
    expect(an.findings.map((f) => `${f.rule} ${f.url.replace(E, "")}`).sort()).toEqual(["internal-link-to-redirect /about", "missing-description /about"]);
    expect(an.checked).toContain(`${E}/about`);
    expect(crawledUrls(run.pages)).toEqual(expect.arrayContaining([`${E}/about/`, `${E}/team/`]));
  });

  it("a 5xx or 429 page makes the crawl incomplete; 429 is not a broken link (R-2)", async () => {
    const { deps } = fakeSite({
      [`${E}/`]: page("Home", "h", ["/busy", "/err"]),
      [`${E}/busy`]: { status: 429, body: "slow down" },
      [`${E}/err`]: { status: 503, body: "down" },
    });
    const run = await crawlSite("example.com", S(), deps);
    expect(run.exhaustive).toBe(false);
    expect(run.notes.join(" ")).toMatch(/server error or 429/);
    const rules = analyzeCrawl(run.pages, { exhaustive: run.exhaustive }).findings.map((f) => `${f.rule} ${f.url.replace(E, "")}`);
    expect(rules).toEqual(["broken-internal-link /err"]);
  });

  it("never follows a link or redirect to another port on the client's host (SEC-2)", async () => {
    const { deps, requests } = fakeSite({
      [`${E}/`]: page("Home", "h", ["https://example.com:6379/", "/hop"]),
      [`${E}/hop`]: { status: 302, location: "https://example.com:8443/admin" },
    });
    const run = await crawlSite("example.com", S(), deps);
    expect(requests.map((r) => r.url).filter((u) => /:6379|:8443/.test(u))).toEqual([]);
    expect(byUrl(run.pages, "/hop")).toMatchObject({ skipped: "off-site-redirect" });
  });

  it("strips control characters from page text", async () => {
    const { deps } = fakeSite({ [`${E}/`]: page("Bad\u202Etitle\u0007", "d", []) });
    const run = await crawlSite("example.com", S(), deps);
    expect(byUrl(run.pages, "/")!.title).toBe("Badtitle");
  });
});

describe("extractCrawlPage", () => {
  it("resolves links against <base>, drops fragments and non-http schemes, de-duplicates", () => {
    const x = extractCrawlPage(html('<base href="https://example.com/dir/"><title> T </title><link rel="canonical" href="/c">', a("x", "x#frag", "javascript:alert(1)", "tel:1", "/y", "//example.org/z")), "https://example.com/page");
    expect(x.links).toEqual(["https://example.com/dir/x", "https://example.com/y", "https://example.org/z"]);
    expect(x).toMatchObject({ title: "T", canonical: "https://example.com/c", h1Count: 0, linksCapped: false });
  });
});

describe("local crawl storage", () => {
  it("keeps the newest 10 crawls per client", () => {
    for (let i = 0; i < CRAWLS_KEPT + 2; i++) {
      saveCrawl({ id: `crawl_t${String(i).padStart(2, "0")}`, client: "retention.example.com", ranAt: 1_000 + i, settings: {}, summary: {}, exhaustive: i % 2 === 0, pages: [] });
    }
    saveCrawl({ id: "crawl_other", client: "other.example.com", ranAt: 1, settings: {}, summary: {}, exhaustive: true, pages: [] });
    const list = listCrawls("retention.example.com");
    expect(list).toHaveLength(CRAWLS_KEPT);
    expect(list[0]!.id).toBe("crawl_t11");
    expect(getCrawl("crawl_t00")).toBeUndefined();
    expect(latestCrawl("retention.example.com", { exhaustiveOnly: true })!.id).toBe("crawl_t10");
    expect(getCrawl("crawl_other")).toBeDefined();
  });
});

describe("runLocalCrawl", () => {
  const client = { slug: "example.com", domain: "example.com", name: "Example Co", keyPages: [] } as unknown as Client;
  it("judges orphans against the sitemaps only for an exhaustive crawl, and saves the crawl", async () => {
    const saved: unknown[] = [];
    const sitemapCalls: string[][] = [];
    const { deps } = fakeSite(SITE);
    const ld: LocalCrawlDeps = {
      crawl: deps,
      sitemaps: async (_c, roots) => {
        sitemapCalls.push(roots);
        return { urls: new Set([`${E}/a`, `${E}/lonely`, `${E}/c/`]), lastmods: new Map(), hreflang: new Map(), hreflangCapped: false, readFailed: false, complete: true, anyUrlset: true, files: [], totalLocs: 3, fallback: null };
      },
      save: (c) => void saved.push(c),
      version: "1.0.0",
    };
    const { result, findings, checked } = await runLocalCrawl(client, {}, ld);
    expect(sitemapCalls).toEqual([["https://example.com/sitemap.xml"]]);
    expect(result.summary.orphans).toEqual({ available: true, count: 1, urls: [`${E}/lonely`] });
    expect(result).toMatchObject({ client: "example.com", exhaustive: true, stoppedBy: null, findingCount: findings.length });
    expect(result.topIssues[0]!.severity).toBe("high");
    expect(result.crawlId).toMatch(/^crawl_/);
    expect(checked).toContain(CRAWL_SITE_KEY);
    expect(saved).toHaveLength(1);

    const capped = await runLocalCrawl(client, { maxPages: 2 }, { ...ld, crawl: fakeSite(SITE).deps });
    expect(capped.result.summary.orphans).toMatchObject({ available: false, reason: expect.stringMatching(/not exhaustive \(stopped by maxPages\)/) });
    expect(sitemapCalls).toHaveLength(1);
  });

  it("doesn't judge orphans for a crawl that didn't start at the homepage (R-4)", async () => {
    const calls: string[] = [];
    const ld: LocalCrawlDeps = {
      crawl: fakeSite(SITE).deps,
      sitemaps: async () => (calls.push("sitemaps"), Promise.reject(new Error("unused"))),
      save: () => undefined,
      version: "1",
    };
    const { result } = await runLocalCrawl(client, { startUrls: [`${E}/a`] }, ld);
    expect(result.settings.seededFromHomepage).toBe(false);
    expect(result.summary.orphans).toEqual({ available: false, reason: expect.stringMatching(/didn't start at the homepage/) });
    expect(calls).toEqual([]);
  });

  it("refuses when no start URL is on the client's host", async () => {
    await expect(runLocalCrawl(client, { startUrls: ["https://example.org/"] }, { crawl: fakeSite({}).deps, sitemaps: async () => { throw new Error("x"); }, save: () => undefined, version: "1" })).rejects.toThrow(/No start URL is on example.com/);
  });
});

describe("fetchHop and a real local server", () => {
  let server: Server;
  let base = "";
  const hits: { path: string; ua: string }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push({ path: req.url ?? "", ua: String(req.headers["user-agent"]) });
      const host = `http://${req.headers.host}`;
      const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": type, ...headers }).end(body);
      switch (req.url) {
        case "/robots.txt":
          return send(200, "text/plain", `User-agent: *\nDisallow: /secret\nSitemap: ${host}/sitemap.xml\n`);
        case "/sitemap.xml":
          return send(200, "application/xml", `<urlset><url><loc>${host}/</loc></url><url><loc>${host}/about</loc></url><url><loc>${host}/orphan</loc></url></urlset>`);
        case "/":
          return send(200, "text/html", html("<title>Home</title>", a("/about", "/secret/page", "/moved", "/file.pdf")));
        case "/about":
          return send(200, "text/html", html("<title>About</title>", a("/")));
        case "/moved":
          return send(301, "text/html", "", { location: "/about" });
        case "/s.xml.gz":
          return void res.writeHead(200, { "content-type": "application/gzip" }).end(gzipSync("<urlset></urlset>"));
        case "/file.pdf":
          return send(200, "application/pdf", "%PDF-1.4");
        default:
          return send(404, "text/html", "nope");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    delete process.env.ALLOW_PRIVATE_URLS;
    server.close();
  });

  it("refuses a loopback address unless ALLOW_PRIVATE_URLS is set", async () => {
    delete process.env.ALLOW_PRIVATE_URLS;
    await expect(fetchHop(`${base}/`, { userAgent: "t" })).rejects.toThrow(/private or loopback/);
    expect(hits).toHaveLength(0);
  });

  it("crawls the site end to end: robots respected, honest UA, non-HTML bodies not read, orphans from the sitemap", async () => {
    process.env.ALLOW_PRIVATE_URLS = "true";
    const hop = await fetchHop(`${base}/moved`, { userAgent: "t" });
    expect(hop).toMatchObject({ status: 301, location: "/about", body: null });
    expect(await fetchHop(`${base}/s.xml.gz`, { userAgent: "t", body: "any" })).toMatchObject({ status: 200, body: "<urlset></urlset>" });
    expect(await fetchHop(`${base}/file.pdf`, { userAgent: "t" })).toMatchObject({ status: 200, body: null });
    hits.length = 0;

    const { collectSitemaps } = await import("../src/reports/site-hygiene.js");
    const { fetchRaw } = await import("../src/providers/render.js");
    const { extractCrawlIsolated } = await import("../src/analysis/extract-isolated.js");
    const saved: string[] = [];
    const sitemapUa: string[] = [];
    const client = { slug: "127.0.0.1", domain: "127.0.0.1", name: "Local", keyPages: [] } as unknown as Client;
    const { result } = await runLocalCrawl(client, { startUrls: [`${base}/`] }, {
      crawl: { fetchHop, extract: (h, u) => extractCrawlIsolated(h, u), assertAllowed: () => undefined },
      sitemaps: (_c, roots, o) => {
        sitemapUa.push(o.userAgent);
        return collectSitemaps({ roots, siteOrigin: base, get: (u) => fetchRaw(u, { refresh: true }), onClientHost: () => true, notes: [] });
      },
      save: (c) => void saved.push(c.id),
      version: "0.1.0",
    });
    const paths = hits.map((h) => h.path);
    expect(paths).not.toContain("/secret/page");
    expect(hits.filter((h) => h.path !== "/sitemap.xml").every((h) => h.ua.startsWith("crawlmark/0.1.0 "))).toBe(true);
    expect(result.exhaustive).toBe(true);
    expect(result.summary.orphans).toEqual({ available: true, count: 1, urls: [`${base}/orphan`] });
    expect(result.summary.byStatus).toMatchObject({ "200": 3, "301": 1, "skipped:robots": 1 });
    expect(result.topIssues.map((f) => f.rule)).toContain("internal-link-to-redirect");
    expect(saved).toEqual([result.crawlId]);
    expect(sitemapUa).toEqual(["crawlmark/0.1.0 (+https://github.com/idrewlong/crawlmark-mcp)"]);
  });
});

describe("loadLocalCrawlDeps", () => {
  it("reads the package version from the project root (this module is one level below src/)", async () => {
    const { loadLocalCrawlDeps } = await import("../src/reports/local-crawl.js");
    const { packageVersion } = await import("../src/lib/entry.js");
    const deps = await loadLocalCrawlDeps();
    expect(deps.version).toBe(packageVersion(new URL("../src/index.ts", import.meta.url).href));
    expect(deps.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("sitemapFetcher (SEC-3)", () => {
  it("follows redirects on the client's host and refuses one that leaves it, without fetching it", async () => {
    const fetched: string[] = [];
    const site: Record<string, Partial<Hop>> = {
      "https://example.com/sitemap.xml": { status: 301, location: "/sitemap_index.xml" },
      "https://example.com/sitemap_index.xml": { status: 200, body: "<urlset></urlset>" },
      "https://example.com/away.xml": { status: 302, location: "https://example.org/sitemap.xml" },
    };
    const get = sitemapFetcher({
      fetchHop: async (url, o) => (fetched.push(`${url} ${o.userAgent}`), { url, status: 0, location: null, contentType: "application/xml", xRobotsTag: null, body: null, truncated: false, ...site[url] }),
      userAgent: "crawlmark/1",
      onClientHost: (u) => new URL(u).hostname === "example.com",
      assertAllowed: () => undefined,
    });
    expect(await get("https://example.com/sitemap.xml")).toMatchObject({ status: 200, finalUrl: "https://example.com/sitemap_index.xml", redirects: 1, html: "<urlset></urlset>" });
    await expect(get("https://example.com/away.xml")).rejects.toThrow(/redirects off the client's site/);
    expect(fetched.some((f) => f.includes("example.org"))).toBe(false);
    expect(fetched.every((f) => f.endsWith(" crawlmark/1"))).toBe(true);
  });
});
