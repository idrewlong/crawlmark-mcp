import { describe, expect, it, vi } from "vitest";
import { findingAlerts } from "../src/analysis/alerts.js";
import { diffAudits, type StoredAudit } from "../src/analysis/diff.js";
import { checkedPairs, checkKey, checkOf, extractFindings, type Finding } from "../src/analysis/findings.js";
import type { AuditResult } from "../src/reports/audit.js";
import { runAudits, type AuditDeps } from "../src/scheduled.js";

const gtmData = {
  container: { publicId: "GTM-EXAMPLE", name: "example.com", accountId: "1", containerId: "2", domainName: ["example.com"] },
  findings: [
    { id: "x1", source: "gtm", rule: "legacy-ua", severity: "medium", title: "Universal Analytics tag \u202eOld\u200b UA", entity: { kind: "tag", id: "7", name: "Old UA" }, evidence: "UA-1234-1\u0007" },
    { id: "x2", source: "gtm", rule: "unused-variable", severity: "low", title: "Unused variable: dlv", entity: { kind: "variable", id: "12", name: "dlv" } },
  ],
};
const audit = (withGtm: boolean, ok = true) =>
  ({
    pages: [],
    site: { sitemaps: { ok: false, error: "x" }, crawl: null, backlinks: null, hygiene: { ok: false, error: "x" }, ...(withGtm ? { tagManager: ok ? { ok: true, data: gtmData } : { ok: false, error: "no access" } } : {}) },
  }) as unknown as AuditResult;
const stored = (id: string, ranAt: number, a: AuditResult): StoredAudit => ({ id, client: "example.com", ranAt, settings: {}, summary: {}, findings: extractFindings(a), checked: checkedPairs(a), result: {} });

describe("Tag Manager findings in run_audit (opt-in)", () => {
  it("maps each GTM finding: source gtm, gtm://<publicId>/<kind>/<id>, untrusted text stripped, stable ids", () => {
    const f = extractFindings(audit(true));
    expect(f).toEqual([
      { id: expect.any(String), source: "gtm", rule: "legacy-ua", url: "gtm://GTM-EXAMPLE/tag/7", severity: "medium", title: "Universal Analytics tag Old UA", evidence: "UA-1234-1" },
      { id: expect.any(String), source: "gtm", rule: "unused-variable", url: "gtm://GTM-EXAMPLE/variable/12", severity: "low", title: "Unused variable: dlv" },
    ]);
    expect(extractFindings(audit(true)).map((x) => x.id)).toEqual(f.map((x) => x.id));
    expect(extractFindings(audit(false))).toEqual([]);
  });

  it("every GTM finding depends on its container; a later audit without includeTagManager shows them unverified, never resolved", () => {
    expect(checkedPairs(audit(true))).toEqual([{ url: "gtm://GTM-EXAMPLE", source: "gtm" }]);
    for (const f of extractFindings(audit(true))) expect(checkKey(checkOf(f))).toBe(checkKey({ url: "gtm://GTM-EXAMPLE", source: "gtm" }));
    const without = diffAudits(stored("a", 1, audit(true)), stored("b", 2, audit(false)));
    expect(without.counts).toEqual({ new: 0, firstChecked: 0, resolved: 0, persistent: 0, unverified: 2, retired: 0 });
    const failed = diffAudits(stored("a", 1, audit(true)), stored("b", 2, audit(true, false)));
    expect(failed.counts.unverified).toBe(2);
    const fixed = diffAudits(stored("a", 1, audit(true)), stored("b", 2, { ...audit(true), site: { ...audit(true).site, tagManager: { ok: true, data: { ...gtmData, findings: [] } } } } as never));
    expect(fixed.counts.resolved).toBe(2);
  });

  it("GTM findings never alert (medium and low only)", () => {
    expect(findingAlerts("example.com", extractFindings(audit(true)) as Finding[])).toEqual([]);
  });

  it("crawlmark-cli audit passes includeTagManager only with --include-tag-manager", async () => {
    const runAudit = vi.fn(async () => ({ auditId: "new" }));
    const deps: AuditDeps = { runAudit, getAudit: () => ({ ...stored("new", 2, audit(false)) }), latestAuditBefore: () => undefined };
    const c = { slug: "example.com", domain: "example.com", keyPages: ["https://example.com/"] } as never;
    await runAudits([c], { deps });
    expect(runAudit).toHaveBeenLastCalledWith(c, { fresh: true });
    await runAudits([c], { deps, includeTagManager: true });
    expect(runAudit).toHaveBeenLastCalledWith(c, { fresh: true, includeTagManager: true });
  });
});
