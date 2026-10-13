import type { Severity } from "./findings.js";
import { normalizeUrl } from "./findings.js";
import type { HreflangIssue } from "./hreflang.js";
import { blocksEverything, isAllowed, parseRobots, pathOf, rulesFor } from "./robots.js";
import type { SchemaResult } from "./structured-data.js";

/** One issue from the site hygiene checks. They become findings with source "site". */
export interface HygieneFlag {
  rule: string;
  /** The page, sitemap URL or robots.txt URL the issue is about. */
  url: string;
  severity: Severity;
  title: string;
  evidence?: string;
}

export interface RobotsSummary {
  url: string;
  /** HTTP status, or null when the fetch failed. */
  status: number | null;
  found: boolean;
  /** Group used for Googlebot: "googlebot", "*" or "none". */
  group?: string;
  disallowAll?: boolean;
  sitemaps: string[];
  blockedKeyPages: string[];
}

/** robots.txt analysis from a fetch result. `text` is the body when the file exists. Pure. */
export function analyzeRobots(
  robotsUrl: string,
  fetched: { status: number; contentType: string | null; text: string },
  keyPages: string[],
): { robots: RobotsSummary; flags: HygieneFlag[] } {
  const flags: HygieneFlag[] = [];
  const looksHtml = /html/i.test(fetched.contentType ?? "") || /^\s*<(!doctype|html)/i.test(fetched.text);
  if (fetched.status === 404 || fetched.status === 410 || (fetched.status === 200 && looksHtml)) {
    flags.push({
      rule: "robots-missing",
      url: robotsUrl,
      severity: "low",
      title: "robots.txt is missing",
      evidence: fetched.status === 200 ? "The URL returns an HTML page, not a robots.txt file." : `HTTP ${fetched.status}`,
    });
    return { robots: { url: robotsUrl, status: fetched.status, found: false, sitemaps: [], blockedKeyPages: [] }, flags };
  }
  if (fetched.status !== 200) throw new Error(`robots.txt returned HTTP ${fetched.status}`);

  const file = parseRobots(fetched.text);
  const star = rulesFor(file, "*");
  const bot = rulesFor(file, "googlebot");
  const disallowAll = star.matched === "*" && blocksEverything(star.rules);
  if (disallowAll) {
    flags.push({ rule: "robots-disallow-all", url: robotsUrl, severity: "high", title: "robots.txt blocks all crawlers from the whole site", evidence: "Disallow: / for User-agent: *" });
  }
  const blockedKeyPages = keyPages.filter((u) => {
    try {
      return !isAllowed(bot.rules, pathOf(u));
    } catch {
      return false;
    }
  });
  for (const u of blockedKeyPages) {
    flags.push({ rule: "robots-blocks-key-page", url: u, severity: "high", title: "robots.txt blocks a key page for Googlebot", evidence: `group: ${bot.matched}` });
  }
  if (file.sitemaps.length === 0) {
    flags.push({ rule: "robots-no-sitemap", url: robotsUrl, severity: "low", title: "robots.txt has no Sitemap line" });
  }
  return { robots: { url: robotsUrl, status: 200, found: true, group: bot.matched, disallowAll, sitemaps: file.sitemaps, blockedKeyPages }, flags };
}

/** Compare key pages with the sitemap URL set (host's `www.` and the protocol are ignored). */
const looseKey = (u: string) => normalizeUrl(u).replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();

export function keyPagesMissingFromSitemaps(keyPages: string[], sitemapUrls: Iterable<string>): HygieneFlag[] {
  const set = new Set<string>();
  for (const u of sitemapUrls) set.add(looseKey(u));
  return keyPages
    .filter((u) => !set.has(looseKey(u)))
    .map((u) => ({ rule: "key-page-not-in-sitemap", url: u, severity: "medium" as const, title: "Key page is not listed in any sitemap" }));
}

export interface SampleResult {
  url: string;
  status: number;
  finalUrl: string;
  redirects: number;
  noindex: boolean;
  /** Where the noindex came from. */
  noindexSource?: "x-robots-tag" | "meta robots";
}

export function sampleFlags(samples: SampleResult[]): HygieneFlag[] {
  const out: HygieneFlag[] = [];
  for (const s of samples) {
    if (s.redirects > 0) out.push({ rule: "sitemap-redirect", url: s.url, severity: "medium", title: "Sitemap lists a URL that redirects", evidence: `-> ${s.finalUrl}` });
    if (s.status !== 200) out.push({ rule: "sitemap-non200", url: s.url, severity: s.status >= 400 ? "high" : "medium", title: "Sitemap lists a URL that does not return 200", evidence: `HTTP ${s.status}` });
    if (s.noindex) out.push({ rule: "sitemap-noindex", url: s.url, severity: "high", title: "Sitemap lists a noindex page", evidence: s.noindexSource });
  }
  return out;
}

export const hasNoindex = (directives: string | null | undefined) => /(^|[,\s])(noindex|none)([,\s]|$)/i.test(directives ?? "");

export function schemaFlags(url: string, r: SchemaResult): HygieneFlag[] {
  const out: HygieneFlag[] = [];
  const missing = r.issues.filter((i) => i.kind === "missing-property");
  if (missing.length) {
    out.push({
      rule: "schema-missing-property",
      url,
      severity: "medium",
      title: "JSON-LD is missing required properties (basic validation, not the Rich Results Test)",
      evidence: missing.map((i) => `${i.type}: ${i.detail.join(", ")}`).join("; "),
    });
  }
  const rec = r.issues.filter((i) => i.kind === "missing-recommended");
  if (rec.length) {
    out.push({
      rule: "schema-missing-recommended",
      url,
      severity: "low",
      title: "JSON-LD is missing properties Google recommends (basic validation, not the Rich Results Test)",
      evidence: rec.map((i) => `${i.type}: ${i.detail.join(", ")}`).join("; "),
    });
  }
  const bad = r.issues.filter((i) => i.kind === "parse-error");
  if (bad.length) {
    out.push({
      rule: "schema-parse-error",
      url,
      severity: "low",
      title: "A JSON-LD block is not valid JSON (basic validation, not the Rich Results Test)",
      evidence: `${bad.length} block${bad.length === 1 ? "" : "s"}: ${bad[0]!.detail[0]}`,
    });
  }
  return out;
}

const HREFLANG_META: Record<HreflangIssue["rule"], { severity: Severity; title: string }> = {
  "hreflang-not-reciprocal": { severity: "medium", title: "hreflang alternates do not link back to this page" },
  "hreflang-missing-self": { severity: "medium", title: "hreflang set has no self-reference" },
  "hreflang-missing-x-default": { severity: "low", title: "Multiple languages but no hreflang x-default" },
};

export const hreflangFlags = (url: string, issues: HreflangIssue[]): HygieneFlag[] =>
  issues.map((i) => ({ rule: i.rule, url, ...HREFLANG_META[i.rule], evidence: i.evidence }));

/**
 * Sitemap URLs the (exhaustive) crawl never reached. URLs whose `<lastmod>` is after the crawl
 * started may simply be newer than the crawl, so they are left out.
 */
export function orphanUrls(sitemapUrls: Iterable<string>, crawled: Iterable<string>, opts: { crawlAtMs?: number; lastmods?: ReadonlyMap<string, number> } = {}): string[] {
  const reached = new Set<string>();
  for (const u of crawled) reached.add(looseKey(u));
  const out: string[] = [];
  for (const u of sitemapUrls) {
    if (reached.has(looseKey(u))) continue;
    const mod = opts.lastmods?.get(u);
    if (opts.crawlAtMs !== undefined && mod !== undefined && mod > opts.crawlAtMs) continue;
    out.push(u);
  }
  return out;
}

/** One finding per orphan. Never capped: a cap would let the diff call the uncapped ones resolved. */
export const orphanFlags = (urls: string[]): HygieneFlag[] =>
  urls.map((u) => ({ rule: "orphan-page", url: u, severity: "medium" as const, title: "Sitemap URL the full crawl never reached through links (orphan page)" }));

/** The stored result of the site hygiene checks (audit `site.hygiene`). */
export interface SiteHygiene {
  origin: string;
  robots: RobotsSummary | { error: string };
  sitemaps:
    | {
        sources: { robots: string[]; gsc: string[]; fallback: string | null };
        files: { url: string; kind?: "index" | "urlset"; urls?: number; error?: string }[];
        totalUrls: number;
        /** False when a cap (depth, child count, URL count) or a fetch failure left the URL set partial. */
        complete: boolean;
        sampled: SampleResult[];
        sampleErrors: { url: string; error: string }[];
      }
    | { error: string };
  structuredData:
    | { pages: { url: string; source: "rendered" | "raw"; blocks: number; types: string[]; issues: SchemaResult["issues"] }[]; errors: { url: string; error: string }[] }
    | { error: string };
  hreflang: { pages: { url: string; alternates: number; issues: string[] }[]; errors: { url: string; error: string }[] } | { error: string };
  orphans: { available: false; reason: string } | { available: true; crawlTaskId: string; crawledUrls: number; orphanCount: number; orphans: string[] };
  flags: HygieneFlag[];
  /** Check keys of the sub-checks that ran to completion (see siteCheckUrl in findings.ts); they feed the audit diff. */
  checked: string[];
  notes: string[];
}
