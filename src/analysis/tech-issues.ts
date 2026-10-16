/**
 * One deduplicated technical-issues list from every source (Phase 13, spec 13.5.3, D8-D10). Pure: the
 * readers in reports/technical-issues.ts turn stored audits, crawls and inspections into RawIssues, and
 * this module maps them onto one canonical catalogue, merges them, picks a severity and diffs two
 * snapshots with audit-diff semantics (a source that didn't re-run can't clear anything).
 *
 * The catalogue is data: adding a row needs no code change. A rule no row matches keeps its own key,
 * `<source>:<rule>`, so nothing is ever dropped or merged by guesswork.
 */
import type { IssueSeverity, IssueSource, SourceRun, TechIssue, TechIssueSource, TechnicalIssuesData } from "../reports/report-types.js";
import { CRAWL_COMPLETE_KEY, CRAWL_COMPLETE_RULES, normalizeUrl } from "./findings.js";

const SEVERITIES: IssueSeverity[] = ["critical", "high", "medium", "low"];

/** One problem as a single source reports it, before merging. Text is already sanitised by the reader. */
export interface RawIssue {
  source: IssueSource;
  /** The source's rule. Audit rules are `<finding source>:<rule>` (e.g. `axe:button-name`, `onpage:no_title`). */
  rule: string;
  /** Null for count-only sources (a provider's per-check page count). */
  url: string | null;
  severity: IssueSeverity;
  nativeSeverity: string;
  title: string;
  /** Pages, for count-only sources. */
  count: number | null;
  examples?: string[];
  /** Short evidence (an HTTP status for sitemap URLs): used only to pick the catalogue row. */
  evidence?: string;
}

export interface CatalogueRow {
  key: string;
  title: string;
  category: string;
  /** `<issue source>:<rule>` patterns (audit rules carry their finding source: `audit:onpage:no_title`). */
  match: string[];
  /** Ahrefs issue names (case-insensitive prefix). */
  ahrefs?: string[];
}

/**
 * The starter mapping (spec 13.5.3). crawlmark sources: `audit:<finding source>:<rule>` for the saved audit's
 * findings, `local_crawl:<rule>`, `site_hygiene:<rule>`, `gsc_inspection:<rule>`; DataForSEO crawl checks:
 * `dataforseo_crawl:<check>`. Ahrefs names are filled in by Stage B (research §1).
 */
export const CATALOGUE: readonly CatalogueRow[] = [
  { key: "broken-internal-link", title: "Internal link to a broken page", category: "links", match: ["local_crawl:broken-internal-link", "dataforseo_crawl:is_broken"], ahrefs: ["Page has links to broken page"] },
  { key: "server-error", title: "Page returns a server error (5xx)", category: "crawlability", match: ["audit:onpage:is_5xx_code", "dataforseo_crawl:is_5xx_code", "site_hygiene:sitemap-non200:5xx"], ahrefs: ["5XX page"] },
  { key: "client-error-page", title: "Page returns a client error (4xx)", category: "crawlability", match: ["audit:onpage:is_4xx_code", "dataforseo_crawl:is_4xx_code", "site_hygiene:sitemap-non200:4xx"], ahrefs: ["4XX page"] },
  { key: "missing-title", title: "Page has no title", category: "content", match: ["local_crawl:missing-title", "audit:onpage:no_title", "dataforseo_crawl:no_title"], ahrefs: ["Title tag missing or empty"] },
  { key: "duplicate-title", title: "Title is used by another page", category: "duplicates", match: ["local_crawl:duplicate-title", "audit:onpage:duplicate_title_tag", "dataforseo_crawl:duplicate_title_tag"], ahrefs: ["Multiple pages have same title"] },
  { key: "missing-description", title: "Page has no meta description", category: "content", match: ["local_crawl:missing-description", "audit:onpage:no_description", "dataforseo_crawl:no_description"], ahrefs: ["Meta description tag missing or empty"] },
  { key: "missing-h1", title: "Page has no H1 heading", category: "content", match: ["audit:onpage:no_h1_tag", "dataforseo_crawl:no_h1_tag"], ahrefs: ["H1 tag missing or empty"] },
  { key: "redirect-chain", title: "Redirect chain (two or more hops)", category: "redirects", match: ["local_crawl:redirect-chain", "dataforseo_crawl:redirect_chain"], ahrefs: ["Redirect chain"] },
  { key: "noindex-in-sitemap", title: "Sitemap lists a noindex page", category: "indexability", match: ["site_hygiene:sitemap-noindex"], ahrefs: ["Noindex page in sitemap"] },
  { key: "canonical-mismatch", title: "Google chose a different canonical than the page declares", category: "indexability", match: ["audit:indexing:canonical-mismatch", "gsc_inspection:canonical-mismatch"] },
  { key: "canonical-js-only", title: "Canonical differs between the raw and the rendered page", category: "indexability", match: ["audit:rendering:canonical-mismatch", "audit:rendering:canonical-js-only"] },
  { key: "not-indexed", title: "Page is not indexed", category: "indexability", match: ["audit:indexing:not-indexed", "gsc_inspection:not-indexed"] },
  { key: "orphan-page", title: "Page in a sitemap with no internal links to it", category: "links", match: ["site_hygiene:orphan-page"], ahrefs: ["Orphan page (has no incoming internal links)"] },
  { key: "robots-blocks-key-page", title: "robots.txt blocks a key page", category: "crawlability", match: ["site_hygiene:robots-blocks-key-page"] },
  { key: "ai-crawler-blocked", title: "An AI search crawler is blocked", category: "ai-discoverability", match: ["site_hygiene:ai-search-crawler-blocked"] },
  { key: "slow-lcp", title: "Slow largest contentful paint", category: "performance", match: ["audit:lighthouse:largest-contentful-paint", "audit:crux:field-lcp-poor", "audit:crux:field-lcp-needs-improvement"], ahrefs: ["Slow page"] },
];

const BY_MATCH = new Map<string, CatalogueRow>(CATALOGUE.flatMap((r) => r.match.map((m) => [m, r] as const)));

/** The catalogue pattern a raw issue is looked up by (sitemap URLs that don't return 200 split by status class). */
function matchKey(r: RawIssue): string {
  if (r.source === "site_hygiene" && r.rule === "sitemap-non200") {
    const status = Number(/(\d{3})/.exec(r.evidence ?? "")?.[1]);
    if (status >= 500) return "site_hygiene:sitemap-non200:5xx";
    if (status >= 400) return "site_hygiene:sitemap-non200:4xx";
  }
  return `${r.source}:${r.rule}`;
}

/**
 * Stage B: an Ahrefs Site Audit issue matches a row by its name (case-insensitive prefix: Ahrefs doesn't document its
 * issue IDs, research §1). Unmatched ones keep their own key.
 */
function providerRow(r: RawIssue): CatalogueRow | undefined {
  if (r.source === "ahrefs_site_audit") {
    const name = r.rule.toLowerCase();
    return CATALOGUE.find((row) => row.ahrefs?.some((a) => name.startsWith(a.toLowerCase())));
  }
  return undefined;
}

/** Canonical key, title and category for a raw issue: its catalogue row, axe rules per rule, else `<source>:<rule>`. */
export function canonicalOf(r: RawIssue): { key: string; title: string; category: string } {
  const row = BY_MATCH.get(matchKey(r)) ?? providerRow(r);
  if (row) return { key: row.key, title: row.title, category: row.category };
  if (r.source === "audit" && r.rule.startsWith("axe:")) return { key: `a11y:${r.rule.slice(4)}`, title: r.title, category: "accessibility" };
  return { key: `${r.source}:${r.rule}`, title: r.title, category: "other" };
}

/** Sources that are crawlmark's own checks; everything else is a provider's crawler. */
const OWN_SOURCES: ReadonlySet<IssueSource> = new Set(["audit", "local_crawl", "site_hygiene", "gsc_inspection"]);

/** D9: the highest severity across sources, except that an item only providers report is never critical. */
export function mergedSeverity(sources: { source: IssueSource; severity: IssueSeverity }[]): IssueSeverity {
  let best = SEVERITIES.length - 1;
  for (const s of sources) best = Math.min(best, SEVERITIES.indexOf(s.severity));
  const sev = SEVERITIES[best]!;
  return sev === "critical" && !sources.some((s) => OWN_SOURCES.has(s.source)) ? "high" : sev;
}

/** The identity of an item across snapshots: its key, plus its URL for URL-level items. */
export const itemId = (i: Pick<TechIssue, "key" | "url">) => `${i.key}\n${i.url ?? ""}`;

const bySeverity = (a: TechIssue, b: TechIssue) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.affected - a.affected || a.key.localeCompare(b.key) || (a.url ?? "").localeCompare(b.url ?? "");

/**
 * D8: merge raw issues on (canonical key, normalised URL) for URL-level ones and on the key for count-only ones.
 * Each item keeps every source with its native severity and count; `affected` is the largest count any one
 * source reports (never a sum: different crawlers' counts aren't additive). Sorted severity → affected → key.
 */
export function mergeIssues(raws: RawIssue[]): TechIssue[] {
  const items = new Map<string, { item: TechIssue; sev: { source: IssueSource; severity: IssueSeverity }[] }>();
  for (const r of raws) {
    const c = canonicalOf(r);
    const url = r.url === null ? null : normalizeUrl(r.url);
    const id = `${c.key}\n${url ?? ""}`;
    let e = items.get(id);
    if (!e) {
      e = { item: { key: c.key, title: c.title, category: c.category, severity: r.severity, url, affected: 0, sources: [], change: "first_run" }, sev: [] };
      items.set(id, e);
    }
    e.sev.push({ source: r.source, severity: r.severity });
    const examples = [...new Set((r.examples ?? (url ? [url] : [])).map((u) => normalizeUrl(u)))].slice(0, 3);
    const existing = e.item.sources.find((s) => s.source === r.source && s.rule === r.rule);
    if (existing) {
      existing.count = existing.count === null || r.count === null ? (existing.count ?? r.count) : Math.max(existing.count, r.count);
      existing.examples = [...new Set([...existing.examples, ...examples])].slice(0, 3);
      if (SEVERITIES.indexOf(r.severity) < SEVERITIES.indexOf(existing.nativeSeverity as IssueSeverity)) existing.nativeSeverity = r.nativeSeverity;
    } else {
      const s: TechIssueSource = { source: r.source, rule: r.rule, nativeSeverity: r.nativeSeverity, count: r.count, examples };
      e.item.sources.push(s);
    }
  }
  const out: TechIssue[] = [];
  for (const { item, sev } of items.values()) {
    item.severity = mergedSeverity(sev);
    item.affected = Math.max(item.url ? 1 : 0, ...item.sources.map((s) => s.count ?? 0));
    item.sources.sort((a, b) => a.source.localeCompare(b.source) || a.rule.localeCompare(b.rule));
    out.push(item);
  }
  return out.sort(bySeverity);
}

/** The stored half of a technical-issues run (D10): its items (change fields left out) and the source runs it read. */
/** A stored item with the source runs that last reported it (R-1): a carried, not re-checked item keeps them. */
export type SeenIssue = TechIssue & { seen?: SourceRun[] };

export interface IssueSnapshotData {
  items: SeenIssue[];
  checked: SourceRun[];
}

export interface DiffOptions {
  now: number;
  maxAgeDays: number;
}

/** True when `source` has a newer run in `cur` than in `base` (a different run that ran later). */
function reran(source: IssueSource, cur: SourceRun[], base: SourceRun[], rule: string): boolean {
  const now = cur.find((r) => r.source === source);
  if (!now) return false;
  const then = base.find((r) => r.source === source);
  if (then && (now.runId === then.runId || Date.parse(now.ranAt) <= Date.parse(then.ranAt))) return false;
  // An audit only clears what its own checks looked at again (lighthouse, axe, indexing, …).
  if (source === "audit" && now.checks) {
    const finding = rule.split(":")[0]!;
    if (!now.checks.includes(finding)) return false;
  }
  // A capped crawl may miss the other page of a duplicate (or the canonical target), so only a complete one clears those.
  if (source === "local_crawl" && CRAWL_COMPLETE_RULES.has(rule) && !(now.checks ?? []).includes(CRAWL_COMPLETE_KEY)) return false;
  return true;
}

/**
 * D10: compare a run with the base snapshot. new = in the run, not in the base; persistent = in both; a base item
 * the run doesn't have is resolved only when a source that reported it has a newer run now (and, for an audit,
 * ran that check again); otherwise unverified, never counted as fixed. Unverified items stay in the open list
 * (nothing confirmed they're gone), so they are carried into the next snapshot too. With no base every item is
 * `first_run` and `changes` is null.
 */
export function diffIssues(
  current: IssueSnapshotData,
  base: IssueSnapshotData | undefined,
  o: DiffOptions = { now: Date.now(), maxAgeDays: Number.POSITIVE_INFINITY },
): { items: SeenIssue[]; resolved: TechIssue[]; unverified: SeenIssue[]; noLongerChecked: number; changes: TechnicalIssuesData["changes"] } {
  if (!base) return { items: current.items.map((i) => ({ ...i, change: "first_run" })), resolved: [], unverified: [], noLongerChecked: 0, changes: null };
  const before = new Map(base.items.map((i) => [itemId(i), i]));
  const now = new Set(current.items.map(itemId));
  const available = new Set(current.checked.map((r) => r.source));
  const items = current.items.map((i): SeenIssue => ({ ...i, change: before.has(itemId(i)) ? "persistent" : "new" }));
  const resolved: TechIssue[] = [];
  const unverified: SeenIssue[] = [];
  let noLongerChecked = 0;
  for (const b of base.items) {
    if (now.has(itemId(b))) continue;
    const seen = b.seen?.length ? b.seen : base.checked.filter((r) => b.sources.some((s) => s.source === r.source));
    const cleared = b.sources.some((s) => reran(s.source, current.checked, seen, s.rule));
    if (cleared) {
      const { seen: _s, ...rest } = b;
      resolved.push({ ...rest, change: "resolved" });
      continue;
    }
    // R-1: carry a not re-checked item only while a source that reported it is still read and its run isn't too old;
    // otherwise it's no longer checked and leaves the open list (never counted as resolved).
    const live = seen.filter((r) => available.has(r.source) && o.now - Date.parse(r.ranAt) <= o.maxAgeDays * 86_400_000);
    if (!live.length) {
      noLongerChecked++;
      continue;
    }
    unverified.push({ ...b, seen, change: "unverified" });
  }
  return {
    items: [...items, ...unverified].sort(bySeverity),
    resolved: resolved.sort(bySeverity),
    unverified: unverified.sort(bySeverity),
    noLongerChecked,
    changes: { new: items.filter((i) => i.change === "new").length, resolved: resolved.length, persistent: items.filter((i) => i.change === "persistent").length, unverified: unverified.length },
  };
}

/** Items at or above `min` severity. */
export const atLeast = <T extends Pick<TechIssue, "severity">>(items: T[], min: IssueSeverity): T[] => items.filter((i) => SEVERITIES.indexOf(i.severity) <= SEVERITIES.indexOf(min));

/** Open-item counts per severity. */
export function severityCounts(items: TechIssue[]): Record<IssueSeverity, number> {
  const c: Record<IssueSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of items) c[i.severity]++;
  return c;
}
