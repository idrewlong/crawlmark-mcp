import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { suggestBrandTerms } from "../brand-terms.js";
import { addBrandTerms, removeBrandTerms } from "../clients.js";
import { BRAND_TERM_SOURCES } from "../lib/clients.js";
import { handler } from "./util.js";

/**
 * Brand-term tools. add_/remove_brand_terms are free and local (they edit
 * clients.yaml); suggest_brand_terms reads Search Console (free) and, as a
 * fallback, DataForSEO (paid), and writes only with apply: true.
 */

const clientArg = z
  .string()
  .describe("Client domain, e.g. 'example.com' (URL and www. forms also work), or a clients.yaml slug. Use list_clients to see options.");

const termsArg = z.array(z.string().max(100)).min(1).max(50);

export function registerBrandTools(server: McpServer) {
  server.registerTool(
    "add_brand_terms",
    {
      title: "Add brand terms",
      description:
        "Add brand terms to one client in clients.yaml: names people search for that client (e.g. \"bella forn\", \"bella forno pizza\"). " +
        "They add to the built-in domain and name matching that splits branded from non-branded queries, and apply only to this client. " +
        "Skips, with a reason, terms already listed (ignoring case, spacing and punctuation), repeats and unusable ones. Free, local.",
      inputSchema: {
        client: clientArg,
        terms: termsArg,
        source: z
          .enum(BRAND_TERM_SOURCES)
          .optional()
          .describe('"manual" (default) when the user named them; "suggested" when they came from suggest_brand_terms and the user confirmed.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler("add_brand_terms", ({ client, terms, source }) => addBrandTerms(client, terms, { source })),
  );

  server.registerTool(
    "remove_brand_terms",
    {
      title: "Remove brand terms",
      description: "Remove brand terms from a client in clients.yaml (matched ignoring case, spacing and punctuation), including ones added automatically. Free, local.",
      inputSchema: { client: clientArg, terms: termsArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler("remove_brand_terms", ({ client, terms }) => removeBrandTerms(client, terms)),
  );

  server.registerTool(
    "suggest_brand_terms",
    {
      title: "Suggest brand terms",
      description:
        "Infer how people search for a client by name, from that client's own queries: Search Console for the last 90 days (free). " +
        "Only when the client has no Search Console property (or Google isn't set up) does it fall back to DataForSEO ranked keywords for its domain (paid, about $0.02, cached 7 days). " +
        "If Search Console returns fewer than 20 rows it does not spend money unless you pass allowPaid: true (ask the user first); a Search Console error is reported, never retried on the paid source. " +
        "Scores 1-3 word phrases its current brand matching misses on name similarity to the domain and name, navigational behaviour (top position with CTR far above the curve; Search Console only) " +
        "and concentration across queries. Never proposes another client's brand (excluded with reason other-client-brand). " +
        "Returns candidates with confidence (high/medium/low), score, evidence and source, the top non-branded queries no candidate covers, costUsd and fromCache. " +
        "Each candidate has autoQualified and reviewReason: only candidates whose words match the distinctive part of the client's name (not trade words, places or company suffixes) are ever saved automatically. " +
        "Read-only unless apply: true, which saves the auto-qualified candidates at or above minConfidence (default high) with source auto-gsc or auto-dataforseo. " +
        "Then review every candidate with a reviewReason (e.g. needs-review: generic-name-match) and the remaining queries: show them to the user, and only for the ones they confirm call " +
        'add_brand_terms with source: "suggested". Undo any term with remove_brand_terms.',
      inputSchema: {
        client: clientArg,
        apply: z.boolean().optional().describe("Save candidates at or above minConfidence. Default false (read-only)."),
        minConfidence: z.enum(["high", "medium"]).optional().describe('Lowest confidence saved with apply (default "high").'),
        allowPaid: z
          .boolean()
          .optional()
          .describe(
            "Paid DataForSEO fallback, about $0.02 per client (cached 7 days). Unset: used only when the client has no Search Console property. " +
              "true: also when Search Console has fewer than 20 query rows (ask the user before passing this). false: never.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler("suggest_brand_terms", ({ client, apply, minConfidence, allowPaid }) => suggestBrandTerms(client, { apply, minConfidence, allowPaid })),
  );
}
