import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadRegistry, resolveClient } from "../clients.js";
import { diffAudits, pickComparison } from "../analysis/diff.js";
import { getAudit, latestAudit, latestAuditBefore, listAudits } from "../lib/audits.js";
import { missingPieces } from "../lib/clients.js";
import { canonicalSpendNames } from "../lib/spend.js";
import { spendSummary } from "../lib/budget.js";
import { purgeExpired } from "../lib/cache.js";
import { onPagePagesWithIssue, onPageSummary } from "../providers/dataforseo.js";
import { runAudit } from "../reports/audit.js";
import { monthlyReport } from "../reports/monthly.js";
import { handler, READ_ONLY } from "./util.js";

const clientArg = z
  .string()
  .describe("Client domain, e.g. 'example.com' (URL and www. forms also work), or a clients.yaml slug. Use list_clients to see options.");

export function registerReportTools(server: McpServer) {
  server.registerTool(
    "list_clients",
    {
      title: "List clients",
      description:
        "List clients from clients.yaml. When Google is set up, Search Console sites and GA4 properties the account can " +
        "access are discovered first and any new domains are added to clients.yaml (existing entries are never changed). " +
        "Shows each client's domain, name, sources, properties, alternates and missing pieces, plus discovery status. " +
        "Discovery is cached for a day; pass refresh to re-list. Clients without Google still work for DataForSEO, Lighthouse and axe.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Bypass the one-day discovery cache and list properties from Google again."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ refresh }) => {
      const registry = await loadRegistry({ refresh: refresh ?? false });
      return {
        clients: registry.clients.map((c) => ({
          domain: c.domain,
          name: c.name,
          sources: c.sources,
          gscProperty: c.gscProperty ?? null,
          ga4PropertyId: c.ga4PropertyId ?? null,
          ...(c.aliases.length ? { aliases: c.aliases } : {}),
          ...(c.alternates.gsc.length || c.alternates.ga4.length ? { alternates: c.alternates } : {}),
          missing: missingPieces(c),
          ...(c.area ? { area: c.area } : {}),
          ...(c.niche ? { niche: c.niche } : {}),
          competitors: c.competitors.length,
          trackedKeywords: c.trackedKeywords.length,
          keyPages: c.keyPages.length,
          monthlyBudgetUsd: c.monthlyBudgetUsd,
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
        "Build the data for a client's monthly SEO report: GSC clicks/impressions/CTR/position vs previous month and last year, " +
        "GA4 organic sessions and key events, top and moving queries and pages, top organic landing pages, and tracked keyword positions, plus an `audit` section: the latest saved audit and its diff against the most recent audit from before the month (`null` unless there is one from before the month and a newer one; a back-dated month still diffs against the latest audit). " +
        "Free by default (Google APIs only); set liveRanks for a paid live SERP check per tracked keyword. " +
        "Returns structured JSON for you to write up; each section reports its own error if a source is unavailable.",
      inputSchema: {
        client: clientArg,
        month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM. Defaults to the last complete month."),
        liveRanks: z.boolean().optional().describe("Check live Google rank for each tracked keyword via DataForSEO (paid)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ client, month, liveRanks }) => monthlyReport(await resolveClient(client), { month, liveRanks })),
  );

  server.registerTool(
    "run_audit",
    {
      title: "Run SEO + accessibility audit",
      description:
        "Audit a client's key pages: Lighthouse (performance, SEO, best practices, Core Web Vitals), axe-core WCAG checks, " +
        "GSC index status per URL, GSC sitemap health, and a DataForSEO on-page check per URL. " +
        "Optionally start a full-site crawl (paid, async; poll with crawl_status) and include a backlinks summary (paid). " +
        "Takes ~30-60s per page because Lighthouse and axe run in a real browser.",
      inputSchema: {
        client: clientArg,
        urls: z.array(z.string().url()).optional().describe("Override the client's keyPages for this run."),
        formFactor: z.enum(["mobile", "desktop"]).optional().describe("Lighthouse emulation. Default mobile."),
        wcagLevel: z.enum(["A", "AA", "AAA"]).optional().describe("WCAG conformance level for axe. Default AA."),
        fullCrawl: z.boolean().optional().describe("Start a full-site DataForSEO crawl (paid)."),
        maxCrawlPages: z.number().int().min(1).max(5000).optional().describe("Crawl page cap. Default 100."),
        backlinks: z.boolean().optional().describe("Include a DataForSEO backlinks summary (paid)."),
        fresh: z
          .boolean()
          .optional()
          .describe("Default true: every check runs live, so the audit is a true snapshot (the on-page check is a paid call per page). false reuses cached results up to a day old."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ client, ...opts }) => runAudit(await resolveClient(client), opts)),
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
    handler(async ({ client, limit }) => {
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
    handler(async ({ auditId }) => {
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
    handler(async ({ client, baseAuditId, targetAuditId }) => {
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
    handler(({ taskId }) => onPageSummary(taskId)),
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
    handler(({ taskId, check, limit }) => onPagePagesWithIssue(taskId, check, limit)),
  );

  server.registerTool(
    "spend_summary",
    {
      title: "Data spend this month",
      description:
        "Paid API spend this calendar month, by client and provider, against the global cap. " +
        "Spend recorded under a clients.yaml slug is counted under that client's domain.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async () => {
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
    "purge_cache",
    {
      title: "Purge expired cache",
      description: "Delete expired cache entries. Fresh entries are kept.",
      inputSchema: {},
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(async () => ({ removed: purgeExpired() })),
  );
}
