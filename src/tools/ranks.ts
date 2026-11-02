import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveClient } from "../clients.js";
import { env } from "../config.js";
import { keywordInput } from "../lib/clients.js";
import { checkRanks, loadCheckRanksDeps, rankHistory } from "../ranks.js";
import { handler } from "./util.js";
import { cliHint } from "../lib/cli-hint.js";

/**
 * Rank history for tracked keywords (Phase 12 B). rank_history reads the local
 * rank_history table only; check_ranks checks ranks now and stores them.
 */

const clientArg = z
  .string()
  .describe("Client domain (e.g. 'example.com'; URL and www. forms also work) or a clients.yaml slug. See list_clients.");
const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Reads only crawlmark's own database: no network. */
const LOCAL_READ = { readOnlyHint: true, openWorldHint: false } as const;
/** Writes crawlmark's own database (rank_history); the same check on the same day replaces its rows. */
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registerRankTools(server: McpServer) {
  server.registerTool(
    "rank_history",
    {
      title: "Rank history",
      description:
        `Stored rank history for a client's tracked keywords: Search Console 7-day average positions (\`gsc\`, saved by check_ranks and ${cliHint()} check-ranks, free) ` +
        "and live Google ranks (`serp`, saved by check_ranks with live: true, serp_check and monthly_report with liveRanks, paid when they ran). " +
        "Per keyword and source: the series and a summary (latest, first, best, worst, change, change30d, change90d). Lower is better: a negative change is an improvement. " +
        "Free and local: reads crawlmark's database only, makes no request. Default range: the last 180 days.",
      inputSchema: {
        client: clientArg,
        keyword: z.string().min(1).max(200).optional().describe("One keyword (any case or spacing). Default: every tracked keyword plus any with stored rows."),
        source: z.enum(["serp", "gsc", "both"]).optional().describe('Default "both".'),
        since: dateArg.optional().describe("YYYY-MM-DD, default 180 days before until."),
        until: dateArg.optional().describe("YYYY-MM-DD, default today."),
      },
      annotations: LOCAL_READ,
    },
    handler("rank_history", async ({ client, keyword, source, since, until }) => rankHistory(await resolveClient(client), { keyword, source, since, until })),
  );

  server.registerTool(
    "check_ranks",
    {
      title: "Check ranks",
      description:
        "Check a client's tracked keywords now and save the result to rank history. By default free: Search Console's average position, clicks, impressions and top page " +
        "over the last 7 complete days. live: true also runs a paid live Google SERP check per keyword through DataForSEO (DataForSEO only, whatever the client's data provider; " +
        "about $0.002 per keyword, checked against the client's and the global monthly caps for the whole run before the first request). " +
        "Call with estimateOnly: true first for a live check: it returns the estimate and the remaining caps and makes no request. " +
        "Each result has the previous stored position and the change (lower is better). Live checks list rankDrops: keywords that left the top 10 or fell by at least ALERT_RANK_DROP places.",
      inputSchema: {
        client: clientArg,
        live: z.boolean().optional().describe("Also run a paid live SERP check per keyword (DataForSEO). Default false."),
        keywords: z.array(keywordInput).min(1).max(200).optional().describe("A subset of the tracked keywords. Default: all tracked keywords."),
        estimateOnly: z.boolean().optional().describe("Return the estimate and remaining caps only; no request, nothing saved."),
      },
      annotations: LOCAL_WRITE,
    },
    handler("check_ranks", async ({ client, live, keywords, estimateOnly }) =>
      checkRanks(await resolveClient(client), { live, keywords, estimateOnly, rankDropThreshold: env.ALERT_RANK_DROP }, await loadCheckRanksDeps()),
    ),
  );
}
