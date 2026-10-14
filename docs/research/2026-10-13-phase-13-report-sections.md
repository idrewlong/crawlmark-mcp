# Phase 13 research: provider report sections, site audits, Search Console indexing

Researched 2026-10-13 (20:00–20:15 CDT) by my-skills:planner (branch `phase-13-plan`) for `specs/2026-10-13-2100-phase-13-report-sections.md`.
Every fact below comes from the vendor's own documentation, accessed 2026-10-13. No API call was made and nothing was spent. Ahrefs facts come from the per-tool OpenAPI files Ahrefs publishes (downloaded and read with `jq`); the other vendors' pages were read in full.

**Reading the note.** **Facts** are documented and cited. **Inference** is my reading and is marked as such. "Not confirmed" at the end lists what a live check has to settle (spec 13.7).

## Sources

| Id | URL | What it gave |
|---|---|---|
| A1 | https://docs.ahrefs.com/reference/index.json | API v3 tool groups, including `site-audit` (`https://api.ahrefs.com/v3/site-audit`) and `management` |
| A2 | https://docs.ahrefs.com/reference/site-audit.json | Site Audit endpoints, parameters, unit costs, response schemas |
| A3 | https://docs.ahrefs.com/reference/site-explorer.json | `metrics`, `metrics-history`, `keywords-history`, `refdomains-history`, `domain-rating-history`, `organic-competitors` |
| A4 | https://docs.ahrefs.com/reference/management.json | Management endpoints (project create/delete: the writes crawlmark must never call) |
| A5 | https://docs.ahrefs.com/api/docs/introduction.md | 60 requests/minute, 429 throttling, eligible paid plans |
| A6 | docs/research/ahrefs-api-v3.md (Phase 9) | unit formula `max(50, per-row × rows)`, free test targets, plans |
| S1 | https://developer.semrush.com/api/v3/llms.txt | Projects API pages: overview, position tracking, site audit; v3 Projects marked deprecated in favour of v4 |
| S2 | https://developer.semrush.com/api/v3/projects/site-audit/ | Site Audit endpoints, unit costs, response fields, issue IDs |
| S3 | https://developer.semrush.com/api/v3/projects/overview/ | Projects API needs the SEO Business subscription and API units |
| S4 | https://developer.semrush.com/api/v3/projects/projects/ | `GET /management/v1/projects` (100 units), fields, deprecation notice |
| S5 | https://developer.semrush.com/api/v3/introduction/api-usage-restrictions/ (updated 2026-08-05) | 10 requests/s, 10 simultaneous; "can't cache … for more than one month" |
| S6 | https://developer.semrush.com/api/v3/seo/overview-reports/ | `domain_rank`, `domain_rank_history`, columns, prices |
| S7 | docs/research/semrush-api.md (Phase 9) | v3/v4 keys, `domain_organic_organic`, v4 backlinks overview (`new_count`, `lost_count`, `score`) |
| D1 | https://docs.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live/ | position-band counts, ETV; sample cost $0.0101 |
| D2 | https://docs.dataforseo.com/v3/dataforseo_labs/google/historical_rank_overview/live/ | monthly history back to 2020-10-01; sample cost $0.106 |
| D3 | https://docs.dataforseo.com/v3/backlinks/history/live/ | monthly backlink history with new/lost counts; sample cost $0.02012 |
| D4 | https://docs.dataforseo.com/v3/backlinks/summary/live/ | summary has no new/lost counts; sample cost $0.02003 |
| D5 | https://docs.dataforseo.com/v3/dataforseo_labs/google/competitors_domain/live/ | `full_domain_metrics` vs `metrics`, `filters`, `intersecting_domains` |
| D6 | https://dataforseo.com/update/pricing-update-in-dataforseo-apis (found by search) | from 2026-07-01: no $100 monthly minimum for Backlinks and LLM Mentions; Backlinks prices +20% |
| D7 | docs/research/2026-10-13-phase-12-apis.md D3 | Labs price $0.012 per task + $0.00012 per item |
| G1 | https://developers.google.com/webmaster-tools/limits (updated 2025-08-28) | URL Inspection quota per site and per project |
| G2 | https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect (updated 2024-07-23) | request, scopes (`webmasters.readonly` accepted) |
| G3 | https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult | `IndexStatusInspectionResult` fields and enums |
| G4 | https://developers.google.com/webmaster-tools/v1/sitemaps (updated 2024-07-23) | Sitemap resource; `contents[].indexed` deprecated |

## 1. Ahrefs Site Audit (API v3)

**Facts** [A1, A2]

- Base `https://api.ahrefs.com/v3/site-audit`. Same `Authorization: Bearer` key as the rest of v3. Every Site Audit endpoint is a **GET**:

  | Endpoint | Cost | What it returns |
  |---|---|---|
  | `GET /site-audit/projects` (`project_id`, `date`, `project_name`, `project_url` all optional) | "free and do not consume any API units" | `healthscores[]`: `project_id`, `project_name`, `target_url`, `target_mode`, `target_protocol`, `date` (finish of the last finished crawl, GMT), `status` (`Completed`, `Stopped`, `Error`, `In_progress`), `health_score`, `total`, `urls_with_errors`, `urls_with_warnings`, `urls_with_notices` |
  | `GET /site-audit/issues` (`project_id` required; `date`, `date_compared` optional, `YYYY-MM-DDThh:mm:ss` UTC) | "a fixed cost of 50 API units per request" | `issues[]`: `issue_id`, `name`, `category` (`Internal pages`, `Indexability`, `AI Discoverability`, `Links`, `Redirects`, `Content`, `Social tags`, `Duplicates`, `Localization`, `Usability and performance`, `Images`, `JavaScript`, `CSS`, `Sitemaps`, `External pages`, `Other`), `importance` (`Error`, `Warning`, `Notice`), `crawled` (URLs affected now), `is_indexable`, and with `date_compared`: `change`, `added`, `new`, `removed`, `missing` |
  | `GET /site-audit/page-explorer` (`project_id`, `issue_id`, `select`, `where`, `order_by`, `date`, `date_compared`, `filter_mode`, `offset`, `limit`) | "a fixed cost of 50 API units per request" | crawled pages (filterable by `issue_id`) |
  | `GET /site-audit/page-content` | not used | |

- `date` defaults to the most recent available crawl; for scheduled crawls Ahrefs returns "the latest crawl finished before the specified timestamp" [A2].
- The project ID is "in the URL of your Site Audit project in Ahrefs: `https://app.ahrefs.com/site-audit/#project_id#`" [A2]. A project must already exist; creating, deleting and editing projects are separate Management endpoints (`POST /projects`, `DELETE /projects`, `PATCH /update-project`) [A4].
- Rate limit 60 requests/minute, 429 when exceeded or throttled [A5].

**Inference**

- Reading Site Audit results is safe and read-only if crawlmark calls only those three GET paths. Nothing here starts a crawl. An Ahrefs key is not read-only (the same key can call the Management writes), so crawlmark must enforce a path allowlist itself.
- `projects?project_url=<domain>` is a free way to find the client's project; a match on more than one project (or none) needs the user to pick.
- Which plans may call Site Audit through the API isn't stated [A5 says "eligible paid plans"]; see Not confirmed.

## 2. Semrush Site Audit (Projects API, v3)

**Facts** [S2, S3, S4, S5]

- Needs "the SEO Business subscription and available API units" [S3]. Requests take the `key` query parameter [S2, S4].
- Endpoints and documented unit costs [S2, S4]:

  | Endpoint | Method | Units | Read-only? |
  |---|---|---|---|
  | `/management/v1/projects` (list; `filter` = `all`, `own`, `shared`, `corporate`) | GET | 100 | yes |
  | `/reports/v1/projects/{ID}/siteaudit/info` (latest audit summary) | GET | 100 | yes |
  | `/reports/v1/projects/{ID}/siteaudit/meta/issues` (issue titles) | GET | 100 | yes |
  | `/reports/v1/projects/{ID}/siteaudit/snapshots` | GET | 100 | yes |
  | `/reports/v1/projects/{ID}/siteaudit/snapshot?snapshot_id=` (score, per-issue counts) | GET | **10,000** | yes |
  | `/reports/v1/projects/{ID}/siteaudit/snapshot/{snapshotId}/issue/{issueId}` (affected URLs; `page`, `limit` default 10) | GET | 100 | yes |
  | `/reports/v1/projects/{ID}/siteaudit/page/list`, `/page/{pageId}` | GET | 100, 1,000 | yes |
  | `/management/v1/projects/{ID}/siteaudit/enable`, `/save` | POST | 100 | **no** (creates/edits the campaign) |
  | `/reports/v1/projects/{ID}/siteaudit/launch` | POST | 100 | **no** (starts a crawl) |

- `/info` fields: `id`, `name`, `url`, `status` (`RUNNING`, `FINISHED`, `CHECKING`, `SAVING`), `errors`, `warnings`, `notices` and their `*_delta`, `broken`, `blocked`, `redirected`, `healthy`, `haveIssues`, `haveIssuesDelta`, `pages_crawled`, `pages_limit`, `defects` (issue ID → number of detections), `last_audit`, `last_failed_audit`, `next_audit`, `depths`, `markups`, settings. It has no quality score; the score is only in `/snapshot` (10,000 units) [S2].
- `/meta/issues`: `issues[]` with `id`, `title`, `title_page`, `url_column`, `info_column`. Issue IDs: 1–99 errors (`1` 5xx, `2` 4xx, `8` broken internal links …), 101–199 warnings (`103` missing h1, `109` temporary redirects …), 201+ notices [S2].
- List-projects fields: `project_id`, `project_name`, `url`, `domain_unicode`, `tools[]` (`{ tool }`), `owner_id`, `permission[]` [S4]. The v3 Projects section is marked deprecated "for new integrations" in favour of v4 Projects; Site Audit itself is still documented under v3 [S1, S4].
- Usage: 10 requests per second, 10 simultaneous; "You can't cache the information received via API for more than one month without Semrush's express written consent." [S5]

**Inference**

- A report can read the latest audit for about 300 units (list 100, cached; `/info` 100; `/meta/issues` 100, cached up to a month) and must never call `/snapshot` (10,000 units) by default. Per-issue URLs cost 100 units per issue.
- Semrush's one-month caching rule applies to anything crawlmark keeps from any Semrush call, including the trend snapshots this phase adds.
- The Semrush v3 key isn't read-only either; the allowlist has to be crawlmark's.

## 3. Organic visibility and backlink history

**DataForSEO** [D1–D7]

- `POST /v3/dataforseo_labs/google/domain_rank_overview/live` (`target` bare domain, location, language): `metrics.organic` has `pos_1`, `pos_2_3`, `pos_4_10`, `pos_11_20`, `pos_21_30` … `pos_91_100`, `etv`, `count`, `estimated_paid_traffic_cost`, `is_new`, `is_up`, `is_down`, `is_lost`. Sample cost $0.0101 [D1]. Labs price $0.012 per task + $0.00012 per item [D7].
- `POST …/historical_rank_overview/live`: monthly items (`year`, `month`) with the same `metrics.organic`; from 2020-10-01; default the last 6 months; `correlate` default true. Sample cost **$0.106** [D2].
- `POST /v3/backlinks/history/live`: monthly (first day of each month), from 2019-01-01: `rank`, `backlinks`, `new_backlinks`, `lost_backlinks`, `referring_domains`, `new_referring_domains`, `lost_referring_domains`, `referring_main_domains`; `rank_scale` `one_hundred` or `one_thousand` (default). New/lost populated from May 2021. Sample cost $0.02012 [D3].
- `POST /v3/backlinks/summary/live` has **no** new/lost counts (only `lost_date` on items) [D4].
- `competitors_domain/live`: `full_domain_metrics` is the competitor's whole footprint; `metrics` covers only keywords shared with the target; `filters` (up to 8), `intersecting_domains` (up to 20), `limit` up to 1000 [D5].
- Since 2026-07-01 the Backlinks API has no $100 monthly minimum; Backlinks prices rose 20% [D6].

**Ahrefs** [A3]

- `GET /site-explorer/metrics`: `org_keywords` (top 100), `org_keywords_1_3`, `org_traffic` (10 units), `org_cost` (10 units). No 4–10 or 11–20 bands.
- `GET /site-explorer/keywords-history` (`select`, `date_from`, `date_to`, `history_grouping` `daily`/`weekly`/`monthly` default monthly, `country`): `date`, `top3`, `top4_10`, `top11_20`, `top11_plus`, `top21_50`, `top51_plus`.
- `GET /site-explorer/metrics-history`: `date`, `org_traffic` (10 units), `org_cost` (10 units), paid fields.
- `GET /site-explorer/refdomains-history`: `date`, `refdomains` (5 units); `GET /site-explorer/domain-rating-history`: `date`, `domain_rating`.
- `GET /site-explorer/organic-competitors` (Phase 9 note): `competitor_domain`, `keywords_common`, `keywords_competitor`, `keywords_target`, `share`, `domain_rating`, `traffic` (10 units); `country` required; `where` filters.
- No count of new/lost referring domains is exposed by `backlinks-stats` (`live`, `all_time`, `live_refdomains`, `all_time_refdomains`).

**Semrush** [S6, S7]

- `type=domain_rank` (one database): 10 units per line; columns include `Or` (organic keywords), `Ot` (organic traffic), `Rk`. `type=domain_rank_history`: 10 units per line, monthly (or daily for the last 31 days with `display_daily`), columns `Dt`, `Or`, `Ot`, ….
- No report on the overview page returns keyword counts by position band. `domain_rank` lists `Ip0`–`Ip3`, `It0`–`It3`, `Ic0`–`Ic3` without definitions on that page.
- v4 backlinks overview (already used, 45 units) returns `backlinks_count`, `domains_count`, `new_count`, `lost_count`, `score` (Authority Score).

**Inference**

- Position bands: DataForSEO gives all four bands the spec needs (top 3 = `pos_1 + pos_2_3`; 21–100 = sum of `pos_21_30` … `pos_91_100`). Ahrefs gives them through `keywords-history` (21–100 = `top21_50 + top51_plus`; Ahrefs organic data stops at position 100, so 51+ means 51–100). Semrush gives none, so its distribution is `null` with a note.
- Ahrefs and Semrush give no new/lost **referring-domain** counts in one cheap call; DataForSEO's history does (monthly). Semrush v4 gives new/lost **backlinks** (window not documented).

## 4. Search Console indexing data

**Facts** [G1–G4]

- There is no Page indexing (Index coverage) report in the Search Console API. Its resources are Search Analytics, Sitemaps, Sites and URL Inspection [G2, G4 navigation].
- `POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`, body `inspectionUrl`, `siteUrl`, optional `languageCode`. Scopes: `webmasters.readonly` **or** `webmasters` [G2].
- Quota: per site 2,000 queries per day and 600 per minute; per Cloud project 10,000,000 per day and 15,000 per minute [G1].
- `IndexStatusInspectionResult` [G3]: `verdict` (`PASS`, `FAIL`, `NEUTRAL`; `PARTIAL` reserved), `coverageState` (free text), `robotsTxtState` (`ALLOWED`, `DISALLOWED`), `indexingState` (`INDEXING_ALLOWED`, `BLOCKED_BY_META_TAG`, `BLOCKED_BY_HTTP_HEADER`; `BLOCKED_BY_ROBOTS_TXT` reserved), `lastCrawlTime`, `pageFetchState` (`SUCCESSFUL`, `SOFT_404`, `BLOCKED_ROBOTS_TXT`, `NOT_FOUND`, `ACCESS_DENIED`, `SERVER_ERROR`, `REDIRECT_ERROR`, `ACCESS_FORBIDDEN`, `BLOCKED_4XX`, `INTERNAL_CRAWL_ERROR`, `INVALID_URL`), `googleCanonical`, `userCanonical`, `crawledAs` (`DESKTOP`, `MOBILE`), `sitemap[]`, `referringUrls[]`. `mobileUsabilityResult` is deprecated.
- Sitemaps resource: `path`, `lastSubmitted`, `isPending`, `isSitemapsIndex`, `type`, `lastDownloaded`, `warnings`, `errors`, `contents[]` with `type` and `submitted`; `contents[].indexed` is "Deprecated; do not use" [G4].

**Inference**

- crawlmark already asks for `webmasters.readonly` (`src/lib/google-auth.ts` `DATA_SCOPES`), so URL Inspection needs no new scope or consent.
- A sampled, rotating inspection within a daily budget is the only way to approximate the Page indexing report through the API. "Submitted vs indexed" from Sitemaps is no longer available.
- Google API daily quotas usually reset at midnight Pacific time; G1 doesn't say so for this API (Not confirmed 8).

## Not confirmed (answered by the live checks in spec 13.7)

1. Which Ahrefs plans may call `/site-audit/*` through the API (A5 only says "eligible paid plans"). Free check: `GET /site-audit/projects`.
2. Whether Ahrefs `/site-audit/issues` returns issue rows for a project whose last crawl `status` is `Stopped` or `Error`.
3. Whether Semrush Projects/Site Audit accept the v3 key (`SEMRUSH_API_KEY`) only, or also the v4 key; and the exact units charged for `/info` and `/meta/issues` (S2 says 100 each).
4. The `tools[].tool` value Semrush uses for Site Audit in the project list (crawlmark assumes `siteaudit`; the docs' example shows only `tracking`).
5. The time window of Semrush v4 backlinks `new_count` / `lost_count`.
6. DataForSEO `historical_rank_overview` real cost for 12 months (sample $0.106) and `domain_rank_overview` real cost (sample $0.0101), after the 2026-07 price update.
7. Whether DataForSEO `competitors_domain` `filters` accepts `["domain", "in", [...]]` to return exactly the saved competitors.
8. When the URL Inspection per-site daily quota resets (assumed midnight Pacific), and the exact error (status and reason) when it runs out.
9. The exact `coverageState` strings Google returns (crawlmark maps them by keyword; unknown strings fall back to `pageFetchState`/`indexingState`/`verdict`).
10. Whether reading a stored DataForSEO On-Page task (`/on_page/summary`, `/on_page/pages`) is always free, and how long DataForSEO keeps a finished task.
11. Ahrefs' terms on storing API data locally (A5 links to the general terms; not researched). Semrush's one-month rule is documented (S5).
