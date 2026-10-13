import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveClient } from "../clients.js";
import { lastCompleteMonth, monthRange } from "../lib/dates.js";
import { runAxe } from "../providers/axe.js";
import { ahrefsStatus } from "../providers/ahrefs.js";
import { dataForSeoStatus } from "../providers/dataforseo.js";
import { semrushStatus } from "../providers/semrush.js";
import { backlinksSummary, competitorDomains, rankedKeywords, searchVolume, serp } from "../providers/seo-data.js";
import { ga4Report } from "../providers/ga4.js";
import { gscInspectUrl, gscQuery } from "../providers/gsc.js";
import { runLighthouse } from "../providers/lighthouse.js";
import { checkRender } from "../providers/render.js";
import { TIMEOUTS } from "../lib/timeout.js";
import { keywordInput } from "../lib/clients.js";
import { assertUserUrl } from "../user-url.js";
import { handler, READ_ONLY } from "./util.js";

/**
 * Lower-level tools for ad-hoc questions ("which pages lost clicks from the
 * blog?"). The report tools in reports.ts cover the routine workflows.
 */

const clientArg = z
  .string()
  .describe("Client domain (e.g. 'example.com'; URL and www. forms also work) or a clients.yaml slug. See list_clients.");
const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const BROWSER = { timeoutMs: TIMEOUTS.browserMs };
/** Routed paid tools: each result carries `provider` (whose data it is), `units` (Ahrefs/Semrush API units; null for DataForSEO), costUsd and fromCache. */
const PAID = "Paid (DataForSEO, Ahrefs or Semrush, per client; the result's `provider` and `units` say which and how many API units)";
const URL_SAFETY =
  "http/https only; hosts that resolve to a private, loopback or link-local address are refused unless ALLOW_PRIVATE_URLS=true, " +
  "and with RESTRICT_TO_CLIENT_DOMAINS=true only client domains and their subdomains are allowed. Times out after 90s.";

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
    handler("gsc_query", async ({ client, startDate, endDate, ...rest }) =>
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
    handler("gsc_inspect_url", async ({ client, url }) => gscInspectUrl(await resolveClient(client), url)),
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
    handler("ga4_report", async ({ client, startDate, endDate, ...rest }) =>
      ga4Report(await resolveClient(client), { ...rangeOrDefault(startDate, endDate), ...rest }),
    ),
  );

  // ------------------------------------- paid SEO data (DataForSEO, Ahrefs or Semrush, per client)

  server.registerTool(
    "keyword_volume",
    {
      title: "Keyword search volume",
      description: "Monthly Google search volume, CPC and competition for up to 1,000 keywords in the client's market. " + PAID + ", cached 30 days.",
      inputSchema: { client: clientArg, keywords: z.array(keywordInput).min(1).max(1000) },
      annotations: READ_ONLY,
    },
    handler("keyword_volume", async ({ client, keywords }) => searchVolume(await resolveClient(client), keywords)),
  );

  server.registerTool(
    "serp_check",
    {
      title: "Live SERP check",
      description: "Live Google organic results for one keyword in the client's market, with the client's rank and the top 10. Paid (DataForSEO only, whatever the client's data provider), cached 1 day.",
      inputSchema: { client: clientArg, keyword: z.string(), depth: z.number().int().min(10).max(100).optional() },
      annotations: READ_ONLY,
    },
    handler("serp_check", async ({ client, keyword, depth }) => serp(await resolveClient(client), keyword, depth)),
  );

  server.registerTool(
    "ranked_keywords",
    {
      title: "Ranked keywords",
      description: "Keywords a domain ranks for (defaults to the client's domain; pass a competitor domain to compare). " + PAID + ", cached 7 days.",
      inputSchema: {
        client: clientArg,
        target: z.string().optional().describe("Domain to analyze. Defaults to the client's domain."),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      annotations: READ_ONLY,
    },
    handler("ranked_keywords", async ({ client, target, limit }) => rankedKeywords(await resolveClient(client), target, limit)),
  );

  server.registerTool(
    "competitor_domains",
    {
      title: "Organic competitors",
      description: "Domains that compete with the client for the same organic keywords. " + PAID + ", cached 30 days.",
      inputSchema: { client: clientArg, limit: z.number().int().min(1).max(100).optional() },
      annotations: READ_ONLY,
    },
    handler("competitor_domains", async ({ client, limit }) => competitorDomains(await resolveClient(client), limit)),
  );

  server.registerTool(
    "backlinks_summary",
    {
      title: "Backlinks summary",
      description: "Backlink and referring-domain counts, rank and spam score for a domain (rank and spam score are DataForSEO-only; `authority` labels each provider's own domain-strength metric). " + PAID + ", cached 7 days.",
      inputSchema: { client: clientArg, target: z.string().optional() },
      annotations: READ_ONLY,
    },
    handler("backlinks_summary", async ({ client, target }) => backlinksSummary(await resolveClient(client), target)),
  );

  server.registerTool(
    "dataforseo_status",
    {
      title: "DataForSEO status",
      description:
        "Check the DataForSEO account: whether the credentials work, the mode (`sandbox` = canned free data, `live` = billed) from the configured base URL, and the account balance in USD. " +
        "Free, never cached, records no spend, and never shows the credentials. A missing or rejected login is reported in the result, not as a tool error.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler("dataforseo_status", () => dataForSeoStatus()),
  );

  server.registerTool(
    "ahrefs_status",
    {
      title: "Ahrefs status",
      description:
        "Check the Ahrefs API v3 key with Ahrefs' free limits-and-usage call: whether the key works, the plan, the key's and workspace's units used this billing month " +
        "and when they reset, plus the units crawlmark recorded this calendar month against its own cap (monthlyUnitCap). " +
        "Free (no API units), never cached, records no spend, and never shows the key. A missing or rejected key is reported in the result, not as a tool error. " +
        "Change the key in a terminal (setup --step ahrefs), never through chat.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler("ahrefs_status", () => ahrefsStatus()),
  );

  server.registerTool(
    "semrush_status",
    {
      title: "Semrush status",
      description:
        "Check the Semrush v3 API key with Semrush's free balance call: whether the key is accepted and how many API units are left, whether a v4 key " +
        "(used for backlinks) is set, plus the units crawlmark recorded this calendar month against its own cap. Accepted proves the key exists, not that the " +
        "plan includes the API (that shows on the first paid call). The v4 key has no free check. Free, never cached, records no spend, never shows a key. " +
        "A missing or rejected key is reported in the result, not as a tool error. Change keys in a terminal (setup --step semrush), never through chat.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler("semrush_status", () => semrushStatus()),
  );

  // ---------------------------------------------------- browser checks (free)

  server.registerTool(
    "lighthouse",
    {
      title: "Lighthouse",
      description:
        "Run Lighthouse on any URL: category scores, lab Core Web Vitals and top opportunities. " +
        "Adds real-user CrUX field data when PSI_API_KEY is set. Free, ~30s. " + URL_SAFETY,
      inputSchema: { url: z.string().url(), formFactor: z.enum(["mobile", "desktop"]).optional() },
      annotations: READ_ONLY,
    },
    handler(
      "lighthouse",
      async ({ url, formFactor }, { signal }) => {
        await assertUserUrl(url);
        return runLighthouse(url, formFactor, { signal });
      },
      BROWSER,
    ),
  );

  server.registerTool(
    "accessibility_check",
    {
      title: "Accessibility check (axe)",
      description:
        "Run axe-core WCAG checks on any URL. Returns violations grouped by rule with impact, WCAG criteria and example selectors. " +
        "Automated checks catch a subset of issues; flag manual review in reports. Free. " + URL_SAFETY,
      inputSchema: { url: z.string().url(), level: z.enum(["A", "AA", "AAA"]).optional() },
      annotations: READ_ONLY,
    },
    handler(
      "accessibility_check",
      async ({ url, level }, { signal }) => {
        await assertUserUrl(url);
        return runAxe(url, level, { signal });
      },
      BROWSER,
    ),
  );

  server.registerTool(
    "render_check",
    {
      title: "Rendered vs raw HTML check",
      description:
        "Fetch a URL twice, as plain HTML (Googlebot-like user agent, no JavaScript) and as rendered by headless Chrome, then compare title, " +
        "meta description, canonical, robots meta, H1s, links, JSON-LD types, hreflang, Open Graph and visible word count. " +
        "Flags SEO elements that only appear after JavaScript runs (rules like title-js-only, canonical-mismatch, content-js-dependent). " +
        "Free, ~15s, cached 1 day. " + URL_SAFETY,
      inputSchema: { url: z.string().url(), refresh: z.boolean().optional().describe("Bypass the one-day cache.") },
      annotations: READ_ONLY,
    },
    handler(
      "render_check",
      async ({ url, refresh }, { signal }) => {
        await assertUserUrl(url);
        return checkRender(url, { refresh: refresh ?? false, signal });
      },
      BROWSER,
    ),
  );
}
