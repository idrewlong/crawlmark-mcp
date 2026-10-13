import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveClient } from "../clients.js";
import {
  runCannibalization,
  runDecliningPages,
  runLowCtr,
  runQuickWins,
  runStrikingDistance,
} from "../reports/opportunities.js";
import { handler, READ_ONLY } from "./util.js";

const clientArg = z
  .string()
  .describe("Client domain, e.g. 'example.com' (URL and www. forms also work), or a clients.yaml slug. Use list_clients to see options.");

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const common = {
  client: clientArg,
  startDate: date.optional().describe("YYYY-MM-DD. Give with endDate. Default: the last 28 days ending 3 days ago (Search Console lags 2-3 days)."),
  endDate: date.optional().describe("YYYY-MM-DD. Give with startDate."),
  includeBranded: z.boolean().optional().describe("Keep branded queries. Default false: they are excluded, since branded rankings are rarely an opportunity."),
  limit: z.number().int().min(1).max(500).optional().describe("Rows to return, best first. Default 25. The result reports the total found."),
};
const minImpressions = (d: number) => z.number().int().min(0).optional().describe(`Minimum impressions in the window. Default ${d}.`);
const position = (name: string, d: number) => z.number().min(0).optional().describe(`${name} average position (inclusive). Default ${d}.`);

const FREE = "Free (Search Console only). Returns the window used, a `method` string describing the thresholds, and rows sorted best first.";

export function registerOpportunityTools(server: McpServer) {
  server.registerTool(
    "striking_distance",
    {
      title: "Striking-distance queries",
      description:
        "Queries ranking just below the top results (default positions 5-20, at least 100 impressions) with their top page, position, impressions, clicks, CTR and estimated extra clicks if they reached position 3. " +
        FREE,
      inputSchema: { ...common, minPosition: position("Minimum", 5), maxPosition: position("Maximum", 20), minImpressions: minImpressions(100) },
      annotations: READ_ONLY,
    },
    handler("striking_distance", async ({ client, ...o }) => runStrikingDistance(await resolveClient(client), o)),
  );

  server.registerTool(
    "quick_wins",
    {
      title: "Pages just off page one",
      description: "Pages averaging positions 11-20 (default) with at least 100 impressions, with their top 3 queries: the pages closest to page one. " + FREE,
      inputSchema: { ...common, minPosition: position("Minimum", 11), maxPosition: position("Maximum", 20), minImpressions: minImpressions(100) },
      annotations: READ_ONLY,
    },
    handler("quick_wins", async ({ client, ...o }) => runQuickWins(await resolveClient(client), o)),
  );

  server.registerTool(
    "low_ctr",
    {
      title: "Low-CTR top results",
      description:
        "Queries in positions 1-5 whose CTR is below 60% of the expected CTR for that position: title and meta description rewrite candidates, with the page, CTR, expected CTR and estimated extra clicks. " +
        FREE,
      inputSchema: {
        ...common,
        minPosition: position("Minimum", 1),
        maxPosition: position("Maximum", 5),
        ctrRatio: z.number().min(0).max(1).optional().describe("Flag CTR below this fraction of the expected CTR. Default 0.6."),
        minImpressions: minImpressions(100),
      },
      annotations: READ_ONLY,
    },
    handler("low_ctr", async ({ client, ...o }) => runLowCtr(await resolveClient(client), o)),
  );

  server.registerTool(
    "cannibalization",
    {
      title: "Keyword cannibalization",
      description:
        "Queries where 2 or more pages each get at least 10% of the query's impressions (and the query has at least 100 in total), with each page's impression share, position and clicks. " +
        FREE,
      inputSchema: {
        ...common,
        minImpressions: minImpressions(100),
        minShare: z.number().min(0).max(1).optional().describe("Fraction of the query's impressions each competing page needs. Default 0.1."),
      },
      annotations: READ_ONLY,
    },
    handler("cannibalization", async ({ client, ...o }) => runCannibalization(await resolveClient(client), o)),
  );

  server.registerTool(
    "declining_pages",
    {
      title: "Declining pages",
      description:
        "Pages whose clicks fell by at least 30% and at least 10 clicks versus the previous period of equal length, with clicks and position before and after and the queries that lost the most clicks. " +
        FREE,
      inputSchema: {
        ...common,
        minDropPct: z.number().min(0).max(100).optional().describe("Minimum click drop in percent. Default 30."),
        minClickLoss: z.number().int().min(0).optional().describe("Minimum clicks lost. Default 10."),
      },
      annotations: READ_ONLY,
    },
    handler("declining_pages", async ({ client, ...o }) => runDecliningPages(await resolveClient(client), o)),
  );
}
