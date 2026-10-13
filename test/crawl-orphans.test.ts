/**
 * Phase 12 C1: site_hygiene's orphan check picks the newest exhaustive crawl within
 * ORPHAN_MAX_CRAWL_AGE_DAYS, local or DataForSEO (never starting one). Local HTTP server,
 * ALLOW_PRIVATE_URLS only inside this file's server block; the DataForSEO crawl is read from the cache.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import type { CrawlPage } from "../src/analysis/crawl.js";
import { saveAudit } from "../src/lib/audits.js";
import { cacheKey, putCache, TTL } from "../src/lib/cache.js";
import { saveCrawl } from "../src/lib/crawls.js";
import { siteHygiene } from "../src/reports/site-hygiene.js";

const DAY = 86_400_000;
let server: Server;
let base = "";
beforeAll(async () => {
  process.env.ALLOW_PRIVATE_URLS = "true";
  server = createServer((req, res) => {
    const host = `http://${req.headers.host}`;
    const send = (type: string, body: string) => res.writeHead(200, { "content-type": type }).end(body);
    if (req.url === "/robots.txt") return send("text/plain", `User-agent: *\nSitemap: ${host}/s.xml\n`);
    if (req.url === "/s.xml") return send("application/xml", `<urlset>${["/", "/a", "/b", "/c"].map((p) => `<url><loc>${host}${p}</loc></url>`).join("")}</urlset>`);
    return send("text/html", "<html><head><title>t</title></head><body>ok</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  delete process.env.ALLOW_PRIVATE_URLS;
  server.close();
});

const pageAt = (url: string): CrawlPage => ({ url, depth: 0, status: 200, finalUrl: url, finalStatus: 200, redirectChain: [], contentType: "text/html", title: "t", description: "d", canonical: null, robots: null, noindex: false, h1Count: 1, inlinks: 1, outlinks: 0, firstLinkedFrom: null, parsed: true, issues: [] });
const clientFor = (slug: string) => ({ slug, domain: "127.0.0.1", keyPages: [] as string[] }) as unknown as Client;
const dfsAudit = (slug: string, taskId: string, ranAt: number) =>
  saveAudit({ id: `a-${slug}`, client: slug, ranAt, settings: {}, summary: {}, findings: [], checked: [], result: { site: { crawl: { ok: true, data: { taskId } } } } });

describe("orphans: local vs DataForSEO crawl", () => {
  it("uses a complete local crawl newer than the DataForSEO one", async () => {
    const slug = "local-newer";
    dfsAudit(slug, "task-old", Date.now() - 40 * DAY);
    saveCrawl({ id: "crawl_local1", client: slug, ranAt: Date.now() - 2 * DAY, settings: { seededFromHomepage: true }, summary: {}, exhaustive: true, pages: [pageAt(`${base}/`), pageAt(`${base}/a`)] });
    // A newer but capped local crawl is ignored.
    saveCrawl({ id: "crawl_local2", client: slug, ranAt: Date.now() - DAY, settings: { seededFromHomepage: true }, summary: {}, exhaustive: false, pages: [pageAt(`${base}/`)] });
    const r = await siteHygiene(clientFor(slug), { origin: base, gscSitemapPaths: [] });
    expect(r.orphans).toMatchObject({ available: true, source: "local", crawlId: "crawl_local1", orphanCount: 2 });
    expect(r.flags.filter((f) => f.rule === "orphan-page").map((f) => f.url.replace(base, "")).sort()).toEqual(["/b", "/c"]);
    expect(r.checked).toContain("site:orphans");
    expect(r.notes.join(" ")).toMatch(/local crawl crawl_local1/);
  });

  it("uses the DataForSEO crawl when it is newer, unchanged in shape", async () => {
    const slug = "dfs-newer";
    dfsAudit(slug, "task-new", Date.now() - DAY);
    putCache(cacheKey("crawl-urls", "task-new"), TTL.week, { exhaustive: true, urls: [`${base}/`, `${base}/a`, `${base}/b`] });
    saveCrawl({ id: "crawl_older", client: slug, ranAt: Date.now() - 5 * DAY, settings: { seededFromHomepage: true }, summary: {}, exhaustive: true, pages: [pageAt(`${base}/`)] });
    const r = await siteHygiene(clientFor(slug), { origin: base, gscSitemapPaths: [] });
    expect(r.orphans).toEqual({ available: true, crawlTaskId: "task-new", crawledUrls: 3, orphanCount: 1, orphans: [`${base}/c`] });
  });

  it("falls back to the local crawl when the newer DataForSEO crawl hit its cap", async () => {
    const slug = "dfs-capped";
    dfsAudit(slug, "task-capped", Date.now() - DAY);
    putCache(cacheKey("crawl-urls", "task-capped"), TTL.week, { exhaustive: false, urls: [`${base}/`] });
    saveCrawl({ id: "crawl_fallback", client: slug, ranAt: Date.now() - 3 * DAY, settings: { seededFromHomepage: true }, summary: {}, exhaustive: true, pages: [pageAt(`${base}/`), pageAt(`${base}/a`), pageAt(`${base}/b`), pageAt(`${base}/c`)] });
    const r = await siteHygiene(clientFor(slug), { origin: base, gscSitemapPaths: [] });
    expect(r.orphans).toMatchObject({ available: true, source: "local", crawlId: "crawl_fallback", orphanCount: 0 });
    expect(r.notes.join(" ")).toMatch(/DataForSEO crawl couldn't be used for orphans \(the stored crawl hit its page cap/);
  });

  it("ignores a complete local crawl that didn't start at the homepage (R-4)", async () => {
    const slug = "not-seeded";
    saveCrawl({ id: "crawl_keypages", client: slug, ranAt: Date.now() - DAY, settings: { seededFromHomepage: false }, summary: {}, exhaustive: true, pages: [pageAt(`${base}/a`)] });
    const r = await siteHygiene(clientFor(slug), { origin: base, gscSitemapPaths: [] });
    expect(r.orphans).toEqual({ available: false, reason: "not available: no full crawl" });
  });

  it("refuses a local crawl older than the limit, naming the local crawl", async () => {
    const slug = "local-old";
    saveCrawl({ id: "crawl_stale", client: slug, ranAt: Date.now() - 45 * DAY, settings: { seededFromHomepage: true }, summary: {}, exhaustive: true, pages: [pageAt(`${base}/`)] });
    const r = await siteHygiene(clientFor(slug), { origin: base, gscSitemapPaths: [] });
    expect(r.orphans).toEqual({ available: false, reason: expect.stringMatching(/newest complete local crawl is 45 days old \(limit 30\); run local_crawl again/) });
    expect(r.checked).not.toContain("site:orphans");
  });
});
