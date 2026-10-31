# What does crawlmark need to add link_gap, lost_links, unlinked_mentions and Gmail-based backlink outreach?
Date: 2026-10-30 · Author: my-skills:researcher · Requested by: orchestrator · Status: final (items marked UNVERIFIED are not confirmed from an official source)

No API keys were used, no paid calls were made, and no code was changed. Everything below was read from official docs or the vendors' published OpenAPI spec.

## Answer (TL;DR)
- **Data providers (confidence high).** DataForSEO can do all four tools with one pay-as-you-go account. There is no monthly commitment any more: the $100 Backlinks API commitment was removed on 2026-07-01. Ahrefs v3 has a first-class link-intersect endpoint (one call, up to 20 competitors) and broken-backlinks. Semrush v4 has no confirmed intersect or broken-page endpoint, so treat it as "not supported" for these tools in v1.
- **One DataForSEO caveat for link_gap (high).** `domain_intersection` returns only domains that link to ALL listed targets. "Links to 2+ of 5 competitors" therefore needs the 10 pairs (C(5,2)), or per-competitor `referring_domains` pulls with local set math.
- **Unlinked mentions (high).** The DataForSEO Content Analysis `search` response has no field saying whether the page links to the brand domain. crawlmark must check that itself, by fetching the page or comparing against the client's referring pages.
- **Gmail (high on scopes, medium on policy).** `gmail.compose`, `gmail.readonly`, `gmail.metadata` and `gmail.modify` are all RESTRICTED. Only `gmail.send` is merely sensitive, and it cannot create drafts. Google exempts personal use and small known groups from verification and the CASA assessment. In Testing status the refresh token dies after 7 days.
- **Safest design (medium).** Drafts only. crawlmark never calls send. Either use `gmail.compose` natively, or hand the drafts to the AI app's Gmail connector so crawlmark needs no Gmail scope at all.

## Findings

### 1. link_gap

**DataForSEO Backlinks API, `POST https://api.dataforseo.com/v3/backlinks/domain_intersection/live`** ([docs](https://docs.dataforseo.com/v3/backlinks/domain_intersection/live/))
- The endpoint description says it is "especially useful for creating a Link Gap feature". The `result` is documented as "domains that link to all targets from the POST array".
- Request parameters:
  - `targets`: required, object, up to 20 domains, subdomains or pages.
  - `exclude_targets`: up to 10. Results are domains linking to `targets` but not to these. Put the client here.
  - `filters` (up to 8) and `order_by` (up to 3).
  - `limit`: default 100, max 1000. Also `offset`.
  - `backlinks_status_type`: `all`, `live` (default) or `lost`.
  - `backlinks_filters`: filters the underlying backlinks. The docs example is `[["dofollow","=",true]]`.
  - `intersection_mode`: `all` (default) or `partial`.
  - `include_subdomains`, `include_indirect_links`, `exclude_internal_backlinks`, `rank_scale`, `internal_list_limit` and `tag`.
- Response: `result.items[].domain_intersection` is an object keyed "1".."20", one entry per target.
  - Each entry has `target` (the referring domain), `rank`, `backlinks`, `backlinks_spam_score`, `referring_domains`, `referring_pages`, `first_seen` and `lost_date`.
  - It also has `broken_backlinks`, `broken_pages` and the `referring_links_*` breakdowns.
  - There is no dofollow field. Use `backlinks_filters`.
- Filtering by rank or spam score on this endpoint:
  - The filter list says prefixes are the target sequence number, for example `1.referring_links_tld.$tld`.
  - The exact names for rank and `backlinks_spam_score` here were not shown in the part of the filter page I could read. UNVERIFIED; test it in the sandbox.
- Consequence for "2+ competitors": the endpoint intersects ALL targets, so run it once per competitor pair with `exclude_targets=[client]`, and union the results. A 5-competitor client needs 10 calls.
- Alternative: `POST /v3/backlinks/referring_domains/live` ([docs](https://docs.dataforseo.com/v3/backlinks/referring_domains/live/)) once per competitor and once for the client, then count in SQLite.
  - It takes `target`, `limit` (max 1000), `offset`, `filters` (for example `["backlinks",">",100]`), `order_by` (for example `["rank,desc"]`) and `backlinks_filters`.
  - It returns `domain`, `rank`, `backlinks_spam_score`, `backlinks`, `first_seen` and `lost_date`.
  - This has no pair explosion, but it needs more rows and paging.
- `page_intersection` (`/v3/backlinks/page_intersection/live`) takes the same targets and filters ([docs](https://docs.dataforseo.com/v3/backlinks/page_intersection/live/)). Its items carry `anchor`, `text_pre`, `text_post`, `dofollow`, `first_seen` and `last_seen`. Use it only to fetch the linking pages for the top gap domains.
- Limits ([overview](https://docs.dataforseo.com/v3/backlinks/overview/)): the Backlinks API is Live-only, with up to 10,000 calls per minute and 30 simultaneous requests.

**Price** ([pricing](https://dataforseo.com/pricing/backlinks/backlinks))
- $0.024 per task plus $0.000036 per returned row, for all Backlinks endpoints. The sample responses in the docs show a per-task cost of about $0.02.
- Filtering and sorting add no charge. That statement is made on the Content Analysis pricing page, not the Backlinks page, so for Backlinks it is UNVERIFIED.
- The Backlinks pricing page's own example (1,000 rows = "$0.05") disagrees with its stated rates ($0.06). Budget from the rates.

**Ahrefs API v3, `POST /v3/competitive-analysis/link-intersect-refdomains`**
- Source: the `competitive-analysis.link-intersect-refdomains` path in the official OpenAPI document [openapi.json](https://docs.ahrefs.com/openapi.json). The path is not in the per-tool `site-explorer.json` spec.
- Request:
  - `target` (`url`, `mode`, `protocol`), required. This is the client.
  - `competitors`: 1 to 20 targets.
  - `select`, `where`, `order_by`, `limit` (default 1000) and `output`.
- `where` can filter `intersect` (number of competitors linking), `links_to_competitor_1..N`, `domain_rating`, `is_dofollow`, `is_content`, `is_sponsored`, `is_ugc`, `languages` and `link_type`.
- Response `referring-domains[]` fields: `domain`, `domain_rating`, `intersect` ("Number of competitors linked from this result"), `links_to_target`, `links_to_competitor_N` and `traffic_domain` (10 units).
- `links_to_target` is selectable, but it is not in the documented `where` identifiers. So "does not link to the client" is probably a client-side filter (`links_to_target == 0`) combined with `where intersect >= 2`. Whether the server accepts `links_to_target` in `where` is UNVERIFIED.
- This one call replaces the DataForSEO pair loop. There is no spam score. The only quality signal is `domain_rating`.
- A sibling `link-intersect-refpages` exists.
- Units ([limits-consumption](https://docs.ahrefs.com/api/docs/limits-consumption.md)): `max(50, per_row_cost × rows)`. The row cost is the sum of the unique fields used in `select`, `where` and `order_by`, and most fields cost 1 unit.
  - `domain, domain_rating, intersect, links_to_target` is about 4 units per row.
  - 1,000 rows is therefore about 4,000 units. This is derived from the documented formula, not confirmed for this endpoint.
- Plan: "Ahrefs API is available on eligible paid plans" (same page). The existing note `docs/research/ahrefs-api-v3.md` records Lite or higher for direct API use.

**Semrush v4 backlinks** ([docs](https://developer.semrush.com/api/v4/seo/backlinks/))
- Visible endpoints under `https://api.semrush.com/apis/v4/backlinks/v1/`: `/overview` (45 units per request), `/links` (45 per line), `/ref-domains` (40 per line), `/pages` (40), `/anchors` (40), `/competitors` (40), `/summary` (40), `/ref-ips` (20) and `/score-profile` (1).
- The page's navigation also lists "Summary Comparison" and "Matrix". Their details were not readable, so whether either gives link-gap data is UNVERIFIED.
- The deprecated v3 `backlinks_matrix` ("Comparison by referring domains") and `backlinks_comparison` ("Batch comparison", up to 200 targets) cost 40 units per line ([v3 docs](https://developer.semrush.com/api/v3/analytics/backlinks/)).
- The v3 Backlinks API is marked deprecated in favor of v4 (same page).
- No endpoint named "intersect" was found. A local gap computed from `/ref-domains` would cost about 40 units × lines × (1 + number of competitors).

### 2. lost_links

**(a) Client URLs that are dead but still have backlinks**
- DataForSEO `POST /v3/backlinks/backlinks/live` ([docs](https://docs.dataforseo.com/v3/backlinks/backlinks/live/)):
  - Item fields: `is_broken` ("true when the target page returns 4xx or 5xx"), `url_to_status_code` (null means not yet crawled), `url_to`, `url_from`, `page_from_status_code`, `is_lost`, `anchor`, `text_pre`, `text_post`, `dofollow`, `first_seen`, `prev_seen`, `last_seen`, `domain_from_rank`, `backlink_spam_score` and `semantic_location`.
  - Filters ([filters page](https://docs.dataforseo.com/v3/backlinks/filters/)): `is_broken` (`=`, `<>`), `url_to_status_code` (`<`, `>`, `=`, `in`, `not_in`, ...) and `dofollow`.
  - Other parameters: `mode` (`as_is`, `one_per_domain`, `one_per_anchor`), `limit` max 1000, `offset` max 20,000 (use `search_after_token` beyond that), and `backlinks_status_type`.
  - A call such as `filters=[["is_broken","=",true]]` returns the broken backlinks. A request with `mode: one_per_domain` collapses them to one per referring domain.
- DataForSEO `POST /v3/backlinks/domain_pages/live` ([docs](https://docs.dataforseo.com/v3/backlinks/domain_pages/live/)) returns each page with `status_code`, `page_summary.backlinks`, `page_summary.referring_domains` and `page_summary.broken_pages`.
  - The `is_broken`, `dofollow` and `url_to_status_code` filters are NOT listed for this endpoint. A status filter is UNVERIFIED.
  - Use `order_by page_summary.backlinks,desc` and filter on `status_code` locally.
- DataForSEO `POST /v3/backlinks/bulk_pages_summary/live` ([docs](https://docs.dataforseo.com/v3/backlinks/bulk_pages_summary/live/)) takes up to 1,000 targets (at most 100 domains). It returns `backlinks`, `referring_domains`, `broken_backlinks` and `broken_pages` per URL. It has no HTTP status code, so crawl the URLs yourself and use this only to rank them by link value. The page shows no per-call rate (see section 4 for the general rate).
- Ahrefs `GET /v3/site-explorer/broken-backlinks` ([spec](https://docs.ahrefs.com/reference/site-explorer.json)):
  - Items carry `http_code_target` (target page status), `http_code` (referring page), `anchor`, `first_seen_link`, `is_dofollow`, `domain_rating_source`, `url_from` and `url_to`.
  - It takes `select`, `where`, `order_by`, `limit`, `mode`, `target` and `protocol`.
- Ahrefs `GET /v3/site-explorer/pages-by-backlinks` (formerly `best-by-external-links`): returns `http_code_target`, `links_to_target`, `refdomains_target` (5 units) and `url_to`. Filter locally for non-2xx.
- Semrush v4 `/links` has `response_code` (the source page's status, not the target's) and `is_lost`. A target-status field is not documented ([docs](https://developer.semrush.com/api/v4/seo/backlinks/)). Treat broken-target detection as unsupported for Semrush.

**(b) Competitors' dead pages with backlinks.** The same endpoints work with the competitor as `target`. Ahrefs `broken-backlinks` on the competitor is one call, and DataForSEO `backlinks/live` with `is_broken=true` is one call per competitor.

**Internet Archive, for what a dead page used to contain**
- Availability API `GET http://archive.org/wayback/available?url=<url>&timestamp=<1-14 digits>` ([docs](https://archive.org/help/wayback_api.php)):
  - It returns `archived_snapshots.closest` with `available`, `url`, `timestamp` and `status`.
  - It returns `{"archived_snapshots":{}}` when nothing is archived.
  - The page itself is dated 2013, "subject to change frequently", and states no rate limits or terms.
- CDX API `GET http://web.archive.org/cdx/search/cdx` ([docs](https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md)):
  - Parameters include `url`, `output=json`, `fl`, `filter=[!]field:regex` (for example `statuscode:200`), `collapse`, `from`, `to`, `limit` and `matchType`.
  - The default result fields include `timestamp`, `original`, `mimetype`, `statuscode` and `digest`.
  - No rate limit is stated. The server's per-query maximum is 150,000 results by default.
- Terms: I could not retrieve archive.org's Terms of Use text (the pages returned only a title). Terms for automated use are UNVERIFIED. A figure of about 15 requests per minute (HTTP 429) appears in third-party wrappers only and is not in official docs. Design as polite: throttle to roughly 1 request per 4 seconds, back off on 429, cache by URL, and fall back gracefully.

### 3. unlinked_mentions

**DataForSEO Content Analysis, `POST /v3/content_analysis/search/live`** ([docs](https://docs.dataforseo.com/v3/content_analysis/search/live/))
- Request parameters:
  - `keyword`: required. An exact phrase needs escaped quotes, for example `"\"acme plumbing\""`.
  - `keyword_fields`: restricts matching to `title`, `main_title`, `previous_title` or `snippet`.
  - `page_type`: `ecommerce`, `news`, `blogs`, `message-boards`, `organization`.
  - `search_mode`: `as_is` or `one_per_domain`.
  - `filters` (up to 8), `order_by`, `limit` (max 1000), and `offset` (up to about 10,000 results) or `offset_token`.
- Item fields: `url`, `domain`, `main_domain`, `url_rank`, `domain_rank`, `spam_score`, `fetch_time`, `country`, `language`, `page_types`, and `content_info` (`title`, `snippet`, `highlighted_text`, `date_published`, `content_quality_score`, sentiment, ...).
- **It does not say whether the page links to the brand domain.** Anchor and outbound-link data are not in the response.
- Excluding the client's own site works with a filter on `main_domain` (the docs example is `["main_domain","=","reviewfinder.ca"]`; `<>` is a supported operator).
- Pipeline:
  1. Search by brand term and exclude the client's `main_domain`.
  2. Dedupe with `one_per_domain`.
  3. Drop domains that already appear in the client's referring-domains list (cheap, from `backlinks/referring_domains`).
  4. For the remaining pages, crawl locally and check for an `<a href>` to the client domain.
- Price ([pricing](https://dataforseo.com/pricing/content-analysis)): $0.024 per task plus $0.000036 per row, so 1,000 rows costs $0.06. The page says filtering and sorting add no charge.
- The "Content Analysis needs no subscription or minimum" statement comes from that pricing page only; I did not find a separate Content Analysis activation page.

**Ahrefs equivalent**
- `POST /v3/brand-radar/web-pages` is described as "Returns web pages that mention the requested brands or competitors. Brand mentions are matched against page titles and content from Ahrefs' web index." ([openapi.json](https://docs.ahrefs.com/openapi.json))
- Whether it reports link status, what it costs in units, and whether Brand Radar needs an add-on plan: UNVERIFIED.
- Ahrefs also has `GET /brand-radar/mentions-overview`. Its description says requests returning only custom prompt data are free. It targets AI-answer mentions and is not a web-mention finder.

**Semrush:** no mention endpoint found in the v4 backlinks list.

### 4. DataForSEO access rules
- **Current state (high confidence):** the DataForSEO announcement dated 1 July 2026 says "The $100 monthly commitment for the Backlinks API and LLM Mentions API access is now removed… you no longer need to meet a monthly minimum payment requirement… Access to both APIs is now available under the same pay-as-you-go model used across all DataForSEO APIs." ([announcement](https://dataforseo.com/update/pricing-update-in-dataforseo-apis))
- The Backlinks API landing page says "$50 minimum top-up", "No subscription", and a "$1 free trial credit". It mentions no activation step ([backlinks-data-api](https://dataforseo.com/backlinks-data-api)).
- The sandbox is free: "You can test Backlinks API for free using DataForSEO Sandbox" ([overview](https://docs.dataforseo.com/v3/backlinks/overview/)).
- **Stale material to ignore:** a search snippet of a DataForSEO help-center page still describes an "Activate under Backlinks API" step with a "$100 monthly" charge. I could not open that page (the help-center URLs I tried returned 404). Third-party articles repeat the $100 figure. The only authoritative source is the July 2026 announcement. Still, a user whose account predates July 2026 may see an old Access Subscriptions page, so crawlmark should surface any "access denied" or "not activated" API error rather than assume the account is ready.
- DataForSEO API access uses credentials from https://app.dataforseo.com/api-access (overview page).

### 5. Outreach fields

| Field | DataForSEO `backlinks/live` and `page_intersection` | Ahrefs `all-backlinks` / `broken-backlinks` | Semrush v4 `/links` |
|---|---|---|---|
| Anchor text | `anchor` | `anchor` | `anchor` |
| Text before/after | `text_pre`, `text_post` | `snippet_left`, `snippet_right` | not documented |
| Dofollow | `dofollow` (bool) | `is_dofollow`, `is_nofollow` | `is_nofollow` (no dofollow bool on this endpoint) |
| First seen | `first_seen` | `first_seen_link` | `first_seen_at` |
| Last seen / lost | `last_seen`, `is_lost`, `prev_seen` | `last_seen`, `is_lost`, `lost_reason` | `last_seen_at`, `is_lost` |
| Referring page status | `page_from_status_code` | `http_code` | `response_code` |

Sources: [DataForSEO backlinks](https://docs.dataforseo.com/v3/backlinks/backlinks/live/), [page_intersection](https://docs.dataforseo.com/v3/backlinks/page_intersection/live/), [Ahrefs spec](https://docs.ahrefs.com/reference/site-explorer.json), [Semrush v4](https://developer.semrush.com/api/v4/seo/backlinks/). The Ahrefs `all-backlinks` field list also comes from the spec (checked in a downloaded copy).

Per-row cost note: Ahrefs `snippet_left` and `snippet_right` cost may be above 1 unit. I did not check the per-field unit notes for them.

### 6. Gmail scopes and OAuth status ([scopes](https://developers.google.com/workspace/gmail/api/auth/scopes))

| Scope | Class | What it allows |
|---|---|---|
| `gmail.labels` | non-sensitive | edit labels |
| `gmail.send` | **sensitive** | "Send email on your behalf" |
| `gmail.compose` | **restricted** | "Manage drafts and send emails" |
| `gmail.readonly` | **restricted** | view messages and settings |
| `gmail.metadata` | **restricted** | headers and labels, not bodies |
| `gmail.modify` | **restricted** | read, compose and send |
| `gmail.insert`, `gmail.settings.basic`, `mail.google.com` | restricted | |

- No scope allows drafts but forbids sending. `gmail.compose` includes send. A "drafts only" guarantee has to live in crawlmark's code, not in the scope. This is from the table above.
- Draft creation needs `gmail.compose` or a broader scope. Reading replies in a thread needs `gmail.readonly`, `gmail.metadata` (headers only) or `gmail.modify`; all are restricted.
- API quota ([quota](https://developers.google.com/workspace/gmail/api/reference/quota)): 6,000 units per user per minute. `drafts.create` costs 10 units, `messages.send` and `drafts.send` 100 each, and `threads.get` 40 (120 with `format=full`).
- **Testing vs production** ([audience page](https://support.google.com/cloud/answer/15549945), [OAuth expiry](https://developers.google.com/identity/protocols/oauth2#expiration)):
  - External apps in Testing status: up to 100 listed test users, and "Authorizations by a test user will expire seven days from the time of consent". The refresh token also expires in 7 days. The exception is apps that request only name, email or profile scopes.
  - Once published to "In production" while unverified, users see an "unverified app" warning and the app is capped at 100 new users for the project's lifetime. The page says that cap does not apply if you request only approved scopes.
  - Internal user type needs a Google Cloud organization and limits the app to its members.
  - A refresh token is also invalidated after six months unused, and there is a limit of 100 refresh tokens per Google Account per OAuth client.
- **Verification and CASA** ([restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)):
  - An annual independent security assessment (CASA) is required for restricted-scope apps that access data "from or through a third-party server".
  - Listed exemptions ("you don't need to submit it for review"): personal use by you or a small group of people you know personally, development/testing/staging projects not offered to all Google users, service-account-only data, and internal use in a Workspace or Cloud Identity organization with an Internal user type.
  - The page does not state a cost.
  - Each crawlmark user brings their own Google Cloud OAuth client. Their use fits the "personal use / development" exemption, so verification is optional. Whether a distributed npm tool counts as "an app offered to users" does not arise, because crawlmark ships no shared client ID. That is my reading, not Google's text. Hence UNVERIFIED as a legal conclusion.
- **Impact on the existing setup:** `src/lib/google-auth.ts:12-24,34` currently requests `webmasters.readonly`, `analytics.readonly`, `tagmanager.readonly`, `openid` and `email`. Adding a restricted Gmail scope to that same login would make the one consent screen heavier, and for users in Testing status the 7-day expiry applies to the whole token. Keep Gmail as a separate opt-in login with its own token file, so users who never use outreach are unaffected. Incremental authorization behavior was not verified here.
- **Service account:** a plain service account cannot read a user's Gmail. Domain-wide delegation exists, but "only super admins can enable domain-wide delegation of authority" ([about-auth](https://developers.google.com/workspace/gmail/api/auth/about-auth)). Gmail via crawlmark would be OAuth-only, not service account.

### 7. Sending limits and bulk-sender rules
- **Consumer Gmail** ([limits](https://support.google.com/mail/answer/22839)): no more than 500 recipients in one email and no more than 500 emails per day. Hitting the limit blocks sending for 1 to 24 hours. Many bounces can also pause sending (about 24 hours).
- **Google Workspace** ([limits](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace)): 2,000 messages per day per user over a rolling 24 hours (trial accounts 500). 3,000 external recipients per day and 3,000 unique recipients per day (2,000 external). Mail merge is 1,500 per day. A message sent through the Gmail API can have at most 500 recipients. Trial accounts get lower limits that rise automatically after $100 USD cumulative payment, which can take up to 75 days.
- **Per-recipient limit:** no per-recipient daily limit is documented on either page. UNVERIFIED. Consumer Gmail mentions only a recipient-side "can't accept more messages right now" error with no number.
- **Bulk sender requirements** ([sender guidelines](https://support.google.com/a/answer/81126)):
  - A bulk sender is one who "sends more than 5,000 messages per day to Gmail accounts". Bulk senders need SPF, DKIM and DMARC, and one-click unsubscribe with a visible link for marketing messages.
  - All senders need SPF or DKIM, TLS, and a spam rate in Postmaster Tools below 0.3% (the page recommends staying below 0.10%).
  - The page states these apply to personal Gmail accounts.
- For low-volume 1:1 outreach, the 5,000-per-day tier and the one-click unsubscribe header requirement do not apply. The all-sender items (authentication on the sending domain, low spam complaints) do. A spam rate of 0.3% is only 3 complaints per 1,000 messages to Gmail users, which is easy to hit with cold outreach.

### 8. CAN-SPAM, GDPR, PECR
- **CAN-SPAM** ([FTC guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)):
  - "The law makes no exception for business-to-business email."
  - The test is the message's "primary purpose": purely commercial messages must follow the full law, and purely transactional or relationship messages are mostly exempt.
  - Requirements: no false or misleading header information, no deceptive subject lines, identify the message as an ad, include a valid physical postal address, tell recipients how to opt out, and honor opt-outs "within 10 business days" (no fee, and no more than a reply email or one web page visit). Responsibility is not transferred to a vendor you hire.
  - Penalties: up to $53,088 per violating email.
- Does a link request count as commercial? The FTC guide does not address link requests. A message asking a site to link to a client's commercial site arguably has a commercial primary purpose, but I could not read the regulation text (16 CFR 316.3; the eCFR fetch was redirected) and this is a legal judgment. UNVERIFIED. The conservative path is to comply fully.
- **Address harvesting:** 15 U.S.C. § 7704(b)(1)(A)(i) makes it an aggravated violation when an address was "obtained using an automated means from an Internet website or proprietary online service operated by another person" that carried a notice that it will not transfer addresses for sending email ([Cornell LII](https://www.law.cornell.edu/uscode/text/15/7704)). That is a narrow condition (the site must carry such a notice), but a scraper that collects addresses automatically should respect any such notice.
- **UK PECR** ([ICO](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/electronic-and-telephone-marketing/electronic-mail-marketing/)):
  - You may email corporate bodies (companies, LLPs, government bodies). Sole traders and some partnerships count as individuals and need specific consent or a soft opt-in.
  - Do not conceal identity, give a valid contact address, offer an opt-out in every message, and keep a "do not contact" list.
  - Soft opt-in covers only your own existing customers, not prospects.
- **GDPR:** a named person's work email is personal data. Art. 6(1)(f) allows processing "necessary for the purposes of the legitimate interests pursued by the controller or by a third party… except where such interests are overridden by the interests or fundamental rights" of the person ([text of Art. 6](https://gdpr-info.eu/art-6-gdpr/), an unofficial mirror of the Regulation). This means a documented legitimate-interest assessment and a way to opt out and to have data deleted. EU member-state ePrivacy rules for B2B email differ and were not researched. UNVERIFIED for any EU country.
- None of this is legal advice.

### 9. Gmail via the user's AI app (crawlmark only produces drafts)
- **Claude:** Gmail is a connector in Claude's Connectors Directory, available on web, desktop and mobile. Capabilities per Claude's help page: search and read emails, draft emails, and send, reply to and forward. "By default, Claude asks for your approval before each of these actions." Team and Enterprise owners can restrict actions. ([connectors article](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors), [setup article](https://support.claude.com/en/articles/11176164-use-google-workspace-connectors))
  - Observation: the Gmail connector tools exposed in this very session include `create_draft`, `update_draft`, `send_message`, `reply`, `get_thread` and `search_threads`. That is a tool listing, not a docs source.
- **ChatGPT:**
  - OpenAI's plugin documentation says "Install the Gmail plugin to work with Gmail." ([docs](https://learn.chatgpt.com/docs/plugins))
  - OpenAI help-center release notes, as summarized by search, say that from 8 June 2026 Plus, Pro, Business and Enterprise users on web can send drafted email once Gmail or Outlook is connected. They also say availability varies by region, with the EEA, UK and Switzerland named for some apps ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)). I read these only through search summaries.
  - The Gmail plugin page (https://openai.com/business/plugins/gmail/) returned 403 to my fetcher, so its capability list is UNVERIFIED.
- **Codex:** the same OpenAI plugin documentation covers Codex and ChatGPT, and the Gmail plugin is installed via the plugin directory (`/plugins` in the Codex CLI, per the search summary of [developers.openai.com/codex/plugins](https://developers.openai.com/codex/plugins), which redirects to the page above). Gmail capabilities there: UNVERIFIED.
- **Cursor:** Cursor's MCP documentation lists no built-in Gmail connector. MCP servers are added through the Cursor Marketplace or `.cursor/mcp.json`, with optional OAuth ([docs](https://cursor.com/docs/context/mcp)). Any Gmail server would be third-party.
- Design implication: crawlmark can return the outreach as structured data (recipient, subject, body, thread key, the backlink opportunity ID), and the AI app's connector creates the Gmail draft. crawlmark then needs no Gmail scope, no restricted-scope handling and no token storage, and the 7-day Testing problem disappears. The cost is that crawlmark cannot enforce caps, do-not-contact checks or follow-up limits after the hand-off.

### 10. Finding contact addresses
- **Legitimate sources** (no vendor involved): the site's contact and about pages, `mailto:` links, and JSON-LD. Schema.org `ContactPoint` has `email`, `contactType` and `availableLanguage`, and `contactPoint` is a property of `Organization` and `Person` ([schema.org](https://schema.org/ContactPoint)). Whether `Organization` itself has an `email` property could not be confirmed from the page I fetched.
- Prefer role addresses (editor@, info@, contact form) over individuals' addresses, because they fall outside the personal-data questions above.
- **Paid finders:** Hunter.io ([pricing](https://hunter.io/pricing)): Free $0 with 50 credits per month, Starter $49 per month (2,000 credits), Growth $149 per month (10,000), Scale $299 per month (25,000). One credit per email found in Domain Search or Email Finder, and 0.5 credit per verification. Credits do not roll over. API rate limits ([API docs](https://hunter.io/api-documentation/v2)): Domain Search and Email Finder 15 per second and 500 per minute, Email Verifier 10 per second and 300 per minute. No credit is charged when Email Finder finds nothing. Hunter's terms ([terms](https://hunter.io/terms-of-service)) say the user "will remain an independent Controller" under GDPR and must comply with data protection law; they do not mention anti-spam laws. Per-call credit cost for the API: not given on the page I could read.
- **Legal risk of scraping addresses:** the § 7704 harvesting provision above is the one US statute I verified. Broader scraping law (computer-misuse, terms-of-service and EU database rules) was not researched. UNVERIFIED.

## Options compared

| Option | Fit | Cost | Risk | Notes |
|---|---|---|---|---|
| DataForSEO for all four tools | Best. Already integrated; BYO key; no commitment | about $0.02 to $0.60 per run (see below) | `domain_intersection` needs a pair loop; no link flag on Content Analysis | Pay-as-you-go since 2026-07-01 |
| Ahrefs v3 for link_gap and lost_links | Best single call for link gap (`intersect`); `broken-backlinks` gives target status | about 4 units per row, 50 minimum per call (derived) | Needs a paid Ahrefs plan with API access; units can run out | No spam score; no mention search confirmed |
| Semrush v4 | Weak. No intersect or target-status confirmed | 40 to 45 units per line | Local gap computation is expensive | Skip in v1; document as unsupported |
| Gmail native, `gmail.compose` drafts only | Good: enforceable caps, DNC list, audit | Free | Restricted scope; 7-day refresh expiry in Testing; user consent friction | Cannot be scope-limited to "no send" |
| Gmail via AI-app connector | Lowest build and compliance burden | Free | crawlmark cannot enforce sending rules; connector differs per app | Claude connector asks approval per send |
| Hunter.io finder | Good coverage | $0 to $299 per month | Extra vendor, GDPR controller duties | Make optional |

## Recommendation

**(a) Data provider plan and cost per run (client with 5 competitors, 6 domains)**

All costs below are derived from the published rates. Assume 500 rows per call unless stated. These are estimates, not measured.

| Tool | DataForSEO | Ahrefs |
|---|---|---|
| `link_gap` | 10 pairwise `domain_intersection` calls with `exclude_targets=[client]`, `backlinks_filters=[["dofollow","=",true]]`, `limit` 500: 10 × ($0.024 + 500 × $0.000036) = about $0.42. Cap at 1000 rows per call: at most $0.60. | One `link-intersect-refdomains` call, 500 rows × 4 fields = about 2,000 units (50-unit minimum applies below 13 rows) |
| `lost_links` (client + 5 competitors) | 6 `backlinks/live` calls with `is_broken=true`, `mode: one_per_domain`, 500 rows: about $0.25. Wayback: free. | 6 `broken-backlinks` calls. At about 8 units per row for 200 rows: 9,600 units total (assumption) |
| `unlinked_mentions` | 1 to 3 brand terms × 1 `content_analysis/search` call at 500 rows: about $0.04 to $0.13, plus local crawling (free) | `brand-radar/web-pages`: UNVERIFIED |
| Total | about $0.70 to $1.00 per full run | about 12,000 to 20,000 units |

- Build DataForSEO first, since crawlmark already has the client and per-client spend cap. Count each paired call against the monthly cap before it runs, and refuse a run that would exceed it.
- Add Ahrefs link-intersect as the cheaper path (one call) for clients whose data provider is Ahrefs. Gate Semrush to "not supported".
- Caching: cache results per client and target set in SQLite, so re-runs cost nothing. Pairwise runs can reuse earlier pair results.
- Optional but good: an `--approve-spend` style dry-run that prints the planned number of calls and an upper-bound cost before spending.

**(b) Safest Gmail design**
1. **v1: no native Gmail.** Add an `outreach_drafts` tool that stores opportunities and returns ready-to-send drafts (recipient candidates, subject, body with the opt-out line and sender postal address, opportunity ID). Tell the user to hand them to their AI app's Gmail connector, and note the connector's approval prompt before each send. This needs no restricted scope.
2. **v2 (optional): drafts-only native.**
   - Separate `crawlmark-cli auth gmail` login with its own token file, scope `gmail.compose` only (add `gmail.readonly` only if reply tracking is wanted).
   - crawlmark code calls `drafts.create` and never calls `messages.send` or `drafts.send`. The human sends from Gmail. State this limit plainly, because `gmail.compose` technically also allows sending.
   - Guide users to publish their own OAuth client to "In production" (unverified) or accept 7-day re-login while in Testing.
3. **Do not ship send-with-confirmation in v1.** If it is added later, require the explicit per-message confirmation, a hard daily cap (suggest 20 to 25, far below the 500 consumer and 2,000 Workspace limits), and spacing between sends.
4. **Controls in both designs:**
   - A per-client do-not-contact list (domain and address) checked before any draft, plus automatic addition on opt-out.
   - Every draft includes a plain opt-out line ("reply 'no thanks' and I won't email again"), the sender's real name and the client's identity, a physical postal address, an accurate subject, and no deceptive "Re:" or "Fwd:" tricks.
   - At most one follow-up per contact, at least 5 to 7 days later, and none after a reply, bounce or opt-out.
   - No bulk or merged sends, and one contact per domain per campaign.
   - Role addresses and contact forms first.
   - Log every draft or send in SQLite for audit.
   - Honor opt-outs within 10 business days (CAN-SPAM); do it immediately in practice.

**(c) Open risks**
1. DataForSEO `domain_intersection` returns only all-targets intersections. If a user passes 6+ competitors the pair count grows quickly (C(6,2)=15, C(10,2)=45), so cap competitor count for link_gap or switch to the `referring_domains` approach.
2. Whether `rank` and `backlinks_spam_score` can be filtered on `domain_intersection`, whether `domain_pages` supports a status filter, and Ahrefs `where links_to_target` are all UNVERIFIED. Resolve these with a sandbox call or a free Ahrefs target before building.
3. Unlinked-mention accuracy depends on local crawling. Pages blocked by JS rendering or by robots.txt will be misreported, so reuse the existing `render_check` and crawler.
4. Wayback terms and rate limits are not documented in official sources I could read. Use throttling and caching.
5. DataForSEO account state: users on older accounts may still see an "activate Backlinks API" step. Surface API access errors clearly.
6. Restricted Gmail scopes: Testing-mode expiry of 7 days, an unverified-app warning, and Google policy changes. Re-check the exemption wording before launch, since "small group of people you know personally" is Google's phrase and its fit for a public npm package is a judgment call.
7. Legal: whether link-request outreach is "commercial" under CAN-SPAM, and each user's GDPR/PECR duties, need a lawyer if crawlmark is marketed for EU use. crawlmark should ship compliance defaults, not claim compliance.
8. Reputation: one burst of cold email can damage a client's domain or the user's Gmail account (sending blocked for up to 24 hours, possible suspension; see section 7). Warn users to use a sending address that is not the client's main domain.
9. AI-app connectors differ by region and plan (ChatGPT's Gmail features are limited in the EEA, UK and Switzerland per release notes), so the connector route will not work for every user.

## Sources
- [DataForSEO Backlinks domain_intersection](https://docs.dataforseo.com/v3/backlinks/domain_intersection/live/) — accessed 2026-10-30
- [DataForSEO Backlinks page_intersection](https://docs.dataforseo.com/v3/backlinks/page_intersection/live/) — 2026-10-30
- [DataForSEO Backlinks backlinks](https://docs.dataforseo.com/v3/backlinks/backlinks/live/) — 2026-10-30
- [DataForSEO Backlinks referring_domains](https://docs.dataforseo.com/v3/backlinks/referring_domains/live/) — 2026-10-30
- [DataForSEO Backlinks domain_pages](https://docs.dataforseo.com/v3/backlinks/domain_pages/live/) — 2026-10-30
- [DataForSEO Backlinks bulk_pages_summary](https://docs.dataforseo.com/v3/backlinks/bulk_pages_summary/live/) — 2026-10-30
- [DataForSEO Backlinks filters](https://docs.dataforseo.com/v3/backlinks/filters/) — 2026-10-30
- [DataForSEO Backlinks overview](https://docs.dataforseo.com/v3/backlinks/overview/) — 2026-10-30
- [DataForSEO Content Analysis search](https://docs.dataforseo.com/v3/content_analysis/search/live/) — 2026-10-30
- [DataForSEO Content Analysis pricing](https://dataforseo.com/pricing/content-analysis) — 2026-10-30
- [DataForSEO Backlinks pricing](https://dataforseo.com/pricing/backlinks/backlinks) — 2026-10-30
- [DataForSEO pricing update, 2026-07-01](https://dataforseo.com/update/pricing-update-in-dataforseo-apis) — 2026-10-30
- [DataForSEO Backlinks API page](https://dataforseo.com/backlinks-data-api) — 2026-10-30
- [Ahrefs API OpenAPI document](https://docs.ahrefs.com/openapi.json) and [Site Explorer spec](https://docs.ahrefs.com/reference/site-explorer.json) — 2026-10-30
- [Ahrefs API limits and consumption](https://docs.ahrefs.com/api/docs/limits-consumption.md) and [free test queries](https://docs.ahrefs.com/api/docs/free-test-queries.md) — 2026-10-30
- [Semrush API v4 Backlinks](https://developer.semrush.com/api/v4/seo/backlinks/) and [v3 Backlinks](https://developer.semrush.com/api/v3/analytics/backlinks/) — 2026-10-30
- [Wayback availability API](https://archive.org/help/wayback_api.php) and [CDX server README](https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md) — 2026-10-30
- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Gmail quota](https://developers.google.com/workspace/gmail/api/reference/quota), [about auth](https://developers.google.com/workspace/gmail/api/auth/about-auth) — 2026-10-30
- [Google OAuth 2.0 token expiration](https://developers.google.com/identity/protocols/oauth2#expiration), [Manage app audience](https://support.google.com/cloud/answer/15549945), [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) — 2026-10-30
- [Gmail sending limits (Workspace)](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace), [Gmail sending limits (consumer)](https://support.google.com/mail/answer/22839), [Email sender guidelines](https://support.google.com/a/answer/81126) — 2026-10-30
- [FTC CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business), [15 U.S.C. 7704](https://www.law.cornell.edu/uscode/text/15/7704) — 2026-10-30
- [ICO PECR electronic mail marketing](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/electronic-and-telephone-marketing/electronic-mail-marketing/), [GDPR Art. 6 (mirror)](https://gdpr-info.eu/art-6-gdpr/) — 2026-10-30
- [Claude Gmail connector help](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) — 2026-10-30
- [OpenAI plugins docs](https://learn.chatgpt.com/docs/plugins), [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) (via search summary) — 2026-10-30
- [Cursor MCP docs](https://cursor.com/docs/context/mcp) — 2026-10-30
- [schema.org ContactPoint](https://schema.org/ContactPoint) — 2026-10-30
- [Hunter pricing](https://hunter.io/pricing), [Hunter API docs](https://hunter.io/api-documentation/v2), [Hunter terms](https://hunter.io/terms-of-service) — 2026-10-30
- Local: `src/lib/google-auth.ts`, `docs/research/ahrefs-api-v3.md`, `docs/research/semrush-api.md`
