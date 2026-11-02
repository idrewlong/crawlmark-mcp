import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveClient } from "../clients.js";
import { CRAWL_RULE_IDS } from "../analysis/crawl.js";
import { getCrawl } from "../lib/crawls.js";
import { CRAWL_LIMITS, CRAWL_TIME_LIMIT_MS, inCrawlScope } from "../providers/crawler.js";
import { loadLocalCrawlDeps, runLocalCrawl } from "../reports/local-crawl.js";
import { assertUserUrl } from "../user-url.js";
import { handler } from "./util.js";

/**
 * The free local crawler (Phase 12 C1). local_crawl crawls the client's own site and
 * saves the result; local_crawl_pages reads a saved crawl's pages.
 */

const clientArg = z
  .string()
  .describe("Client domain (e.g. 'example.com'; URL and www. forms also work) or a clients.yaml slug. See list_clients.");
/** Fetches the client's site and writes crawlmark's own database (local_crawls); the newest 10 per client are kept. */
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const LOCAL_READ = { readOnlyHint: true, openWorldHint: false } as const;
const int = (l: { min: number; max: number }) => z.number().int().min(l.min).max(l.max);

export function registerCrawlTools(server: McpServer) {
  server.registerTool(
    "local_crawl",
    {
      title: "Local site crawl (free)",
      description:
        "Crawl a client's own site from this machine (free, no paid provider) and save the result: status codes, redirects and chains, titles, meta descriptions, canonicals, H1s, " +
        "internal links, click depth, broken internal links, noindex pages, missing H1s, titles that repeat the brand name, and orphan pages (sitemap URLs no link reaches; only when the crawl finished within its caps). " +
        "After the link crawl it also fetches sitemap URLs the links didn't reach (sharing the page cap and time limit; their links are not followed; includeSitemapUrls false turns this off). " +
        "Polite: obeys robots.txt (the crawlmark group, or Googlebot's with userAgent googlebot, else *), Crawl-delay up to 10 s, otherwise one request per 250 ms per host, " +
        "honest user agent. Same host only by default (www. included). Every URL and redirect is SSRF-guarded and RESTRICT_TO_CLIENT_DOMAINS applies. HTML only, no JavaScript rendering " +
        "(render_check covers that), 2 MB per page, 15 s per request, 10 minutes per crawl. Returns a summary and the top 50 issues; list pages with local_crawl_pages. " +
        "site_hygiene and run_audit use the newest complete crawl (local or DataForSEO) for orphans.",
      inputSchema: {
        client: clientArg,
        maxPages: int(CRAWL_LIMITS.maxPages).optional().describe("Most pages to fetch. Default 300, max 2000."),
        maxDepth: int(CRAWL_LIMITS.maxDepth).optional().describe("Most clicks from the start pages. Default 10."),
        concurrency: int(CRAWL_LIMITS.concurrency).optional().describe("Requests in flight at once (still spaced per host). Default 4."),
        userAgent: z.enum(["crawlmark", "googlebot"]).optional().describe('Default "crawlmark" (its own user agent and robots group). "googlebot" sends Googlebot\'s user agent and obeys its robots group.'),
        includeSubdomains: z.boolean().optional().describe("Also crawl subdomains of the client's domain. Default false."),
        includeSitemapUrls: z.boolean().optional().describe("After the link crawl, also fetch sitemap URLs the links didn't reach (same caps, robots rules and politeness). Default true."),
        startUrls: z.array(z.string().url()).min(1).max(50).optional().describe("Where to start, on the client's host. Default: the homepage plus the client's key pages (never sitemap URLs, so orphans can be found)."),
      },
      annotations: LOCAL_WRITE,
    },
    handler(
      "local_crawl",
      async ({ client, ...o }, { signal }) => {
        const c = await resolveClient(client);
        for (const u of o.startUrls ?? []) {
          // Scope first (no DNS lookup for a URL that is refused anyway), then the usual URL guard.
          if (!inCrawlScope(u, c.domain, o.includeSubdomains ?? false, "any")) throw new Error(`Start URL ${u} is not on ${c.domain}${o.includeSubdomains ? " or its subdomains" : ""}.`);
          await assertUserUrl(u);
        }
        const { result } = await runLocalCrawl(c, { ...o, signal }, await loadLocalCrawlDeps());
        return result;
      },
      { timeoutMs: CRAWL_TIME_LIMIT_MS + 90_000 },
    ),
  );

  server.registerTool(
    "local_crawl_pages",
    {
      title: "Pages from a local crawl",
      description:
        "Pages from a saved local_crawl (crawlmark keeps the newest 10 crawls per client): URL, status, depth, title, description, canonical, robots, H1 count, inlinks, outlinks, " +
        "redirect chain and issues. Filter by issue rule or status code. Free and local: reads crawlmark's database only.",
      inputSchema: {
        crawlId: z.string().min(1).max(100).describe("crawlId from local_crawl."),
        issue: z.enum(CRAWL_RULE_IDS as [string, ...string[]]).optional().describe("Only pages with this issue."),
        status: z.number().int().min(100).max(599).optional().describe("Only pages whose first response had this HTTP status."),
        limit: z.number().int().min(1).max(500).optional().describe("Default 100."),
      },
      annotations: LOCAL_READ,
    },
    handler("local_crawl_pages", async ({ crawlId, issue, status, limit }) => {
      const crawl = getCrawl(crawlId);
      if (!crawl) throw new Error(`No saved crawl ${crawlId}. Only the newest 10 crawls per client are kept; run local_crawl again.`);
      const matching = crawl.pages.filter((p) => (issue === undefined || p.issues.includes(issue)) && (status === undefined || p.status === status));
      return {
        crawlId: crawl.id,
        client: crawl.client,
        ranAt: new Date(crawl.ranAt).toISOString(),
        exhaustive: crawl.exhaustive,
        total: matching.length,
        pages: matching.slice(0, limit ?? 100).map((p) => ({
          url: p.url,
          status: p.status,
          ...(p.finalStatus !== null && p.redirectChain.length ? { finalStatus: p.finalStatus } : {}),
          depth: p.depth ?? "sitemap",
          title: p.title,
          description: p.description,
          canonical: p.canonical,
          robots: p.robots,
          h1Count: p.h1Count,
          inlinks: p.inlinks,
          outlinks: p.outlinks,
          redirectChain: p.redirectChain,
          issues: p.issues,
          ...(p.skipped ? { skipped: p.skipped } : {}),
          ...(p.error ? { error: p.error } : {}),
        })),
      };
    }),
  );
}
