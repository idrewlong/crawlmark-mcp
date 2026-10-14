# Ahrefs API terms on storing data locally

Date: 2026-10-13 · Author: my-skills:researcher · Requested for: Phase 13 Stage B (snapshot retention for Ahrefs). Official sources only, accessed 2026-10-13. Quotes came through a summarising fetch tool; re-read clauses on the live page before quoting them to users. Not legal advice.

## Answer

- **No published time limit** on storing or caching Ahrefs API data for a customer using their own API key. Semrush's one-month rule has no Ahrefs equivalent. Confidence: medium-high that none is published; Enterprise customers have separate contracts (Terms 1.3).
- **Explicit storage rules exist only in the Ahrefs Connect developer terms** (partner programme for publicly available third-party apps; new integrations need an Enterprise plan). They require caching "only for as long as necessary", purging caches on revocation, and forbid "shadow databases" and reconstructing datasets. They read as binding Connect developers, not a local tool using the customer's own key, but they signal Ahrefs' intent.
- **Main risk is the general Terms of Service:** licence "solely for the purposes of your internal business operations" (12.4); no "publishing, or exploiting for any commercial purposes, any portion of Ahrefs Services ... without our express written consent" (12.7(a)); no competing product (4.4(l)); automated access is allowed through the API (4.4(j)). Showing Ahrefs numbers to a consultant's own clients is neither expressly allowed nor forbidden; no agency or white-label clause exists. Attribution: generic "attribute such proprietary rights in any publication or distribution, where applicable" (12.2) and don't remove proprietary notices (12.7(b)).
- **MCP:** Ahrefs' hosted MCP endpoint must not be used via custom scripts or bridges; the REST API v3 is the sanctioned programmatic route.

## Decision for crawlmark (Phase 13 Stage B)

1. No 31-day cap for Ahrefs (that rule is Semrush-specific).
2. Store only small derived aggregates (counts per site, metric and date) — never raw rows such as referring-domain lists, keyword lists or competitor row dumps. Hard design rule.
3. Retain Ahrefs aggregates up to 25 months (enough for year-over-year); user-configurable purge; delete stored Ahrefs rows when the Ahrefs key is removed or a client is removed.
4. Data stays local to the user's machine and database; never pooled or sent to a crawlmark-run service. Re-assess if crawlmark ever becomes hosted or multi-user.
5. Reports show a "Source: Ahrefs" line (likewise for other vendors), kept even in white-label mode, and present counts as summary indicators.
6. Use REST API v3 only; never call Ahrefs' hosted MCP endpoint.
7. Docs tell users to confirm their own Ahrefs plan permits sharing Ahrefs-derived metrics with clients.

What would change this: a written Ahrefs retention cap, an explicit client-reporting prohibition, or an Enterprise contract term — then fall back to fetch-live-only for the affected feature.

## Sources

- Ahrefs Terms of Service: https://ahrefs.com/legal/terms (last modified 2026-09-14)
- Ahrefs Connect Terms of Service: https://docs.ahrefs.com/ahrefs-connect/docs/terms-of-service.md
- Ahrefs docs index: https://docs.ahrefs.com/llms.txt
- API introduction: https://docs.ahrefs.com/api/docs/introduction.md
- API limits and consumption: https://docs.ahrefs.com/api/docs/limits-consumption.md
- MCP introduction: https://docs.ahrefs.com/mcp/docs/introduction.md
- MCP tool categories: https://docs.ahrefs.com/mcp/docs/tool-categories.md

## Not confirmed

- Any numeric storage limit for API-key users; whether Connect rules apply to a self-hosted tool using the customer's own key; whether client reporting counts as "internal business operations"; any required attribution wording beyond 12.2; Enterprise contract terms; treatment of API data passed to an AI assistant. A written answer from Ahrefs support or sales would settle these.
