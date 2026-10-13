import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient, loadClients } from "../config.js";
import { spendSummary } from "../lib/budget.js";
import { purgeExpired } from "../lib/cache.js";
import { onPagePagesWithIssue, onPageSummary } from "../providers/dataforseo.js";
import { runAudit } from "../reports/audit.js";
import { monthlyReport } from "../reports/monthly.js";
import { handler, READ_ONLY } from "./util.js";

const clientArg = z.string().describe("Client slug from clients.yaml, e.g. 'acme-plumbing'. Use list_clients to see options.");

export function registerReportTools(server: McpServer) {
  server.registerTool(
    "list_clients",
    {
      title: "List clients",
      description: "List configured clients with their domain, connected data sources and monthly data budget.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async () =>
      [...loadClients().values()].map((c) => ({
        slug: c.slug,
        name: c.name,
        domain: c.domain,
        gsc: Boolean(c.gscProperty),
        ga4: Boolean(c.ga4PropertyId),
        trackedKeywords: c.trackedKeywords.length,
        keyPages: c.keyPages.length,
        monthlyBudgetUsd: c.monthlyBudgetUsd,
      })),
    ),
  );

  server.registerTool(
    "monthly_report",
    {
      title: "Monthly SEO report",
      description:
        "Build the data for a client's monthly SEO report: GSC clicks/impressions/CTR/position vs previous month and last year, " +
        "GA4 organic sessions and key events, top and moving queries and pages, top organic landing pages, and tracked keyword positions. " +
        "Free by default (Google APIs only); set liveRanks for a paid live SERP check per tracked keyword. " +
        "Returns structured JSON for you to write up; each section reports its own error if a source is unavailable.",
      inputSchema: {
        client: clientArg,
        month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM. Defaults to the last complete month."),
        liveRanks: z.boolean().optional().describe("Check live Google rank for each tracked keyword via DataForSEO (paid)."),
      },
      annotations: READ_ONLY,
    },
    handler(({ client, month, liveRanks }) => monthlyReport(getClient(client), { month, liveRanks })),
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
      },
      annotations: READ_ONLY,
    },
    handler(({ client, ...opts }) => runAudit(getClient(client), opts)),
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
      description: "Paid API spend this calendar month, by client and provider, against the global cap.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async () => spendSummary()),
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
