import { describe, expect, it } from "vitest";
import { diffAudits, monthlyAuditSection, pickComparison, type StoredAudit } from "../src/analysis/diff.js";
import { checkedPairs, extractFindings, findingId, normalizeUrl, onPageSeverity, type Finding } from "../src/analysis/findings.js";
import type { AuditResult } from "../src/reports/audit.js";

const ok = <T>(data: T) => ({ ok: true as const, data });
const fail = (error: string) => ({ ok: false as const, error });

function page(url: string, over: Record<string, unknown> = {}) {
  return {
    url,
    lighthouse: ok({
      url,
      formFactor: "mobile",
      scores: { performance: 95, accessibility: 95, bestPractices: 95, seo: 95 },
      lab: { lcpMs: 1500, cls: 0.01, tbtMs: 0, fcpMs: 0, speedIndexMs: 0 },
      opportunities: [],
    }),
    accessibility: ok({ url, level: "AA", violations: [], counts: { critical: 0, serious: 0, moderate: 0, minor: 0 }, incomplete: 0, passes: 1 }),
    indexing: ok({ url, verdict: "PASS", coverageState: "Submitted and indexed", googleCanonical: url, userCanonical: url }),
    onPage: ok({ failedChecks: [] }),
    ...over,
  };
}

function audit(pages: unknown[], sitemaps: unknown = ok([])): AuditResult {
  return {
    client: { slug: "example.com", name: "Example", domain: "example.com" },
    ranAt: "2026-10-01T00:00:00.000Z",
    settings: { formFactor: "mobile", wcagLevel: "AA", pages: pages.length },
    summary: {},
    site: { sitemaps, crawl: null, backlinks: null },
    pages,
  } as unknown as AuditResult;
}

const stored = (id: string, ranAt: number, a: AuditResult): StoredAudit => ({
  id,
  client: "example.com",
  ranAt,
  settings: a.settings,
  summary: a.summary,
  findings: extractFindings(a),
  checked: checkedPairs(a),
  result: a,
});

describe("extractFindings", () => {
  const url = "https://example.com/";

  it("maps axe impacts and uses the first example selector as evidence", () => {
    const a = audit([
      page(url, {
        accessibility: ok({
          violations: [
            { id: "color-contrast", impact: "serious", help: "Contrast", nodes: 2, examples: [".btn", ".nav"] },
            { id: "region", impact: "minor", help: "Region", nodes: 1, examples: [] },
            { id: "label", impact: "critical", help: "Label", nodes: 1, examples: ["#q"] },
            { id: "list", impact: "moderate", help: "List", nodes: 1, examples: ["ul"] },
          ],
        }),
      }),
    ]);
    const f = extractFindings(a);
    const by = Object.fromEntries(f.map((x) => [x.rule, x]));
    expect(by["color-contrast"]).toMatchObject({ severity: "high", evidence: ".btn; 2 nodes", source: "axe" });
    expect(by["region"]!.severity).toBe("low");
    expect(by["label"]!.severity).toBe("critical");
    expect(by["list"]!.severity).toBe("medium");
  });

  it("maps lighthouse scores, lab metrics and opportunities by threshold", () => {
    const a = audit([
      page(url, {
        lighthouse: ok({
          scores: { performance: 40, accessibility: 89, bestPractices: 90, seo: 50 },
          lab: { lcpMs: 4001, cls: 0.12 },
          opportunities: [
            { id: "render-blocking-resources", title: "Eliminate render-blocking", savingsMs: 800 },
            { id: "small", title: "Small", savingsMs: 500 },
            { id: "none", title: "None" },
          ],
        }),
      }),
    ]);
    const by = Object.fromEntries(extractFindings(a).map((x) => [x.rule, x.severity]));
    expect(by).toEqual({
      "category-performance": "high",
      "category-accessibility": "medium",
      "category-seo": "medium",
      "largest-contentful-paint": "high",
      "cumulative-layout-shift": "medium",
      "render-blocking-resources": "low",
    });
    const mid = extractFindings(audit([page(url, { lighthouse: ok({ scores: { performance: 95, accessibility: 95, bestPractices: 95, seo: 95 }, lab: { lcpMs: 2600, cls: 0.3 }, opportunities: [] }) })]));
    expect(Object.fromEntries(mid.map((x) => [x.rule, x.severity]))).toEqual({ "largest-contentful-paint": "medium", "cumulative-layout-shift": "high" });
  });

  it("maps indexing verdicts and canonical mismatches", () => {
    const a = audit([
      page(url, { indexing: ok({ verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed", googleCanonical: "https://example.com/a", userCanonical: "https://example.com/b" }) }),
    ]);
    const f = extractFindings(a);
    expect(f.find((x) => x.rule === "not-indexed")).toMatchObject({ severity: "high", evidence: "Crawled - currently not indexed" });
    expect(f.find((x) => x.rule === "canonical-mismatch")!.severity).toBe("medium");
    // trailing slash alone is not a mismatch
    const same = audit([page(url, { indexing: ok({ verdict: "PASS", googleCanonical: "https://example.com/x/", userCanonical: "https://example.com/x" }) })]);
    expect(extractFindings(same)).toEqual([]);
  });

  it("maps on-page checks through the severity table", () => {
    expect(onPageSeverity("no_title")).toBe("high");
    expect(onPageSeverity("is_5xx_code")).toBe("high");
    expect(onPageSeverity("no_h1_tag")).toBe("medium");
    expect(onPageSeverity("flash")).toBe("low");
    const f = extractFindings(audit([page(url, { onPage: ok({ failedChecks: ["no_description", "is_broken", "title_too_long"] }) })]));
    expect(f.map((x) => [x.rule, x.severity])).toEqual([
      ["no_description", "medium"],
      ["is_broken", "high"],
      ["title_too_long", "low"],
    ]);
  });

  it("maps sitemaps: errors high, warnings low, clean none", () => {
    const f = extractFindings(
      audit([], ok([{ path: "https://example.com/a.xml", errors: 2, warnings: 1 }, { path: "https://example.com/b.xml", errors: 0, warnings: 3 }, { path: "https://example.com/c.xml", errors: 0, warnings: 0 }])),
    );
    expect(f.map((x) => [x.url, x.severity])).toEqual([["https://example.com/a.xml", "high"], ["https://example.com/b.xml", "low"]]);
  });

  it("emits nothing for failed sections", () => {
    const a = audit([page(url, { lighthouse: fail("x"), accessibility: fail("x"), indexing: fail("x"), onPage: fail("x") })], fail("x"));
    expect(extractFindings(a)).toEqual([]);
    expect(checkedPairs(a)).toEqual([]);
  });

  it("gives stable ids that ignore URL noise and differ by selector", () => {
    expect(findingId("axe", "r", "https://Example.com/a/#frag")).toBe(findingId("axe", "r", "https://example.com/a"));
    expect(findingId("axe", "r", "https://example.com/a")).not.toBe(findingId("onpage", "r", "https://example.com/a"));
    // A different first axe selector is the same finding.
    const axeWith = (sel: string) =>
      extractFindings(audit([page("https://example.com/", { accessibility: ok({ violations: [{ id: "r", impact: "minor", help: "h", nodes: 1, examples: [sel] }] }) })]));
    expect(axeWith(".x")[0]!.id).toBe(axeWith(".y")[0]!.id);
    expect(axeWith(".y")[0]!.evidence).toBe(".y; 1 node");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
    const a = audit([page(url, { onPage: ok({ failedChecks: ["no_title"] }) })]);
    expect(extractFindings(a)).toEqual(extractFindings(a));
  });
});

describe("diffAudits", () => {
  const u1 = "https://example.com/";
  const u2 = "https://example.com/about";
  const withChecks = (url: string, failed: string[]) => page(url, { onPage: ok({ failedChecks: failed }) });

  it("splits new, resolved, persistent and sorts by severity then URL", () => {
    const base = stored("a", 1000, audit([withChecks(u1, ["no_title", "no_h1_tag"]), withChecks(u2, ["is_broken"])]));
    const target = stored("b", 2000, audit([withChecks(u1, ["no_title", "flash"]), withChecks(u2, ["no_description", "no_title"])]));
    const d = diffAudits(base, target);
    expect(d.persistent.map((f) => f.rule)).toEqual(["no_title"]);
    expect(d.resolved.map((f) => [f.rule, f.url])).toEqual([["is_broken", u2], ["no_h1_tag", u1]]);
    expect(d.new.map((f) => [f.severity, f.url, f.rule])).toEqual([
      ["high", u2, "no_title"],
      ["medium", u2, "no_description"],
      ["low", u1, "flash"],
    ]);
    expect(d.counts).toEqual({ new: 3, firstChecked: 0, resolved: 2, persistent: 1, unverified: 0, retired: 0 });
    expect(d.base).toEqual({ auditId: "a", ranAt: new Date(1000).toISOString() });
  });

  it("marks a finding unverified when its check errored in the target", () => {
    const base = stored("a", 1000, audit([withChecks(u1, ["no_title"])]));
    const target = stored("b", 2000, audit([page(u1, { onPage: fail("sandbox 500") })]));
    const d = diffAudits(base, target);
    expect(d.unverified.map((f) => f.rule)).toEqual(["no_title"]);
    expect(d.resolved).toEqual([]);
    expect(d.counts.unverified).toBe(1);
  });

  it("marks findings unverified when the URL was not audited at all, and site findings when sitemaps failed", () => {
    const sm = ok([{ path: "https://example.com/s.xml", errors: 1, warnings: 0 }]);
    const base = stored("a", 1000, audit([withChecks(u1, ["no_title"]), withChecks(u2, ["no_title"])], sm));
    const t1 = stored("b", 2000, audit([withChecks(u1, [])], fail("no access")));
    const d = diffAudits(base, t1);
    expect(d.resolved.map((f) => f.url)).toEqual([u1]);
    expect(d.unverified.map((f) => f.url).sort()).toEqual([u2, "https://example.com/s.xml"].sort());
    const t2 = stored("c", 3000, audit([withChecks(u1, []), withChecks(u2, [])], ok([])));
    expect(diffAudits(base, t2).resolved).toHaveLength(3);
  });

  it("treats an empty onPage result as not checked", () => {
    const base = stored("a", 1000, audit([withChecks(u1, ["no_title"])]));
    const target = stored("b", 2000, audit([page(u1, { onPage: ok(null) })]));
    expect(diffAudits(base, target).unverified).toHaveLength(1);
  });

  it("reports identical audits as all persistent and lists score changes", () => {
    const a = audit([withChecks(u1, ["no_title"])]);
    const d0 = diffAudits(stored("a", 1, a), stored("b", 2, a));
    expect(d0.counts).toEqual({ new: 0, firstChecked: 0, resolved: 0, persistent: 1, unverified: 0, retired: 0 });
    expect(d0.scoreChanges).toEqual([]);

    const b = audit([
      page(u1, {
        onPage: ok({ failedChecks: ["no_title"] }),
        lighthouse: ok({ scores: { performance: 90, accessibility: 95, bestPractices: 95, seo: 95 }, lab: { lcpMs: 1, cls: 0 }, opportunities: [] }),
      }),
    ]);
    expect(diffAudits(stored("a", 1, a), stored("b", 2, b)).scoreChanges).toEqual([{ url: "https://example.com", category: "performance", from: 95, to: 90 }]);
  });

  it("warns on settings mismatches and on non-fresh targets close to the base", () => {
    const a = audit([withChecks(u1, [])]);
    const mk = (id: string, ranAt: number, settings: Record<string, unknown>): StoredAudit => ({ ...stored(id, ranAt, a), settings });
    const s = { formFactor: "mobile", wcagLevel: "AA", fresh: true };
    expect(diffAudits(mk("a", 0, s), mk("b", 1000, s)).warnings).toEqual([]);
    const w = diffAudits(mk("a", 0, s), mk("b", 1000, { ...s, formFactor: "desktop", wcagLevel: "A" })).warnings;
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/form factor/);
    expect(w[1]).toMatch(/WCAG/);
    expect(diffAudits(mk("a", 0, s), mk("b", 1000, { ...s, fresh: false })).warnings[0]).toMatch(/not run fresh/);
    expect(diffAudits(mk("a", 0, s), mk("b", 25 * 3600_000, { ...s, fresh: false })).warnings).toEqual([]);
    // Audits saved before the flag existed count as not fresh.
    const { fresh: _f, ...legacy } = s;
    expect(diffAudits(mk("a", 0, s), mk("b", 1000, legacy)).warnings[0]).toMatch(/not run fresh/);
  });

  it("keys score changes on the normalised URL", () => {
    const mkPage = (url: string, perf: number) =>
      page(url, { lighthouse: ok({ scores: { performance: perf, accessibility: 95, bestPractices: 95, seo: 95 }, lab: { lcpMs: 1, cls: 0 }, opportunities: [] }) });
    const d = diffAudits(stored("a", 1, audit([mkPage("https://example.com/", 90)])), stored("b", 2, audit([mkPage("https://Example.com", 80)])));
    expect(d.scoreChanges).toEqual([{ url: "https://example.com", category: "performance", from: 90, to: 80 }]);
  });

  it("keeps ids on findings it returns", () => {
    const f: Finding[] = diffAudits(stored("a", 1, audit([withChecks(u1, [])])), stored("b", 2, audit([withChecks(u1, ["flash"])]))).new;
    expect(f[0]!.id).toBe(findingId("onpage", "flash", u1));
  });
});

describe("pickComparison", () => {
  const mk = (id: string, ranAt: number, client = "example.com"): StoredAudit => ({ ...stored(id, ranAt, audit([])), client });
  const all = [mk("a1", 1000), mk("a2", 2000), mk("a3", 3000), mk("o1", 2500, "example.org")];
  const store = {
    get: (id: string) => all.find((a) => a.id === id),
    latest: () => all.filter((a) => a.client === "example.com").sort((x, y) => y.ranAt - x.ranAt)[0],
    before: (t: number) => all.filter((a) => a.client === "example.com" && a.ranAt < t).sort((x, y) => y.ranAt - x.ranAt)[0],
  };
  const pick = (args: { baseAuditId?: string; targetAuditId?: string }) => {
    const r = pickComparison("example.com", args, store);
    return [r.base.id, r.target.id];
  };

  it("defaults to the latest audit versus the one before it", () => expect(pick({})).toEqual(["a2", "a3"]));
  it("handles one ID", () => {
    expect(pick({ targetAuditId: "a2" })).toEqual(["a1", "a2"]);
    expect(pick({ baseAuditId: "a1" })).toEqual(["a1", "a3"]);
  });
  it("accepts two IDs", () => expect(pick({ baseAuditId: "a1", targetAuditId: "a3" })).toEqual(["a1", "a3"]));
  it("errors clearly", () => {
    expect(() => pickComparison("none.example", {}, { ...store, latest: () => undefined })).toThrow(/no saved audits/);
    expect(() => pick({ targetAuditId: "a1" })).toThrow(/older than a1/);
    expect(() => pick({ baseAuditId: "missing" })).toThrow(/No audit "missing"/);
    expect(() => pick({ baseAuditId: "o1" })).toThrow(/No audit "o1" for example.com/);
    expect(() => pick({ baseAuditId: "a3", targetAuditId: "a1" })).toThrow(/newer than the target/);
    expect(() => pick({ baseAuditId: "a2", targetAuditId: "a2" })).toThrow(/same audit/);
  });
});

describe("monthlyAuditSection", () => {
  const a = stored("old", 1000, audit([]));
  const b = stored("new", 2000, audit([]));
  it("is null unless a later audit and one from before the month both exist", () => {
    expect(monthlyAuditSection(undefined, undefined)).toBeNull();
    expect(monthlyAuditSection(b, undefined)).toBeNull();
    expect(monthlyAuditSection(undefined, a)).toBeNull();
    expect(monthlyAuditSection(a, a)).toBeNull();
  });
  it("returns the latest summary and its diff against the earlier audit", () => {
    const s = monthlyAuditSection(b, a)!;
    expect(s.auditId).toBe("new");
    expect(s.diff.base.auditId).toBe("old");
    expect(s.diff.counts.persistent).toBe(0);
  });
});
