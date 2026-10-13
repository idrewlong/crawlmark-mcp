/**
 * Phase 12 C3: Bing Webmaster Tools (read-only). Stubbed fetch only (no network); the fixtures follow
 * Microsoft's documented JSON samples. A sentinel key proves the key never reaches a result, an error,
 * the cache or a log line.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { crawlIssueLabels, matchBingSite, parseBingDate, parseCrawlIssues, parseUserSites, topRows, parseStatRows, windowsFor, parseTraffic } from "../src/analysis/bing.js";
import { db } from "../src/lib/store.js";
import {
  BING_READ_METHODS,
  BingApiError,
  bingErrorMessage,
  bingGet,
  bingOverview,
  bingReport,
  BingSiteError,
  BingUnavailableError,
  bingCacheKey,
  bingUserSites,
  checkBingKey,
  keyFingerprint,
  type BingReadMethod,
} from "../src/providers/bing.js";

const KEY = "SENTINEL-bing-key-0123456789abcdef";
const FIX = join(import.meta.dirname, "fixtures", "bing");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");
const BY_METHOD: Record<string, string> = {
  GetUserSites: "user-sites.json",
  GetRankAndTrafficStats: "traffic.json",
  GetQueryStats: "query-stats.json",
  GetPageStats: "page-stats.json",
  GetCrawlStats: "crawl-stats.json",
  GetCrawlIssues: "crawl-issues.json",
};
const methodOf = (url: string) => new URL(url).pathname.split("/").pop()!;

/** A fake Bing: answers each method from its fixture and records the URLs it was asked for. */
function fakeBing(over: Partial<Record<string, () => Response>> = {}) {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const m = methodOf(url);
    if (over[m]) return over[m]!();
    const f = BY_METHOD[m];
    return f ? new Response(fixture(f), { status: 200, headers: { "content-type": "application/json" } }) : new Response("{}", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, urls, mock: fetchImpl };
}
const noSleep = async () => undefined;
const allCache = () => JSON.stringify(db.prepare("SELECT key, value FROM cache").all());

describe("read-only allowlist", () => {
  const WRITE = /^(Add|Remove|Submit|Save|Update|Enable|Verify|Fetch)/;
  it("lists only read methods", () => {
    expect(BING_READ_METHODS.filter((m) => WRITE.test(m))).toEqual([]);
    expect(BING_READ_METHODS.every((m) => m.startsWith("Get"))).toBe(true);
  });

  it("refuses every write method before any request, even with a key", async () => {
    const f = fakeBing();
    for (const m of ["SubmitUrl", "SubmitUrlBatch", "SubmitSitemap", "SubmitContent", "AddSite", "RemoveSite", "SaveSettings", "UpdateBlockedUrl", "EnableDisableQueryParameter", "VerifySite", "FetchUrl", "AddBlockedUrl"]) {
      await expect(bingGet(m as BingReadMethod, { siteUrl: "https://example.com/" }, { key: KEY, fetchImpl: f.fetchImpl })).rejects.toThrow(/not on crawlmark's read-only list/);
    }
    expect(f.mock).not.toHaveBeenCalled();
  });

  it("no source file names a Bing write method as a string", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith(".ts")) files.push(join(dir, e.name));
      }
    };
    walk(join(import.meta.dirname, "..", "src"));
    const bingFiles = files.filter((f) => /bing/i.test(readFileSync(f, "utf8")));
    for (const f of bingFiles) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/["'`](Add|Remove|Submit|Save|Update|Enable|Verify|Fetch)(Site|Url|Sitemap|Content|Feed|Blocked|Query|Deep|Page|Country|Crawl|Connected|Children)\w*["'`]/);
    }
  });
});

describe("parsing", () => {
  it("/Date(ms±hhmm)/ to the calendar day it names", () => {
    expect(parseBingDate("/Date(1316156400000-0700)/")).toBe("2011-09-16");
    expect(parseBingDate("/Date(1316156400000+0000)/")).toBe("2011-09-16");
    expect(parseBingDate("/Date(1316131200000)/")).toBe("2011-09-16");
    expect(parseBingDate("/Date(1316214000000+0530)/")).toBe("2011-09-17");
    expect(parseBingDate("2011-09-16T00:00:00-07:00")).toBe("2011-09-16");
    expect([parseBingDate("yesterday"), parseBingDate(null), parseBingDate(42)]).toEqual([null, null, null]);
  });

  it("crawl issue flags, as numbers or names", () => {
    expect(crawlIssueLabels(32)).toEqual(["contains malware"]);
    expect(crawlIssueLabels(4 | 16)).toEqual(["4xx error", "blocked by robots.txt"]);
    expect(crawlIssueLabels(1024)).toEqual(["other issue"]);
    expect(crawlIssueLabels("ContainsMalware, Code5xx")).toEqual(["contains malware", "5xx error"]);
    expect(crawlIssueLabels(0)).toEqual([]);
  });

  it("strips control and format characters from Bing's text", () => {
    const rows = parseStatRows(JSON.parse(fixture("query-stats.json")).d, 300);
    expect(rows.map((r) => r.key)).toContain("water heater <b>repair</b>[31m");
    expect(JSON.stringify(rows)).not.toMatch(/\\u001b/);
    const issues = parseCrawlIssues([{ Url: "https://example.com/\u202Egp.exe", Issues: 4, HttpCode: 404, InLinks: 1 }, { Url: "https://example.com/ok", Issues: 0 }]);
    expect(issues).toEqual([{ url: "https://example.com/gp.exe", issue: "4xx error", httpCode: 404, inLinks: 1 }]);
  });
});

describe("site matching", () => {
  const sites = parseUserSites(JSON.parse(fixture("user-sites.json")).d);
  it("matches by normalised host, preferring https and the root; verification codes are dropped", () => {
    expect(JSON.stringify(sites)).not.toMatch(/258CAD|DnsVerification|AuthenticationCode/i);
    expect(matchBingSite(sites, { domain: "example.com" })).toEqual({ ok: true, site: "https://www.example.com/", source: "matched", alternates: ["http://example.com/"] });
    expect(matchBingSite(sites, { domain: "example.net" })).toMatchObject({ ok: true, site: "https://example.net/blog/" });
    expect(matchBingSite(sites, { domain: "example.org" })).toEqual({ ok: false, reason: "unverified", unverified: ["https://example.org/"] });
    expect(matchBingSite(sites, { domain: "example.edu" })).toEqual({ ok: false, reason: "no-match", unverified: [] });
  });

  it("SEC-2: a bingSite on another host is refused, even when that site is verified; subdomains are fine", () => {
    expect(matchBingSite(sites, { domain: "example.com", bingSite: "https://example.net/blog/" })).toEqual({ ok: false, reason: "override-other-host", unverified: [] });
    expect(matchBingSite(sites, { domain: "example.com", bingSite: "https://notexample.com/" })).toMatchObject({ reason: "override-other-host" });
    expect(matchBingSite(sites, { domain: "example.com", bingSite: "https://example.com.evil.example/" })).toMatchObject({ reason: "override-other-host" });
    const withSub = [...sites, { url: "https://blog.example.com/", verified: true }];
    expect(matchBingSite(withSub, { domain: "example.com", bingSite: "https://blog.example.com/" })).toMatchObject({ ok: true, site: "https://blog.example.com/", source: "bingSite" });
  });

  it("bingSite overrides, ignoring case and a trailing slash, and must be verified", () => {
    expect(matchBingSite(sites, { domain: "example.com", bingSite: "HTTP://example.com" })).toEqual({ ok: true, site: "http://example.com/", source: "bingSite", alternates: [] });
    expect(matchBingSite(sites, { domain: "example.com", bingSite: "https://example.com/" })).toMatchObject({ ok: false, reason: "override-not-found" });
    expect(matchBingSite(sites, { domain: "example.org", bingSite: "https://example.org/" })).toMatchObject({ ok: false, reason: "override-unverified" });
  });
});

describe("bingGet", () => {
  it("no key is unavailable with the setup step, and makes no request", async () => {
    const f = fakeBing();
    const err = await bingGet("GetUserSites", {}, { key: "", fetchImpl: f.fetchImpl }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BingUnavailableError);
    expect((err as Error).message).toMatch(/BING_WEBMASTER_API_KEY.*setup --step bing/);
    expect(f.mock).not.toHaveBeenCalled();
  });

  it("sends the key as apikey to the base URL (the closed test port) and unwraps d", async () => {
    const f = fakeBing();
    const r = await bingGet<unknown[]>("GetQueryStats", { siteUrl: "https://www.example.com/" }, { key: KEY, fetchImpl: f.fetchImpl, noCache: true });
    expect(f.urls[0]).toBe(`http://127.0.0.1:9/GetQueryStats?siteUrl=https%3A%2F%2Fwww.example.com%2F&apikey=${KEY}`);
    expect(r.value).toHaveLength(5);
  });

  it("maps ErrorCode 3 to the key message and never echoes the key or URL", async () => {
    const f = fakeBing({ GetUserSites: () => new Response(`{"ErrorCode":3,"Message":"InvalidApiKey ${KEY} https://ssl.bing.com/x?apikey=${KEY}"}`, { status: 400 }) });
    const err = await bingGet("GetUserSites", {}, { key: KEY, fetchImpl: f.fetchImpl, noCache: true }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BingUnavailableError);
    expect((err as Error).message).toBe("Bing rejected the API key; run setup --step bing.");
    expect(bingErrorMessage(400, '{"ErrorCode":14,"Message":"NotAuthorized"}')).toMatchObject({ unavailable: false, message: expect.stringMatching(/isn't a site this key can read/) });
    expect(bingErrorMessage(400, "<root><ErrorCode type=\"number\">3</ErrorCode></root>")).toMatchObject({ unavailable: true, code: 3 });
    expect(bingErrorMessage(503, "")).toMatchObject({ retryable: true, message: "Bing Webmaster Tools returned HTTP 503." });
  });

  it("retries throttling once, then gives up with a fixed message", async () => {
    let n = 0;
    const f = fakeBing({ GetCrawlIssues: () => (++n === 1 ? new Response('{"ErrorCode":4,"Message":"ThrottleUser"}', { status: 400 }) : new Response(fixture("crawl-issues.json"))) });
    const sleep = vi.fn(noSleep);
    const r = await bingGet<unknown[]>("GetCrawlIssues", { siteUrl: "https://www.example.com/" }, { key: KEY, fetchImpl: f.fetchImpl, noCache: true, sleep });
    expect(r.value).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(1);
    const always = fakeBing({ GetCrawlIssues: () => new Response('{"ErrorCode":5}', { status: 400 }) });
    const err = await bingGet("GetCrawlIssues", { siteUrl: "https://www.example.com/" }, { key: KEY, fetchImpl: always.fetchImpl, noCache: true, sleep: noSleep }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BingApiError);
    expect(always.mock).toHaveBeenCalledTimes(2);
  });

  it("a network error reports only its class, never the URL with the key", async () => {
    const fetchImpl = vi.fn(async (u: string) => {
      throw Object.assign(new TypeError(`fetch failed for ${u}`), { cause: new Error(u) });
    });
    const err = await bingGet("GetUserSites", {}, { key: KEY, fetchImpl: fetchImpl as never, noCache: true, sleep: noSleep }).catch((e: Error) => e);
    expect((err as Error).message).toBe("Couldn't reach Bing Webmaster Tools (TypeError).");
    expect(JSON.stringify(err)).not.toContain(KEY);
  });

  it("checkBingKey counts sites without returning the key or verification codes", async () => {
    const r = await checkBingKey(KEY, fakeBing().fetchImpl);
    expect(r).toEqual({ ok: true, sites: 4, verified: 3 });
    const bad = await checkBingKey(KEY, fakeBing({ GetUserSites: () => new Response('{"ErrorCode":3,"Message":"InvalidApiKey"}', { status: 400 }) }).fetchImpl);
    expect(bad).toEqual({ ok: false, kind: "refused", problem: "Bing rejected the API key; run setup --step bing." });
    const throttled = await checkBingKey(KEY, fakeBing({ GetUserSites: () => new Response('{"ErrorCode":4,"Message":"ThrottleUser"}', { status: 400 }) }).fetchImpl);
    expect(throttled).toMatchObject({ ok: false, kind: "throttled" });
    const down = await checkBingKey(KEY, (async () => {
      throw new TypeError("fetch failed");
    }) as never);
    expect(down).toEqual({ ok: false, kind: "network", problem: "Couldn't reach Bing Webmaster Tools (TypeError)." });
    const other = await checkBingKey(KEY, fakeBing({ GetUserSites: () => new Response('{"ErrorCode":8,"Message":"InvalidParameter"}', { status: 400 }) }).fetchImpl);
    expect(other).toMatchObject({ ok: false, kind: "other" });
  });
});

describe("bingReport (fixtures)", () => {
  it("28 days ending on Bing's newest day vs the 28 before; top rows, crawl stats and issues", async () => {
    const f = fakeBing();
    const r = await bingReport({ domain: "example.com" }, {}, { key: KEY, fetchImpl: f.fetchImpl, refresh: true });
    expect(r.site).toBe("https://www.example.com/");
    expect(r.siteSource).toBe("matched");
    expect(r.window).toEqual({ startDate: "2026-09-13", endDate: "2026-10-10" });
    expect(r.previous).toEqual({ startDate: "2026-08-16", endDate: "2026-09-12", clicks: 280, impressions: 2800, ctr: 10 });
    expect(r.totals).toEqual({ clicks: 420, impressions: 3360, ctr: 12.5, change: { clicks: 50, impressions: 20, ctr: 2.5 } });
    expect(r.byDay).toHaveLength(28);
    expect(r.byDay[0]).toEqual({ date: "2026-09-13", clicks: 15, impressions: 120 });
    expect(r.topQueries).toEqual([
      { query: "emergency plumber", clicks: 60, impressions: 400, avgPosition: 3.5 },
      { query: "drain cleaning", clicks: 30, impressions: 400, avgPosition: 6 },
      { query: "water heater <b>repair</b>[31m", clicks: 5, impressions: 50, avgPosition: 9 },
    ]);
    expect(r.topPages.map((p) => p.page)).toEqual(["https://www.example.com/", "https://www.example.com/a|b*c_[x]"]);
    expect(r.crawl.stats).toHaveLength(30);
    expect(r.crawl.stats.at(-1)).toMatchObject({ date: "2026-10-10", inIndex: 534, crawledPages: 138 });
    expect(r.crawl.issues).toEqual([
      { url: "https://www.example.com/private", issue: "blocked by robots.txt, contains malware", httpCode: 200, inLinks: 10 },
      { url: "https://www.example.com/gone", issue: "4xx error", httpCode: 404, inLinks: 3 },
      { url: "https://www.example.com/old", issue: "301 redirect", httpCode: 301, inLinks: 1 },
    ]);
    expect(r.notes[0]).toBe("Bing updates query stats weekly");
    // Six reads, each to a read method, with the key only in the request URL.
    expect(f.urls.map(methodOf)).toEqual(["GetUserSites", "GetRankAndTrafficStats", "GetQueryStats", "GetPageStats", "GetCrawlStats", "GetCrawlIssues"]);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(allCache()).not.toContain(KEY);

    const again = await bingReport({ domain: "example.com" }, { days: 7 }, { key: KEY, fetchImpl: f.fetchImpl });
    expect(again).toMatchObject({ fromCache: true, window: { startDate: "2026-10-04", endDate: "2026-10-10" } });
    expect(f.urls).toHaveLength(6);
  });

  it("a previous window Bing has no data for is null, never zeros (R-1)", async () => {
    const r = await bingReport({ domain: "example.com" }, { days: 60 }, { key: KEY, fetchImpl: fakeBing().fetchImpl, refresh: true });
    expect(r.window).toEqual({ startDate: "2026-08-12", endDate: "2026-10-10" });
    expect(r.previous).toEqual({ startDate: "2026-06-13", endDate: "2026-08-11", clicks: null, impressions: null, ctr: null });
    expect(r.totals.change).toEqual({ clicks: null, impressions: null, ctr: null });
    expect(r.notes.join(" ")).toMatch(/no traffic for the previous window/);
  });

  it("windows past Bing's history are noted; days is clamped to 7..180", () => {
    const days = parseTraffic(JSON.parse(fixture("traffic.json")).d);
    expect(windowsFor(days, 7, "2026-10-12").window).toEqual({ startDate: "2026-10-04", endDate: "2026-10-10" });
    expect(windowsFor([], 7, "2026-10-12").window.endDate).toBe("2026-10-12");
    const rows = parseStatRows(JSON.parse(fixture("query-stats.json")).d, 300);
    expect(topRows(rows, { startDate: "2026-08-01", endDate: "2026-08-31" }, 5)).toEqual([{ key: "old query", clicks: 99, impressions: 999, avgPosition: 1 }]);
  });

  it("a client with no verified site is an error naming bingSite; the override is honoured", async () => {
    const f = fakeBing();
    const err = await bingReport({ domain: "example.org" }, {}, { key: KEY, fetchImpl: f.fetchImpl, refresh: true }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BingSiteError);
    expect((err as Error).message).toMatch(/not verified.*bingSite/);
    const none = await bingReport({ domain: "example.edu" }, {}, { key: KEY, fetchImpl: f.fetchImpl }).catch((e: Error) => e);
    expect((none as Error).message).toMatch(/No verified Bing Webmaster Tools site for example\.edu.*--bing-site/);
    const wrong = await bingReport({ domain: "example.com", bingSite: "https://nope.example.com/" }, {}, { key: KEY, fetchImpl: f.fetchImpl }).catch((e: Error) => e);
    expect((wrong as Error).message).toMatch(/bingSite https:\/\/nope\.example\.com\/ for example\.com isn't a site this Bing key can read/);
    const other = await bingReport({ domain: "example.com", bingSite: "https://example.net/blog/" }, {}, { key: KEY, fetchImpl: f.fetchImpl }).catch((e: Error) => e);
    expect(other).toBeInstanceOf(BingSiteError);
    expect((other as Error).message).toMatch(/is on another host, so it would show another site's Bing data.*--bing-site none/);
    const pinned = await bingReport({ domain: "example.com", bingSite: "http://example.com" }, {}, { key: KEY, fetchImpl: f.fetchImpl, refresh: true });
    expect(pinned).toMatchObject({ site: "http://example.com/", siteSource: "bingSite" });
  });

  it("bingOverview reads a report period and its comparison", async () => {
    const f = fakeBing();
    const r = await bingOverview(
      { domain: "example.com" },
      { window: { startDate: "2026-09-13", endDate: "2026-10-10" }, compare: { which: "previous_year", range: { startDate: "2025-09-13", endDate: "2025-10-10" } }, limit: 2 },
      { key: KEY, fetchImpl: f.fetchImpl, refresh: true },
    );
    expect(r).toMatchObject({ site: "https://www.example.com/", totals: { clicks: 420, change: { clicks: null, impressions: null, ctr: null } }, previous: null, limit: 2, crawl: { issueCount: 3, latest: { date: "2026-10-10" } } });
    expect(r.topQueries).toHaveLength(2);
    expect(r.notes.join(" ")).toMatch(/no traffic for the previous year/);
  });
});

describe("BING_BASE_URL (test-only override)", () => {
  async function loadEnv(shell: string | undefined, envFile: string): Promise<{ BING_BASE_URL: string; BING_WEBMASTER_API_KEY?: string | undefined }> {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const saved = { home: process.env.CRAWLMARK_HOME, base: process.env.BING_BASE_URL, key: process.env.BING_WEBMASTER_API_KEY };
    const home = mkdtempSync(join(tmpdir(), "crawlmark-bing-env-"));
    writeFileSync(join(home, ".env"), envFile);
    process.env.CRAWLMARK_HOME = home;
    if (shell === undefined) delete process.env.BING_BASE_URL;
    else process.env.BING_BASE_URL = shell;
    try {
      vi.resetModules();
      return (await import("../src/config.js")).env;
    } finally {
      process.env.CRAWLMARK_HOME = saved.home;
      process.env.BING_BASE_URL = saved.base;
      if (saved.key === undefined) delete process.env.BING_WEBMASTER_API_KEY;
      else process.env.BING_WEBMASTER_API_KEY = saved.key;
      vi.resetModules();
    }
  }

  it("is honoured only from the shell, and only as https or loopback http", async () => {
    const DEFAULT = "https://ssl.bing.com/webmaster/api.svc/json";
    expect((await loadEnv(undefined, "BING_BASE_URL=http://127.0.0.1:7777\n")).BING_BASE_URL).toBe(DEFAULT);
    expect((await loadEnv("http://127.0.0.1:7777/", "")).BING_BASE_URL).toBe("http://127.0.0.1:7777");
    expect((await loadEnv("http://bing.example.com", "")).BING_BASE_URL).toBe(DEFAULT);
    const e = await loadEnv(undefined, "BING_WEBMASTER_API_KEY=from-env-file\n");
    expect(e.BING_WEBMASTER_API_KEY).toBe("from-env-file");
  });
});

describe("SEC-1: a response body cut mid-stream", () => {
  it("is a network failure named by class only, retried once", async () => {
    const { createServer } = await import("node:http");
    let hits = 0;
    const srv = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json", "content-length": "5000" });
      res.write('{"d":[{"Url":"https://www.example.com/');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    // Real fetch to the loopback server (BING_BASE_URL is the closed test port, so rewrite the origin).
    const fetchImpl = ((u: string, init?: RequestInit) => fetch(u.replace("http://127.0.0.1:9", `http://127.0.0.1:${port}`), init)) as typeof fetch;
    const sleep = vi.fn(noSleep);
    try {
      const err = await bingGet("GetUserSites", {}, { key: KEY, fetchImpl, noCache: true, sleep }).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/^Couldn't reach Bing Webmaster Tools \((TypeError|Error)\)\.$/);
      expect((err as Error).message).not.toMatch(/terminated|other side closed/i);
      expect(hits).toBe(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      const check = await checkBingKey(KEY, fetchImpl);
      expect(check).toMatchObject({ ok: false, problem: expect.stringMatching(/^Couldn't reach Bing Webmaster Tools/) });
    } finally {
      srv.close();
    }
  });
});

describe("SEC-3: Bing cache entries", () => {
  it("hold parsed sites only (no verification codes) and are separated per key by a fingerprint", async () => {
    const f = fakeBing();
    const a = await bingUserSites({ key: KEY, fetchImpl: f.fetchImpl, refresh: true });
    expect(a).toMatchObject({ fromCache: false, sites: expect.arrayContaining([{ url: "https://www.example.com/", verified: true }]) });
    expect(allCache()).not.toMatch(/258CAD|AuthenticationCode|DnsVerificationCode|258cad36/);
    expect(await bingUserSites({ key: KEY, fetchImpl: f.fetchImpl })).toMatchObject({ fromCache: true });
    expect(f.mock).toHaveBeenCalledTimes(1);

    // A different key (a new account after setup --step bing) never gets the old key's cached sites or stats.
    const OTHER = "SENTINEL-bing-other-key-1111";
    const g = fakeBing({ GetUserSites: () => new Response('{"d":[{"Url":"https://example.org/","IsVerified":true}]}') });
    expect(await bingUserSites({ key: OTHER, fetchImpl: g.fetchImpl })).toEqual({ fromCache: false, sites: [{ url: "https://example.org/", verified: true }] });
    await bingGet("GetCrawlIssues", { siteUrl: "https://www.example.com/" }, { key: KEY, fetchImpl: f.fetchImpl, refresh: true });
    await bingGet("GetCrawlIssues", { siteUrl: "https://www.example.com/" }, { key: OTHER, fetchImpl: g.fetchImpl });
    expect(g.urls.map((u) => new URL(u).pathname)).toEqual(["/GetUserSites", "/GetCrawlIssues"]);

    expect(keyFingerprint(KEY)).toMatch(/^[0-9a-f]{8}$/);
    expect(KEY).not.toContain(keyFingerprint(KEY));
    expect(bingCacheKey(KEY, "GetQueryStats", "https://www.example.com/")).not.toBe(bingCacheKey(OTHER, "GetQueryStats", "https://www.example.com/"));
    expect(allCache()).not.toContain(KEY);
    expect(allCache()).not.toContain(OTHER);
  });
});
