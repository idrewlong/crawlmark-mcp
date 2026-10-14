/**
 * Phase 13 A-4: the technical-issues catalogue, merge, severity and diff (pure), the source readers over the
 * temp SQLite stores, the stored DataForSEO crawl read (GET summary only, stubbed fetch on the closed local
 * port) and the technical_issues flow end to end with a fake clock. example.com only; no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";
import type { StoredAudit } from "../src/analysis/diff.js";
import { findingId, type Finding } from "../src/analysis/findings.js";
import type { CrawlPage } from "../src/analysis/crawl.js";
import { canonicalOf, CATALOGUE, diffIssues, mergedSeverity, mergeIssues, type RawIssue } from "../src/analysis/tech-issues.js";
import { saveAudit, newAuditId } from "../src/lib/audits.js";
import { newCrawlId, saveCrawl } from "../src/lib/crawls.js";
import { countIssueSnapshots, saveIssueSnapshot } from "../src/lib/issue-snapshots.js";
import { db } from "../src/lib/store.js";
import { loadTechIssuesDeps, technicalIssues, TOOL_BASE_AGE_MS, type TechIssuesDeps } from "../src/reports/technical-issues.js";
import type { SourceRun } from "../src/reports/report-types.js";

afterEach(() => vi.unstubAllGlobals());

const E = "https://example.com";
const raw = (o: Partial<RawIssue> & Pick<RawIssue, "source" | "rule">): RawIssue => ({ url: `${E}/a`, severity: "medium", nativeSeverity: "medium", title: o.rule, count: null, ...o });
const run = (source: SourceRun["source"], runId: string, ranAt: string, checks?: string[]): SourceRun => ({ source, runId, ranAt, stale: false, ...(checks ? { checks } : {}) });

describe("catalogue and merge (D8)", () => {
  it("merges the audit's on-page no_title and the local crawl's missing-title on one URL into one item with two sources", () => {
    const items = mergeIssues([
      raw({ source: "local_crawl", rule: "missing-title", url: `${E}/contact/`, severity: "high", nativeSeverity: "high" }),
      raw({ source: "audit", rule: "onpage:no_title", url: `${E}/contact`, severity: "high", nativeSeverity: "high" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "missing-title", title: "Page has no title", url: `${E}/contact`, affected: 1, severity: "high" });
    expect(items[0]!.sources.map((s) => [s.source, s.rule])).toEqual([
      ["audit", "onpage:no_title"],
      ["local_crawl", "missing-title"],
    ]);
  });

  it("count-only items merge on the key with affected = the largest count reported (never a sum)", () => {
    const items = mergeIssues([
      raw({ source: "dataforseo_crawl", rule: "no_title", url: null, count: 3 }),
      raw({ source: "dataforseo_crawl", rule: "no_title", url: null, count: 5 }),
      raw({ source: "dataforseo_crawl", rule: "no_title", url: null, count: 4 }),
      // A URL-level item with the same key stays its own item.
      raw({ source: "local_crawl", rule: "missing-title", url: `${E}/x` }),
    ]);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.url === null)).toMatchObject({ key: "missing-title", affected: 5 });
    expect(items.find((i) => i.url === null)!.sources).toEqual([{ source: "dataforseo_crawl", rule: "no_title", nativeSeverity: "medium", count: 5, examples: [] }]);
  });

  it("an unmapped rule keeps its own key; axe rules stay one item per rule; sitemap URLs split by status class", () => {
    expect(canonicalOf(raw({ source: "local_crawl", rule: "deep-page" })).key).toBe("local_crawl:deep-page");
    expect(canonicalOf(raw({ source: "audit", rule: "axe:color-contrast", title: "Contrast" }))).toEqual({ key: "a11y:color-contrast", title: "Contrast", category: "accessibility" });
    expect(canonicalOf(raw({ source: "site_hygiene", rule: "sitemap-non200", evidence: "HTTP 503" })).key).toBe("server-error");
    expect(canonicalOf(raw({ source: "site_hygiene", rule: "sitemap-non200", evidence: "HTTP 404" })).key).toBe("client-error-page");
    expect(canonicalOf(raw({ source: "site_hygiene", rule: "sitemap-non200", evidence: "HTTP 301" })).key).toBe("site_hygiene:sitemap-non200");
    expect(canonicalOf(raw({ source: "audit", rule: "rendering:canonical-mismatch" })).key).toBe("canonical-js-only");
    expect(canonicalOf(raw({ source: "audit", rule: "indexing:canonical-mismatch" })).key).toBe("canonical-mismatch");
    // The table is data: every match pattern belongs to exactly one row.
    const patterns = CATALOGUE.flatMap((r) => r.match);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("severity (D9): the highest across sources; an item only providers report is never critical", () => {
    expect(mergedSeverity([{ source: "local_crawl", severity: "medium" }, { source: "dataforseo_crawl", severity: "high" }])).toBe("high");
    expect(mergedSeverity([{ source: "audit", severity: "critical" }])).toBe("critical");
    expect(mergedSeverity([{ source: "ahrefs_site_audit", severity: "critical" }, { source: "semrush_site_audit", severity: "low" }])).toBe("high");
    expect(mergedSeverity([{ source: "ahrefs_site_audit", severity: "critical" }, { source: "audit", severity: "low" }])).toBe("critical");
  });
});

describe("diff (D10)", () => {
  const items = (...ids: [string, string][]) => mergeIssues(ids.map(([source, rule]) => raw({ source: source as RawIssue["source"], rule, url: `${E}/${rule.replace(/\W/g, "")}` })));

  it("first run: every item first_run and changes null", () => {
    const d = diffIssues({ items: items(["local_crawl", "missing-title"]), checked: [run("local_crawl", "c1", "2026-10-01T00:00:00Z")] }, undefined);
    expect(d.changes).toBeNull();
    expect(d.items.map((i) => i.change)).toEqual(["first_run"]);
  });

  it("new, persistent, resolved (the source ran again) and unverified (it didn't) — unverified stays open", () => {
    const base = {
      items: items(["local_crawl", "missing-title"], ["local_crawl", "redirect-chain"], ["dataforseo_crawl", "no_h1_tag"]),
      checked: [run("local_crawl", "c1", "2026-09-01T00:00:00Z"), run("dataforseo_crawl", "t1", "2026-09-01T00:00:00Z")],
    };
    const current = {
      items: items(["local_crawl", "missing-title"], ["local_crawl", "missing-description"]),
      // The crawl ran again; the DataForSEO task is the same one (it didn't re-crawl).
      checked: [run("local_crawl", "c2", "2026-10-01T00:00:00Z"), run("dataforseo_crawl", "t1", "2026-09-01T00:00:00Z")],
    };
    const d = diffIssues(current, base);
    expect(d.changes).toEqual({ new: 1, persistent: 1, resolved: 1, unverified: 1 });
    expect(d.resolved.map((i) => i.key)).toEqual(["redirect-chain"]);
    expect(d.unverified.map((i) => i.key)).toEqual(["missing-h1"]);
    expect(d.items.map((i) => [i.key, i.change]).sort()).toEqual([
      ["missing-description", "new"],
      ["missing-h1", "unverified"],
      ["missing-title", "persistent"],
    ]);
  });

  it("an audit only clears checks it ran again; a capped crawl never clears duplicate titles", () => {
    const a = mergeIssues([raw({ source: "audit", rule: "axe:button-name" }), raw({ source: "local_crawl", rule: "duplicate-title" })]);
    const d = diffIssues(
      { items: [], checked: [run("audit", "a2", "2026-10-01T00:00:00Z", ["lighthouse"]), run("local_crawl", "c2", "2026-10-01T00:00:00Z", [])] },
      { items: a, checked: [run("audit", "a1", "2026-09-01T00:00:00Z", ["axe"]), run("local_crawl", "c1", "2026-09-01T00:00:00Z", ["site:crawl-complete"])] },
    );
    expect(d.resolved).toEqual([]);
    expect(d.unverified.map((i) => i.key).sort()).toEqual(["a11y:button-name", "duplicate-title"]);
  });
});

// ---- end to end over the temp stores ----

const finding = (source: Finding["source"], rule: string, url: string, severity: Finding["severity"], title = rule): Finding => ({ id: findingId(source, rule, url), source, rule, url, severity, title });
const page = (url: string, o: Partial<CrawlPage> = {}): CrawlPage => ({ url, depth: 0, status: 200, finalUrl: url, finalStatus: 200, redirectChain: [], contentType: "text/html", title: `T ${url}`, description: `D ${url}`, canonical: null, robots: null, noindex: false, h1Count: 1, inlinks: 1, outlinks: 0, firstLinkedFrom: null, parsed: true, issues: [], ...o });

function storeAudit(client: string, ranAt: number, findings: Finding[]): StoredAudit {
  const a: StoredAudit = {
    id: newAuditId(ranAt),
    client,
    ranAt,
    settings: {},
    summary: {},
    findings,
    checked: [
      { url: `${E}/contact`, source: "onpage" },
      { url: `${E}/contact`, source: "axe" },
      { url: "site", source: "site" },
      { url: "site:robots", source: "site" },
    ],
    result: {},
  };
  saveAudit(a);
  return a;
}

const C = (slug: string) => ({ slug, domain: "example.com", name: "Example Co" }) as unknown as Client;

describe("technical_issues over stored sources (Done-when)", () => {
  it("returns merged items with sources, writes one snapshot, and a call 25 h later reports changes per D10", async () => {
    const slug = "issues-e2e.example.com";
    const t0 = Date.parse("2026-10-09T08:00:00Z");
    storeAudit(slug, t0, [
      finding("onpage", "no_title", `${E}/contact`, "high"),
      finding("axe", "button-name", `${E}/contact`, "critical", "Buttons must have discernible text"),
      finding("site", "ai-search-crawler-blocked", `${E}/`, "low", "An AI search crawler is blocked"),
      finding("site", "sitemap-non200", `${E}/gone`, "high", "Sitemap lists a URL that does not return 200"),
    ]);
    saveCrawl({ id: newCrawlId(t0 + 3_600_000), client: slug, ranAt: t0 + 3_600_000, settings: {}, summary: {}, exhaustive: true, pages: [page(`${E}/`), page(`${E}/contact`, { title: null })] });

    let now = t0 + 2 * 3_600_000;
    const real = await loadTechIssuesDeps();
    const deps: TechIssuesDeps = { ...real, now: () => now, latestCrawlTask: () => undefined };
    const first = await technicalIssues(C(slug), { baseBeforeMs: now - TOOL_BASE_AGE_MS, limit: 50 }, deps);
    const title = first.issues.find((i) => i.key === "missing-title")!;
    expect(title.sources.map((s) => s.source).sort()).toEqual(["audit", "local_crawl"]);
    expect(first.issues[0]).toMatchObject({ key: "a11y:button-name", severity: "critical" });
    expect(first.sources.map((s) => s.source)).toEqual(["audit", "site_hygiene", "local_crawl"]);
    expect(first.unavailable).toEqual([
      { source: "dataforseo_crawl", reason: "no stored DataForSEO crawl for example.com" },
      { source: "gsc_inspection", reason: expect.any(String) },
    ]);
    expect(first.changes).toBeNull();
    expect(first.base).toBeNull();
    expect(countIssueSnapshots(slug)).toBe(1);

    // 25 hours later: a new local crawl finds the title fixed, but the saved audit (the same one) still reports it,
    // so the item persists with the audit as its only source; the new crawl also finds a missing description.
    now += 25 * 3_600_000;
    saveCrawl({ id: newCrawlId(now - 1000), client: slug, ranAt: now - 1000, settings: {}, summary: {}, exhaustive: true, pages: [page(`${E}/`), page(`${E}/contact`), page(`${E}/new`, { description: null })] });
    const second = await technicalIssues(C(slug), { baseBeforeMs: now - TOOL_BASE_AGE_MS, limit: 50 }, deps);
    expect(second.base?.snapshotId).toBe(first.snapshotId);
    expect(second.changes).toEqual({ new: 1, persistent: 4, resolved: 0, unverified: 0 });
    expect(second.issues.find((i) => i.key === "missing-description")).toMatchObject({ change: "new", url: `${E}/new` });
    expect(second.issues.find((i) => i.key === "missing-title")!.sources.map((s) => s.source)).toEqual(["audit"]);
    expect(countIssueSnapshots(slug)).toBe(2);
  });

  it("stale sources are flagged; minSeverity and limit cut the list, counts cover everything listed", async () => {
    const slug = "issues-stale.example.com";
    const t0 = Date.parse("2026-07-01T08:00:00Z");
    storeAudit(slug, t0, [finding("onpage", "no_title", `${E}/a`, "high"), finding("onpage", "no_description", `${E}/b`, "medium"), finding("lighthouse", "uses-long-cache-ttl", `${E}/c`, "low")]);
    const deps: TechIssuesDeps = { ...(await loadTechIssuesDeps()), now: () => Date.parse("2026-10-01T00:00:00Z"), latestCrawlTask: () => undefined };
    const r = await technicalIssues(C(slug), { baseBeforeMs: 0, sources: ["audit"], minSeverity: "medium", limit: 1, save: false }, deps);
    expect(r.sources).toEqual([expect.objectContaining({ source: "audit", stale: true })]);
    expect(r.total).toBe(2);
    expect(r.issues).toHaveLength(1);
    expect(r.counts).toEqual({ critical: 0, high: 1, medium: 1, low: 0 });
    expect(r.snapshotId).toBeNull();
    expect(countIssueSnapshots(slug)).toBe(0);
  });

  it("the provider Site Audit sources request nothing: unavailable, needing allowPaid", async () => {
    const deps: TechIssuesDeps = { ...(await loadTechIssuesDeps()), latestCrawlTask: () => undefined };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const r = await technicalIssues(C("issues-paid.example.com"), { baseBeforeMs: 0, sources: ["ahrefs_site_audit", "semrush_site_audit"] }, deps);
    expect(r.unavailable).toEqual([
      { source: "ahrefs_site_audit", reason: "paid source: needs allowPaid (it spends provider units)" },
      { source: "semrush_site_audit", reason: "paid source: needs allowPaid (it spends provider units)" },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("stored DataForSEO crawl (D11)", () => {
  it("reads only GET /on_page/summary/{id}, only when the task is at most 30 days old, problem checks only", async () => {
    const log: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const u = new URL(String(input));
        if (u.hostname !== "127.0.0.1") throw new Error("real host");
        log.push(`${init.method ?? "GET"} ${u.pathname}`);
        return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0, result: [{ crawl_progress: "finished", page_metrics: { onpage_score: 88, checks: { no_title: 3, is_https: 40, no_h1_tag: 2, duplicate_title_tag: 6 } } }] }] }), { status: 200 });
      }),
    );
    const now = Date.parse("2026-10-13T00:00:00Z");
    const deps: TechIssuesDeps = { ...(await loadTechIssuesDeps()), now: () => now, latestAudit: () => undefined, latestCrawl: () => undefined, latestCrawlTask: () => ({ taskId: "10111213-1415-1617-1819-202122232425", ranAt: now - 10 * 86_400_000 }) };
    const r = await technicalIssues(C("issues-dfs.example.com"), { baseBeforeMs: 0, sources: ["dataforseo_crawl"], save: false }, deps);
    expect(log).toEqual(["GET /v3/on_page/summary/10111213-1415-1617-1819-202122232425"]);
    expect(r.issues.map((i) => [i.key, i.affected, i.url])).toEqual([
      ["missing-title", 3, null],
      ["duplicate-title", 6, null],
      ["missing-h1", 2, null],
    ]);
    expect(r.issues.find((i) => i.key === "missing-title")?.severity).toBe("high");

    log.length = 0;
    const old = await technicalIssues(C("issues-dfs.example.com"), { baseBeforeMs: 0, sources: ["dataforseo_crawl"], save: false }, { ...deps, latestCrawlTask: () => ({ taskId: "old", ranAt: now - 31 * 86_400_000 }) });
    expect(log).toEqual([]);
    expect(old.unavailable).toEqual([{ source: "dataforseo_crawl", reason: "the newest DataForSEO crawl is more than 30 days old" }]);
  });
});

describe("issue snapshots", () => {
  it("keeps the newest 24 per client", () => {
    const slug = "issues-keep.example.com";
    for (let i = 0; i < 26; i++) saveIssueSnapshot({ id: `iss_${String(i).padStart(26, "0")}`, client: slug, capturedAt: 1000 + i, items: [], checked: [], settings: { sources: ["audit"], maxAgeDays: 45 } });
    expect(countIssueSnapshots(slug)).toBe(24);
    const ids = (db.prepare("SELECT id FROM issue_snapshots WHERE client = ? ORDER BY captured_at").all(slug) as { id: string }[]).map((r) => r.id);
    expect(ids[0]).toBe(`iss_${"2".padStart(26, "0")}`);
  });
});

describe("technical_issues report section", () => {
  it("compares with the newest snapshot from before the period ended, runs its free sources without allowPaid, and is unavailable with no source", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fixtureReport } = await import("./fixtures/reports/report.js");
    const { fakeDeps } = await import("./fixtures/reports/deps.js");
    const { TECH_ISSUES, EMPTY_TECH_ISSUES } = await import("./fixtures/reports/p13-data.js");
    const home = mkdtempSync(join(tmpdir(), "crawlmark-p13-ti-"));
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "report-templates.yaml"), "version: 1\ntemplates:\n  t:\n    title: T\n    sections:\n      - { id: issues, type: technical_issues, paid: true, sources: [audit, ahrefs_site_audit], limit: 10 }\n");
    const calls: unknown[] = [];
    const deps = fakeDeps({ technicalIssues: async (_c, o) => (calls.push(o), { ...TECH_ISSUES, snapshotId: "iss_x" }) });
    const r = await fixtureReport({ homeDir: home, template: "t", include: [] }, deps);
    const s = r.sections[0]!;
    expect(s.status).toBe("ok");
    expect(s.status === "ok" && (s.data as Record<string, unknown>).snapshotId).toBeUndefined();
    expect(calls).toEqual([{ sources: ["audit", "ahrefs_site_audit"], minSeverity: undefined, limit: 10, maxAgeDays: undefined, issueUrls: undefined, allowPaid: false, baseBeforeMs: Date.parse("2026-10-01T00:00:00Z"), excludeSnapshotIds: [] }]);
    const none = await fixtureReport({ homeDir: home, template: "t", include: [] }, fakeDeps({ technicalIssues: async () => ({ ...EMPTY_TECH_ISSUES, snapshotId: null }) }));
    expect(none.sections[0]).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/^no saved audit, crawl or URL Inspection results for example.com yet/) });
  });
});

describe("R-1: carried not re-checked issues expire", () => {
  it("three snapshots: a DataForSEO item stays unverified while the same task is read, then drops out (no longer checked) once the source is missing", async () => {
    const slug = "issues-carry.example.com";
    const day = 86_400_000;
    let now = Date.parse("2026-10-01T00:00:00Z");
    let task: { taskId: string; ranAt: number } | undefined = { taskId: "aaaaaaaa-1111", ranAt: now - day };
    let checks: Record<string, number> = { no_title: 37 };
    const deps: TechIssuesDeps = {
      ...(await loadTechIssuesDeps()),
      now: () => now,
      latestAudit: () => undefined,
      latestCrawl: () => undefined,
      latestCrawlTask: () => task,
      onPageSummary: async () => ({ status: "finished", issues: Object.entries(checks).map(([check, pages]) => ({ check, pages })) }),
    };
    const run = () => technicalIssues(C(slug), { baseBeforeMs: now - TOOL_BASE_AGE_MS + 1, sources: ["dataforseo_crawl"] }, deps);
    const first = await run();
    expect(first.issues.map((i) => [i.key, i.affected])).toEqual([["missing-title", 37]]);
    // 2: the same task, but its summary no longer lists the check (an odd read): not re-run, so carried as unverified.
    now += 2 * day;
    checks = {};
    const second = await run();
    expect(second.issues.map((i) => [i.key, i.change])).toEqual([["missing-title", "unverified"]]);
    // 3: the stored crawl is gone (older than 30 days / deleted): the source is unavailable, so the item is dropped.
    now += 2 * day;
    task = undefined;
    const third = await run();
    expect(third.issues).toEqual([]);
    expect(third.noLongerChecked).toBe(1);
    expect(third.changes).toMatchObject({ resolved: 0, unverified: 0 });
  });

  it("a carried item also drops once the run that reported it is older than maxAgeDays", () => {
    const base = { items: mergeIssues([raw({ source: "dataforseo_crawl", rule: "no_title", url: null, count: 3 })]).map((i) => ({ ...i, seen: [run("dataforseo_crawl", "t1", "2026-08-01T00:00:00Z")] })), checked: [run("dataforseo_crawl", "t1", "2026-08-01T00:00:00Z")] };
    const cur = { items: [], checked: [run("dataforseo_crawl", "t1", "2026-08-01T00:00:00Z")] };
    expect(diffIssues(cur, base, { now: Date.parse("2026-08-20T00:00:00Z"), maxAgeDays: 45 }).unverified).toHaveLength(1);
    const late = diffIssues(cur, base, { now: Date.parse("2026-10-01T00:00:00Z"), maxAgeDays: 45 });
    expect(late.unverified).toHaveLength(0);
    expect(late.noLongerChecked).toBe(1);
  });
});

describe("issue snapshot retention and base (spec fixes a, b)", () => {
  it("keeps the newest 24 plus the newest of each month for 25 months", () => {
    const slug = "issues-months.example.com";
    // One a month from January 2025 to September 2026 (21), then 30 in early October 2026.
    for (let m = 0; m < 21; m++) saveIssueSnapshot({ id: `iss_m${String(m).padStart(2, "0")}`, client: slug, capturedAt: Date.UTC(2025, m, 15), items: [], checked: [], settings: { sources: ["audit"], maxAgeDays: 45 } });
    for (let i = 0; i < 30; i++) saveIssueSnapshot({ id: `iss_z${String(i).padStart(2, "0")}`, client: slug, capturedAt: Date.UTC(2026, 9, 1) + i * 3_600_000, items: [], checked: [], settings: { sources: ["audit"], maxAgeDays: 45 } });
    const ids = (db.prepare("SELECT id FROM issue_snapshots WHERE client = ? ORDER BY captured_at").all(slug) as { id: string }[]).map((r) => r.id);
    expect(ids.filter((i) => i.startsWith("iss_m"))).toHaveLength(21);
    expect(ids.filter((i) => i.startsWith("iss_z"))).toHaveLength(24);
    // A month older than 25 months is pruned once it's outside the newest 24.
    saveIssueSnapshot({ id: "iss_old", client: slug, capturedAt: Date.UTC(2024, 0, 1), items: [], checked: [], settings: { sources: ["audit"], maxAgeDays: 45 } });
    expect((db.prepare("SELECT COUNT(*) AS n FROM issue_snapshots WHERE id = 'iss_old'").get() as { n: number }).n).toBe(0);
  });

  it("the base leaves out snapshots the current run made", async () => {
    const { latestIssueSnapshotBefore } = await import("../src/lib/issue-snapshots.js");
    const slug = "issues-exclude.example.com";
    saveIssueSnapshot({ id: "iss_a", client: slug, capturedAt: 1000, items: [], checked: [], settings: { sources: ["audit"], maxAgeDays: 45 } });
    saveIssueSnapshot({ id: "iss_b", client: slug, capturedAt: 2000, items: [], checked: [], settings: { sources: ["audit"], maxAgeDays: 45 } });
    expect(latestIssueSnapshotBefore(slug, 5000)?.id).toBe("iss_b");
    expect(latestIssueSnapshotBefore(slug, 5000, ["iss_b"])?.id).toBe("iss_a");
  });
});

describe("SEC-5: DataForSEO task IDs", () => {
  it("are validated and URL-encoded before they reach a path; a bad one makes no request", async () => {
    const { onPageSummary, onPageCrawlUrls, checkTaskId } = await import("../src/providers/dataforseo.js");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ crawl_progress: "finished", page_metrics: { checks: {} } }] }] })));
    vi.stubGlobal("fetch", fetch);
    for (const bad of ["../../v3/keywords_data", "a/b?c=d", "short", "x".repeat(65), "id with space"]) {
      await expect(onPageSummary(bad)).rejects.toThrow(/isn't a DataForSEO task ID/);
      await expect(onPageCrawlUrls("sec5.example.com", bad)).rejects.toThrow(/isn't a DataForSEO task ID/);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(checkTaskId("10111213-1415-1617-1819-202122232425")).toBe("10111213-1415-1617-1819-202122232425");
    await onPageSummary("10111213-1415-1617-1819-202122232425");
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toMatch(/\/on_page\/summary\/10111213-1415-1617-1819-202122232425$/);
  });
});
