# Semrush fixtures

Copied from the documented examples in Semrush's v4 API docs (https://developer.semrush.com/api/v4/, accessed
2026-10-15). No real API call was made. Real domains and keywords are replaced with `example.com` / `seo tools`.

| File | Source |
|---|---|
| `v4-keyword-metrics.json` | the documented v4 Get Keyword Metrics response (Early Access; `search_volume` and `cpc` are strings) |
| `v4-backlinks-overview.json` | the documented v4 backlinks overview response (excerpt) |
| `v4-error-403.json` | the documented v4 JSON error body |

crawlmark uses Semrush's v4 API only; the older v3 reports, balance check and Projects API aren't supported.
