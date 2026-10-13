/**
 * Phase 12 C1: crawl findings in saved audits and the diff's resolved/unverified semantics.
 * Pure: hand-built audit results.
 */
import { describe, expect, it } from "vitest";
import { diffAudits, type StoredAudit } from "../src/analysis/diff.js";
import { checkedPairs, checkOf, extractFindings, findingId, type Finding } from "../src/analysis/findings.js";
import type { AuditResult } from "../src/reports/audit.js";

const E = "https://example.com";
const f = (rule: string, url: string, severity: Finding["severity"] = "medium"): Finding => ({ id: findingId("crawl", rule, url), source: "crawl", rule, url, severity, title: rule });

function audit(id: string, ranAt: number, crawl?: { findings: Finding[]; checked: string[] }): StoredAudit {
  const a = {
    client: { slug: "example.com" },
    settings: {},
    summary: {},
    pages: [],
    site: { sitemaps: { ok: false, error: "x" }, crawl: null, backlinks: null, hygiene: { ok: false, error: "x" }, ...(crawl ? { localCrawl: { ok: true, data: crawl } } : {}) },
  } as unknown as AuditResult;
  return { id, client: "example.com", ranAt, settings: {}, summary: {}, findings: extractFindings(a), checked: checkedPairs(a), result: a };
}

describe("crawl findings in audits", () => {
  it("extracts crawl findings and checked pairs; duplicates depend on a complete crawl", () => {
    const a = audit("a", 1, { findings: [f("broken-internal-link", `${E}/gone`, "high"), f("duplicate-title", `${E}/a`)], checked: ["site:crawl", "site:crawl-complete", `${E}/gone`, `${E}/a`] });
    expect(a.findings.map((x) => x.rule).sort()).toEqual(["broken-internal-link", "duplicate-title"]);
    expect(a.checked).toEqual(expect.arrayContaining([{ url: "site:crawl", source: "crawl" }, { url: `${E}/gone`, source: "crawl" }]));
    expect(checkOf({ source: "crawl", rule: "duplicate-title", url: `${E}/a` })).toEqual({ url: "site:crawl-complete", source: "crawl" });
    expect(checkOf({ source: "crawl", rule: "missing-title", url: `${E}/a/` })).toEqual({ url: `${E}/a`, source: "crawl" });
  });

  it("a fixed page in a complete crawl resolves; a capped crawl leaves duplicates unverified; no crawl leaves everything unverified", () => {
    const base = audit("a", 1, { findings: [f("broken-internal-link", `${E}/gone`, "high"), f("duplicate-title", `${E}/a`), f("missing-title", `${E}/b`, "high")], checked: ["site:crawl", "site:crawl-complete", `${E}/gone`, `${E}/a`, `${E}/b`] });

    const complete = diffAudits(base, audit("b", 2, { findings: [], checked: ["site:crawl", "site:crawl-complete", `${E}/gone`, `${E}/a`, `${E}/b`] }));
    expect(complete.resolved.map((x) => x.rule).sort()).toEqual(["broken-internal-link", "duplicate-title", "missing-title"]);

    // Capped: /b and /gone were fetched again (fixed), /a too, but its duplicate partner may not have been.
    const capped = diffAudits(base, audit("c", 3, { findings: [], checked: ["site:crawl", `${E}/a`, `${E}/b`] }));
    expect(capped.resolved.map((x) => x.rule).sort()).toEqual(["missing-title"]);
    expect(capped.unverified.map((x) => x.rule).sort()).toEqual(["broken-internal-link", "duplicate-title"]);

    const none = diffAudits(base, audit("d", 4));
    expect(none.resolved).toEqual([]);
    expect(none.unverified).toHaveLength(3);
  });
});
