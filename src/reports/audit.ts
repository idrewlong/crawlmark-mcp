import type { Client } from "../config.js";
import { runAxe, type AxeResult, type WcagLevel } from "../providers/axe.js";
import { backlinksSummary, instantPage, onPageStartCrawl } from "../providers/seo-data.js";
import { gscInspectUrl, gscSitemaps } from "../providers/gsc.js";
import { checkRender, type RenderCheck } from "../providers/render.js";
import { runLighthouse, type FormFactor, type LighthouseResult } from "../providers/lighthouse.js";
import { checkedPairs, extractFindings } from "../analysis/findings.js";
import { clientOrigin, cruxHistory } from "../providers/crux.js";
import { runGtmAudit, type GtmAuditResult } from "./gtm.js";
import { newAuditId, saveAudit } from "../lib/audits.js";
import type { CruxHistoryResult } from "./report-types.js";
import { section, type Section } from "./section.js";
import { siteHygiene } from "./site-hygiene.js";

export interface AuditOptions {
  /** Override the client's keyPages for this run. */
  urls?: string[];
  formFactor?: FormFactor;
  wcagLevel?: WcagLevel;
  /** Kick off a full-site DataForSEO crawl (paid, async). Returns a taskId to poll with crawl_status. Unavailable (not failed) without DataForSEO. */
  fullCrawl?: boolean;
  maxCrawlPages?: number;
  /** Skip the response cache so the audit is a real snapshot. Default true; false reuses results up to a day old. */
  fresh?: boolean;
  /** Include a backlinks summary (paid) from the client's data provider. */
  backlinks?: boolean;
  /** Aborts the audit (run_audit's 10-minute limit): the running browser is closed, no further pages start, nothing is saved. */
  signal?: AbortSignal;
  /** Phase 12: CrUX History for the client's origin as `site.cruxHistory`, with `crux` findings from the latest period. Default false. */
  cruxHistory?: boolean;
  /** Phase 12: the Tag Manager container audit as `site.tagManager`, with `gtm` findings (medium/low, never alerts). Opt-in only; default false. */
  includeTagManager?: boolean;
}

interface PageAudit {
  url: string;
  lighthouse: Section<LighthouseResult>;
  accessibility: Section<AxeResult>;
  rendering: Section<RenderCheck>;
  indexing: Section<Awaited<ReturnType<typeof gscInspectUrl>>>;
  onPage: Section<unknown>;
}

export type AuditResult = Awaited<ReturnType<typeof collectAudit>>;

interface SiteChecks {
  sitemaps: Section<Awaited<ReturnType<typeof gscSitemaps>>>;
  crawl: Section<Awaited<ReturnType<typeof onPageStartCrawl>>> | null;
  backlinks: Section<Awaited<ReturnType<typeof backlinksSummary>>> | null;
  hygiene: Section<Awaited<ReturnType<typeof siteHygiene>>>;
  cruxHistory?: Section<CruxHistoryResult>;
  tagManager?: Section<GtmAuditResult>;
}

/** Run every check and save the snapshot. The result carries `auditId` for list/get/compare_audits. */
export async function runAudit(client: Client, opts: AuditOptions = {}) {
  const result = await collectAudit(client, opts);
  opts.signal?.throwIfAborted();
  const findings = extractFindings(result);
  const ranAt = Date.parse(result.ranAt);
  const auditId = newAuditId(ranAt);
  saveAudit({
    id: auditId,
    client: client.slug,
    ranAt,
    settings: result.settings,
    summary: result.summary,
    findings,
    checked: checkedPairs(result),
    result,
  });
  return { auditId, findingCount: findings.length, ...result };
}

async function collectAudit(client: Client, opts: AuditOptions) {
  const urls = opts.urls?.length ? opts.urls : client.keyPages;
  const formFactor = opts.formFactor ?? "mobile";
  const wcagLevel = opts.wcagLevel ?? "AA";
  const fresh = opts.fresh ?? true;
  const signal = opts.signal;
  const cacheOpts = { refresh: fresh, signal };

  // Site-level checks run in parallel; they're all network calls.
  const [sitemaps, crawl, links, crux, tagManager] = await Promise.all([
    section(() => gscSitemaps(client)),
    opts.fullCrawl ? section(() => onPageStartCrawl(client, opts.maxCrawlPages ?? 100)) : Promise.resolve(null),
    opts.backlinks ? section(() => backlinksSummary(client)) : Promise.resolve(null),
    opts.cruxHistory ? section(() => cruxHistory({ origin: clientOrigin(client) }, { refresh: fresh })) : Promise.resolve(undefined),
    opts.includeTagManager ? section(() => runGtmAudit(client, { refresh: fresh })) : Promise.resolve(undefined),
  ]);

  // Page-level browser checks run one page at a time so Chrome instances don't
  // fight over CPU and skew Lighthouse timings.
  const pages: PageAudit[] = [];
  for (const url of urls) {
    signal?.throwIfAborted();
    const lighthouse = await section(() => runLighthouse(url, formFactor, cacheOpts));
    const accessibility = await section(() => runAxe(url, wcagLevel, cacheOpts));
    const rendering = await section(() => checkRender(url, cacheOpts));
    const [indexing, onPage] = await Promise.all([
      section(() => gscInspectUrl(client, url, cacheOpts)),
      section(async () => (await instantPage(client, url, cacheOpts)).page),
    ]);
    pages.push({ url, lighthouse, accessibility, rendering, indexing, onPage });
  }

  // Site hygiene runs after the pages so key pages with a rendering result reuse its cached DOM.
  signal?.throwIfAborted();
  const hygiene = await section(() =>
    siteHygiene(client, {
      urls,
      fresh,
      signal,
      gscSitemapPaths: sitemaps.ok ? sitemaps.data.flatMap((s) => (s.path ? [s.path] : [])) : undefined,
      renderedUrls: pages.filter((p) => p.rendering.ok).map((p) => p.url),
    }),
  );

  return {
    client: { slug: client.slug, name: client.name, domain: client.domain },
    ranAt: new Date().toISOString(),
    settings: { formFactor, wcagLevel, pages: urls.length, fresh },
    summary: summarize(pages),
    // Phase 12 keys appear only when their option is set, so a default result keeps its shape.
    site: { sitemaps, crawl, backlinks: links, hygiene, ...(crux ? { cruxHistory: crux } : {}), ...(tagManager ? { tagManager } : {}) } as SiteChecks,
    pages,
    next: opts.fullCrawl
      ? "A full crawl was started. Call crawl_status with the taskId in site.crawl; crawls of 100 pages usually finish in a few minutes."
      : undefined,
  };
}

/** Roll page results up into the numbers a report leads with. */
function summarize(pages: PageAudit[]) {
  const lh = pages.flatMap((p) => (p.lighthouse.ok ? [p.lighthouse.data] : []));
  const ax = pages.flatMap((p) => (p.accessibility.ok ? [p.accessibility.data] : []));
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

  const notIndexed = pages
    .filter((p) => p.indexing.ok && p.indexing.data.verdict !== "PASS")
    .map((p) => ({ url: p.url, coverage: p.indexing.ok ? p.indexing.data.coverageState : undefined }));

  const a11yTotals = ax.reduce(
    (t, r) => ({
      critical: t.critical + r.counts.critical,
      serious: t.serious + r.counts.serious,
      moderate: t.moderate + r.counts.moderate,
      minor: t.minor + r.counts.minor,
    }),
    { critical: 0, serious: 0, moderate: 0, minor: 0 },
  );

  // Most common a11y rules across pages, so fixes can be templated once.
  const ruleCounts = new Map<string, { help: string; impact: string | null; pages: number; nodes: number }>();
  for (const r of ax) {
    for (const v of r.violations) {
      const cur = ruleCounts.get(v.id) ?? { help: v.help, impact: v.impact, pages: 0, nodes: 0 };
      cur.pages += 1;
      cur.nodes += v.nodes;
      ruleCounts.set(v.id, cur);
    }
  }

  return {
    avgScores: {
      performance: avg(lh.map((r) => r.scores.performance)),
      accessibility: avg(lh.map((r) => r.scores.accessibility)),
      bestPractices: avg(lh.map((r) => r.scores.bestPractices)),
      seo: avg(lh.map((r) => r.scores.seo)),
    },
    slowestPages: [...lh].sort((a, b) => b.lab.lcpMs - a.lab.lcpMs).slice(0, 5).map((r) => ({ url: r.url, lcpMs: r.lab.lcpMs })),
    accessibilityIssues: a11yTotals,
    topAccessibilityRules: [...ruleCounts.entries()]
      .sort(([, a], [, b]) => b.pages - a.pages || b.nodes - a.nodes)
      .slice(0, 10)
      .map(([id, v]) => ({ id, ...v })),
    notIndexed,
    failedChecks: pages.flatMap((p) =>
      (["lighthouse", "accessibility", "rendering", "indexing", "onPage"] as const)
        .filter((k) => !p[k].ok)
        .map((k) => ({ url: p.url, check: k, error: (p[k] as { error: string }).error })),
    ),
  };
}
