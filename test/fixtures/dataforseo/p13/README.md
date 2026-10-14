# DataForSEO fixtures for Phase 13 B

Hand-built from the response examples in DataForSEO's documentation (research note D1-D5, accessed 2026-10-13), not recordings: field names and nesting follow the docs; values are invented for example.com and its placeholder competitors. Costs are the docs' sample costs.

| File | Endpoint |
|---|---|
| `domain_rank_overview_live.json` | `POST /v3/dataforseo_labs/google/domain_rank_overview/live` |
| `historical_rank_overview_live.json` | `POST /v3/dataforseo_labs/google/historical_rank_overview/live` |
| `backlinks_history_live.json` | `POST /v3/backlinks/history/live` |
| `competitors_domain_live.json` | `POST /v3/dataforseo_labs/google/competitors_domain/live` (lists the target itself first, as DataForSEO does; one domain carries a bidi control escape) |
