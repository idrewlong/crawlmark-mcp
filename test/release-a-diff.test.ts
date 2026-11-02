/**
 * Release A, D8: an audit diff only calls a finding "new" when the earlier audit checked it. Findings on pages or sources the
 * base didn't check are "first checked"; findings of a Tag Manager container the target replaced are "retired".
 */
import { describe, expect, it } from "vitest";
import { findingAlerts } from "../src/analysis/alerts.js";
import { diffAudits, monthlyAuditSection, type StoredAudit } from "../src/analysis/diff.js";
import { findingId, type CheckedPair, type Finding } from "../src/analysis/findings.js";

const E = "https://example.com";

function finding(source: Finding["source"], rule: string, url: string, severity: Finding["severity"] = "high"): Finding {
  return { id: findingId(source, rule, url), source, rule, url, severity, title: `${rule} on ${url}` };
}

function audit(id: string, ranAt: number, findings: Finding[], checked: CheckedPair[], pages: string[] = [], extra: Partial<StoredAudit> = {}): StoredAudit {
  return { id, client: "example", ranAt, settings: { fresh: true, formFactor: "mobile", wcagLevel: "AA" }, summary: {}, findings, checked, result: { pages: pages.map((url) => ({ url })) }, ...extra };
}

const T0 = Date.parse("2026-09-01T00:00:00Z");
const T1 = Date.parse("2026-10-01T00:00:00Z");

describe("D8: first checked", () => {
  it("a finding on a page the base didn't check is firstChecked, not new, with the page-set warning", () => {
    const a = `${E}/a`;
    const b = `${E}/b`;
    const base = audit("aud_1", T0, [finding("axe", "button-name", a)], [{ url: a, source: "axe" }], [a]);
    const target = audit("aud_2", T1, [finding("axe", "button-name", a), finding("axe", "color-contrast", b, "critical")], [{ url: a, source: "axe" }, { url: b, source: "axe" }], [a, b]);
    const d = diffAudits(base, target);
    expect(d.new).toEqual([]);
    expect(d.firstChecked.map((f) => f.url)).toEqual([b]);
    expect(d.persistent.map((f) => f.url)).toEqual([a]);
    expect(d.counts).toMatchObject({ new: 0, firstChecked: 1, persistent: 1, retired: 0 });
    expect(d.warnings.join("\n")).toMatch(/The target audited 1 page\(s\) the base didn't/);
    expect(d.warnings.join("\n")).toMatch(/first checked/);
  });

  it("a finding on a page and source the base did check is still new", () => {
    const a = `${E}/a`;
    const base = audit("aud_1", T0, [], [{ url: a, source: "axe" }], [a]);
    const target = audit("aud_2", T1, [finding("axe", "button-name", a)], [{ url: a, source: "axe" }], [a]);
    const d = diffAudits(base, target);
    expect(d.new.map((f) => f.rule)).toEqual(["button-name"]);
    expect(d.firstChecked).toEqual([]);
    expect(d.warnings.join("\n")).not.toMatch(/page\(s\) the base didn't/);
  });

  it("a source the base didn't run on that page is firstChecked", () => {
    const a = `${E}/a`;
    const base = audit("aud_1", T0, [], [{ url: a, source: "lighthouse" }], [a]);
    const target = audit("aud_2", T1, [finding("axe", "button-name", a)], [{ url: a, source: "lighthouse" }, { url: a, source: "axe" }], [a]);
    const d = diffAudits(base, target);
    expect(d.firstChecked).toHaveLength(1);
    expect(d.new).toEqual([]);
  });

  it("scheduled alerts ignore first-checked findings", () => {
    const b = `${E}/b`;
    const base = audit("aud_1", T0, [], [{ url: `${E}/a`, source: "axe" }], [`${E}/a`]);
    const target = audit("aud_2", T1, [finding("axe", "color-contrast", b, "critical")], [{ url: `${E}/a`, source: "axe" }, { url: b, source: "axe" }], [`${E}/a`, b]);
    const d = diffAudits(base, target);
    expect(d.firstChecked[0]?.severity).toBe("critical");
    expect(findingAlerts("example", d.new)).toEqual([]);
  });

  it("monthlyAuditSection carries the new fields", () => {
    const base = audit("aud_1", T0, [], [{ url: `${E}/a`, source: "axe" }]);
    const target = audit("aud_2", T1, [finding("axe", "x", `${E}/b`)], [{ url: `${E}/a`, source: "axe" }, { url: `${E}/b`, source: "axe" }]);
    expect(monthlyAuditSection(target, base)?.diff.counts).toMatchObject({ new: 0, firstChecked: 1 });
  });
});

describe("D8: Tag Manager container change", () => {
  const gtmA = (kind: string, id: string) => `gtm://GTM-AAAA111/${kind}/${id}`;
  const gtmB = (kind: string, id: string) => `gtm://GTM-BBBB222/${kind}/${id}`;

  it("the old container's findings are retired, the new container's are firstChecked, with the warning and containerChange", () => {
    const base = audit("aud_1", T0, [finding("gtm", "unused-tag", gtmA("tag", "1")), finding("gtm", "unused-tag", gtmA("tag", "2"))], [{ url: "gtm://GTM-AAAA111", source: "gtm" }]);
    const target = audit("aud_2", T1, [finding("gtm", "unused-tag", gtmB("tag", "9"))], [{ url: "gtm://GTM-BBBB222", source: "gtm" }]);
    const d = diffAudits(base, target);
    expect(d.retired).toHaveLength(2);
    expect(d.firstChecked.map((f) => f.url)).toEqual([gtmB("tag", "9")]);
    expect(d.new).toEqual([]);
    expect(d.resolved.filter((f) => f.url.startsWith("gtm://GTM-AAAA111"))).toEqual([]);
    expect(d.unverified.filter((f) => f.url.startsWith("gtm://GTM-AAAA111"))).toEqual([]);
    expect(d.containerChange).toEqual({ from: "GTM-AAAA111", to: "GTM-BBBB222" });
    expect(d.warnings).toContain("Tag Manager container changed from GTM-AAAA111 to GTM-BBBB222: 2 finding(s) of GTM-AAAA111 are retired and GTM-BBBB222's are listed as first checked.");
    expect(d.counts).toMatchObject({ retired: 2, firstChecked: 1, new: 0, resolved: 0, unverified: 0 });
  });

  it("the same container keeps normal resolved/new semantics", () => {
    const base = audit("aud_1", T0, [finding("gtm", "unused-tag", gtmA("tag", "1"))], [{ url: "gtm://GTM-AAAA111", source: "gtm" }]);
    const target = audit("aud_2", T1, [finding("gtm", "unused-tag", gtmA("tag", "2"))], [{ url: "gtm://GTM-AAAA111", source: "gtm" }]);
    const d = diffAudits(base, target);
    expect(d.resolved).toHaveLength(1);
    expect(d.new).toHaveLength(1);
    expect(d.retired).toEqual([]);
    expect(d.containerChange).toBeUndefined();
  });

  it("a base that never ran Tag Manager makes the target's findings firstChecked", () => {
    const base = audit("aud_1", T0, [], [{ url: `${E}/a`, source: "axe" }]);
    const target = audit("aud_2", T1, [finding("gtm", "unused-tag", gtmB("tag", "9"))], [{ url: `${E}/a`, source: "axe" }, { url: "gtm://GTM-BBBB222", source: "gtm" }]);
    const d = diffAudits(base, target);
    expect(d.firstChecked).toHaveLength(1);
    expect(d.new).toEqual([]);
    expect(d.containerChange).toBeUndefined();
  });
});
