# DataForSEO fixtures

These are scrubbed recordings of real DataForSEO **sandbox** responses (`https://sandbox.dataforseo.com/v3`), captured with `npx tsx scripts/record-fixtures.ts <dir>` using the same request bodies the providers send. Structure and field names are exactly as returned.

Scrubbing applied: real domains, brands, page titles and text replaced with `example.com`-style placeholders; IP addresses replaced with `192.0.2.1`; task IDs and all `cost` fields removed; `items` trimmed to at most 5 recorded entries. Note the sandbox returns canned data regardless of the requested target.

Hand-added edge cases (not part of the recordings), so the mapper tests cover them:

- ranked keywords: items whose keyword starts with `edge case` (null volume and traffic, missing `serp_item`, a `paid` item that must be excluded)
- competitors: `edge-case-null-metrics.example` (null `metrics.organic`) and an item with no `domain`
- instant pages: `checks.flash` and `checks.has_micromarkup_errors` set to `true`
- backlinks: `info.server` and `info.cms` set to a generic value / null

To refresh, re-run the recorder (sandbox only; it refuses any other base URL), scrub, and re-apply the edge cases.

| File | Endpoint |
|---|---|
| `dataforseo_labs_google_ranked_keywords_live.json` | `/dataforseo_labs/google/ranked_keywords/live` |
| `dataforseo_labs_google_competitors_domain_live.json` | `/dataforseo_labs/google/competitors_domain/live` |
| `backlinks_summary_live.json` | `/backlinks/summary/live` |
| `on_page_instant_pages.json` | `/on_page/instant_pages` |
