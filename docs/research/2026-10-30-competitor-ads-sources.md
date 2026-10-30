# Which data sources could power a `competitor_ads` tool (US local/service businesses)?
Date: 2026-10-30 · Author: my-skills:researcher · Requested by: orchestrator · Status: partial (Meta access requirements, LinkedIn/Google official statements unverified)

## Answer (TL;DR)
Build `competitor_ads` on DataForSEO's Google Ads Search + Google Ads Advertisers SERP APIs (Google Ads Transparency Center data). They are cheap ($0.002 live per 40 ads, $0.0006 standard), use the existing login/password, and have a `location_code` 2840 example. Meta, TikTok and LinkedIn official APIs do not cover US commercial ads (confidence high for Meta/TikTok, medium for LinkedIn). Add DataForSEO Labs `domain_rank_overview` paid metrics (count, ETV, est. paid cost) as an optional "paid footprint" summary. Confidence: medium-high; US commercial coverage of the DataForSEO ads data is implied by examples, not stated by the docs.

## Findings

### 1. DataForSEO
**Google Ads Advertisers** (find advertiser ids by name/keyword)
- `POST https://api.dataforseo.com/v3/serp/google/ads_advertisers/live/advanced` ([docs](https://docs.dataforseo.com/v3/serp/google/ads_advertisers/live/advanced/)).
- Params: `keyword` (required, max 700 chars), one of `location_name` / `location_code` (e.g. 2840) / `location_coordinate`, `priority` (1 default, 2 extra charge), `tag`. No location = all locations.
- Items: `ads_advertiser` (title, advertiser_id, location, verified, approx_ads_count), `ads_multi_account_advertiser` (grouped accounts), `ads_domain` (domain). All have rank_group/rank_absolute.
- Price: Standard $0.0006/task, Priority $0.0012, Live $0.002; paid at task submit, fetching queued results free ([pricing](https://dataforseo.com/pricing/serp/google-ads-advertisers-serp-api)).

**Google Ads Search** (the ads themselves)
- `POST https://api.dataforseo.com/v3/serp/google/ads_search/live/advanced` ([live docs](https://docs.dataforseo.com/v3/serp/google/ads_search/live/advanced/)). Task mode: `/v3/serp/google/ads_search/task_post/`, `/tasks_ready/`, `/task_get/advanced/` ([overview](https://docs.dataforseo.com/v3/serp/google/ads_search/overview/)). The overview text says Standard is the only supported method yet lists the Live path in navigation; the Live page itself documents a working live endpoint (unverified by call; confirm in Sandbox, which is free).
- Params: `target` (domain; required unless `advertiser_ids`), `advertiser_ids` (up to 25), `location_code`/`location_name`/`location_coordinate`, `depth` (default 40, max 120 on the live page; pricing page says max 700 for tasks), `platform` (all, google_play, google_maps, google_search, google_shopping, youtube), `format` (all, text, image, video), `date_from`/`date_to` (yyyy-mm-dd, both required together, range 2018-05-31 to today), `priority`, `tag`.
- Ad item (`ads_search`): `advertiser_id`, `creative_id`, `title`, `url`, `verified`, `format`, `preview_image` (url/height/width), `preview_url`, `first_shown`, `last_shown`, rank fields. Notably NO ad body text beyond `title`, and no per-ad region list in the documented fields (the doc lists none). Creative text/images/video are reachable via `preview_url`/`preview_image` only.
- Price: Standard $0.0006, Priority $0.0012, Live $0.002 per SERP of 40 results; each extra 40 (depth rounded up) adds one base price; location/platform/format/date/advertiser filters free ([pricing](https://dataforseo.com/pricing/serp/google-ads-search-serp-api)).
- Coverage: "based on the Google Ads Transparency platform"; results for `desktop` and `windows` only. Docs do not explicitly say US commercial ads are covered; examples use `location_code` 2840 and `region=US` URLs. Unverified in the strict sense; a Sandbox or one real call confirms.
- Typical cost of "what are competitor X's ads": 1 advertiser lookup ($0.002) + 1 ads search ($0.002 for 40; $0.006 for 120 live) = about $0.004-$0.008 per competitor. Five competitors about $0.02-$0.04.

**Labs paid-search data**
- `POST /v3/dataforseo_labs/google/domain_rank_overview/live` returns `metrics.organic` and `metrics.paid` each with `count`, `etv`, `estimated_paid_traffic_cost`, pos_1..pos_91_100 buckets, is_new/up/down/lost ([docs](https://docs.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live/)).
- `ranked_keywords/live` takes `item_types` (organic, paid, featured_snippet, local_pack, ai_overview_reference; default organic+paid) and returns aggregate paid metrics for the target; the fetched page did not describe item-level paid fields (page truncated at 100k of 215k chars; unverified) ([docs](https://docs.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live/)).
- Price: general Labs rate $0.012 per request + $0.00012 per item; these endpoints are not in the exceptions list ([pricing](https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api)). domain_rank_overview sample cost shows $0.0101 (example only). Crawlmark already has `planRankOverview` (src/providers/dataforseo.ts:483), so paid counts may already be fetchable.

### 2. Meta Ad Library API (`ads_archive`)
- Official reference ([ads_archive](https://developers.facebook.com/docs/graph-api/reference/ads_archive/)): `ad_type` values ALL, EMPLOYMENT_ADS, FINANCIAL_PRODUCTS_AND_SERVICES_ADS, HOUSING_ADS, POLITICAL_AND_ISSUE_ADS. `ad_reached_countries` doc: "Ads that did not reach any location in the EU will only return if they are about social issues, elections or politics." So a US-only commercial ad is not returned with ad_type=ALL. Confirmed from official text; the page does not mention UK rules (secondary sources say EU + UK).
- `bylines`, `delivery_by_region`, audience-size filters are political-only. `search_page_ids` up to 10; `search_terms` max 100 chars; `ad_active_status` defaults to ACTIVE.
- Rate limits: only error 613 mentioned, no numbers.
- Access requirements (identity confirmation, app, token): NOT verifiable; Meta's library API pages returned 403 to fetch and the reference does not state them. Secondary sources only ([metapi.io](https://metapi.io/compare/facebook-ad-library-api)).
- Conclusion: unusable for US local/service competitors (their ads are commercial, US-only), except housing/employment/financial special categories, which are also US-relevant but unverified here.

### 3. Google Ads Transparency Center official API
- No official public API for commercial ads found. Only Google's political ads data is published as a BigQuery public dataset `google_political_ads` ([Google Cloud blog](https://cloud.google.com/blog/topics/developers-practitioners/how-get-started-political-ads-transparency-report-dataset)); political only, so irrelevant. The Transparency Center FAQ fetch returned only navigation text, so "no API" is an absence-of-evidence finding (medium confidence). DataForSEO is the practical route (scrapes/mirrors the Transparency Center).

### 4. TikTok and LinkedIn
- TikTok Commercial Content API: public/researcher access with a TikTok for Developers account (official email) and an application, approval about 2 working days. Currently "we are ONLY including data from EU countries." Paid ads data include published/last seen date, targeting, reach ([TikTok for Developers](https://developers.tiktok.com/products/commercial-content-api/)). Not useful for US.
- LinkedIn: could not reach an official LinkedIn page. Secondary guides say a gated Ad Library API product exists (developer app + review) tied to EU DSA transparency; LinkedIn's separate Advertising API is for managing your own accounts ([Microsoft Learn tiers](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/marketing-tiers)). Unverified; B2B skew makes it low value for local/service anyway.

### 5. Semrush
- The Semrush MCP page ([developer.semrush.com/api/basics/semrush-mcp](https://developer.semrush.com/api/basics/semrush-mcp/)) says `https://mcp.semrush.com/v2/mcp` exposes "all SEO API methods", Trends API methods and read-only Projects v3. The fetch summary inferred paid-search reports (domain paid keywords, ad copies, ad history, paid competitors, PLA) from the SEO API list, but the page did not itself list them: unverified. The MCP uses the same API-unit billing. My attempt to list the connected Semrush toolkit `paid_search_research` was blocked by the permission classifier, though that toolkit name appearing in this session's tool list suggests paid-search research is a toolkit. Not verified.
- API v4 paid-search reports: not verified (the v3 advertising-research doc URL 404'd). Caller's belief stands as unverified.
- Per the brief, crawlmark would not call the MCP; users connect it themselves. A crawlmark note pointing Semrush users to the MCP's paid_search_research for ad copy history is an option.

## Options compared
| Option | Fit | Cost | Risk | Notes |
|---|---|---|---|---|
| DataForSEO ads_advertisers + ads_search | High: existing creds, US local on Google | ~$0.004-0.008 per competitor live; ~$0.001-0.002 standard | Medium: US coverage implied not stated; no ad body text | Covers Search, Maps, Shopping, YouTube, Play |
| DataForSEO Labs paid metrics | Medium: summary only | ~$0.012 + $0.00012/item | Low | Paid kw count, ETV, est. spend; Labs data is estimated |
| Meta ads_archive | Low | Free | High: no US commercial ads; verification needed | Skip |
| TikTok CCAPI | None for US | Free | EU-only | Skip |
| LinkedIn Ad Library | Low | Unknown | Unverified, gated | Skip |
| Google official | None | n/a | No API | BigQuery is political only |
| Semrush MCP/API | Medium for Semrush users | API units | Unverified | User-side only |

## Recommendation
1. Build `competitor_ads` on DataForSEO: step 1 `ads_advertisers` (or skip it if the competitor domain is known and use `target` directly), step 2 `ads_search` with `target`/`advertiser_ids`, `location_code` 2840 (or client market), optional `platform`, `format`, date range. Default to live, depth 40, about $0.002-0.004 per competitor; cache like other paid calls.
2. Optionally enrich with `domain_rank_overview` paid block (count, ETV, estimated_paid_traffic_cost) for a paid-footprint line; reuse existing planRankOverview.
3. Be honest in output: Google only; ads show headline/preview, first/last shown, format; no spend or targeting. Do not promise Meta/TikTok/LinkedIn.
4. Before building: run one Sandbox call (free) or a single live call on a known local advertiser to confirm US commercial coverage and the live-endpoint availability. This would change the recommendation if US local ads are missing.

## Sources
- [DFS Ads Search live](https://docs.dataforseo.com/v3/serp/google/ads_search/live/advanced/) · [Ads Search overview](https://docs.dataforseo.com/v3/serp/google/ads_search/overview/) · [Ads Advertisers live](https://docs.dataforseo.com/v3/serp/google/ads_advertisers/live/advanced/) — accessed 2026-10-30
- [Advertisers pricing](https://dataforseo.com/pricing/serp/google-ads-advertisers-serp-api) · [Ads Search pricing](https://dataforseo.com/pricing/serp/google-ads-search-serp-api) · [Labs pricing](https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api) — accessed 2026-10-30
- [domain_rank_overview](https://docs.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live/) · [ranked_keywords](https://docs.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live/) — accessed 2026-10-30
- [Meta ads_archive reference](https://developers.facebook.com/docs/graph-api/reference/ads_archive/) — accessed 2026-10-30
- [metapi.io Meta comparison (secondary)](https://metapi.io/compare/facebook-ad-library-api) — accessed 2026-10-30
- [TikTok Commercial Content API](https://developers.tiktok.com/products/commercial-content-api/) — accessed 2026-10-30
- [LinkedIn tiers (Microsoft Learn)](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/marketing-tiers) · [ZenABM guide (secondary)](https://zenabm.com/blog/linkedin-ads-library-api) — accessed 2026-10-30
- [Google political ads BigQuery](https://cloud.google.com/blog/topics/developers-practitioners/how-get-started-political-ads-transparency-report-dataset) — accessed 2026-10-30
- [Semrush MCP docs](https://developer.semrush.com/api/basics/semrush-mcp/) — accessed 2026-10-30
