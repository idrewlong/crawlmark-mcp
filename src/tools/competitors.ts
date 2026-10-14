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
import { ENTRY_SOURCES, isPlainDomain, keywordInput, normalizeHost } from "../lib/clients.js";
import { gapCompetitors, keywordGap, keywordIdeas } from "../providers/seo-data.js";
import { handler, READ_ONLY } from "./util.js";

/**
 * Competitor and tracked-keyword management plus competitor suggestions.
 * The list and profile tools are free and local: they edit clients.yaml
 * (comments and other entries are kept). suggest_competitors, keyword_ideas and
 * keyword_gap are paid and read-only.
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
    handler("add_competitors", ({ client, domains, note, source }) => addCompetitors(client, domains, { note, source })),
  );

  server.registerTool(
    "remove_competitors",
    {
      title: "Remove competitors",
      description: "Remove competitor domains (any URL or www. form) from a client in clients.yaml. Free, local.",
      inputSchema: { client: clientArg, domains: z.array(z.string()).min(1).max(100) },
      annotations: REMOVE,
    },
    handler("remove_competitors", ({ client, domains }) => removeCompetitors(client, domains)),
  );

  server.registerTool(
    "list_competitors",
    {
      title: "List competitors",
      description: "A client's competitors from clients.yaml, with any note, source (manual or suggested) and date added, plus its area and niche. Free, local.",
      inputSchema: { client: clientArg },
      annotations: LIST,
    },
    handler("list_competitors", async ({ client }) => {
      const c = await resolveClient(client);
      return { client: c.domain, area: c.area ?? null, niche: c.niche ?? null, brandTerms: c.brandTerms, count: c.competitorEntries.length, competitors: c.competitorEntries };
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
      inputSchema: { client: clientArg, keywords: z.array(keywordInput).min(1).max(200), note: noteArg, source: sourceArg },
      annotations: ADD,
    },
    handler("add_keywords", ({ client, keywords, note, source }) => addKeywords(client, keywords, { note, source })),
  );

  server.registerTool(
    "remove_keywords",
    {
      title: "Remove tracked keywords",
      description: "Remove tracked keywords from a client in clients.yaml (matched ignoring case and extra spaces). Free, local.",
      inputSchema: { client: clientArg, keywords: z.array(keywordInput).min(1).max(200) },
      annotations: REMOVE,
    },
    handler("remove_keywords", ({ client, keywords }) => removeKeywords(client, keywords)),
  );

  server.registerTool(
    "list_keywords",
    {
      title: "List tracked keywords",
      description: "A client's tracked keywords from clients.yaml, with any note, source and date added. Free, local.",
      inputSchema: { client: clientArg },
      annotations: LIST,
    },
    handler("list_keywords", async ({ client }) => {
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
        "Set a client's area, niche, display name or brand terms in clients.yaml. brandTerms are names people search for the brand (e.g. [\"example plumbing\", \"ex plumbing\"]); they add to the built-in domain and name matching used to split branded from non-branded queries, and the list you pass replaces the stored one ([] clears it). area is a DataForSEO location_name (City,Region,Country, " +
        'e.g. "Austin,Texas,United States") used for local SERP searches; niche is a few words on what the client does ' +
        '(e.g. "emergency plumber"). dataProvider overrides the default SEO data provider for this client; it chooses whose paid data is used, not credentials. ' +
        'country is the ISO two-letter market Ahrefs and Semrush use (e.g. "US", "GB"). bingSite pins the Bing Webmaster Tools site bing_report reads (e.g. "https://www.example.com/"; it must be on the client\'s domain or a subdomain); unset, the domain is matched against your Bing key\'s verified sites. ' +
        "gbpPlaceId saves the client's Google Business Profile place ID (matched.placeId from local_profile) for local_profile, local_pack and local_reviews: set it only after the user has confirmed that local_profile found their business (it must be a place ID local_profile returned for this client in the last day). " +
        'Pass an empty string to clear a field. Free, local.',
      inputSchema: {
        client: clientArg,
        area: z.string().max(200).optional(),
        niche: z.string().max(200).optional(),
        name: z.string().max(200).optional(),
        brandTerms: z.array(z.string().max(100)).max(50).optional().describe("Replaces the client's brand terms; an empty array clears them."),
        dataProvider: z
          .enum(["dataforseo", "ahrefs", "semrush", ""])
          .optional()
          .describe('Whose paid keyword, ranking, competitor and backlink data this client uses; "" clears the override (back to the default provider).'),
        country: z
          .string()
          .regex(/^([A-Za-z]{2})?$/)
          .optional()
          .describe('ISO 3166-1 alpha-2 market for Ahrefs/Semrush, stored uppercase (e.g. "US", "GB"); "" clears it.'),
        bingSite: z
          .string()
          .max(500)
          .optional()
          .describe('The Bing Webmaster Tools site URL for bing_report, as Bing lists it (e.g. "https://www.example.com/"); "" clears it (match by domain).'),
        gbpPlaceId: z
          .string()
          .max(300)
          .optional()
          .describe('The Google place ID local_profile returned (matched.placeId), saved only after the user confirms it is their business; "" clears it.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    // Site Audit project IDs are set in a terminal only (crawlmark-cli clients set, SEC-1), never through chat.
    handler("set_client_profile", ({ client, area, niche, name, brandTerms, dataProvider, country, bingSite, gbpPlaceId }) =>
      setClientProfile(client, { area, niche, name, brandTerms, dataProvider, country, bingSite, gbpPlaceId }),
    ),
  );

  // ------------------------------------------------------------ suggestions (paid, read-only)

  server.registerTool(
    "suggest_competitors",
    {
      title: "Suggest competitors",
      description:
        "Suggest likely competitors for a client from two sources: organic keyword overlap from the client's data provider (DataForSEO, Ahrefs or Semrush), and live Google results from DataForSEO " +
        "for up to 5 seed keywords (seeds you pass, the niche, tracked keywords, then top non-branded Search Console queries that relate to them) in the client's area " +
        "(or its market when no area is set). Pass `seeds`: 3-5 non-branded service keywords (from the niche and homepage, confirmed with the user), since the client's own ranked keywords are mostly branded. Excludes the client's own site, current competitors, ignored domains and big platforms " +
        "(social, directories, business-data sites, marketplaces, encyclopedias, .gov/.edu) and brand lookalikes (domains starting with the client's brand initialism or name). Returns ranked candidates with evidence, costUsd and fromCache. " +
        "Paid (cached; costUsd for DataForSEO, `units` for Ahrefs/Semrush; without DataForSEO the SERP source is skipped with a note). Read-only: this never saves anything. Show the candidates and their evidence to the user, ask which " +
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
    handler("suggest_competitors", ({ client, area, niche, seeds, limit }) => suggestCompetitors(client, { area, niche, seeds, limit })),
  );

  // ------------------------------------------------ keyword ideas and gap (paid, read-only; Phase 12 B)

  const ESTIMATE_FIRST =
    "Paid through the client's data provider (DataForSEO in USD, Ahrefs or Semrush in API units), checked against the client's and the global monthly caps for the whole call before the first request. " +
    "Call with estimateOnly: true first, tell the user the provider, the cost and what's left, and run it only after they agree; when the estimate doesn't fit, the message names a limit that does. Cached 7 days.";

  server.registerTool(
    "keyword_ideas",
    {
      title: "Keyword ideas",
      description:
        "Keyword ideas from seed keywords in the client's market: `related` (searches related to the seeds) or `matching` (keywords containing a seed). " +
        "Each idea has volume, CPC, competition (0-1; null for Ahrefs), difficulty labelled by provider (dataforseo_kd, ahrefs_kd or semrush_kd: different 0-100 scales, never compare them), intent (DataForSEO only) and the seed. " +
        ESTIMATE_FIRST,
      inputSchema: {
        client: clientArg,
        seeds: z.array(keywordInput).min(1).max(20).describe("1-20 seed keywords, e.g. the services the client sells (never just the brand name)."),
        mode: z.enum(["related", "matching"]).optional().describe('Default "related".'),
        limit: z.number().int().min(1).max(200).optional().describe("Ideas in total (default 50)."),
        estimateOnly: z.boolean().optional().describe("Return the estimate and the remaining cap only; no request."),
      },
      annotations: READ_ONLY,
    },
    handler("keyword_ideas", async ({ client, seeds, mode, limit, estimateOnly }) =>
      keywordIdeas(await resolveClient(client), { seeds, mode: mode ?? "related", limit: limit ?? 50 }, { estimateOnly }),
    ),
  );

  server.registerTool(
    "keyword_gap",
    {
      title: "Competitor keyword gap",
      description:
        "Keywords the client's competitors rank for and the client doesn't, sorted by volume and de-duplicated across competitors (each with the competitors' positions and URLs). " +
        "Competitors default to the client's saved ones (the first 3); with none saved, use suggest_competitors first. With Ahrefs, \"the client already ranks\" is decided from the client's own Search Console data (free; clientCheck: gsc) when it has a property. " +
        "Difficulty is labelled by provider (never compare scales). " +
        ESTIMATE_FIRST,
      inputSchema: {
        client: clientArg,
        competitors: z.array(z.string().min(1).max(253)).min(1).max(5).optional().describe("Competitor domains. Default: the client's saved competitors (at most 3)."),
        limit: z.number().int().min(1).max(500).optional().describe("Keywords per competitor (default 50)."),
        minVolume: z.number().int().min(0).optional().describe("Drop keywords below this monthly volume (default 0)."),
        estimateOnly: z.boolean().optional().describe("Return the estimate and the remaining cap only; no request."),
      },
      annotations: READ_ONLY,
    },
    handler("keyword_gap", async ({ client, competitors, limit, minVolume, estimateOnly }) => {
      const c = await resolveClient(client);
      return keywordGap(c, { competitors: gapCompetitors(c, competitors), limit: limit ?? 50, minVolume: minVolume ?? 0 }, { estimateOnly });
    }),
  );

  // ------------------------------------------------ Phase 13 B: provider visibility, competitors and stored trends

  const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
  const SNAPSHOTS =
    "Results are stored as dated snapshots (counts only) so later reports can compare months; a stored snapshot from the last 7 days (SNAPSHOT_REUSE_DAYS) is reused instead of calling the provider, unless refresh: true. " +
    "Through the client's data provider only (no fallback to another provider). Call with estimateOnly: true first, state the provider, cost and what's left, and run it only after the user agrees.";

  server.registerTool(
    "organic_visibility",
    {
      title: "Organic visibility",
      description:
        "A domain's organic search visibility from the client's data provider: ranking keywords (top 100), keywords by position band (top 3, 4-10, 11-20, 21-100; not available from Semrush) and estimated organic traffic, labelled by provider (never compare traffic across providers). " +
        "Comparisons with a month and a year ago appear only when stored snapshots (or, with history: true, the provider's own history, paid) have them. " +
        SNAPSHOTS,
      inputSchema: {
        client: clientArg,
        history: z.boolean().optional().describe("Buy the provider's monthly history when no stored snapshot covers the comparisons or the trend (paid; default false)."),
        months: z.number().int().min(1).max(24).optional().describe("Trend months (default 12)."),
        refresh: z.boolean().optional().describe("Fetch today's figures even when a stored snapshot would do."),
        estimateOnly: z.boolean().optional().describe("Return the estimate and the remaining cap only; no request."),
      },
      annotations: LOCAL_WRITE,
    },
    handler("organic_visibility", async ({ client, history, months, refresh, estimateOnly }) => {
      const ps = await import("../reports/provider-sections.js");
      return ps.providerTool(await resolveClient(client), { type: "organic_visibility", history, trendMonths: months, refresh }, { estimateOnly }, await ps.loadProviderSectionDeps(), await ps.loadSpendDeps());
    }),
  );

  server.registerTool(
    "competitor_overview",
    {
      title: "Competitor overview",
      description:
        "The client's top organic competitors from its data provider: saved competitors first (in saved order), then the provider's suggestions (big platforms and denylisted domains left out), each with keywords shared with the client, its ranking keywords and estimated traffic. " +
        "A saved competitor the provider doesn't list is looked up on its own (shared keywords unknown). " +
        SNAPSHOTS,
      inputSchema: {
        client: clientArg,
        limit: z.number().int().min(1).max(10).optional().describe("Competitors listed (default 5)."),
        source: z.enum(["saved", "suggested", "saved_then_suggested"]).optional().describe('Default "saved_then_suggested".'),
        refresh: z.boolean().optional().describe("Fetch today's figures even when stored snapshots would do."),
        estimateOnly: z.boolean().optional().describe("Return the estimate and the remaining cap only; no request."),
      },
      annotations: LOCAL_WRITE,
    },
    handler("competitor_overview", async ({ client, limit, source, refresh, estimateOnly }) => {
      const ps = await import("../reports/provider-sections.js");
      return ps.providerTool(await resolveClient(client), { type: "competitor_overview", limit, source, refresh }, { estimateOnly }, await ps.loadProviderSectionDeps(), await ps.loadSpendDeps());
    }),
  );

  server.registerTool(
    "seo_trends",
    {
      title: "Stored SEO trends",
      description:
        "Stored backlinks or visibility snapshots for a client (or a competitor's domain) over time, one series per provider and market (they're never mixed). " +
        "Snapshots come from the backlinks, organic_visibility and competitor_overview report sections and tools, backlinks_summary on the client's own domain, and crawlmark-cli seo-snapshot. Free and local: no provider request.",
      inputSchema: {
        client: clientArg,
        kind: z.enum(["backlinks", "visibility"]),
        target: z.string().max(253).optional().describe("A domain (default: the client's own; competitors' visibility is stored too)."),
        months: z.number().int().min(1).max(24).optional().describe("Months back (default 12)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("seo_trends", async ({ client, kind, target, months }) => {
      const ps = await import("../reports/provider-sections.js");
      const t = target === undefined ? undefined : normalizeHost(target);
      if (target !== undefined && (!t || !isPlainDomain(t))) throw new Error(`"${target.slice(0, 100)}" isn't a domain.`);
      return ps.seoTrends(await resolveClient(client), kind, t, months ?? 12);
    }),
  );
}
