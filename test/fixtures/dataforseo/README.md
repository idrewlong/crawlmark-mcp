# DataForSEO fixtures

These are scrubbed recordings of real DataForSEO **sandbox** responses (`https://sandbox.dataforseo.com/v3`), captured with `npx tsx scripts/record-fixtures.ts <dir> [only]` using the same request bodies the providers send. Structure and field names are exactly as returned.

Scrubbing applied: real domains, brands, page titles and text replaced with `example.com`-style placeholders; IP addresses replaced with `192.0.2.1`; task IDs and all `cost` fields removed; `items` trimmed to at most 5 recorded entries. Note the sandbox returns canned data regardless of the requested target.

Hand-added edge cases (not part of the recordings), so the mapper tests cover them:

- ranked keywords: items whose keyword starts with `edge case` (null volume and traffic, missing `serp_item`, a `paid` item that must be excluded)
- competitors: `edge-case-null-metrics.example` (null `metrics.organic`) and an item with no `domain`
- instant pages: `checks.flash` and `checks.has_micromarkup_errors` set to `true`
- backlinks: `info.server` and `info.cms` set to a generic value / null
- SERP: a leading `local_pack` item (must be dropped) and a trailing organic item with no `domain`. The recording's real result domains were replaced with `competitor-*.example`, `directory.example` and `social.example`, keeping one domain twice (positions 1 and 6) and mixing `www.` and bare hosts so the merge tests cover both

To refresh, re-run the recorder (sandbox only; it refuses any other base URL), scrub, and re-apply the edge cases.

- user data: `appendix_user_data.json` is the real response's structure trimmed by hand (the `rates`, `money.limits` and `money.statistics` trees cut down to a few keys), with the login replaced by `login@example.com` and the money values replaced by round placeholders (the sandbox returns canned, meaningless balances)

| File | Endpoint |
|---|---|
| `dataforseo_labs_google_ranked_keywords_live.json` | `/dataforseo_labs/google/ranked_keywords/live` |
| `dataforseo_labs_google_competitors_domain_live.json` | `/dataforseo_labs/google/competitors_domain/live` |
| `backlinks_summary_live.json` | `/backlinks/summary/live` |
| `on_page_instant_pages.json` | `/on_page/instant_pages` |
| `serp_google_organic_live_regular.json` | `/serp/google/organic/live/regular` (with `location_name`, depth 20) |
| `appendix_user_data.json` | `/appendix/user_data` (GET) |
