import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AI_MODES, AI_PLATFORMS, aiVisibility } from "../ai-visibility.js";
import { resolveClient } from "../clients.js";
import { handler, READ_ONLY } from "./util.js";

/**
 * AI-search visibility (Phase 12 C5): off unless AI_VISIBILITY_ENABLED=true, paid through DataForSEO LLM Mentions,
 * with its own monthly sub-cap. Registered always so the description can explain how to turn it on.
 */

const clientArg = z
  .string()
  .describe("Client domain (e.g. 'example.com'; URL and www. forms also work) or a clients.yaml slug. See list_clients.");

export function registerAiVisibilityTools(server: McpServer) {
  server.registerTool(
    "ai_visibility",
    {
      title: "AI-search visibility",
      description:
        "Where a client's domain is cited in AI answers, from DataForSEO LLM Mentions: mode \"mentions\" lists questions in Google AI Overviews (platform \"google\", default) or ChatGPT (\"chat_gpt\", United States English only) whose answer cites the domain, " +
        "with the cited URL, its position among the sources, the question's AI search volume and an answer excerpt; mode \"metrics\" gives aggregate mention counts and AI search volume by platform, location and language, and the domains cited alongside it. " +
        "OFF unless AI_VISIBILITY_ENABLED=true is set (see setup_status). PAID: $0.10 per request plus $0.001 per row (about $0.12 for 20 rows; the minimum is $0.10 per request), checked against its own monthly cap (AI_VISIBILITY_MONTHLY_BUDGET_USD, default $2) and the client's and the global caps before the request; cached a week. " +
        "DataForSEO has required a $100 monthly top-up for LLM Mentions access; its 2026-07-07 update says that minimum was removed, so tell the user to check their DataForSEO account. " +
        "Always call with estimateOnly: true first, tell the user the cost and that warning, and run it only after they agree. DataForSEO only; its free sandbox serves LLM Mentions for trying it.",
      inputSchema: {
        client: clientArg,
        mode: z.enum(AI_MODES).optional().describe('"mentions" (default): answers citing the domain. "metrics": aggregate counts.'),
        platform: z.enum(AI_PLATFORMS).optional().describe('"google" (AI Overviews, default) or "chat_gpt" (United States English only).'),
        limit: z.number().int().min(1).max(100).optional().describe("Answers to return in mentions mode, 1 to 100. Default 20 ($0.001 each on top of $0.10)."),
        estimateOnly: z.boolean().optional().describe("Return the estimate, the remaining caps and the minimum-commitment warning only; no request, no charge."),
      },
      annotations: READ_ONLY,
    },
    handler("ai_visibility", async ({ client, mode, platform, limit, estimateOnly }) => aiVisibility(await resolveClient(client), { mode, platform, limit, estimateOnly }), { timeoutMs: 150_000 }),
  );
}
