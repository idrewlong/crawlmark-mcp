import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveClient } from "../clients.js";
import { lastCompleteMonth, monthRange } from "../lib/dates.js";
import { runAxe } from "../providers/axe.js";
import { backlinksSummary, competitorDomains, rankedKeywords, searchVolume, serp } from "../providers/dataforseo.js";
import { ga4Report } from "../providers/ga4.js";
import { gscInspectUrl, gscQuery } from "../providers/gsc.js";
import { runLighthouse } from "../providers/lighthouse.js";
import { handler, READ_ONLY } from "./util.js";

/**
 * Lower-level tools for ad-hoc questions ("which pages lost clicks from the
 * blog?"). The report tools in reports.ts cover the routine workflows.
 */

const clientArg = z
  .string()
  .describe("Client domain (e.g. 'example.com'; URL and www. forms also work) or a clients.yaml slug. See list_clients.");
const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function rangeOrDefault(startDate?: string, endDate?: string) {
  if (startDate && endDate) return { startDate, endDate };
  return monthRange(lastCompleteMonth());
}

export function registerRawTools(server: McpServer) {
  // ------------------------------------------------------------- Google (free)

  server.registerTool(
    "gsc_query",
    {
      title: "Search Console query",
      description:
        "Query Google Search Console search analytics for a client. Group by query, page, country, device or date, " +
        "and filter by page or query substring. Free. Defaults to the last complete month.",
      inputSchema: {
        client: clientArg,
        startDate: dateArg.optional(),
        endDate: dateArg.optional(),
        dimensions: z.array(z.enum(["query", "page", "country", "device", "date"])).optional(),
        pageContains: z.string().optional(),
        queryContains: z.string().optional(),
        rowLimit: z.number().int().min(1).max(25000).optional(),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ client, startDate, endDate, ...rest }) =>
      gscQuery(await resolveClient(client), { ...rangeOrDefault(startDate, endDate), ...rest }),
    ),
  );

  server.registerTool(
    "gsc_inspect_url",
    {
      title: "Inspect URL in Search Console",
      description: "Index status, Google-selected canonical, last crawl, mobile usability and rich results for one URL. Free.",
      inputSchema: { client: clientArg, url: z.string().url() },
      annotations: READ_ONLY,
    },
    handler(async ({ client, url }) => gscInspectUrl(await resolveClient(client), url)),
  );

  server.registerTool(
    "ga4_report",
    {
      title: "GA4 report",
      description:
        "Run a GA4 Data API report for a client. Pass GA4 API metric and dimension names " +
        "(e.g. metrics: sessions, keyEvents, engagementRate; dimensions: landingPagePlusQueryString, sessionDefaultChannelGroup, date). Free.",
      inputSchema: {
        client: clientArg,
        metrics: z.array(z.string()).min(1),
        dimensions: z.array(z.string()).optional(),
        startDate: dateArg.optional(),
        endDate: dateArg.optional(),
        organicOnly: z.boolean().optional().describe("Restrict to Organic Search sessions."),
        limit: z.number().int().min(1).max(10000).optional(),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ client, startDate, endDate, ...rest }) =>
      ga4Report(await resolveClient(client), { ...rangeOrDefault(startDate, endDate), ...rest }),
    ),
  );

  // ------------------------------------------------------- DataForSEO (paid)

  server.registerTool(
    "keyword_volume",
    {
      title: "Keyword search volume",
      description: "Monthly Google search volume, CPC and competition for up to 1,000 keywords in the client's market. Paid, cached 30 days.",
      inputSchema: { client: clientArg, keywords: z.array(z.string()).min(1).max(1000) },
      annotations: READ_ONLY,
    },
    handler(async ({ client, keywords }) => searchVolume(await resolveClient(client), keywords)),
  );

  server.registerTool(
    "serp_check",
    {
      title: "Live SERP check",
      description: "Live Google organic results for one keyword in the client's market, with the client's rank and the top 10. Paid, cached 1 day.",
      inputSchema: { client: clientArg, keyword: z.string(), depth: z.number().int().min(10).max(100).optional() },
      annotations: READ_ONLY,
    },
    handler(async ({ client, keyword, depth }) => serp(await resolveClient(client), keyword, depth)),
  );

  server.registerTool(
    "ranked_keywords",
    {
      title: "Ranked keywords",
      description: "Keywords a domain ranks for (defaults to the client's domain; pass a competitor domain to compare). Paid, cached 7 days.",
      inputSchema: {
        client: clientArg,
        target: z.string().optional().describe("Domain to analyze. Defaults to the client's domain."),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ client, target, limit }) => rankedKeywords(await resolveClient(client), target, limit)),
  );

  server.registerTool(
    "competitor_domains",
    {
      title: "Organic competitors",
      description: "Domains that compete with the client for the same organic keywords. Paid, cached 30 days.",
      inputSchema: { client: clientArg, limit: z.number().int().min(1).max(100).optional() },
      annotations: READ_ONLY,
    },
    handler(async ({ client, limit }) => competitorDomains(await resolveClient(client), limit)),
  );

  server.registerTool(
    "backlinks_summary",
    {
      title: "Backlinks summary",
      description: "Backlink and referring-domain counts, rank and spam score for a domain. Paid, cached 7 days.",
      inputSchema: { client: clientArg, target: z.string().optional() },
      annotations: READ_ONLY,
    },
    handler(async ({ client, target }) => backlinksSummary(await resolveClient(client), target)),
  );

  // ---------------------------------------------------- browser checks (free)

  server.registerTool(
    "lighthouse",
    {
      title: "Lighthouse",
      description:
        "Run Lighthouse on any URL: category scores, lab Core Web Vitals and top opportunities. " +
        "Adds real-user CrUX field data when PSI_API_KEY is set. Free, ~30s.",
      inputSchema: { url: z.string().url(), formFactor: z.enum(["mobile", "desktop"]).optional() },
      annotations: READ_ONLY,
    },
    handler(({ url, formFactor }) => runLighthouse(url, formFactor)),
  );

  server.registerTool(
    "accessibility_check",
    {
      title: "Accessibility check (axe)",
      description:
        "Run axe-core WCAG checks on any URL. Returns violations grouped by rule with impact, WCAG criteria and example selectors. " +
        "Automated checks catch a subset of issues; flag manual review in reports. Free.",
      inputSchema: { url: z.string().url(), level: z.enum(["A", "AA", "AAA"]).optional() },
      annotations: READ_ONLY,
    },
    handler(({ url, level }) => runAxe(url, level)),
  );
}
