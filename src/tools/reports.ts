import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadRegistry, resolveClient } from "../clients.js";
import { diffAudits, pickComparison } from "../analysis/diff.js";
import { getAudit, latestAudit, latestAuditBefore, listAudits } from "../lib/audits.js";
import { missingPieces, type Client } from "../lib/clients.js";
import { env, HOME, seoDefaultProvider } from "../config.js";
import { packageVersion } from "../lib/entry.js";
import { exportReport } from "../reports/export.js";
import { chromePdfPrinter } from "../reports/render/pdf.js";
import { loadTemplates, templateFileWarnings } from "../reports/templates/load.js";
import { FORMATS } from "../reports/templates/schema.js";
import { canonicalSpendNames } from "../lib/spend.js";
import { spendSummary } from "../lib/budget.js";
import { purgeExpired } from "../lib/cache.js";
import { onPagePagesWithIssue, onPageSummary } from "../providers/dataforseo.js";
import { runAudit } from "../reports/audit.js";
import { HYGIENE_BUDGET_MS, siteHygiene } from "../reports/site-hygiene.js";
import { monthlyReport } from "../reports/monthly.js";
import { getReportTemplate, listReportTemplates, validateReportTemplate } from "../reports/templates/service.js";
import { getStoredReport, loadDefaultRunDeps, runTemplate } from "../reports/templates/run.js";
import { TIMEOUTS } from "../lib/timeout.js";
import { purgeOldToolCalls, summarizeUsage, toolCallsSince } from "../lib/usage.js";
import { assertUserUrl } from "../user-url.js";
import { handler, READ_ONLY } from "./util.js";

const clientArg = z
  .string()
  .describe("Client domain, e.g. 'example.com' (URL and www. forms also work), or a clients.yaml slug. Use list_clients to see options.");

/** The client's SEO data provider for list_clients: its own override, else the default marked "(default)". */
function listedProvider(c: Client): string {
  if (c.dataProvider) return c.dataProvider;
  return seoDefaultProvider.ok ? `${seoDefaultProvider.provider} (default)` : `(default is invalid: ${seoDefaultProvider.invalidValue})`;
}

export function registerReportTools(server: McpServer) {
  server.registerTool(
    "list_clients",
    {
      title: "List clients",
      description:
        "List clients from clients.yaml. When Google is set up, Search Console sites and GA4 properties the account can " +
        "access are discovered first and any new domains are added to clients.yaml (existing entries are never changed). " +
        "Shows each client's domain, name, sources, properties, alternates and missing pieces, its SEO data provider (dataProvider, marked \"(default)\" when inherited) and Ahrefs/Semrush market (country), plus discovery status. " +
        "Discovery is cached for a day; pass refresh to re-list. Clients without Google still work for DataForSEO, Lighthouse and axe.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Bypass the one-day discovery cache and list properties from Google again."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler("list_clients", async ({ refresh }) => {
      const registry = await loadRegistry({ refresh: refresh ?? false });
      return {
        clients: registry.clients.map((c) => ({
          domain: c.domain,
          name: c.name,
          sources: c.sources,
          gscProperty: c.gscProperty ?? null,
          ga4PropertyId: c.ga4PropertyId ?? null,
          ...(c.gtmContainerId ? { gtmAccountId: c.gtmAccountId ?? null, gtmContainerId: c.gtmContainerId } : {}),
          ...(c.aliases.length ? { aliases: c.aliases } : {}),
          ...(c.alternates.gsc.length || c.alternates.ga4.length ? { alternates: c.alternates } : {}),
          missing: missingPieces(c),
          ...(c.area ? { area: c.area } : {}),
          ...(c.niche ? { niche: c.niche } : {}),
          ...(c.brandTerms.length ? { brandTerms: c.brandTerms } : {}),
          competitors: c.competitors.length,
          trackedKeywords: c.trackedKeywords.length,
          keyPages: c.keyPages.length,
          monthlyBudgetUsd: c.monthlyBudgetUsd,
          dataProvider: listedProvider(c),
          country: c.country,
        })),
        ignored: registry.ignored,
        clientsFile: registry.clientsFile,
        discovery: { ...registry.discovery, fromCache: registry.fromCache },
      };
    }),
  );

  server.registerTool(
    "monthly_report",
    {
      title: "Monthly SEO report",
      description:
        "Build the data for a client's monthly SEO report. `vsPreviousMonth` and `vsLastYear` include a `previous` object, and `change` is null when the earlier period has no impressions. Covers: GSC clicks/impressions/CTR/position vs previous month and last year, " +
        "GA4 organic sessions and key events, top and moving queries and pages (each query row carries `branded: boolean`), a branded vs non-branded split of clicks, impressions, CTR and impression-weighted position for the month and the previous one (query-level, so anonymized queries are excluded), top organic landing pages, and tracked keyword positions, plus an `audit` section: the latest saved audit and its diff against the most recent audit from before the month (`null` unless there is one from before the month and a newer one; a back-dated month still diffs against the latest audit). " +
        "Also includes an `opportunities` section: the top 5 non-branded striking-distance queries, low-CTR top results and cannibalized queries for the month. " +
        "Free by default (Google APIs only); set liveRanks for a paid live SERP check per tracked keyword. " +
        "Returns structured JSON for you to write up; each section reports its own error if a source is unavailable.",
      inputSchema: {
        client: clientArg,
        month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM. Defaults to the last complete month."),
        liveRanks: z.boolean().optional().describe("Check live Google rank for each tracked keyword via DataForSEO (paid)."),
      },
      annotations: READ_ONLY,
    },
    handler("monthly_report", async ({ client, month, liveRanks }) => monthlyReport(await resolveClient(client), { month, liveRanks })),
  );

  server.registerTool(
    "list_report_templates",
    {
      title: "List report templates",
      description:
        "Report templates available for a client: the builtin `monthly`, the global file (<home>/config/report-templates.yaml) and the client's own file " +
        "(<home>/config/report-templates/<domain>.yaml), with each template's period, section count, optional sections (rendered only when asked for with `include`) and paid sections. " +
        "Also reports whether each file exists and is valid; an invalid file never hides the builtin `monthly`. Free and local.",
      inputSchema: { client: clientArg.optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("list_report_templates", async ({ client }) => {
      const slug = client ? (await resolveClient(client)).slug : undefined;
      return listReportTemplates(HOME.dir, slug);
    }),
  );

  server.registerTool(
    "get_report_template",
    {
      title: "Get a report template",
      description:
        "One report template with its defaults filled in (period, comparisons, sections) and the resolved branding (client file over global, field by field; the logo as a path plus whether it exists). Free and local.",
      inputSchema: { client: clientArg.optional(), template: z.string().min(1).max(40).describe("Template id, e.g. monthly. See list_report_templates.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("get_report_template", async ({ client, template }) => {
      const slug = client ? (await resolveClient(client)).slug : undefined;
      return getReportTemplate(HOME.dir, template, slug);
    }),
  );

  server.registerTool(
    "validate_report_template",
    {
      title: "Validate a report template",
      description:
        "Check report template YAML before saving it, or check the saved global or client file. Returns `valid`, `errors` with YAML paths " +
        "(e.g. templates.monthly.sections[3].limit) and `warnings` (e.g. a logo file that doesn't exist). Give exactly one of `yaml` or `file`. No network, writes nothing.",
      inputSchema: {
        yaml: z.string().max(100_000).optional().describe("Template file text to check."),
        file: z.enum(["global", "client"]).optional().describe("Check the saved global file, or the client's file (needs client)."),
        client: clientArg.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("validate_report_template", async ({ yaml, file, client }) => {
      const slug = client ? (await resolveClient(client)).slug : undefined;
      return validateReportTemplate(HOME.dir, { yaml, file, clientSlug: slug });
    }),
  );

  server.registerTool(
    "run_report_template",
    {
      title: "Run a report template",
      description:
        "Build a client's report from a template (default: the `monthly` template, the same data as monthly_report). Returns `reportId`, the period (with comparisons), " +
        "each section's `status` (ok, error, unavailable, or skipped for a paid section without allowPaid) and `data`, computed `highlights` (facts only), `notes` and this run's paid `spend`. " +
        "Read each section's status before writing about it. The data is kept for 24 hours: pass `reportId` to export_report so the files show exactly these numbers. " +
        "Free unless the template has a paid section and you set allowPaid (state the cost first). Optional sections (e.g. cwv, gtm) run only when listed in `include`.",
      inputSchema: {
        client: clientArg,
        template: z.string().min(1).max(40).optional().describe("Template id (list_report_templates). Default: the template file's default, else monthly."),
        month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM. Overrides the template's period."),
        quarter: z.string().regex(/^\d{4}-Q[1-4]$/i).optional().describe("YYYY-Qn, e.g. 2026-Q3."),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        include: z.array(z.string().min(1).max(40)).max(40).optional().describe("Optional section ids to include, e.g. [\"cwv\", \"gtm\"]."),
        allowPaid: z.boolean().optional().describe("Run paid sections (only when the user asked; state the estimate first)."),
      },
      annotations: READ_ONLY,
    },
    handler("run_report_template", async ({ client, ...opts }) => runTemplate(await resolveClient(client), { ...opts, homeDir: HOME.dir }, await loadDefaultRunDeps())),
  );

  server.registerTool(
    "export_report",
    {
      title: "Export a report to files",
      description:
        "Save a client report as Markdown, HTML, PDF and/or Word (docx) files under the reports folder (<home>/reports/<client>/<YYYY-MM>/<template>-<period>.<ext>; files 0600). " +
        "Pass the `reportId` from run_report_template so the files show exactly the numbers you wrote about (kept 24 hours), or the same arguments as run_report_template to run it first. " +
        "`narrative` is your commentary (summary plus text per section id; paragraphs, `- ` bullets and **bold** only; at most 30,000 characters); without it the files are labelled data-only. " +
        "`inline: \"html\"` also returns a docs-friendly HTML copy (no logo, plain tables) for saving to Google Docs with the user's own Drive tool, only after the user agrees; `formats: []` with inline writes no file. " +
        "Re-exporting the same template and period overwrites its files. PDF needs Chrome; if it fails, the other formats are still written and `warnings` says why.",
      inputSchema: {
        client: clientArg,
        reportId: z.string().max(40).optional().describe("From run_report_template. Leave out the template and period arguments when you pass it."),
        template: z.string().min(1).max(40).optional(),
        month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        quarter: z.string().regex(/^\d{4}-Q[1-4]$/i).optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        include: z.array(z.string().min(1).max(40)).max(40).optional(),
        allowPaid: z.boolean().optional(),
        formats: z.array(z.enum(FORMATS)).max(4).optional().describe("Default: the template file's defaults.formats, else md and html."),
        narrative: z
          .object({
            summary: z.string().max(6000).optional(),
            sections: z.record(z.string().max(40), z.string().max(6000)).optional(),
          })
          .strict()
          .optional()
          .describe("Your commentary: `summary`, and text keyed by section id (e.g. search, brand, traffic, opportunities, audit)."),
        inline: z.enum(["html", "md"]).optional().describe("Also return the report as text (html is the Google Docs format)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler(
      "export_report",
      async ({ client, reportId, formats, narrative, inline, ...runArgs }, { signal }) => {
        const c = await resolveClient(client);
        let report;
        if (reportId) {
          const given = (["template", "month", "quarter", "startDate", "endDate", "include", "allowPaid"] as const).filter((k) => runArgs[k] !== undefined);
          if (given.length) throw new Error(`With reportId, leave out ${given.join(", ")}: the stored report already fixes the template and period.`);
          report = getStoredReport(reportId);
          if (report.client.slug !== c.slug) throw new Error(`Report ${reportId} is for ${report.client.domain}, not ${c.domain}.`);
        } else {
          report = await runTemplate(c, { ...runArgs, homeDir: HOME.dir }, await loadDefaultRunDeps());
        }
        const loaded = loadTemplates({ homeDir: HOME.dir, clientSlug: c.slug });
        const out = await exportReport(report, {
          formats: formats ?? loaded.defaults.formats,
          narrative,
          inline,
          reportsDir: env.REPORTS_DIR,
          branding: loaded.branding,
          version: packageVersion(new URL("../index.js", import.meta.url).href),
          printer: chromePdfPrinter,
          signal,
          warnings: templateFileWarnings(loaded),
        });
        return { reportId: report.reportId, ...out };
      },
      { timeoutMs: TIMEOUTS.auditMs },
    ),
  );

  server.registerTool(
    "run_audit",
    {
      title: "Run SEO + accessibility audit",
      description:
        "Audit a client's key pages: Lighthouse (performance, SEO, best practices, Core Web Vitals), axe-core WCAG checks, " +
        "GSC index status per URL, GSC sitemap health, and a DataForSEO on-page check per URL. " +
        "Optionally start a full-site crawl (paid, async; poll with crawl_status) and include a backlinks summary (paid). " +
        "Takes ~30-60s per page because Lighthouse and axe run in a real browser; each browser check stops after 90s and the whole audit after 10 minutes. " +
        "`urls` overrides go through the same URL checks as render_check (private addresses refused; RESTRICT_TO_CLIENT_DOMAINS applies).",
      inputSchema: {
        client: clientArg,
        urls: z.array(z.string().url()).optional().describe("Override the client's keyPages for this run."),
        formFactor: z.enum(["mobile", "desktop"]).optional().describe("Lighthouse emulation. Default mobile."),
        wcagLevel: z.enum(["A", "AA", "AAA"]).optional().describe("WCAG conformance level for axe. Default AA."),
        fullCrawl: z.boolean().optional().describe("Start a full-site DataForSEO crawl (paid)."),
        maxCrawlPages: z.number().int().min(1).max(5000).optional().describe("Crawl page cap. Default 100."),
        backlinks: z.boolean().optional().describe("Include a backlinks summary from the client's data provider (DataForSEO, Ahrefs or Semrush; paid)."),
        fresh: z
          .boolean()
          .optional()
          .describe("Default true: every check runs live, so the audit is a true snapshot (the on-page check is a paid call per page). false reuses cached results up to a day old."),
        cruxHistory: z
          .boolean()
          .optional()
          .describe("Also add real-user Core Web Vitals history (CrUX, free with CRUX_API_KEY or PSI_API_KEY) as site.cruxHistory, with findings for poor or needs-improvement LCP, INP and CLS in the latest period. Default false."),
        includeTagManager: z
          .boolean()
          .optional()
          .describe("Also audit the client's Tag Manager container (as gtm_audit does) as site.tagManager, with its findings (source gtm, medium or low; never alerts). Only when the user asks; default false."),
        localCrawl: z
          .boolean()
          .optional()
          .describe("Also run the free local crawl (as local_crawl does, up to 4 minutes inside the audit) as site.localCrawl, with its findings (source crawl); it is saved, so the orphan check can use it. Default false."),
        maxLocalCrawlPages: z.number().int().min(1).max(2000).optional().describe("Page cap for localCrawl. Default 300."),
      },
      annotations: READ_ONLY,
    },
    handler(
      "run_audit",
      async ({ client, ...opts }, { signal }) => {
        const c = await resolveClient(client);
        // User-supplied overrides are checked up front so a refused URL fails the call, not just one section.
        for (const url of opts.urls ?? []) await assertUserUrl(url);
        return runAudit(c, { ...opts, signal });
      },
      { timeoutMs: TIMEOUTS.auditMs },
    ),
  );

  server.registerTool(
    "site_hygiene",
    {
      title: "Site hygiene checks",
      description:
        "Site-level checks that need no browser: robots.txt (missing, blocks everything, blocks key pages, no Sitemap line), " +
        "sitemaps (found via robots.txt and Search Console, indexes followed to depth 2 and 50 children; up to 50 URLs sampled for non-200, redirects and noindex; key pages missing from every sitemap), " +
        "basic JSON-LD validation on key pages (required properties for Organization, LocalBusiness, Article, Product, BreadcrumbList, FAQPage; not the Rich Results Test), " +
        "hreflang (self-reference, reciprocity, x-default) and orphan pages (only when a complete crawl is already stored: the newest of a local_crawl (free) or a DataForSEO crawl, within 30 days; never starts a crawl). " +
        "Every fetch is SSRF-guarded and size-capped. Uses raw HTML; run_audit uses the rendered DOM where it has a rendering result. Findings use source `site`; run_audit includes the same checks.",
      inputSchema: {
        client: clientArg,
        fresh: z.boolean().optional().describe("Skip the one-day response cache. Default true."),
      },
      annotations: READ_ONLY,
    },
    handler(
      "site_hygiene",
      async ({ client, fresh }, { signal }) => {
        const c = await resolveClient(client);
        for (const url of c.keyPages) await assertUserUrl(url);
        const result = await siteHygiene(c, { fresh: fresh ?? true, signal });
        return { client: c.slug, ...result };
      },
      { timeoutMs: HYGIENE_BUDGET_MS + 30_000 },
    ),
  );

  server.registerTool(
    "list_audits",
    {
      title: "List saved audits",
      description:
        "Saved run_audit snapshots for a client, newest first: audit ID, run time, page count, average scores and finding count. " +
        "Use the IDs with get_audit and compare_audits. Free and local.",
      inputSchema: {
        client: clientArg,
        limit: z.number().int().min(1).max(200).optional().describe("Default 20."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("list_audits", async ({ client, limit }) => {
      const c = await resolveClient(client);
      return {
        client: c.slug,
        audits: listAudits(c.slug, limit ?? 20).map((a) => ({
          auditId: a.id,
          ranAt: new Date(a.ranAt).toISOString(),
          pages: (a.settings as { pages?: number }).pages ?? null,
          avgScores: (a.summary as { avgScores?: unknown }).avgScores ?? null,
          findings: a.findingCount,
        })),
      };
    }),
  );

  server.registerTool(
    "get_audit",
    {
      title: "Get a saved audit",
      description: "The full stored result of one audit, plus its normalised findings, by audit ID from run_audit or list_audits. Free and local.",
      inputSchema: { auditId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("get_audit", async ({ auditId }) => {
      const a = getAudit(auditId);
      if (!a) throw new Error(`No audit with ID "${auditId}". Use list_audits to see saved audits.`);
      return { auditId: a.id, client: a.client, ranAt: new Date(a.ranAt).toISOString(), findings: a.findings, result: a.result };
    }),
  );

  server.registerTool(
    "compare_audits",
    {
      title: "Compare two audits",
      description:
        "Diff two saved audits of a client: new, resolved, persistent and unverified findings plus Lighthouse score changes. " +
        "A finding counts as resolved only if its check ran successfully in the later audit; otherwise it is unverified. " +
        "Defaults to the latest audit versus the one before it. Free and local.",
      inputSchema: {
        client: clientArg,
        baseAuditId: z.string().optional().describe("The earlier audit. Default: the one before the target."),
        targetAuditId: z.string().optional().describe("The later audit. Default: the latest."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("compare_audits", async ({ client, baseAuditId, targetAuditId }) => {
      const c = await resolveClient(client);
      const { base, target } = pickComparison(c.slug, { baseAuditId, targetAuditId }, {
        get: getAudit,
        latest: () => latestAudit(c.slug),
        before: (ranAt) => latestAuditBefore(c.slug, ranAt),
      });
      return diffAudits(base, target);
    }),
  );

  server.registerTool(
    "crawl_status",
    {
      title: "Crawl status",
      description:
        "Check a full-site crawl started by run_audit. Returns progress, the on-page score, and a count of pages per issue " +
        "(missing meta descriptions, duplicate titles, broken links, etc). Free to poll.",
      inputSchema: { taskId: z.string().describe("taskId from run_audit's site.crawl.") },
      annotations: READ_ONLY,
    },
    handler("crawl_status", ({ taskId }) => onPageSummary(taskId)),
  );

  server.registerTool(
    "crawl_issue_pages",
    {
      title: "Pages with a crawl issue",
      description:
        "List the URLs from a finished crawl that fail one check, e.g. 'no_description', 'duplicate_title', 'is_broken', " +
        "'no_h1_tag', 'large_page_size'. Use the check names returned by crawl_status.",
      inputSchema: {
        taskId: z.string(),
        check: z.string().describe("Check name from crawl_status issues[].check."),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      annotations: READ_ONLY,
    },
    handler("crawl_issue_pages", ({ taskId, check, limit }) => onPagePagesWithIssue(taskId, check, limit)),
  );

  server.registerTool(
    "spend_summary",
    {
      title: "Data spend this month",
      description:
        "Paid API spend this calendar month, by client and provider, against the global cap. " +
        "DataForSEO is billed in USD (cost_usd, totalUsd); Ahrefs and Semrush in their own API units (units per row, and `units.ahrefs` / `units.semrush` " +
        "with this month's use and the global unit cap). Units are never converted to dollars. " +
        "Spend recorded under a clients.yaml slug is counted under that client's domain.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler("spend_summary", async () => {
      // Merge rows recorded under a clients.yaml slug into that client. If the
      // client list can't be loaded, show the raw ledger rather than failing.
      let canonical = new Map<string, string>();
      try {
        canonical = canonicalSpendNames((await loadRegistry()).clients);
      } catch (err) {
        console.error(`crawlmark: spend_summary could not load clients: ${(err as Error).message}`);
      }
      return spendSummary(canonical);
    }),
  );

  server.registerTool(
    "usage_summary",
    {
      title: "Tool usage summary",
      description:
        "How the tools have been used over the last N days (default 30): per tool, the number of calls, errors, error rate, " +
        "error classes (e.g. TimeoutError, UrlRefusedError) and p50/p95 duration in ms. Only the tool, client, duration and outcome are logged, never other arguments. Free and local.",
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe("Look-back window in days. Default 30.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("usage_summary", async ({ days }) => {
      const window = days ?? 30;
      const since = Date.now() - window * 24 * 60 * 60 * 1000;
      const rows = toolCallsSince(since);
      return { days: window, since: new Date(since).toISOString(), totalCalls: rows.length, tools: summarizeUsage(rows) };
    }),
  );

  server.registerTool(
    "purge_cache",
    {
      title: "Purge expired cache",
      description: "Delete expired cache entries (fresh entries are kept) and tool-call usage rows older than 365 days.",
      inputSchema: {},
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler("purge_cache", async () => ({ removed: purgeExpired(), usageRowsRemoved: purgeOldToolCalls() })),
  );
}
