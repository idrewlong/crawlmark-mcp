import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addCompetitors,
  addKeywords,
  removeCompetitors,
  removeKeywords,
  resolveClient,
  setClientProfile,
} from "../clients.js";
import { suggestCompetitors } from "../competitors.js";
import { ENTRY_SOURCES } from "../lib/clients.js";
import { handler, READ_ONLY } from "./util.js";

/**
 * Competitor and tracked-keyword management plus competitor suggestions.
 * The list and profile tools are free and local: they edit clients.yaml
 * (comments and other entries are kept). suggest_competitors is paid and read-only.
 */

const clientArg = z
  .string()
  .describe("Client domain, e.g. 'example.com' (URL and www. forms also work), or a clients.yaml slug. Use list_clients to see options.");

const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const REMOVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
const LIST = { readOnlyHint: true, openWorldHint: false } as const;

const noteArg = z.string().max(500).optional().describe("Optional note saved with each new entry, e.g. why it was added.");
const sourceArg = z
  .enum(ENTRY_SOURCES)
  .optional()
  .describe('"manual" (default) when the user named them; "suggested" when they came from suggest_competitors and the user confirmed.');

export function registerCompetitorTools(server: McpServer) {
  // ------------------------------------------------------------ competitors

  server.registerTool(
    "add_competitors",
    {
      title: "Add competitors",
      description:
        "Add competitor domains to a client in clients.yaml. Accepts bare domains, www. forms or full URLs (saved as the bare domain). " +
        "Skips, with a reason, the client's own domain (and its subdomains), domains already listed, repeats and non-domains. " +
        "Returns what was added, what was skipped and the full list. Free, local.",
      inputSchema: {
        client: clientArg,
        domains: z.array(z.string()).min(1).max(100),
        note: noteArg,
        source: sourceArg,
      },
      annotations: ADD,
    },
    handler(({ client, domains, note, source }) => addCompetitors(client, domains, { note, source })),
  );

  server.registerTool(
    "remove_competitors",
    {
      title: "Remove competitors",
      description: "Remove competitor domains (any URL or www. form) from a client in clients.yaml. Free, local.",
      inputSchema: { client: clientArg, domains: z.array(z.string()).min(1).max(100) },
      annotations: REMOVE,
    },
    handler(({ client, domains }) => removeCompetitors(client, domains)),
  );

  server.registerTool(
    "list_competitors",
    {
      title: "List competitors",
      description: "A client's competitors from clients.yaml, with any note, source (manual or suggested) and date added, plus its area and niche. Free, local.",
      inputSchema: { client: clientArg },
      annotations: LIST,
    },
    handler(async ({ client }) => {
      const c = await resolveClient(client);
      return { client: c.domain, area: c.area ?? null, niche: c.niche ?? null, count: c.competitorEntries.length, competitors: c.competitorEntries };
    }),
  );

  // ------------------------------------------------------------ keywords

  server.registerTool(
    "add_keywords",
    {
      title: "Add tracked keywords",
      description:
        "Add tracked keywords to a client in clients.yaml (saved lowercase with single spaces). Skips, with a reason, keywords already tracked, " +
        "repeats and empty ones. monthly_report reports their positions. Free, local.",
      inputSchema: { client: clientArg, keywords: z.array(z.string()).min(1).max(200), note: noteArg, source: sourceArg },
      annotations: ADD,
    },
    handler(({ client, keywords, note, source }) => addKeywords(client, keywords, { note, source })),
  );

  server.registerTool(
    "remove_keywords",
    {
      title: "Remove tracked keywords",
      description: "Remove tracked keywords from a client in clients.yaml (matched ignoring case and extra spaces). Free, local.",
      inputSchema: { client: clientArg, keywords: z.array(z.string()).min(1).max(200) },
      annotations: REMOVE,
    },
    handler(({ client, keywords }) => removeKeywords(client, keywords)),
  );

  server.registerTool(
    "list_keywords",
    {
      title: "List tracked keywords",
      description: "A client's tracked keywords from clients.yaml, with any note, source and date added. Free, local.",
      inputSchema: { client: clientArg },
      annotations: LIST,
    },
    handler(async ({ client }) => {
      const c = await resolveClient(client);
      return { client: c.domain, count: c.keywordEntries.length, keywords: c.keywordEntries };
    }),
  );

  // ------------------------------------------------------------ profile

  server.registerTool(
    "set_client_profile",
    {
      title: "Set client profile",
      description:
        "Set a client's area, niche or display name in clients.yaml. area is a DataForSEO location_name (City,Region,Country, " +
        'e.g. "Austin,Texas,United States") used for local SERP searches; niche is a few words on what the client does ' +
        '(e.g. "emergency plumber"). Pass an empty string to clear a field. Free, local.',
      inputSchema: {
        client: clientArg,
        area: z.string().max(200).optional(),
        niche: z.string().max(200).optional(),
        name: z.string().max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler(({ client, area, niche, name }) => setClientProfile(client, { area, niche, name })),
  );

  // ------------------------------------------------------------ suggestions (paid, read-only)

  server.registerTool(
    "suggest_competitors",
    {
      title: "Suggest competitors",
      description:
        "Suggest likely competitors for a client from two sources: DataForSEO organic keyword overlap, and live Google results " +
        "for up to 5 seed keywords (seeds you pass, the niche, tracked keywords, then top non-branded Search Console queries that relate to them) in the client's area " +
        "(or its market when no area is set). Pass `seeds`: 3-5 non-branded service keywords (from the niche and homepage, confirmed with the user), since the client's own ranked keywords are mostly branded. Excludes the client's own site, current competitors, ignored domains and big platforms " +
        "(social, directories, business-data sites, marketplaces, encyclopedias, .gov/.edu) and brand lookalikes (domains starting with the client's brand initialism or name). Returns ranked candidates with evidence, costUsd and fromCache. " +
        "Paid (DataForSEO; cached). Read-only: this never saves anything. Show the candidates and their evidence to the user, ask which " +
        'to add, and only after they confirm call add_competitors with those domains and source: "suggested".',
      inputSchema: {
        client: clientArg,
        area: z.string().max(200).optional().describe('DataForSEO location_name for this search only, e.g. "Austin,Texas,United States". Defaults to the client\'s area.'),
        niche: z.string().max(200).optional().describe("What the client does, for this search only. Defaults to the client's niche."),
        seeds: z.array(z.string().min(1).max(100)).max(5).optional().describe("3-5 non-branded service keywords to search first (e.g. 'modular home installation'). Never the client's brand name. For this search only."),
        limit: z.number().int().min(1).max(50).optional().describe("Candidates to return (default 10)."),
      },
      annotations: READ_ONLY,
    },
    handler(({ client, area, niche, seeds, limit }) => suggestCompetitors(client, { area, niche, seeds, limit })),
  );
}
