/**
 * Release A, D8: technical-issues diffs only call an item "new" when the base run covered it. Items the base never looked
 * at are "first_checked"; items of a Tag Manager container the audit replaced are "retired", never resolved.
 */
import { describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import type { StoredAudit } from "../src/analysis/diff.js";
import type { CrawlPage } from "../src/analysis/crawl.js";
import { findingId, type Finding } from "../src/analysis/findings.js";
import { CATALOGUE, canonicalOf, diffIssues, mergeIssues, type RawIssue } from "../src/analysis/tech-issues.js";
import { newAuditId, saveAudit } from "../src/lib/audits.js";
import { newCrawlId, saveCrawl } from "../src/lib/crawls.js";
import { loadTechIssuesDeps, technicalIssues, TOOL_BASE_AGE_MS, type TechIssuesDeps } from "../src/reports/technical-issues.js";
import type { SourceRun } from "../src/reports/report-types.js";

const E = "https://example.com";
const raw = (o: Partial<RawIssue> & Pick<RawIssue, "source" | "rule">): RawIssue => ({ url: `${E}/a`, severity: "medium", nativeSeverity: "medium", title: o.rule, count: null, ...o });
const run = (source: SourceRun["source"], runId: string, ranAt: string, o: Partial<SourceRun> = {}): SourceRun => ({ source, runId, ranAt, stale: false, ...o });

describe("first_checked (pure)", () => {
  it("a crawl issue is first_checked when the base snapshot had no local_crawl run", () => {
    const base = { items: mergeIssues([raw({ source: "audit", rule: "axe:button-name", url: `${E}/a` })]), checked: [run("audit", "a1", "2026-09-01T00:00:00Z", { checks: ["axe"] })] };
    const current = {
      items: mergeIssues([raw({ source: "audit", rule: "axe:button-name", url: `${E}/a` }), raw({ source: "local_crawl", rule: "missing-title", url: `${E}/b` })]),
      checked: [run("audit", "a1", "2026-09-01T00:00:00Z", { checks: ["axe"] }), run("local_crawl", "c1", "2026-10-01T00:00:00Z")],
    };
    const d = diffIssues(current, base);
    expect(d.items.find((i) => i.key === "missing-title")?.change).toBe("first_checked");
    expect(d.changes).toEqual({ new: 0, firstChecked: 1, resolved: 0, persistent: 1, unverified: 0, retired: 0 });
  });

  it("an audit finding whose source the base audit didn't run is first_checked; one it did run is new", () => {
    const base = { items: [], checked: [run("audit", "a1", "2026-09-01T00:00:00Z", { checks: ["axe"] })] };
    const current = {
      items: mergeIssues([raw({ source: "audit", rule: "axe:button-name", url: `${E}/a` }), raw({ source: "audit", rule: "lighthouse:largest-contentful-paint", url: `${E}/a` })]),
      checked: [run("audit", "a2", "2026-10-01T00:00:00Z", { checks: ["axe", "lighthouse"] })],
    };
    const d = diffIssues(current, { items: base.items, checked: base.checked });
    expect(d.items.map((i) => [i.key, i.change]).sort()).toEqual([
      ["a11y:button-name", "new"],
      ["slow-lcp", "first_checked"],
    ]);
  });

  it("baseCovered decides URL-level items when it returns a boolean", () => {
    const base = { items: [], checked: [run("local_crawl", "c1", "2026-09-01T00:00:00Z")] };
    const current = { items: mergeIssues([raw({ source: "local_crawl", rule: "missing-title", url: `${E}/b` }), raw({ source: "local_crawl", rule: "missing-description", url: `${E}/c` })]), checked: [run("local_crawl", "c2", "2026-10-01T00:00:00Z")] };
    const d = diffIssues(current, base, { now: Date.parse("2026-10-02T00:00:00Z"), maxAgeDays: 45, baseCovered: (_s, _r, url) => (url === `${E}/b` ? false : url === `${E}/c` ? true : undefined) });
    expect(d.items.map((i) => [i.key, i.change]).sort()).toEqual([
      ["missing-description", "new"],
      ["missing-title", "first_checked"],
    ]);
  });
});

describe("retired (pure)", () => {
  it("items of a replaced Tag Manager container are retired and never resolved or unverified", () => {
    const old = mergeIssues([raw({ source: "audit", rule: "gtm:unused-tag", url: "gtm://GTM-AAAA111/tag/1" }), raw({ source: "audit", rule: "gtm:unused-tag", url: "gtm://GTM-AAAA111/tag/2" })]);
    const base = { items: old, checked: [run("audit", "a1", "2026-09-01T00:00:00Z", { checks: ["gtm"], gtmContainer: "GTM-AAAA111" })] };
    const current = {
      items: mergeIssues([raw({ source: "audit", rule: "gtm:unused-tag", url: "gtm://GTM-BBBB222/tag/9" })]),
      checked: [run("audit", "a2", "2026-10-01T00:00:00Z", { checks: ["gtm"], gtmContainer: "GTM-BBBB222" })],
    };
    const d = diffIssues(current, base);
    expect(d.retired).toHaveLength(2);
    expect(d.resolved).toEqual([]);
    expect(d.unverified).toEqual([]);
    expect(d.items.map((i) => [i.url, i.change])).toEqual([["gtm://GTM-BBBB222/tag/9", "first_checked"]]);
    expect(d.changes).toMatchObject({ retired: 2, firstChecked: 1, new: 0, resolved: 0 });
    expect(d.notes.join("\n")).toMatch(/Tag Manager container changed from GTM-AAAA111 to GTM-BBBB222/);
  });

  it("the same container keeps new / resolved semantics", () => {
    const base = { items: mergeIssues([raw({ source: "audit", rule: "gtm:unused-tag", url: "gtm://GTM-AAAA111/tag/1" })]), checked: [run("audit", "a1", "2026-09-01T00:00:00Z", { checks: ["gtm"], gtmContainer: "GTM-AAAA111" })] };
    const current = { items: mergeIssues([raw({ source: "audit", rule: "gtm:unused-tag", url: "gtm://GTM-AAAA111/tag/2" })]), checked: [run("audit", "a2", "2026-10-01T00:00:00Z", { checks: ["gtm"], gtmContainer: "GTM-AAAA111" })] };
    const d = diffIssues(current, base);
    expect(d.retired).toEqual([]);
    expect(d.resolved).toHaveLength(1);
    expect(d.items[0]?.change).toBe("new");
    expect(d.notes).toEqual([]);
  });

  it("an older snapshot without gtmContainer falls back to the source-level rule", () => {
    const base = { items: [], checked: [run("audit", "a1", "2026-09-01T00:00:00Z", { checks: ["gtm"] })] };
    const current = { items: mergeIssues([raw({ source: "audit", rule: "gtm:unused-tag", url: "gtm://GTM-BBBB222/tag/9" })]), checked: [run("audit", "a2", "2026-10-01T00:00:00Z", { checks: ["gtm"], gtmContainer: "GTM-BBBB222" })] };
    expect(diffIssues(current, base).items[0]?.change).toBe("new");
  });
});

describe("catalogue rows for the crawl rules (contract with the crawl workstream)", () => {
  it("maps missing-h1 from the crawl and the new brand-repeat rule", () => {
    expect(canonicalOf(raw({ source: "local_crawl", rule: "missing-h1" })).key).toBe("missing-h1");
    expect(canonicalOf(raw({ source: "local_crawl", rule: "title-brand-repeated" }))).toEqual({ key: "title-brand-repeated", title: "Title repeats the brand name", category: "content" });
    const patterns = CATALOGUE.flatMap((r) => r.match);
    expect(new Set(patterns).size).toBe(patterns.length);
  });
});

// ---- end to end over the temp stores ----

const finding = (source: Finding["source"], rule: string, url: string, severity: Finding["severity"]): Finding => ({ id: findingId(source, rule, url), source, rule, url, severity, title: rule });
const page = (url: string, o: Partial<CrawlPage> = {}): CrawlPage => ({ url, depth: 0, status: 200, finalUrl: url, finalStatus: 200, redirectChain: [], contentType: "text/html", title: `T ${url}`, description: `D ${url}`, canonical: null, robots: null, noindex: false, h1Count: 1, inlinks: 1, outlinks: 0, firstLinkedFrom: null, parsed: true, issues: [], ...o });
const C = (slug: string) => ({ slug, domain: "example.com", name: "Example Co" }) as unknown as Client;

function storeAudit(client: string, ranAt: number, findings: Finding[], checked: StoredAudit["checked"], container?: string): StoredAudit {
  const a: StoredAudit = { id: newAuditId(ranAt), client, ranAt, settings: {}, summary: {}, findings, checked, result: container ? { site: { tagManager: { ok: true, data: { container: { publicId: container } } } } } : {} };
  saveAudit(a);
  return a;
}

describe("technicalIssues over stored sources", () => {
  it("a page the base audit didn't check is first_checked; a crawl page the base crawl didn't fetch is first_checked", async () => {
    const slug = "ti-first.example.com";
    const t0 = Date.parse("2026-10-09T08:00:00Z");
    storeAudit(slug, t0, [], [{ url: `${E}/a`, source: "axe" }]);
    saveCrawl({ id: newCrawlId(t0 + 1000), client: slug, ranAt: t0 + 1000, settings: {}, summary: {}, exhaustive: true, pages: [page(`${E}/`), page(`${E}/a`)] });
    let now = t0 + 3_600_000;
    const deps: TechIssuesDeps = { ...(await loadTechIssuesDeps()), now: () => now, latestCrawlTask: () => undefined };
    await technicalIssues(C(slug), { baseBeforeMs: now - TOOL_BASE_AGE_MS, limit: 50 }, deps);

    now += 25 * 3_600_000;
    storeAudit(slug, now - 5000, [finding("axe", "button-name", `${E}/a`, "high"), finding("axe", "button-name", `${E}/b`, "high")], [{ url: `${E}/a`, source: "axe" }, { url: `${E}/b`, source: "axe" }]);
    saveCrawl({ id: newCrawlId(now - 1000), client: slug, ranAt: now - 1000, settings: {}, summary: {}, exhaustive: true, pages: [page(`${E}/`), page(`${E}/a`), page(`${E}/c`, { title: null })] });
    const r = await technicalIssues(C(slug), { baseBeforeMs: now - TOOL_BASE_AGE_MS, limit: 50 }, deps);
    const by = (key: string, url: string) => r.issues.find((i) => i.key === key && i.url === url)?.change;
    expect(by("a11y:button-name", `${E}/a`)).toBe("new");
    expect(by("a11y:button-name", `${E}/b`)).toBe("first_checked");
    expect(by("missing-title", `${E}/c`)).toBe("first_checked");
    expect(r.changes).toMatchObject({ new: 1, firstChecked: 2, retired: 0 });
  });

  it("a Tag Manager container change retires the old container's items and notes it", async () => {
    const slug = "ti-gtm.example.com";
    const t0 = Date.parse("2026-10-09T08:00:00Z");
    storeAudit(slug, t0, [finding("gtm", "unused-tag", "gtm://GTM-AAAA111/tag/1", "medium")], [{ url: "gtm://GTM-AAAA111", source: "gtm" }], "GTM-AAAA111");
    let now = t0 + 3_600_000;
    const deps: TechIssuesDeps = { ...(await loadTechIssuesDeps()), now: () => now, latestCrawlTask: () => undefined };
    const first = await technicalIssues(C(slug), { baseBeforeMs: now - TOOL_BASE_AGE_MS, limit: 50, sources: ["audit"] }, deps);
    expect(first.sources[0]?.gtmContainer).toBe("GTM-AAAA111");

    now += 25 * 3_600_000;
    storeAudit(slug, now - 5000, [finding("gtm", "unused-tag", "gtm://GTM-BBBB222/tag/9", "medium")], [{ url: "gtm://GTM-BBBB222", source: "gtm" }], "GTM-BBBB222");
    const r = await technicalIssues(C(slug), { baseBeforeMs: now - TOOL_BASE_AGE_MS, limit: 50, sources: ["audit"] }, deps);
    expect(r.changes).toMatchObject({ retired: 1, firstChecked: 1, resolved: 0, unverified: 0 });
    expect(r.resolved).toEqual([]);
    expect(r.issues.map((i) => i.url)).toEqual(["gtm://GTM-BBBB222/tag/9"]);
    expect(r.notes?.join("\n")).toMatch(/Tag Manager container changed from GTM-AAAA111 to GTM-BBBB222/);
  });
});
