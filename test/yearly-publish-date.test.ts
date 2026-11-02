/**
 * Release 0.5.0 Y2.1: publish dates read from a crawled page (C4 content_by_year, decision C-D2). Pure: cheerio-loaded
 * strings, no network. A sitemap lastmod, dateModified or HTTP Last-Modified is never a publish date.
 */
import * as cheerio from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractPublished, MAX_JSONLD_SCRIPTS, MAX_JSONLD_CHARS } from "../src/analysis/publish-date.js";
import { extractCrawlPage } from "../src/analysis/crawl-parse.js";

const U = "https://example.com/blog/post";
const read = (head: string, url = U) => extractPublished(cheerio.load(`<!doctype html><html><head>${head}</head><body></body></html>`), url);
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const HOME = "https://example.com/";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("extractPublished", () => {
  it("reads datePublished from a BlogPosting as YYYY-MM-DD (jsonld)", () => {
    expect(read(ld({ "@type": "BlogPosting", datePublished: "2023-04-02T10:00:00Z" }))).toEqual({ date: "2023-04-02", source: "jsonld" });
  });
  it("walks @graph and arrays, and accepts @type as an array", () => {
    expect(read(ld({ "@context": "https://schema.org", "@graph": [{ "@type": "Organization", name: "x" }, { "@type": ["Thing", "Article"], datePublished: "2021-01-05" }] }))).toEqual({ date: "2021-01-05", source: "jsonld" });
    expect(read(ld([{ "@type": "WebSite" }, { "@type": "NewsArticle", datePublished: "2020-02-03" }]))).toEqual({ date: "2020-02-03", source: "jsonld" });
    expect(read(ld({ "@graph": [{ "@type": "WebPage", datePublished: "2019-09-09" }] }))).toEqual({ date: "2019-09-09", source: "jsonld" });
  });
  it("ignores objects of other types and dateModified", () => {
    expect(read(ld({ "@type": "Organization", datePublished: "2023-04-02" }), HOME)).toBeNull();
    expect(read(ld({ "@type": "Article", dateModified: "2024-05-05" }), HOME)).toBeNull();
  });
  it("reads article:published_time, then time[itemprop=datePublished]", () => {
    expect(read('<meta property="article:published_time" content="2022-06-30T08:00:00+02:00">')).toEqual({ date: "2022-06-30", source: "meta" });
    expect(read('<meta property="article:modified_time" content="2022-06-30T08:00:00Z">', HOME)).toBeNull();
    const $ = cheerio.load('<html><body><time itemprop="datePublished" datetime="2018-11-12">12 Nov</time></body></html>');
    expect(extractPublished($, HOME)).toEqual({ date: "2018-11-12", source: "meta" });
    const $2 = cheerio.load('<html><body><time itemprop="datePublished">12 Nov</time></body></html>');
    expect(extractPublished($2, HOME)).toBeNull();
  });
  it("reads a year (and month) from the URL path", () => {
    expect(read("", "https://example.com/2019/05/slug/")).toEqual({ date: "2019-05", source: "url" });
    expect(read("", "https://example.com/2021/slug")).toEqual({ date: "2021", source: "url" });
    expect(read("", "https://example.com/2021/13/slug")).toEqual({ date: "2021", source: "url" });
  });
  it("rejects years before 1995 and dates more than a day ahead", () => {
    expect(read("", "https://example.com/1990/slug/")).toBeNull();
    expect(read('<meta property="article:published_time" content="1994-12-31">', HOME)).toBeNull();
    expect(read(ld({ "@type": "Article", datePublished: "2026-10-16" }), HOME)).toBeNull();
    expect(read(ld({ "@type": "Article", datePublished: "2026-10-14" }), HOME)).toEqual({ date: "2026-10-14", source: "jsonld" });
    expect(read(ld({ "@type": "Article", datePublished: "not a date" }), HOME)).toBeNull();
  });
  it("falls through an invalid higher source to the next", () => {
    expect(read(ld({ "@type": "Article", datePublished: "2026-12-01" }) + '<meta property="article:published_time" content="2020-01-01">')).toEqual({ date: "2020-01-01", source: "meta" });
  });
  it("prefers JSON-LD over meta over the URL", () => {
    const meta = '<meta property="article:published_time" content="2022-01-01">';
    expect(read(meta + ld({ "@type": "Article", datePublished: "2023-03-03" }), "https://example.com/2019/slug/")).toEqual({ date: "2023-03-03", source: "jsonld" });
    expect(read(meta, "https://example.com/2019/slug/")).toEqual({ date: "2022-01-01", source: "meta" });
  });
  it("skips malformed JSON-LD without throwing and keeps reading the next script", () => {
    const bad = '<script type="application/ld+json">{ not json</script>';
    expect(read(bad + ld({ "@type": "Article", datePublished: "2017-07-07" }))).toEqual({ date: "2017-07-07", source: "jsonld" });
  });
  it("skips a script over the size cap and ignores scripts after the 20th", () => {
    const big = `<script type="application/ld+json">${JSON.stringify({ "@type": "Article", datePublished: "2017-07-07", pad: "x".repeat(MAX_JSONLD_CHARS) })}</script>`;
    expect(read(big, HOME)).toBeNull();
    const filler = Array.from({ length: MAX_JSONLD_SCRIPTS }, () => ld({ "@type": "Organization" })).join("");
    expect(read(filler + ld({ "@type": "Article", datePublished: "2017-07-07" }), HOME)).toBeNull();
    const nineteen = Array.from({ length: MAX_JSONLD_SCRIPTS - 1 }, () => ld({ "@type": "Organization" })).join("");
    expect(read(nineteen + ld({ "@type": "Article", datePublished: "2017-07-07" }), HOME)).toEqual({ date: "2017-07-07", source: "jsonld" });
  });
  it("looks four levels deep and no further", () => {
    const deep = { a: { b: { c: { d: { "@type": "Article", datePublished: "2017-07-07" } } } } };
    expect(read(ld(deep), HOME)).toBeNull();
    const ok = { a: { b: { c: { "@type": "Article", datePublished: "2017-07-07" } } } };
    expect(read(ld(ok), HOME)).toEqual({ date: "2017-07-07", source: "jsonld" });
  });
  it("takes only a page and its address: no sitemap or header input exists", () => {
    expect(extractPublished.length).toBe(2);
  });
});

describe("extractCrawlPage", () => {
  it("returns published alongside the other fields", () => {
    const html = `<!doctype html><html><head><title>T</title>${ld({ "@type": "BlogPosting", datePublished: "2023-04-02" })}</head><body><h1>H</h1></body></html>`;
    expect(extractCrawlPage(html, U).published).toEqual({ date: "2023-04-02", source: "jsonld" });
    expect(extractCrawlPage("<html><body><h1>x</h1></body></html>", HOME).published).toBeNull();
  });
});
