/** Release A, D6: the missing-h1 and title-brand-repeated crawl rules, and that a blank meta description already fires missing-description. */
import { describe, expect, it } from "vitest";
import { analyzeCrawl, brandStrings, type CrawlPage } from "../src/analysis/crawl.js";
import { extractCrawlPage } from "../src/analysis/crawl-parse.js";
import { crawlBrandTerms } from "../src/reports/local-crawl.js";

/** A crawled page built from real HTML through the real parser. */
function pageFrom(url: string, doc: string): CrawlPage {
  const x = extractCrawlPage(`<!doctype html><html><head>${doc.split("|||")[0]}</head><body>${doc.split("|||")[1] ?? ""}</body></html>`, url);
  return {
    url,
    depth: 1,
    status: 200,
    finalUrl: url,
    finalStatus: 200,
    redirectChain: [],
    contentType: "text/html",
    title: x.title,
    description: x.description,
    canonical: x.canonical,
    robots: x.robots,
    noindex: false,
    h1Count: x.h1Count,
    inlinks: 1,
    outlinks: x.links.length,
    firstLinkedFrom: null,
    parsed: true,
    issues: [],
  };
}
const rules = (pages: CrawlPage[], brandTerms?: string[]) => analyzeCrawl(pages, { exhaustive: true, ...(brandTerms ? { brandTerms } : {}) }).findings.map((f) => `${f.rule} ${f.url}`);

describe("missing-h1", () => {
  it("flags a page without an H1 and not one with a single H1", () => {
    const none = pageFrom("https://example.com/none", '<title>T</title><meta name="description" content="d">|||<p>No heading</p>');
    const one = pageFrom("https://example.com/one", '<title>T2</title><meta name="description" content="d2">|||<h1>Heading</h1>');
    const got = rules([none, one]);
    expect(got).toContain("missing-h1 https://example.com/none");
    expect(got).not.toContain("missing-h1 https://example.com/one");
    expect(analyzeCrawl([none, one], { exhaustive: true }).summary.missingH1).toBe(1);
  });
  it("never fires when the H1 count is unknown, or on pages whose content wasn't read", () => {
    const unknown = { ...pageFrom("https://example.com/u", "<title>T</title>|||"), h1Count: null };
    const notHtml = { ...pageFrom("https://example.com/p.pdf", "<title>T</title>|||"), contentType: "application/pdf" };
    const notFound = { ...pageFrom("https://example.com/gone", "|||"), status: 404, finalStatus: 404, parsed: false };
    expect(rules([unknown, notHtml, notFound]).filter((r) => r.startsWith("missing-h1"))).toEqual([]);
  });
});

describe("title-brand-repeated", () => {
  const brand = ["Example Plumbing"];
  it("flags a title that has the brand twice, with evidence", () => {
    const p = pageFrom("https://example.com/a", '<title>Plumbing | Example Plumbing | Example Plumbing</title><meta name="description" content="d">|||<h1>x</h1>');
    const a = analyzeCrawl([p], { exhaustive: true, brandTerms: brand });
    const f = a.findings.find((x) => x.rule === "title-brand-repeated")!;
    expect(f.severity).toBe("low");
    expect(f.evidence).toBe('"example plumbing" appears 2 times in "Plumbing | Example Plumbing | Example Plumbing"');
    expect(a.summary.titleBrandRepeated).toBe(1);
    expect(p.issues).toContain("title-brand-repeated");
  });
  it("does not flag the brand once, and needs whole words", () => {
    const once = pageFrom("https://example.com/b", '<title>Example Plumbing – Services</title><meta name="description" content="d">|||<h1>x</h1>');
    const inside = pageFrom("https://example.com/c", '<title>Acme and Acmeology and Acmes</title><meta name="description" content="d2">|||<h1>x</h1>');
    expect(rules([once], brand)).toEqual([]);
    expect(rules([inside], ["acme"])).toEqual([]);
  });
  it("does nothing without brand strings", () => {
    const p = pageFrom("https://example.com/a", '<title>Acme Acme</title><meta name="description" content="d">|||<h1>x</h1>');
    expect(rules([p])).toEqual([]);
  });
  it("drops brand strings under 3 characters and de-duplicates", () => {
    expect(brandStrings(["Ab", "Example  Plumbing!", "example plumbing", "A&B Co."])).toEqual(["example plumbing", "a b co"]);
  });
  it("builds brand strings from name, brand terms and the domain label", () => {
    expect(crawlBrandTerms({ name: "Example Plumbing", domain: "example.com", brandTerms: ["ex plumb"] })).toEqual(["Example Plumbing", "ex plumb", "example"]);
    // name equal to the domain isn't a brand; a short label (< 4 characters) isn't used
    expect(crawlBrandTerms({ name: "abc.com", domain: "abc.com", brandTerms: [] })).toEqual([]);
    expect(crawlBrandTerms({ name: "www.example.com", domain: "www.example.com", brandTerms: [] })).toEqual(["example"]);
  });
});

describe("blank meta description", () => {
  it("a whitespace-only content attribute already fires missing-description", () => {
    const p = pageFrom("https://example.com/blank", '<title>T</title><meta name="description" content="  ">|||<h1>x</h1>');
    expect(p.description).toBeNull();
    expect(rules([p])).toContain("missing-description https://example.com/blank");
    const empty = pageFrom("https://example.com/empty", '<title>T2</title><meta name="description" content="">|||<h1>x</h1>');
    expect(rules([empty])).toContain("missing-description https://example.com/empty");
  });
});

describe("technical_issues re-analysis of a stored crawl", () => {
  it("passes the client's brand names, so title-brand-repeated fires there too", async () => {
    const { crawlIssues } = await import("../src/reports/technical-issues.js");
    const page = pageFrom("https://example.com/a", '<title>Acme Plumbing | Acme Plumbing Co</title><meta name="description" content="d">|||<h1>H</h1>');
    const crawl = { pages: [page], exhaustive: true } as unknown as Parameters<typeof crawlIssues>[0];
    const keys = (c?: Parameters<typeof crawlIssues>[1]) => crawlIssues(crawl, c).map((i) => JSON.stringify(i));
    expect(keys({ name: "Acme Plumbing", domain: "example.com", brandTerms: [] } as never).some((k) => k.includes("title-brand-repeated"))).toBe(true);
    expect(keys().some((k) => k.includes("title-brand-repeated"))).toBe(false);
  });
});
