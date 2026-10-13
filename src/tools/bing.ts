import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveClient } from "../clients.js";
import { bingReport } from "../providers/bing.js";
import { handler, READ_ONLY } from "./util.js";

/**
 * Bing Webmaster Tools (Phase 12 C3): read-only and free with the user's own
 * BING_WEBMASTER_API_KEY. Only allowlisted read methods are ever called
 * (src/providers/bing.ts); nothing is submitted to Bing.
 */

const clientArg = z
  .string()
  .describe("Client domain (e.g. 'example.com'; URL and www. forms also work) or a clients.yaml slug. See list_clients.");

export function registerBingTools(server: McpServer) {
  server.registerTool(
    "bing_report",
    {
      title: "Bing Webmaster Tools report",
      description:
        "Bing search performance for a client from Bing Webmaster Tools: clicks, impressions and CTR for the last `days` days (default 28, ending on Bing's newest day) vs the same number of days before, " +
        "clicks and impressions by day, the top 25 queries and pages (with Bing's average position), crawl stats for the latest 30 days (pages crawled, in index, crawl errors, status codes) " +
        "and up to 50 URLs with crawl issues. Bing updates query and page stats weekly, so those can lag the daily totals. " +
        "The client's Bing site is matched by domain among the key's verified sites, or pinned with bingSite (set_client_profile). " +
        "Read-only: crawlmark never submits URLs, sitemaps or anything else to Bing. Free; needs BING_WEBMASTER_API_KEY (crawlmark-cli setup --step bing). Cached a day.",
      inputSchema: {
        client: clientArg,
        days: z.number().int().min(7).max(180).optional().describe("Window length in days, 7 to 180. Default 28."),
        refresh: z.boolean().optional().describe("Skip the one-day cache and read Bing again. Default false."),
      },
      annotations: READ_ONLY,
    },
    handler("bing_report", async ({ client, days, refresh }) => {
      const c = await resolveClient(client);
      return bingReport(c, { days }, { refresh: refresh ?? false });
    }),
  );
}
