# Ahrefs API v3 fixtures

Built by hand from the documented response schemas in `docs/research/ahrefs-api-v3.md`
(Ahrefs' OpenAPI spec, accessed 2026-10-13). No real API call was made to produce them.
Field names and nesting follow the schemas exactly; the values are invented, and every domain
is `example.com`, `example.org` or `example.net`.

| File | Endpoint | Notes |
|---|---|---|
| `limits-and-usage.json` | `GET /v3/subscription-info/limits-and-usage` | the note's example object |
| `organic-keywords.json` | `GET /v3/site-explorer/organic-keywords` | plus an all-null row and a row with no keyword (dropped) |
| `organic-competitors.json` | `GET /v3/site-explorer/organic-competitors` | plus a null `traffic` and a null `competitor_domain` (dropped) |
| `backlinks-stats.json` | `GET /v3/site-explorer/backlinks-stats` | the note's example |
| `domain-rating.json` | `GET /v3/site-explorer/domain-rating` | |
| `keywords-overview.json` | `GET /v3/keywords-explorer/overview` | `cpc` is USD cents; one null `cpc` |
| `error-401.json`, `error-400.json` | any endpoint | the documented `{ "error": string }` shape; the strings are invented (exact wording is "Not confirmed" N1) |

Task 10 (live verification against Ahrefs' free test targets) compares these with real responses.
