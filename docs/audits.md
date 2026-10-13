# Audits, opportunities and site checks

Reference for what the audit and opportunity tools check. The [README](../README.md#tools) lists the tools.

## Saved audits and diffs

Every `run_audit` is saved and returns an `auditId`. Runs are fresh by default (the response cache is skipped, so the on-page check is a paid call per page); `fresh: false` reuses results up to a day old, and `compare_audits` warns when the later audit was not fresh.

`compare_audits` diffs two saved audits (default: latest vs the one before) into `new`, `resolved`, `persistent` and `unverified` findings plus Lighthouse score changes. A finding is `resolved` only if its check ran in the later audit; otherwise it is `unverified`.

`monthly_report` includes the latest saved audit plus its diff against the most recent audit from before the month (`null` unless both exist).

## Rendered vs raw HTML

`render_check` (and the `rendering` section of `run_audit`) fetches a URL as plain HTML (Googlebot-like user agent) and as rendered by headless Chrome, extracts title, description, canonical, robots, H1s, links, JSON-LD types, hreflang, Open Graph and visible word count from each, and flags SEO elements that only exist after JavaScript runs: `title-js-only`, `title-mismatch`, `canonical-mismatch`, `robots-js-only`, `content-js-dependent`, `jsonld-js-only`, `links-js-only` and others. Cached for a day; `refresh` bypasses.

## Site hygiene

`site_hygiene({ client })` (and the `site.hygiene` section of `run_audit`, which feeds findings with source `site`) runs five checks. Fetches are cached for a day; the whole run stops after 2 minutes.

| Check | Findings (rule: severity) |
| --- | --- |
| robots.txt (groups `*` and `Googlebot`, `Allow`/`Disallow` longest match, `Sitemap:` lines) | `robots-missing`: low; `robots-disallow-all`: high; `robots-blocks-key-page`: high; `robots-no-sitemap`: low |
| Sitemaps, found via robots.txt and Search Console (or `/sitemap.xml` if neither lists one). Indexes are followed to depth 2 and 50 child sitemaps; `.xml.gz` files are decompressed. Up to 50 URLs, spread evenly, are fetched | `sitemap-non200`: high for 4xx/5xx, else medium; `sitemap-redirect`: medium; `sitemap-noindex` (meta robots or `X-Robots-Tag`): high; `key-page-not-in-sitemap`: medium |
| Structured data on key pages: required properties for Organization, LocalBusiness (and subtypes), Product, BreadcrumbList and FAQPage; recommended properties for Article, BlogPosting, NewsArticle and similar. Basic validation, not Google's Rich Results Test | `schema-missing-property`: medium; `schema-missing-recommended`: low; `schema-parse-error`: low |
| hreflang on key pages, read from three sources and merged: `<link rel="alternate" hreflang>` tags in the page HTML, `xhtml:link` entries in the sitemaps (already fetched, no extra requests), and HTTP `Link:` response headers (raw fetch only, not for pages read from their rendered DOM). Duplicates are merged and each alternate records its source(s). Checks: self-reference, `x-default` when 2+ languages, reciprocity (an alternate can link back through any source), and conflicts (the same hreflang pointing at different URLs in different sources). At most 20 alternates per page are fetched, whichever source they came from | `hreflang-missing-self`: medium; `hreflang-not-reciprocal`: medium; `hreflang-missing-x-default`: low; `hreflang-conflict`: medium |
| Orphan pages: sitemap URLs that a stored DataForSEO full crawl (from an earlier `run_audit` with `fullCrawl`) never reached. No crawl is started. Reports `orphans.available: false` with a reason when there's no usable crawl | `orphan-page`: medium, one per orphan |

A sub-check that could not finish (fetch error, a cap reached, or the time budget running out) is not recorded as checked, so `compare_audits` shows its old findings as `unverified` instead of `resolved`. Sitemap URLs and child sitemaps are only followed on the client's domain and its subdomains.

## Tag Manager audit

`gtm_audit` reads the client's live (published) container through the Tag Manager API and flags:

| Finding | Severity |
|---|---|
| Legacy Universal Analytics tags | medium |
| Tags with no firing trigger | medium |
| More than one GA4 configuration / Google tag for one measurement ID | medium |
| Tags missing consent settings when Consent Mode is used elsewhere in the container | medium |
| Paused tags | low |
| Variables and triggers no tag uses | low |
| Custom HTML tags (listed for review) | low |

It also counts unpublished changes per workspace. The Consent Mode check is a heuristic: it runs only when some tag requires consent or a Consent Initialization trigger exists, and skips tag types with built-in consent checks. Tag Manager findings are not part of `run_audit` yet.

## Opportunities

Free Search Console tools that find where more clicks are likely. Each takes `client`, optional `startDate`/`endDate` (both or neither; default is the last 28 days ending 3 days ago, since Search Console lags 2-3 days), `includeBranded` (default false), `limit` (default 25) and the thresholds below. Each returns the window used, `total` found, and a `method` string describing the thresholds.

| Tool | Finds | Defaults |
|---|---|---|
| `striking_distance` | Queries at positions 5-20: query, top page, position, impressions, clicks, CTR, estimated extra clicks if they reached position 3 | `minPosition` 5, `maxPosition` 20, `minImpressions` 100 |
| `quick_wins` | Pages at positions 11-20 with their top 3 queries | `minPosition` 11, `maxPosition` 20, `minImpressions` 100 |
| `low_ctr` | Queries at positions 1-5 with CTR under 60% of expected: title and meta rewrite candidates | `ctrRatio` 0.6, `minImpressions` 100 |
| `cannibalization` | Queries where 2+ pages each hold at least 10% of the impressions | `minShare` 0.1, `minImpressions` 100 |
| `declining_pages` | Pages whose clicks fell versus the previous equal-length period, with the queries that lost the most | `minDropPct` 30, `minClickLoss` 10 |

Estimates use the expected-CTR-by-position curve in `src/analysis/ctr-curve.ts`, an editable industry-average approximation: treat the numbers as a ranking signal, not a forecast. Small sites often return nothing at the default thresholds; lower `minImpressions` to see more.
