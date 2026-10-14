import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveClient } from "../clients.js";
import { keywordInput } from "../lib/clients.js";
import { localPack, localProfile, localReviews, REVIEW_SORTS } from "../local-seo.js";
import { handler, READ_ONLY } from "./util.js";

/**
 * Local SEO (Phase 12 C4): Google Business Profile, map-pack positions and reviews from DataForSEO Business
 * Data and the Google Maps SERP. Paid, DataForSEO only, estimate first; nothing is written to clients.yaml
 * (a place ID is saved only with set_client_profile after the user confirms it).
 */

const clientArg = z
  .string()
  .describe("Client domain (e.g. 'example.com'; URL and www. forms also work) or a clients.yaml slug. See list_clients.");
const estimateArg = z.boolean().optional().describe("Return the estimate and the remaining monthly caps only; no request is made and nothing is charged.");

export function registerLocalTools(server: McpServer) {
  server.registerTool(
    "local_profile",
    {
      title: "Google Business Profile lookup",
      description:
        "Look up a client's Google Business Profile through DataForSEO Business Data (not the Google Business Profile API): name, address, phone, website, categories, rating and review count, " +
        "the star distribution, whether it's claimed, photos and opening hours, plus up to 4 other listings the lookup returned. Searches by the client's name (or `query`) in its area, or by place ID once one is saved. " +
        "It never saves anything: show the user the match and, only if they confirm it's their business, save `matched.placeId` with set_client_profile gbpPlaceId (local_pack and local_reviews then use it). " +
        "Paid: about $0.0054 per lookup, checked against the client's and the global monthly caps first; cached a day. Call with estimateOnly: true first. DataForSEO only.",
      inputSchema: {
        client: clientArg,
        query: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("The business name as it appears on Google Maps. Default: the client's name. Ignored while the client has a saved gbpPlaceId (that listing is looked up instead); clear it with set_client_profile gbpPlaceId \"\" to search by name again."),
        placeId: z.string().max(300).optional().describe("Look up this Google place ID instead of searching by name. Default: the client's saved gbpPlaceId."),
        estimateOnly: estimateArg,
      },
      annotations: READ_ONLY,
    },
    handler("local_profile", async ({ client, query, placeId, estimateOnly }) => localProfile(await resolveClient(client), { query, placeId, estimateOnly })),
  );

  server.registerTool(
    "local_pack",
    {
      title: "Map pack positions",
      description:
        "Where a client's Google Business listing ranks in Google Maps for keywords in its area (DataForSEO Google Maps SERP), with the top 3 businesses for each keyword. " +
        "Default keywords: the first 5 tracked keywords. The client's listing is recognised by its saved gbpPlaceId, else by its website's domain; clientRank is null when it isn't within `depth`. " +
        "Set the client's area (set_client_profile) for a local search; without it the client's whole market is searched. " +
        "Paid: about $0.002 per keyword, the whole call checked against the client's and the global monthly caps before the first request; cached a day per keyword. Call with estimateOnly: true first. DataForSEO only.",
      inputSchema: {
        client: clientArg,
        keywords: z.array(keywordInput).min(1).max(10).optional().describe("Keywords to check, up to 10. Default: the first 5 tracked keywords."),
        depth: z.number().int().min(10).max(100).optional().describe("Map results to read per keyword, 10 to 100. Default 20 (billed per 100)."),
        estimateOnly: estimateArg,
      },
      annotations: READ_ONLY,
    },
    handler("local_pack", async ({ client, keywords, depth, estimateOnly }) => localPack(await resolveClient(client), { keywords, depth, estimateOnly })),
  );

  server.registerTool(
    "local_reviews",
    {
      title: "Google reviews summary",
      description:
        "A client's Google reviews through DataForSEO Business Data: the overall rating and count, the star distribution of the reviews fetched, and each review's rating, date, text and whether the owner replied. " +
        "Reviewer names, profiles and photos are never returned. Needs the client's confirmed gbpPlaceId (run local_profile and save it with set_client_profile first), so it never reads another business's reviews. " +
        "Reviews are a queued task: this waits up to 75 seconds; if DataForSEO isn't done it returns { pending: true, taskId }, and calling again with that taskId reads it at no extra cost. " +
        "Paid: $0.0015 per 10 reviews (priority queue), checked against the client's and the global monthly caps first; cached a day. Call with estimateOnly: true first. DataForSEO only.",
      inputSchema: {
        client: clientArg,
        depth: z.number().int().min(10).max(100).optional().describe("Reviews to fetch, 10 to 100. Default 20 (billed per 10)."),
        sortBy: z.enum(REVIEW_SORTS).optional().describe('Default "newest".'),
        taskId: z.string().max(64).optional().describe("The taskId of a pending result from an earlier local_reviews call; reads it without a new charge."),
        estimateOnly: estimateArg,
      },
      annotations: READ_ONLY,
    },
    handler("local_reviews", async ({ client, depth, sortBy, taskId, estimateOnly }) => localReviews(await resolveClient(client), { depth, sortBy, taskId, estimateOnly }), { timeoutMs: 150_000 }),
  );
}
