/**
 * Local crawl analysis (Phase 12 C1): per-page issues, duplicate titles and
 * descriptions, findings (source `crawl`) and the checked keys the audit diff
 * uses. Pure: the crawler (src/providers/crawler.ts) produces the pages.
 */
import { stripControl } from "../lib/terminal-text.js";
import { CRAWL_COMPLETE_KEY, CRAWL_SITE_KEY, findingId, normalizeUrl, type Finding, type Severity } from "./findings.js";

export { CRAWL_COMPLETE_KEY, CRAWL_COMPLETE_RULES, CRAWL_SITE_KEY } from "./findings.js";

/** One URL the crawl reached (fetched, or found through a link and skipped). */
export interface CrawlPage {
  /** The URL as linked (fragment removed). */
  url: string;
  /** Link depth from the start URLs (0 = a start URL). */
  depth: number;
  /** First response's HTTP status; null when not fetched (skipped, or the request failed). */
  status: number | null;
  /** Where redirects ended (the URL itself when there were none); null when not fetched. */
  finalUrl: string | null;
  finalStatus: number | null;
  /** Each redirect target in order (empty: no redirect). */
  redirectChain: string[];
  contentType: string | null;
  title: string | null;
  description: string | null;
  canonical: string | null;
  /** meta robots, plus X-Robots-Tag when present ("x-robots-tag: ..."). */
  robots: string | null;
  noindex: boolean;
  h1Count: number | null;
  /** Internal links to this URL from crawled pages (each linking page counted once). */
  inlinks: number;
  /** Unique links on this page (internal and external). */
  outlinks: number;
  firstLinkedFrom: string | null;
  /** Set when the page was reached by following another URL's redirect, not a link. */
  fromRedirect?: string;
  /** Why the URL wasn't fetched or its redirect wasn't followed. */
  skipped?: "robots" | "off-site-redirect" | "redirect-blocked-by-robots";
  error?: string;
  /** True when its HTML was parsed (title, description and links read). */
  parsed: boolean;
  /** Rules this page fails (filled by analyzeCrawl). */
  issues: string[];
}

export const CRAWL_RULES = {
  "broken-internal-link": { severity: "high", title: "Internal link to a page that returns an error" },
  "redirect-chain": { severity: "medium", title: "Redirect chain (two or more hops)" },
  "internal-link-to-redirect": { severity: "low", title: "Internal link points at a redirect" },
  "missing-title": { severity: "high", title: "Page has no title" },
  "duplicate-title": { severity: "medium", title: "Title is used by another page" },
  "missing-description": { severity: "medium", title: "Page has no meta description" },
  "duplicate-description": { severity: "low", title: "Meta description is used by another page" },
  "canonical-to-non-200": { severity: "medium", title: "Canonical points at a URL that doesn't return 200" },
  "canonical-elsewhere": { severity: "low", title: "Canonical points at a different URL" },
  "deep-page": { severity: "low", title: "Page is more than 4 clicks from the start pages" },
  "noindex-linked": { severity: "low", title: "Internally linked page is noindex" },
} as const satisfies Record<string, { severity: Severity; title: string }>;
export type CrawlRule = keyof typeof CRAWL_RULES;
export const CRAWL_RULE_IDS = Object.keys(CRAWL_RULES) as CrawlRule[];

export const DEEP_PAGE_DEPTH = 4;
/** Untrusted page text quoted in evidence is cut to this many characters. */
const SNIPPET = 120;

const snippet = (s: string) => {
  const t = stripControl(s);
  return t.length > SNIPPET ? `${t.slice(0, SNIPPET - 1)}…` : t;
};
const isHtml = (ct: string | null) => ct == null || /html/i.test(ct);
const isOk = (s: number | null) => s !== null && s >= 200 && s < 300;
const isRedirect = (s: number | null) => s !== null && s >= 300 && s < 400;
/** The redirect ended on the same normalised URL (e.g. /about → /about/), so the record holds that page's content. */
const selfRedirect = (p: CrawlPage) => p.redirectChain.length > 0 && p.finalUrl !== null && normalizeUrl(p.finalUrl) === normalizeUrl(p.url);
/** The page's own content was read (a 2xx HTML page that parsed, with no redirect or one to the same normalised URL). */
const hasContent = (p: CrawlPage) => p.parsed && (p.redirectChain.length === 0 ? isOk(p.status) : selfRedirect(p) && isOk(p.finalStatus));

export interface CrawlAnalysis {
  findings: Finding[];
  /** Normalized URLs whose checks ran (fetched, and parsed when it was an HTML page), plus site keys. */
  checked: string[];
  summary: {
    byStatus: Record<string, number>;
    redirects: number;
    brokenLinks: number;
    duplicateTitles: number;
    missingTitles: number;
    duplicateDescriptions: number;
    missingDescriptions: number;
    canonicalIssues: number;
    noindex: number;
    depthHistogram: Record<string, number>;
  };
}

/** Fill each page's `issues` and build the findings, checked keys and summary. Deterministic for the same pages. */
export function analyzeCrawl(pages: CrawlPage[], opts: { exhaustive: boolean }): CrawlAnalysis {
  const byKey = new Map(pages.map((p) => [normalizeUrl(p.url), p]));
  const issues = new Map<CrawlPage, Set<CrawlRule>>();
  const evidence = new Map<string, string>();
  const flag = (p: CrawlPage, rule: CrawlRule, ev?: string) => {
    let s = issues.get(p);
    if (!s) issues.set(p, (s = new Set()));
    s.add(rule);
    if (ev) evidence.set(`${rule}\n${p.url}`, ev);
  };

  // Duplicates are judged among pages whose own content was read; matching ignores case and spacing.
  const groups = (field: "title" | "description") => {
    const m = new Map<string, CrawlPage[]>();
    for (const p of pages) {
      const v = hasContent(p) ? p[field] : null;
      if (!v) continue;
      const k = v.toLowerCase().replace(/\s+/g, " ").trim();
      const list = m.get(k);
      if (list) list.push(p);
      else m.set(k, [p]);
    }
    return [...m.values()].filter((l) => l.length > 1);
  };
  for (const [field, rule] of [["title", "duplicate-title"], ["description", "duplicate-description"]] as const) {
    for (const list of groups(field)) {
      for (const p of list) {
        const other = list.find((o) => o !== p)!;
        flag(p, rule, `"${snippet(p[field]!)}" is also used by ${list.length - 1} other page${list.length > 2 ? "s" : ""}, e.g. ${other.url}`);
      }
    }
  }

  for (const p of pages) {
    const end = p.finalStatus ?? p.status;
    // 429 is rate limiting, not a broken page.
    if (p.status !== null && p.inlinks > 0 && end !== null && end >= 400 && end !== 429) {
      flag(p, "broken-internal-link", `HTTP ${end}; ${p.inlinks} internal link${p.inlinks === 1 ? "" : "s"}, first from ${p.firstLinkedFrom ?? "(unknown)"}`);
    }
    if (p.redirectChain.length >= 2) flag(p, "redirect-chain", `${p.redirectChain.length} hops: ${[p.url, ...p.redirectChain].join(" → ")}`);
    if (isRedirect(p.status) && p.inlinks > 0) flag(p, "internal-link-to-redirect", `redirects to ${p.redirectChain[p.redirectChain.length - 1] ?? "(no location)"}; first linked from ${p.firstLinkedFrom ?? "(unknown)"}`);
    if (hasContent(p) && isHtml(p.contentType)) {
      if (!p.title) flag(p, "missing-title");
      if (!p.description) flag(p, "missing-description");
      if (p.canonical && normalizeUrl(p.canonical) !== normalizeUrl(p.url)) {
        const target = byKey.get(normalizeUrl(p.canonical));
        const targetStatus = target ? (target.redirectChain.length ? target.status : (target.finalStatus ?? target.status)) : null;
        if (target && targetStatus !== null && !isOk(targetStatus)) flag(p, "canonical-to-non-200", `canonical ${p.canonical} returns HTTP ${targetStatus}`);
        else flag(p, "canonical-elsewhere", `canonical ${p.canonical}`);
      }
    }
    if (p.status !== null && p.depth > DEEP_PAGE_DEPTH) flag(p, "deep-page", `depth ${p.depth}`);
    if (p.noindex && p.inlinks > 0) flag(p, "noindex-linked", `${p.inlinks} internal link${p.inlinks === 1 ? "" : "s"}, first from ${p.firstLinkedFrom ?? "(unknown)"}`);
  }

  const findings: Finding[] = [];
  for (const p of pages) {
    const rules = issues.get(p);
    p.issues = rules ? CRAWL_RULE_IDS.filter((r) => rules.has(r)) : [];
    for (const rule of p.issues as CrawlRule[]) {
      const def = CRAWL_RULES[rule];
      const ev = evidence.get(`${rule}\n${p.url}`);
      findings.push({ id: findingId("crawl", rule, p.url), source: "crawl", rule, url: p.url, severity: def.severity, title: def.title, ...(ev ? { evidence: stripControl(ev) } : {}) });
    }
  }

  const checked = new Set<string>([CRAWL_SITE_KEY]);
  if (opts.exhaustive) checked.add(CRAWL_COMPLETE_KEY);
  for (const p of pages) {
    if (p.status === null) continue;
    // A 2xx HTML page whose markup wasn't parsed had its title, description and links unchecked.
    const contentStatus = p.redirectChain.length === 0 ? p.status : selfRedirect(p) ? p.finalStatus : null;
    if (isOk(contentStatus) && isHtml(p.contentType) && !p.parsed) continue;
    checked.add(normalizeUrl(p.url));
  }

  const byStatus: Record<string, number> = {};
  const depthHistogram: Record<string, number> = {};
  for (const p of pages) {
    const k = p.status !== null ? String(p.status) : p.skipped ? `skipped:${p.skipped}` : "error";
    byStatus[k] = (byStatus[k] ?? 0) + 1;
    if (p.status !== null) depthHistogram[String(p.depth)] = (depthHistogram[String(p.depth)] ?? 0) + 1;
  }
  const count = (rule: CrawlRule) => pages.filter((p) => p.issues.includes(rule)).length;
  return {
    findings,
    checked: [...checked],
    summary: {
      byStatus,
      redirects: pages.filter((p) => isRedirect(p.status)).length,
      brokenLinks: count("broken-internal-link"),
      duplicateTitles: count("duplicate-title"),
      missingTitles: count("missing-title"),
      duplicateDescriptions: count("duplicate-description"),
      missingDescriptions: count("missing-description"),
      canonicalIssues: pages.filter((p) => p.issues.includes("canonical-to-non-200") || p.issues.includes("canonical-elsewhere")).length,
      noindex: pages.filter((p) => p.noindex && p.status !== null).length,
      depthHistogram,
    },
  };
}

/** Findings ordered for a short list: severity, then rule, then URL. */
export function topFindings(findings: Finding[], n: number): Finding[] {
  const order: Severity[] = ["critical", "high", "medium", "low"];
  return [...findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.rule.localeCompare(b.rule) || a.url.localeCompare(b.url)).slice(0, n);
}

/** Every URL a crawl reached through links or redirects (fetched or skipped), for the orphan check. */
export function crawledUrls(pages: CrawlPage[]): string[] {
  const out = new Set<string>();
  for (const p of pages) {
    out.add(p.url);
    if (p.finalUrl) out.add(p.finalUrl);
    for (const u of p.redirectChain) out.add(u);
  }
  return [...out];
}
