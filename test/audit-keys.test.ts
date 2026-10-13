/**
 * Phase 12 additive-output check: a default run_audit result has exactly the key set it had before
 * Phase 12 (fixture captured from `main` before audit.ts changed), and the new site.tagManager /
 * site.cruxHistory keys appear only when their option is set. Every source is mocked.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/providers/lighthouse.js", () => ({
  runLighthouse: vi.fn(async (url: string) => ({ url, formFactor: "mobile", scores: { performance: 80, accessibility: 95, bestPractices: 92, seo: 91 }, lab: { lcpMs: 2100, cls: 0.02, tbtMs: 100, fcpMs: 900, speedIndexMs: 1500 }, opportunities: [] })),
}));
vi.mock("../src/providers/axe.js", () => ({ runAxe: vi.fn(async (url: string) => ({ url, level: "AA", counts: { critical: 0, serious: 1, moderate: 0, minor: 0 }, violations: [{ id: "color-contrast", impact: "serious", help: "Contrast", nodes: 2, examples: ["p"] }] })) }));
vi.mock("../src/providers/render.js", () => ({ checkRender: vi.fn(async () => ({ flags: [] })) }));
vi.mock("../src/providers/gsc.js", () => ({
  gscInspectUrl: vi.fn(async () => ({ verdict: "PASS", coverageState: "Submitted and indexed" })),
  gscSitemaps: vi.fn(async () => [{ path: "https://example.com/sitemap.xml", errors: 0, warnings: 0 }]),
}));
vi.mock("../src/providers/seo-data.js", () => ({ instantPage: vi.fn(async () => ({ page: { failedChecks: ["no_description"] } })), backlinksSummary: vi.fn(), onPageStartCrawl: vi.fn() }));
vi.mock("../src/reports/site-hygiene.js", () => ({ siteHygiene: vi.fn(async () => ({ flags: [], checked: ["site:robots"] })) }));
vi.mock("../src/reports/gtm.js", async () => {
  const { GTM_OK } = await import("./fixtures/reports/deps.js");
  return { runGtmAudit: vi.fn(async () => ({ client: "example.com", ...GTM_OK, container: { ...GTM_OK.container, accountId: "1", containerId: "2", domainName: ["example.com"] }, unpublishedChanges: { workspaces: [] }, fromCache: false })) };
});
vi.mock("../src/providers/crux.js", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseCruxHistory } = await import("../src/analysis/crux.js");
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/crux/history-origin.json", import.meta.url), "utf8"));
  return {
    clientOrigin: (c: { domain: string }) => `https://${c.domain}`,
    cruxHistory: vi.fn(async (req: { origin: string }) => parseCruxHistory(fixture, { origin: req.origin, formFactor: "PHONE", metrics: ["lcp", "inp", "cls", "fcp", "ttfb"] }, "CRUX_API_KEY")),
  };
});

// Phase 12 C1: the local crawl inside run_audit, stubbed (no network). Only imported when localCrawl is set.
const crawlRuns: unknown[] = [];
vi.mock("../src/reports/local-crawl.js", () => ({
  loadLocalCrawlDeps: vi.fn(async () => ({})),
  runLocalCrawl: vi.fn(async (_c: unknown, o: unknown) => {
    crawlRuns.push(o);
    const f = { id: "f1", source: "crawl", rule: "missing-title", url: "https://example.com/x", severity: "high", title: "Page has no title" };
    return { result: { crawlId: "crawl_1", exhaustive: true, topIssues: [f], summary: {} }, findings: [f], checked: ["site:crawl", "site:crawl-complete", "https://example.com/x"] };
  }),
  toAuditData: (r: { result: Record<string, unknown>; findings: unknown[]; checked: string[] }) => {
    const { topIssues: _t, ...rest } = r.result;
    return { ...rest, findings: r.findings, checked: r.checked };
  },
}));

const { runAudit } = await import("../src/reports/audit.js");
const FIXTURE = join(import.meta.dirname, "fixtures", "reports", "run-audit-keys.json");

/** Every key path in a JSON value (array items collapse to []). */
function keyPaths(v: unknown, prefix = ""): string[] {
  if (Array.isArray(v)) return v.length ? [...new Set(v.flatMap((x) => keyPaths(x, `${prefix}[]`)))] : [`${prefix}[]`];
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [`${prefix}.${k}`, ...keyPaths(x, `${prefix}.${k}`)]);
  return [];
}

const client = { slug: "example.com", domain: "example.com", name: "Example Co", keyPages: ["https://example.com/"], brandTerms: [], aliases: [], monthlyUnits: { ahrefs: 1, semrush: 1 } } as never;

describe("run_audit output keys", () => {
  it("a default run has the same key set as before Phase 12", async () => {
    const r = JSON.parse(JSON.stringify(await runAudit(client, {})));
    const keys = [...new Set(keyPaths(r))].sort();
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(FIXTURE)) writeFileSync(FIXTURE, JSON.stringify(keys, null, 2) + "\n");
    expect(keys).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
    expect(Object.keys(r.site).sort()).toEqual(["backlinks", "crawl", "hygiene", "sitemaps"]);
  });

  it("includeTagManager: true adds site.tagManager and gtm findings, nothing else", async () => {
    const plain = JSON.parse(JSON.stringify(await runAudit(client, {})));
    const r = JSON.parse(JSON.stringify(await runAudit(client, { includeTagManager: true })));
    expect(Object.keys(r.site).sort()).toEqual(["backlinks", "crawl", "hygiene", "sitemaps", "tagManager"]);
    expect(r.site.tagManager).toMatchObject({ ok: true, data: { container: { publicId: "GTM-EXAMPLE" } } });
    expect(r.findingCount).toBe(plain.findingCount + 2);
  });

  it("cruxHistory: true adds site.cruxHistory and crux findings, nothing else", async () => {
    const plain = JSON.parse(JSON.stringify(await runAudit(client, {})));
    const r = JSON.parse(JSON.stringify(await runAudit(client, { cruxHistory: true })));
    expect(Object.keys(r.site).sort()).toEqual(["backlinks", "crawl", "cruxHistory", "hygiene", "sitemaps"]);
    expect(r.site.cruxHistory).toMatchObject({ ok: true, data: { available: true, key: { origin: "https://example.com" } } });
    expect(Object.keys(r).sort()).toEqual(Object.keys(plain).sort());
    expect(r.findingCount).toBe(plain.findingCount + 2);
  });

  it("localCrawl: true adds site.localCrawl and crawl findings, nothing else (Phase 12 C1)", async () => {
    const plain = JSON.parse(JSON.stringify(await runAudit(client, {})));
    expect(crawlRuns).toHaveLength(0);
    const r = JSON.parse(JSON.stringify(await runAudit(client, { localCrawl: true, maxLocalCrawlPages: 50 })));
    expect(crawlRuns).toEqual([expect.objectContaining({ maxPages: 50, timeLimitMs: 240_000 })]);
    expect(Object.keys(r.site).sort()).toEqual(["backlinks", "crawl", "hygiene", "localCrawl", "sitemaps"]);
    expect(r.site.localCrawl).toMatchObject({ ok: true, data: { crawlId: "crawl_1", checked: expect.arrayContaining(["site:crawl"]) } });
    expect(r.site.localCrawl.data.topIssues).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual(Object.keys(plain).sort());
    expect(r.findingCount).toBe(plain.findingCount + 1);
  });
});
