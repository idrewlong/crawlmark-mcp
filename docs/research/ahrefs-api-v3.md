# Ahrefs API v3: the endpoints crawlmark uses

Researched 2026-10-13 by my-skills:planner (branch `phase-9-plan`) for `specs/2026-10-13-1500-phase-9-seo-data-providers.md`.
Every fact below comes from Ahrefs' own documentation, accessed 2026-10-13. No API call was made.

**Method.** I started with Context7 (`/websites/ahrefs`). It returned fragments of the same OpenAPI spec, so I used the primary sources instead:

- the OpenAPI 3.2 spec that Ahrefs publishes, `https://docs.ahrefs.com/openapi.json`, with per-tool specs listed in `https://docs.ahrefs.com/reference/index.json`;
- the Markdown guide pages under `https://docs.ahrefs.com/api/docs/`;
- the rendered reference pages under `https://docs.ahrefs.com/en/api/reference/`;
- the help-center article on plans.

Parameter names, enums, defaults and field costs are copied from the OpenAPI spec. The spec labels a field's cost in its description, for example `(10 units)`.

**Reading the note.** Each section separates **Facts**, which are documented and cited, from **Inference**, which is my reading and is marked as such. The "Not confirmed" list at the end is what a live call (spec task 10) has to settle.

## Sources

| Id | URL | What it gave |
|---|---|---|
| A1 | https://docs.ahrefs.com/openapi.json | servers, security scheme, every parameter, enum and response schema below |
| A2 | https://docs.ahrefs.com/api/docs/introduction.md | rate limit, 429, where keys live, plan eligibility |
| A3 | https://docs.ahrefs.com/api/docs/api-keys-creation-and-management.md | `Authorization: Bearer`, key admin, per-key unit limits |
| A4 | https://docs.ahrefs.com/api/docs/limits-consumption.md | unit formula, field costs, response headers, cache |
| A5 | https://docs.ahrefs.com/api/docs/free-test-queries.md | free targets and keywords |
| A6 | https://docs.ahrefs.com/api/docs/parameters.md | `select`, `where` and `order_by` syntax |
| A7 | https://docs.ahrefs.com/en/api/reference/site-explorer/get-organic-keywords | rendered page: request sample, response sample (placeholder values) |
| A8 | https://docs.ahrefs.com/en/api/reference/subscription-info/get-limits-and-usage | rendered page for the free account check |
| A9 | https://help.ahrefs.com/en/articles/6559232-about-api-v3 | plans, monthly units, max rows per request |

All were accessed 2026-10-13.

## General

**Facts**

- **Base URL.** `https://api.ahrefs.com/v3` [A1 `servers`]. Each tool has its own prefix, for example `https://api.ahrefs.com/v3/site-explorer` [A1 index].
- **Auth.** Send `Authorization: Bearer YOUR_API_KEY` [A3]. The OpenAPI security scheme is `http` / `bearer` [A1].
- **Keys.**
  - They are created under Account settings / API keys (`https://app.ahrefs.com/account/api-keys`), and only workspace owners and admins can open that page [A2, A3].
  - A workspace can have up to 1,000 keys. Each key's expiry date is between today and 10 years out [A3].
  - A key stops working when the user who created it is removed from the workspace [A3].
  - Each key can have a monthly unit limit [A3].
- **Plans.**
  - Direct API use needs the Lite plan or higher [A9]. Other plans get only the free test queries [A2].
  - Monthly units and the maximum rows per request, per plan [A9]:

    | Plan | API units / month | Max rows per request |
    |---|---|---|
    | Lite | 200,000 | 100 |
    | Standard | 800,000 | 250 |
    | Advanced | 2,000,000 | 500 |
    | Enterprise | custom | unlimited |

  - Some plans allow pay-as-you-go units beyond the allowance, which can be capped or turned off under Account settings / Limits & usage [A3].
- **Rate limit.** The default is 60 requests per minute. Requests can also be throttled under system load. Both cases return HTTP **429** [A2].
- **Units.**
  - Cost per request is `max(base_cost, per_row_cost × rows)`, where the base cost is **50** units [A4].
  - The per-row cost is the sum of the costs of each *unique* field that appears in `select`, `where` or `order_by`. A field used in more than one of them counts once [A4].
  - Most fields cost 1 unit. Some cost 5 or 10, as noted in each field's description [A4].
  - Worked examples from the docs [A4]:
    - Domain rating: 2 fields, 1 row, so the request costs the 50-unit minimum.
    - Backlinks: fields costing 1 + 1 + 10 give 12 units per row, so 500 rows cost 6,000 units.
- **Response headers** [A4]:

  | Header | Meaning |
  |---|---|
  | `x-api-rows` | rows returned |
  | `x-api-units-cost-row` | per-row cost |
  | `x-api-units-cost-total` | units the request should consume |
  | `x-api-units-cost-total-actual` | units the request actually consumed |
  | `x-api-cache` | `hit`, `miss` or `no_cache` |

- **Cache.** A request served from cache costs no units [A4].
- **Free test queries.** These need a key and a paid plan, and cost no units [A5]:
  - Site Explorer, when `target` is `ahrefs.com`, `yep.com` or `firehose.com`, or any URL on those domains.
  - Keywords Explorer, when `keywords` contains *only* `ahrefs`, `yep` or `firehose`. Adding any other keyword, or a `keyword_list_id`, makes the request billable.
  - `limit` is capped at 100 in free test requests.
  - To estimate a cost, run the request against a free target and read `x-api-units-cost-total`.
- **Parameter syntax** [A6]:
  - Every parameter value must be URL-encoded.
  - `select` is a mandatory comma-separated field list on the endpoints that accept it.
  - `order_by` is `field_a:desc,field_b:asc`.
  - `where` is a JSON filter expression.
- **Output.** Each endpoint takes an optional `output` parameter. The organic endpoints accept `json`, `php` or `xml`; the others also accept `csv` [A1]. When it is omitted, the response is JSON (see Inference).
- **Error format.**
  - Every endpoint documents 400, 401, 403, 429 and 500, each with the schema `{ "error": string }` [A1, `components/schemas/*.Error response`].
  - The docs do not explain what each code means, apart from 429 (rate limit) [A2].

**Inference**

- JSON is the default output. Every documented example is JSON, and JSON is the first content type in each response.
- 401 most likely means a missing or invalid key, and 403 a key without access to that endpoint or plan. The docs only name the codes.

## Endpoints

### `GET /v3/subscription-info/limits-and-usage` (the free account check)

**Facts** [A1, A8]

- **Cost.** "Requests to this endpoint are free and do not consume any API units."
- **Parameters.** `output` only (optional: `json`, `csv`, `xml`, `php`).
- **200 schema.** `{ limits_and_usage: { … } }` with these fields:

  | Field | Type | Meaning |
  |---|---|---|
  | `subscription` | string | the plan |
  | `usage_reset_date` | date | start of the next billing period |
  | `units_limit_workspace` | int or null | units available to the workspace |
  | `units_usage_workspace` | int or null | units the workspace used this billing month |
  | `units_limit_api_key` | int or null | this key's monthly limit; null means unlimited |
  | `units_usage_api_key` | int | units this key used this billing month |
  | `api_key_expiration_date` | date-time | when this key stops working |

- **Errors.** 400, 401, 403, 429, 500, each `{ error }`.
- **Example.** The rendered page shows a sample with these keys. The object below is built from the schema; the values are mine:

```json
{ "limits_and_usage": { "subscription": "Standard", "usage_reset_date": "2026-11-01",
  "units_limit_workspace": 800000, "units_usage_workspace": 15000,
  "units_limit_api_key": 50000, "units_usage_api_key": 1200,
  "api_key_expiration_date": "2027-10-13T00:00:00Z" } }
```

### `GET /v3/site-explorer/organic-keywords` (ranked keywords)

**Facts** [A1, A7]

**Parameters**

| Parameter | Required | Type and allowed values | Default |
|---|---|---|---|
| `select` | yes | comma-separated fields | |
| `target` | yes | domain or URL | |
| `date` | yes | `YYYY-MM-DD` | |
| `country` | no | ISO 3166-1 alpha-2, lowercase enum (`us`, `gb`, `de` …) | |
| `mode` | no | `exact`, `prefix`, `domain`, `subdomains` | `subdomains` |
| `protocol` | no | `both`, `http`, `https` | `both` |
| `limit` | no | integer | **1000** |
| `order_by` | no | `field:dir,…` | |
| `where` | no | filter expression | |
| `volume_mode` | no | `monthly`, `average` | `monthly` |
| `traffic_mode` | no | `static`, `adaptive` | `adaptive` |
| `date_compared` | no | `YYYY-MM-DD` | |
| `timeout` | no | seconds | |
| `portfolio_id` | no | integer; takes precedence over `target` | |
| `output` | no | `json`, `php`, `xml` | |

**Response.** A `keywords` array. The fields crawlmark selects:

| Field | Type | Cost per row | Meaning |
|---|---|---|---|
| `keyword` | string or null | 1 | the keyword |
| `best_position` | int or null | 1 | the target's top organic position |
| `best_position_url` | string or null | 1 | the ranking URL |
| `volume` | int or null | 10 | "searches … over the latest month" |
| `sum_traffic` | int or null | 10 | estimated monthly visitors to the target from the keyword |
| `cpc` | int or null | 1 | USD **cents** |

Other 10-unit fields are `keyword_difficulty` and `sum_paid_traffic`. Fields costing 5 units include `all_positions` and `all_positions_prev` [A7].

**Errors.** 400, 401, 403, 429, 500, each `{ error }`.

**Example.** The rendered page shows a sample with placeholder values. This one is built from the schema, with values of mine:

```json
{ "keywords": [ { "keyword": "example widgets", "best_position": 3,
  "best_position_url": "https://example.com/widgets", "volume": 1900, "sum_traffic": 240 } ] }
```

**Cost per row for crawlmark's request.** `select=keyword,best_position,best_position_url,volume,sum_traffic&order_by=volume:desc` costs 1+1+1+10+10 = **23** units per row. `volume` counts once even though it is also in `order_by` [A4].

### `GET /v3/site-explorer/organic-competitors` (competitor domains)

**Facts** [A1]

- **Parameters.** The same set as organic-keywords, with one difference: **`country` is required** here.
- **Response.** A `competitors` array:

  | Field | Type | Cost per row | Meaning |
  |---|---|---|---|
  | `competitor_domain` | string or null | 1 | the competitor, in "domains" group mode |
  | `keywords_common` | int | 1 | keywords both sites rank for |
  | `keywords_competitor` | int | 1 | keywords only the competitor ranks for |
  | `keywords_target` | int | 1 | keywords only the target ranks for |
  | `share` | number | 1 | percentage of common keywords |
  | `domain_rating` | number | 1 | the competitor's DR |
  | `traffic` | int or null | 10 | "monthly visits … from organic search" |

- **Errors.** As above.
- **Example.** Built from the schema, values mine:

```json
{ "competitors": [ { "competitor_domain": "example.org", "keywords_common": 412, "traffic": 5300 } ] }
```

**Cost per row for crawlmark's request.** `select=competitor_domain,keywords_common,traffic&order_by=keywords_common:desc` costs 1+1+10 = **12** units per row.

### `GET /v3/site-explorer/backlinks-stats` (backlink summary)

**Facts** [A1]

- **Parameters.**

  | Parameter | Required | Allowed values | Default |
  |---|---|---|---|
  | `target` | yes | domain or URL | |
  | `date` | yes | `YYYY-MM-DD` | |
  | `mode` | no | `exact`, `prefix`, `domain`, `subdomains` | `subdomains` |
  | `protocol` | no | `both`, `http`, `https` | `both` |
  | `portfolio_id` | no | integer | |
  | `output` | no | `json`, `csv`, `xml`, `php` | |

  There is **no `select`**: all four fields always come back.
- **Response.** `{ metrics: { … } }`:

  | Field | Type | Cost | Meaning |
  |---|---|---|---|
  | `live` | int | 1 | links pointing to the target now |
  | `all_time` | int | 1 | links pointing to the target, all time |
  | `live_refdomains` | int | 5 | unique linking domains now |
  | `all_time_refdomains` | int | 5 | unique linking domains, all time |

**Cost.** 1+1+5+5 = 12 units per row, for one row, so the request costs the 50-unit minimum. That is inference from A4's formula.

**Example.** Built from the schema, values mine:

```json
{ "metrics": { "live": 1840, "all_time": 5120, "live_refdomains": 212, "all_time_refdomains": 498 } }
```

### `GET /v3/site-explorer/domain-rating`

**Facts** [A1, A4, A5]

- **Parameters.** `target` (required), `date` (required, `YYYY-MM-DD`) and `output` (optional).
- **Response.** `{ domain_rating: { domain_rating: number, ahrefs_rank: int | null } }`. `domain_rating` is on a 100-point log scale; `ahrefs_rank` #1 is the strongest.
- **Cost.** A4 uses this endpoint as its 50-unit-minimum example.
- **Free.** A5 gives `https://api.ahrefs.com/v3/site-explorer/domain-rating?date=2023-05-18&target=firehose.com` as a free test query.

### `GET /v3/keywords-explorer/overview` (keyword volume)

**Facts** [A1, A5]

**Parameters**

| Parameter | Required | Type and allowed values | Default |
|---|---|---|---|
| `select` | yes | comma-separated fields | |
| `country` | yes | lowercase alpha-2 enum | |
| `keywords` | no | comma-separated list | |
| `keyword_list_id` | no | integer | |
| `limit` | no | integer | 1000 |
| `order_by` | no | any field except `volume_monthly` | |
| `where` | no | filter expression | |
| `target`, `mode`, `target_position` | no | `target_position` is `in_top10` or `in_top100` | |
| `volume_monthly_date_from`, `volume_monthly_date_to` | no | dates; needed only for `volume_monthly_history` | |
| `timeout`, `output` | no | `output` is `json`, `php` or `xml` | |

**Response.** A `keywords` array:

| Field | Type | Cost | Meaning |
|---|---|---|---|
| `keyword` | string | 1 | the keyword |
| `volume` | int or null | 10 | "average monthly number of searches … over the latest known 12 months" |
| `volume_monthly` | int or null | 10 | the latest month |
| `cpc` | int or null | 1 | USD cents |
| `difficulty` | int or null | 10 | |
| `global_volume` | int or null | 10 | |

**Free example** [A5]. `https://api.ahrefs.com/v3/keywords-explorer/overview?country=us&keywords=ahrefs&select=keyword,volume,traffic_potential,difficulty`

**Cost per row for crawlmark's request.** `select=keyword,volume,cpc` costs 1+10+1 = **12** units per row, with the 50-unit minimum per request.

**Example.** Built from the schema, values mine:

```json
{ "keywords": [ { "keyword": "example widgets", "volume": 1900, "cpc": 125 } ] }
```

## Inference (not stated by Ahrefs)

- **The two "volume" fields differ by endpoint.**
  - In Site Explorer organic-keywords, `volume` is the latest month, and `volume_mode=average` switches it to a 12-month average.
  - In Keywords Explorer overview, `volume` is already the 12-month average.
  - crawlmark should send `volume_mode=average` on organic-keywords if it wants the two to agree. The spec decides this.
- **The `country` enum includes both `gb` and `uk`.** `gb` is the ISO code and is what crawlmark sends.
- **Max rows per request** [A9] is a plan cap, separate from the default `limit` of 1000. A Lite key asking for 1000 rows probably gets 100, but the docs don't say whether that is silent truncation or an error.

## Not confirmed

These need a live call (spec task 10). The Site Explorer ones can use the free targets in A5 at no unit cost.

1. The exact `error` strings and the HTTP status for a bad key. 401 versus 403 is not stated.
2. What happens when the workspace or per-key units run out: the status code, the body, and whether pay-as-you-go silently continues.
3. Whether a `limit` above the plan's row cap is truncated silently or rejected.
4. The maximum number of comma-separated `keywords` per overview request. The docs give no cap.
5. Whether `x-api-units-cost-total-actual` is present on every response, or only some.
6. Whether a key on a plan below Lite gets 401 or 403 from limits-and-usage, or a 200 with a zero limit.
7. Whether the default output is JSON when `output` is omitted. Every example suggests yes.
