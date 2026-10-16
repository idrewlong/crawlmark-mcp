/**
 * The technical_issues tool and report section (Phase 13, spec D8-D11): read every stored source, map it
 * onto the canonical catalogue (analysis/tech-issues.ts), compare with the last snapshot and save a new one.
 *
 * Reports never start crawls (D11): this reads the newest saved audit (findings already extracted), the
 * newest local crawl, the newest stored DataForSEO full crawl within 30 days (a GET of its summary; no
 * task is posted) and stored URL Inspection results. The Ahrefs Site Audit source (paid, Stage B) is
 * read only with allowPaid, for an existing project, through the reader's read-only path allowlist; without
 * allowPaid they're listed as unavailable and nothing is requested. Ahrefs example URLs are never stored (the
 * snapshot keeps Ahrefs issue names and counts only: the Ahrefs storage decision).
 *
 * Every string from a source passes cleanText / cleanUrl before it's stored or returned (Phase 12 D4).
 */
import type { Client } from "../config.js";
import { BudgetExceededError } from "../lib/budget.js";
import { analyzeCrawl } from "../analysis/crawl.js";
import type { StoredAudit } from "../analysis/diff.js";
import { CRAWL_COMPLETE_KEY, onPageSeverity } from "../analysis/findings.js";
import { atLeast, diffIssues, mergeIssues, severityCounts, type RawIssue } from "../analysis/tech-issues.js";
import type { StoredCrawl } from "../lib/crawls.js";
import { cleanText, cleanUrl } from "../lib/inspections.js";
import type { IssueSnapshot } from "../lib/issue-snapshots.js";
import { ulid } from "../lib/ulid.js";
import { FREE_ISSUE_SOURCES, PAID_ISSUE_SOURCES } from "./templates/schema.js";
import type { IssueSeverity, IssueSource, SourceRun, TechnicalIssuesData } from "./report-types.js";

const DAY_MS = 86_400_000;
/** A stored DataForSEO crawl is read only when it's at most this old (D11). */
export const DFS_CRAWL_MAX_AGE_DAYS = 30;
export const DEFAULT_MAX_AGE_DAYS = 45;
/** The tool's base: the newest snapshot older than this. */
export const TOOL_BASE_AGE_MS = DAY_MS;
const RESOLVED_SHOWN = 10;

export interface TechIssuesDeps {
  now(): number;
  latestAudit(client: string): StoredAudit | undefined;
  latestCrawl(client: string): StoredCrawl | undefined;
  latestCrawlTask(client: string): { taskId: string; ranAt: number } | undefined;
  /** GET /on_page/summary/{id} of a stored task (no task is posted). */
  onPageSummary(taskId: string): Promise<{ status?: string | undefined; issues: { check: string; pages: number }[] }>;
  /** Stored URL Inspection results as raw issues (Phase 13 A-5), or undefined when there are none. */
  inspectionIssues?(client: Client): { run: SourceRun; issues: RawIssue[] } | undefined;
  /** DataForSEO on-page checks that mean a problem. */
  problemChecks: ReadonlySet<string>;
  /** Phase 13 B: read a provider Site Audit (paid; existing project only). Throws ProviderUnavailableError for a missing key or project. */
  siteAudit?(client: Client, source: "ahrefs_site_audit", opts: { issueUrls: number }): Promise<{ run: SourceRun; issues: RawIssue[] }>;
  /** Phase 13 B: remember that this provider's data was stored (key-removal purge). */
  markProviderData?(provider: "ahrefs"): void;
  latestIssueSnapshotBefore(client: string, beforeMs: number, excludeIds?: readonly string[]): IssueSnapshot | undefined;
  saveIssueSnapshot(s: IssueSnapshot): void;
}

/** The real stores (and DataForSEO's free summary read), loaded on first use. */
export async function loadTechIssuesDeps(): Promise<TechIssuesDeps> {
  const [audits, crawls, snaps, dfs, shape, inspections, indexing] = await Promise.all([
    import("../lib/audits.js"),
    import("../lib/crawls.js"),
    import("../lib/issue-snapshots.js"),
    import("../providers/dataforseo.js"),
    import("../providers/dataforseo-shape.js"),
    import("../lib/inspections.js"),
    import("../analysis/indexing.js"),
  ]);
  return {
    now: () => Date.now(),
    latestAudit: audits.latestAudit,
    latestCrawl: (c) => crawls.latestCrawl(c),
    latestCrawlTask: audits.latestCrawlTask,
    onPageSummary: async (id) => {
      const s = await dfs.onPageSummary(id);
      return { status: s.status, issues: s.issues };
    },
    problemChecks: shape.PROBLEM_CHECKS,
    // Stored URL Inspection results (latest per URL): not indexed, and Google's canonical differing from the page's.
    inspectionIssues: (c) => {
      if (!c.gscProperty) return undefined;
      const latest = inspections.latestInspections(c.slug, c.gscProperty);
      if (!latest.length) return undefined;
      const at = Math.max(...latest.map((i) => i.inspectedAt));
      return { run: { source: "gsc_inspection", runId: `inspections@${new Date(at).toISOString()}`, ranAt: new Date(at).toISOString(), stale: false }, issues: indexing.inspectionRawIssues(latest, c.keyPages) };
    },
    latestIssueSnapshotBefore: snaps.latestIssueSnapshotBefore,
    saveIssueSnapshot: snaps.saveIssueSnapshot,
    siteAudit: async (c, _source, o) => (await import("../providers/ahrefs-site-audit.js")).readAhrefsSiteAudit(c, o),
    markProviderData: (p) => {
      void import("../lib/provider-data.js").then((m) => m.markProviderData(p));
    },
  };
}

export interface TechIssuesOptions {
  /** Default: every free source. */
  sources?: readonly IssueSource[] | undefined;
  minSeverity?: IssueSeverity | undefined;
  limit?: number | undefined;
  maxAgeDays?: number | undefined;
  issueUrls?: number | undefined;
  allowPaid?: boolean | undefined;
  /** Compare with the newest snapshot captured before this time (template: the end of the report period; tool: 24 h ago). */
  baseBeforeMs: number;
  /** Snapshots this run already made (never its own base). */
  excludeSnapshotIds?: readonly string[] | undefined;
  /** Save this run as a snapshot (default true). */
  save?: boolean | undefined;
}

export type TechIssuesResult = TechnicalIssuesData & { snapshotId: string | null };

const iso = (ms: number) => new Date(ms).toISOString();
const SEVERITY_OK = (s: string): s is IssueSeverity => s === "critical" || s === "high" || s === "medium" || s === "low";

/** The saved audit's findings: site checks as `site_hygiene`, crawlmark's page checks as `audit`; its local crawl is read from the crawl store instead. */
export function auditIssues(audit: StoredAudit): { audit: RawIssue[]; hygiene: RawIssue[]; checks: string[]; hygieneRan: boolean } {
  const out = { audit: [] as RawIssue[], hygiene: [] as RawIssue[] };
  for (const f of audit.findings) {
    if (f.source === "crawl" || !SEVERITY_OK(f.severity)) continue;
    const title = cleanText(f.title) ?? f.rule;
    const url = cleanText(f.url, 2000) ?? "";
    const evidence = cleanText(f.evidence) ?? undefined;
    if (f.source === "site") out.hygiene.push({ source: "site_hygiene", rule: f.rule, url, severity: f.severity, nativeSeverity: f.severity, title, count: null, ...(evidence ? { evidence } : {}) });
    else out.audit.push({ source: "audit", rule: `${f.source}:${f.rule}`, url, severity: f.severity, nativeSeverity: f.severity, title, count: null, ...(evidence ? { evidence } : {}) });
  }
  const sources = new Set(audit.checked.map((c) => c.source));
  return { ...out, checks: [...sources].filter((s) => s !== "site" && s !== "crawl").sort(), hygieneRan: sources.has("site") };
}

/** The newest local crawl's findings (exhaustive crawls also mark `site:crawl-complete`, so they can clear duplicate checks). */
export function crawlIssues(crawl: StoredCrawl): RawIssue[] {
  return analyzeCrawl(crawl.pages, { exhaustive: crawl.exhaustive }).findings.map((f) => ({
    source: "local_crawl" as const,
    rule: f.rule,
    url: cleanText(f.url, 2000) ?? "",
    severity: f.severity,
    nativeSeverity: f.severity,
    title: cleanText(f.title) ?? f.rule,
    count: null,
  }));
}

/** A stored DataForSEO crawl's per-check page counts (count-only items). Only problem checks are kept. */
export function dataForSeoCrawlIssues(summary: { issues: { check: string; pages: number }[] }, problemChecks: ReadonlySet<string>): RawIssue[] {
  return summary.issues
    .filter((i) => i.pages > 0 && (problemChecks.has(i.check) || i.check === "redirect_chain"))
    .map((i) => {
      const check = cleanText(i.check, 80) ?? "check";
      const severity = onPageSeverity(check);
      return { source: "dataforseo_crawl" as const, rule: check, url: null, severity, nativeSeverity: severity, title: `DataForSEO check failed: ${check.replace(/_/g, " ")}`, count: Math.round(i.pages) };
    });
}

/**
 * Read every requested source, merge, compare with the base snapshot (D10) and save this run's snapshot.
 * Sources that can't be read are listed in `unavailable` with crawlmark's own wording (no provider error text).
 */
export async function technicalIssues(client: Client, opts: TechIssuesOptions, deps: TechIssuesDeps): Promise<TechIssuesResult> {
  const now = deps.now();
  const sources = [...new Set(opts.sources?.length ? opts.sources : FREE_ISSUE_SOURCES)];
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const stale = (ranAt: number) => now - ranAt > maxAgeDays * DAY_MS;
  const want = (s: IssueSource) => sources.includes(s);
  const raws: RawIssue[] = [];
  const runs: SourceRun[] = [];
  const unavailable: TechnicalIssuesData["unavailable"] = [];

  if (want("audit") || want("site_hygiene")) {
    const audit = deps.latestAudit(client.slug);
    if (!audit) {
      if (want("audit")) unavailable.push({ source: "audit", reason: `no saved audit for ${client.domain} yet` });
      if (want("site_hygiene")) unavailable.push({ source: "site_hygiene", reason: `no saved audit for ${client.domain} yet` });
    } else {
      const a = auditIssues(audit);
      if (want("audit")) {
        raws.push(...a.audit);
        runs.push({ source: "audit", runId: audit.id, ranAt: iso(audit.ranAt), stale: stale(audit.ranAt), checks: a.checks });
      }
      if (want("site_hygiene")) {
        if (a.hygieneRan) {
          raws.push(...a.hygiene);
          runs.push({ source: "site_hygiene", runId: audit.id, ranAt: iso(audit.ranAt), stale: stale(audit.ranAt) });
        } else unavailable.push({ source: "site_hygiene", reason: "the newest saved audit has no site checks" });
      }
    }
  }

  if (want("local_crawl")) {
    const crawl = deps.latestCrawl(client.slug);
    if (!crawl) unavailable.push({ source: "local_crawl", reason: `no saved local crawl for ${client.domain} yet` });
    else {
      raws.push(...crawlIssues(crawl));
      runs.push({ source: "local_crawl", runId: crawl.id, ranAt: iso(crawl.ranAt), stale: stale(crawl.ranAt), checks: crawl.exhaustive ? [CRAWL_COMPLETE_KEY] : [] });
    }
  }

  if (want("dataforseo_crawl")) {
    const task = deps.latestCrawlTask(client.slug);
    if (!task) unavailable.push({ source: "dataforseo_crawl", reason: `no stored DataForSEO crawl for ${client.domain}` });
    else if (now - task.ranAt > DFS_CRAWL_MAX_AGE_DAYS * DAY_MS) unavailable.push({ source: "dataforseo_crawl", reason: `the newest DataForSEO crawl is more than ${DFS_CRAWL_MAX_AGE_DAYS} days old` });
    else {
      try {
        const summary = await deps.onPageSummary(task.taskId);
        if (summary.status && summary.status !== "finished") unavailable.push({ source: "dataforseo_crawl", reason: "the stored DataForSEO crawl hasn't finished" });
        else {
          raws.push(...dataForSeoCrawlIssues(summary, deps.problemChecks));
          runs.push({ source: "dataforseo_crawl", runId: task.taskId, ranAt: iso(task.ranAt), stale: stale(task.ranAt) });
        }
      } catch {
        unavailable.push({ source: "dataforseo_crawl", reason: "the stored DataForSEO crawl couldn't be read" });
      }
    }
  }

  if (want("gsc_inspection")) {
    const r = deps.inspectionIssues?.(client);
    if (!deps.inspectionIssues) unavailable.push({ source: "gsc_inspection", reason: "URL Inspection results aren't read by this build" });
    else if (!r) unavailable.push({ source: "gsc_inspection", reason: `no stored URL Inspection results for ${client.domain} yet` });
    else {
      raws.push(...r.issues);
      runs.push({ ...r.run, stale: stale(Date.parse(r.run.ranAt)) });
    }
  }

  for (const s of sources.filter((x) => PAID_ISSUE_SOURCES.has(x)) as "ahrefs_site_audit"[]) {
    const label = "Ahrefs";
    if (!opts.allowPaid) {
      unavailable.push({ source: s, reason: "paid source: needs allowPaid (it spends provider units)" });
      continue;
    }
    if (!deps.siteAudit) {
      unavailable.push({ source: s, reason: `the ${label} Site Audit reader isn't available in this build` });
      continue;
    }
    try {
      const r = await deps.siteAudit(client, s, { issueUrls: opts.issueUrls ?? 0 });
      raws.push(...r.issues);
      runs.push({ ...r.run, stale: stale(Date.parse(r.run.ranAt)) });
      deps.markProviderData?.("ahrefs");
    } catch (err) {
      // crawlmark's own wording only (a missing key or project names the setting); never the provider's error text.
      const e = err as Error;
      unavailable.push({ source: s, reason: e.name === "ProviderUnavailableError" || e instanceof BudgetExceededError ? e.message : `the ${label} Site Audit couldn't be read` });
    }
  }

  // Each item remembers the source runs that reported it, so a later run can tell when a carried item is no longer checked.
  const merged = mergeIssues(raws).map((i) => ({ ...i, seen: runs.filter((r) => i.sources.some((x) => x.source === r.source)) }));
  const base = deps.latestIssueSnapshotBefore(client.slug, opts.baseBeforeMs, opts.excludeSnapshotIds ?? []);
  const diff = diffIssues({ items: merged, checked: runs }, base ? { items: base.items.map((i) => ({ ...i, change: "first_run" as const })), checked: base.checked } : undefined, { now, maxAgeDays });

  let snapshotId: string | null = null;
  if (opts.save !== false && runs.length) {
    snapshotId = `iss_${ulid(now)}`;
    // Ahrefs storage decision: counts per issue only; example URLs from Ahrefs are shown in this result, never stored.
    const items = diff.items.map(({ change: _c, ...i }) => ({ ...i, sources: i.sources.map((x) => (x.source === "ahrefs_site_audit" ? { ...x, examples: [] } : x)) }));
    deps.saveIssueSnapshot({ id: snapshotId, client: client.slug, capturedAt: now, items, checked: runs, settings: { sources, maxAgeDays } });
  }

  const open = atLeast(diff.items, opts.minSeverity ?? "low").map(({ seen: _s, ...i }) => i);
  const limit = opts.limit ?? 25;
  return {
    sources: runs,
    unavailable,
    counts: severityCounts(open),
    changes: diff.changes,
    base: base ? { snapshotId: base.id, capturedAt: iso(base.capturedAt) } : null,
    issues: open.slice(0, limit),
    resolved: atLeast(diff.resolved, opts.minSeverity ?? "low").slice(0, RESOLVED_SHOWN),
    limit,
    total: open.length,
    ...(diff.noLongerChecked ? { noLongerChecked: diff.noLongerChecked } : {}),
    snapshotId,
  };
}

/** Phase 13 B: the paid sources' pre-flight (no request): units and requests per provider Site Audit source asked for. */
export async function planPaidIssueSources(client: Client, sources: readonly IssueSource[], issueUrls: number): Promise<{ source: IssueSource; provider: "ahrefs"; units: number; requests: number; breakdown: string }[]> {
  const out = [];
  if (sources.includes("ahrefs_site_audit")) {
    const { planAhrefsSiteAudit } = await import("../providers/ahrefs-site-audit.js");
    out.push({ source: "ahrefs_site_audit" as const, provider: "ahrefs" as const, ...planAhrefsSiteAudit(issueUrls) });
  }
  return out;
}
