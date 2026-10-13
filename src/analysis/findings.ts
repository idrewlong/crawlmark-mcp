import { createHash } from "node:crypto";
import type { AuditResult } from "../reports/audit.js";
import { stripControl } from "../lib/terminal-text.js";
import { cruxCheckUrl, cruxFindings } from "./crux.js";

/**
 * Normalised audit findings. Pure: no I/O, so it is tested with hand-built
 * fixtures. `crux`, `gtm` and `crawl` (Phase 12; `crawl` from the local crawler)
 * appear only when run_audit is asked for them.
 */
export type FindingSource = "lighthouse" | "axe" | "indexing" | "onpage" | "rendering" | "crawl" | "site" | "crux" | "gtm";
export type Severity = "critical" | "high" | "medium" | "low";

export interface Finding {
  /** Stable hash of source + rule + url (+ selector for axe). */
  id: string;
  source: FindingSource;
  /** e.g. "color-contrast", "largest-contentful-paint", "not-indexed". */
  rule: string;
  url: string;
  severity: Severity;
  title: string;
  /** Short detail: selector, metric value, coverage state. */
  evidence?: string;
}

/** One check that ran successfully: this source looked at this URL. */
export interface CheckedPair {
  url: string;
  source: FindingSource;
}

/** Site-level checks (sitemaps) are not tied to a page; they are recorded under this URL. */
export const SITE_CHECK_URL = "site";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

/** Normalise a URL for hashing and comparison: lowercase host, no fragment, no default port, no trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return raw.trim().replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

/**
 * axe reports one entry per rule per page and its node order is not stable between
 * runs, so the selector is deliberately not part of the ID (it is kept as evidence).
 */
export function findingId(source: FindingSource, rule: string, url: string): string {
  return createHash("sha256").update([source, rule, normalizeUrl(url)].join("\n")).digest("hex").slice(0, 16);
}

/**
 * Which site sub-check a finding depends on. Sub-check keys start with "site" (the GSC sitemap
 * check is plain "site"); sampled sitemap URLs and per-page checks use the page URL.
 */
export function siteCheckUrl(rule: string, url: string): string {
  if (rule.startsWith("robots-")) return "site:robots";
  if (rule === "sitemap-non200" || rule === "sitemap-redirect" || rule === "sitemap-noindex") return normalizeUrl(url);
  if (rule === "key-page-not-in-sitemap") return "site:sitemap-urls";
  if (rule.startsWith("schema-")) return `site:schema ${normalizeUrl(url)}`;
  if (rule.startsWith("hreflang-")) return `site:hreflang ${normalizeUrl(url)}`;
  if (rule === "orphan-page") return "site:orphans";
  return SITE_CHECK_URL;
}

const siteKeyUrl = (u: string) => (u.startsWith("site") ? u : normalizeUrl(u));

/** Phase 12 C1: every local crawl records this checked key; only an exhaustive one also records CRAWL_COMPLETE_KEY. */
export const CRAWL_SITE_KEY = "site:crawl";
export const CRAWL_COMPLETE_KEY = "site:crawl-complete";
/** Crawl rules that compare pages with each other, so only a complete (exhaustive) crawl can clear them. */
export const CRAWL_COMPLETE_RULES: ReadonlySet<string> = new Set(["duplicate-title", "duplicate-description", "canonical-to-non-200"]);

/** A Tag Manager finding's container key: `gtm://<publicId>/<kind>/<id>` → `gtm://<publicId>`. */
export const gtmContainerKey = (url: string) => url.replace(/^(gtm:\/\/[^/]+).*$/, "$1");

/** The {url, source} a finding depends on having run, for the diff's resolved/unverified decision. */
export function checkOf(f: Pick<Finding, "source" | "url"> & { rule?: string }): CheckedPair {
  if (f.source === "site") return { url: siteCheckUrl(f.rule ?? "", f.url), source: f.source };
  if (f.source === "crux") return { url: cruxCheckUrl(normalizeUrl(f.url)), source: f.source };
  // Every GTM finding depends on its container having been audited (D13).
  if (f.source === "gtm") return { url: gtmContainerKey(f.url), source: f.source };
  // A capped crawl may miss the other page of a duplicate (or the canonical target), so it can't clear those.
  if (f.source === "crawl" && CRAWL_COMPLETE_RULES.has(f.rule ?? "")) return { url: CRAWL_COMPLETE_KEY, source: f.source };
  return { url: normalizeUrl(f.url), source: f.source };
}

/** crux and gtm check keys (and crawl's site:crawl keys) are already canonical (not page URLs), so they are compared as written. */
export const checkKey = (c: CheckedPair) =>
  `${c.source}\n${c.source === "site" ? siteKeyUrl(c.url) : c.source === "crux" || c.source === "gtm" || (c.source === "crawl" && c.url.startsWith("site:")) ? c.url : normalizeUrl(c.url)}`;

const AXE_SEVERITY: Record<string, Severity> = { critical: "critical", serious: "high", moderate: "medium", minor: "low" };

/**
 * Severity for DataForSEO instant-page checks, keyed by the check names in
 * PROBLEM_CHECKS (dataforseo-shape.ts). Anything not listed is `low`.
 * `noindex` is not exposed by the instant-page mapping today, so it has no entry.
 */
export const ONPAGE_SEVERITY: Record<string, Severity> = {
  no_title: "high",
  is_broken: "high",
  is_4xx_code: "high",
  is_5xx_code: "high",
  no_description: "medium",
  duplicate_title_tag: "medium",
  no_h1_tag: "medium",
};

export const onPageSeverity = (check: string): Severity => ONPAGE_SEVERITY[check] ?? "low";

const humanize = (s: string) => s.replace(/_/g, " ");

export function extractFindings(audit: AuditResult): Finding[] {
  const out = new Map<string, Finding>();
  const add = (f: Omit<Finding, "id">) => {
    const id = findingId(f.source, f.rule, f.url);
    if (!out.has(id)) out.set(id, { id, ...f });
  };

  for (const page of audit.pages) {
    const url = page.url;

    if (page.accessibility.ok) {
      for (const v of page.accessibility.data.violations) {
        const selector = v.examples[0];
        add({
          source: "axe",
          rule: v.id,
          url,
          severity: AXE_SEVERITY[v.impact ?? "minor"] ?? "low",
          title: v.help,
          evidence: `${selector ?? "(no selector)"}; ${v.nodes} ${v.nodes === 1 ? "node" : "nodes"}`,
        });
      }
    }

    if (page.lighthouse.ok) {
      const lh = page.lighthouse.data;
      const cats: [string, number][] = [
        ["performance", lh.scores.performance],
        ["accessibility", lh.scores.accessibility],
        ["best-practices", lh.scores.bestPractices],
        ["seo", lh.scores.seo],
      ];
      for (const [name, score] of cats) {
        if (score < 90) {
          add({
            source: "lighthouse",
            rule: `category-${name}`,
            url,
            severity: score < 50 ? "high" : "medium",
            title: `Lighthouse ${name} score is ${score}`,
            evidence: `score ${score}`,
          });
        }
      }
      if (lh.lab.lcpMs > 2500) {
        add({
          source: "lighthouse",
          rule: "largest-contentful-paint",
          url,
          severity: lh.lab.lcpMs > 4000 ? "high" : "medium",
          title: "Slow largest contentful paint (lab)",
          evidence: `${lh.lab.lcpMs}ms`,
        });
      }
      if (lh.lab.cls > 0.1) {
        add({
          source: "lighthouse",
          rule: "cumulative-layout-shift",
          url,
          severity: lh.lab.cls > 0.25 ? "high" : "medium",
          title: "High cumulative layout shift (lab)",
          evidence: String(lh.lab.cls),
        });
      }
      for (const o of lh.opportunities) {
        if ((o.savingsMs ?? 0) > 500) {
          add({
            source: "lighthouse",
            rule: o.id,
            url,
            severity: "low",
            title: o.title,
            evidence: `${Math.round(o.savingsMs!)}ms potential savings`,
          });
        }
      }
    }

    if (page.indexing.ok) {
      const ix = page.indexing.data;
      if (ix.verdict && ix.verdict !== "PASS") {
        add({
          source: "indexing",
          rule: "not-indexed",
          url,
          severity: "high",
          title: "Page is not indexed",
          ...(ix.coverageState ? { evidence: ix.coverageState } : {}),
        });
      }
      if (ix.googleCanonical && ix.userCanonical && normalizeUrl(ix.googleCanonical) !== normalizeUrl(ix.userCanonical)) {
        add({
          source: "indexing",
          rule: "canonical-mismatch",
          url,
          severity: "medium",
          title: "Google chose a different canonical than the page declares",
          evidence: `google: ${ix.googleCanonical}; declared: ${ix.userCanonical}`,
        });
      }
    }

    if (page.rendering?.ok) {
      for (const f of page.rendering.data.flags) {
        add({ source: "rendering", rule: f.rule, url, severity: f.severity, title: f.title, evidence: f.evidence });
      }
    }

    if (page.onPage.ok) {
      const op = page.onPage.data as { failedChecks?: string[] } | null;
      for (const check of op?.failedChecks ?? []) {
        add({ source: "onpage", rule: check, url, severity: onPageSeverity(check), title: `On-page check failed: ${humanize(check)}` });
      }
    }
  }

  if (audit.site.sitemaps.ok) {
    for (const s of audit.site.sitemaps.data) {
      const path = s.path ?? "(unknown sitemap)";
      if (s.errors > 0) {
        add({ source: "site", rule: "sitemap-errors", url: path, severity: "high", title: "Sitemap has errors", evidence: `${s.errors} errors` });
      } else if (s.warnings > 0) {
        add({ source: "site", rule: "sitemap-warnings", url: path, severity: "low", title: "Sitemap has warnings", evidence: `${s.warnings} warnings` });
      }
    }
  }

  if (audit.site.hygiene?.ok) {
    for (const f of audit.site.hygiene.data.flags) {
      add({ source: "site", rule: f.rule, url: f.url, severity: f.severity, title: f.title, ...(f.evidence ? { evidence: f.evidence } : {}) });
    }
  }

  // Phase 12: only present when run_audit was asked for them.
  if (audit.site.cruxHistory?.ok) for (const f of cruxFindings(audit.site.cruxHistory.data)) add(f);
  const gtm = audit.site.tagManager;
  if (gtm?.ok) {
    const publicId = gtm.data.container.publicId;
    for (const f of gtm.data.findings) {
      // Entity names and evidence come from the container, so they are untrusted text.
      add({
        source: "gtm",
        rule: f.rule,
        url: `gtm://${publicId}/${f.entity.kind}/${f.entity.id}`,
        severity: f.severity,
        title: stripControl(f.title),
        ...(f.evidence ? { evidence: stripControl(f.evidence) } : {}),
      });
    }
  }

  // Phase 12 C1: the local crawl's findings (already built and sanitised by analyzeCrawl).
  if (audit.site.localCrawl?.ok) for (const f of audit.site.localCrawl.data.findings) add({ source: "crawl", rule: f.rule, url: f.url, severity: f.severity, title: f.title, ...(f.evidence ? { evidence: f.evidence } : {}) });

  return [...out.values()];
}

/** Every {url, source} that ran successfully in this audit (and returned usable data). */
export function checkedPairs(audit: AuditResult): CheckedPair[] {
  const out: CheckedPair[] = [];
  for (const p of audit.pages) {
    const url = normalizeUrl(p.url);
    if (p.lighthouse.ok) out.push({ url, source: "lighthouse" });
    if (p.accessibility.ok) out.push({ url, source: "axe" });
    // A missing verdict means Google gave no index status, so nothing was verified.
    if (p.indexing.ok && p.indexing.data.verdict) out.push({ url, source: "indexing" });
    if (p.onPage.ok && p.onPage.data) out.push({ url, source: "onpage" });
    // Only when both the raw and the rendered fetch succeeded.
    if (p.rendering?.ok) out.push({ url, source: "rendering" });
  }
  if (audit.site.sitemaps.ok) out.push({ url: SITE_CHECK_URL, source: "site" });
  if (audit.site.hygiene?.ok) for (const url of audit.site.hygiene.data.checked) out.push({ url, source: "site" });
  const crux = audit.site.cruxHistory;
  // No CrUX data for the origin means nothing was verified.
  if (crux?.ok && crux.data.available) out.push({ url: cruxCheckUrl(normalizeUrl(crux.data.key.origin ?? crux.data.key.url ?? "")), source: "crux" });
  // A container that was audited verifies every GTM finding of that container (D13).
  if (audit.site.tagManager?.ok) out.push({ url: `gtm://${audit.site.tagManager.data.container.publicId}`, source: "gtm" });
  // Every URL the local crawl checked, plus site:crawl (and site:crawl-complete when it was exhaustive).
  if (audit.site.localCrawl?.ok) for (const url of audit.site.localCrawl.data.checked) out.push({ url, source: "crawl" });
  return out;
}
