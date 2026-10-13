# Audits, opportunities and site checks

Reference for what the audit and opportunity tools check. The [README](../README.md#tools) lists the tools.

## Saved audits and diffs

Every `run_audit` is saved and returns an `auditId`. Runs are fresh by default (the response cache is skipped, so the on-page check is a paid call per page); `fresh: false` reuses results up to a day old, and `compare_audits` warns when the later audit was not fresh.

`compare_audits` diffs two saved audits (default: latest vs the one before) into `new`, `resolved`, `persistent` and `unverified` findings plus Lighthouse score changes. A finding is `resolved` only if its check ran in the later audit; otherwise it is `unverified`.

`monthly_report` includes the latest saved audit plus its diff against the most recent audit from before the month (`null` unless both exist).

## Rendered vs raw HTML

`render_check` (and the `rendering` section of `run_audit`) fetches a URL as plain HTML (Googlebot-like user agent) and as rendered by headless Chrome, extracts title, description, canonical, robots, H1s, links, JSON-LD types, hreflang, Open Graph and visible word count from each, and flags SEO elements that only exist after JavaScript runs: `title-js-only`, `title-mismatch`, `canonical-mismatch`, `robots-js-only`, `content-js-dependent`, `jsonld-js-only`, `links-js-only` and others. Cached for a day; `refresh` bypasses.

## Site hygiene

`site_hygiene({ client })` (and the `site.hygiene` section of `run_audit`, which feeds findings with source `site`) runs seven checks. Fetches are cached for a day; the whole run stops after 2 minutes.

| Check | Findings (rule: severity) |
| --- | --- |
| robots.txt (groups `*` and `Googlebot`, `Allow`/`Disallow` longest match, `Sitemap:` lines). Only the first 500 KiB is read, as RFC 9309 allows and Google does; the result says so when a file is longer | `robots-missing`: low; `robots-disallow-all`: high; `robots-blocks-key-page`: high; `robots-no-sitemap`: low |
| Sitemaps, found via robots.txt and Search Console (or `/sitemap.xml` if neither lists one). Indexes are followed to depth 2 and 50 child sitemaps; `.xml.gz` files are decompressed. Up to 50 URLs, spread evenly, are fetched | `sitemap-non200`: high for 4xx/5xx, else medium; `sitemap-redirect`: medium; `sitemap-noindex` (meta robots or `X-Robots-Tag`): high; `key-page-not-in-sitemap`: medium |
| Structured data on key pages: required properties for Organization, LocalBusiness (and subtypes), Product, BreadcrumbList and FAQPage; recommended properties for Article, BlogPosting, NewsArticle and similar. Basic validation, not Google's Rich Results Test | `schema-missing-property`: medium; `schema-missing-recommended`: low; `schema-parse-error`: low |
| hreflang on key pages, read from three sources and merged: `<link rel="alternate" hreflang>` tags in the page HTML, `xhtml:link` entries in the sitemaps (already fetched, no extra requests), and HTTP `Link:` response headers (raw fetch only, not for pages read from their rendered DOM). Duplicates are merged and each alternate records its source(s). Checks: self-reference, `x-default` when 2+ languages, reciprocity (an alternate can link back through any source), and conflicts (the same hreflang pointing at different URLs in different sources). At most 20 alternates per page are fetched, whichever source they came from | `hreflang-missing-self`: medium; `hreflang-not-reciprocal`: medium; `hreflang-missing-x-default`: low; `hreflang-conflict`: medium |
| AI crawler access, from the same robots.txt. For GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, anthropic-ai, PerplexityBot, Perplexity-User, Google-Extended, Applebot-Extended, CCBot, Bytespider, Meta-ExternalAgent and Amazonbot it reports the purpose (`search`, `user` or `training`), the group that applies (`named` or `*`), whether the homepage is allowed, which key pages are blocked, and overall `allowed`, `partial` or `blocked` (the whole site). Blocking an AI search or answer crawler hides the site in that product; blocking a training-only crawler is a legitimate choice, so it's data only. ChatGPT-User and Perplexity-User may ignore robots.txt, so their blocks are data only too. Sources: [research note](research/2026-10-13-llms-txt.md) | `ai-search-crawler-blocked`: low, one per blocked page, listing the crawlers ("if this is intended, ignore it"). Not raised when `robots-disallow-all` or `robots-blocks-key-page` already covers the same `*` block |
| llms.txt (informational). `/llms.txt` and `/llms-full.txt` are fetched with the same guarded fetch: present or missing (404/410, or an HTML page), HTTP status, content type and size. llms.txt is checked against the [llmstxt.org](https://llmstxt.org/) proposal: one H1 title first, an optional blockquote summary and prose, then H2 sections of `- [name](url): notes` links, with an optional "Optional" section. Only the structure is judged (no H1, content before it, more than one H1, a deeper heading before the first H2, H2 sections without links); any top-level list item that starts with a link counts as one, whatever style its notes use. Up to 10 linked URLs on the same host are fetched to find ones that don't return 200. llms.txt is a proposed standard that Google says Google Search doesn't use, so it's reported for information, not scored: a missing file is not a finding | `llms-txt-malformed`: low; `llms-txt-broken-link`: low, one per linked URL |
| Orphan pages: sitemap URLs that a complete crawl never reached. The newest complete crawl from the last 30 days is used: a free [local crawl](#local-crawl) (`orphans.source: "local"`, with its `crawlId`) or a stored DataForSEO full crawl (from an earlier `run_audit` with `fullCrawl`); if the DataForSEO one hit its page cap, an older complete local crawl is used instead. No crawl is started. Reports `orphans.available: false` with a reason when there's no usable crawl | `orphan-page`: medium, one per orphan |

The result has `llmsTxt` and `aiCrawlers` next to the other checks. llms.txt content is untrusted: crawlmark keeps only counts, the title (control characters removed) and the link URLs it checks, and reports show the title as escaped text and URLs as code. Saved audits from before these checks have neither field.

A sub-check that could not finish (fetch error, a cap reached, or the time budget running out) is not recorded as checked, so `compare_audits` shows its old findings as `unverified` instead of `resolved`. Sitemap URLs and child sitemaps are only followed on the client's domain and its subdomains. With `RESTRICT_TO_CLIENT_DOMAINS=true`, every hygiene fetch and each of its redirect hops must stay on the client's domain; a redirect elsewhere is refused and that page isn't checked. Sampled llms.txt links, and their redirects, always stay on llms.txt's own host, and llms.txt isn't checked at all when robots.txt redirected off the client's domain. An llms.txt that can't be read (a server error or a timeout) is not checked, so its earlier findings show as `unverified`; a later run resolves a broken-link finding only if it fetched that link again.

## Local crawl

`local_crawl` (and `crawlmark-cli crawl`, and `run_audit` with `localCrawl: true`) crawls the client's own site from your machine. It's free: the only requests go to the client's site.

- **Scope.** Starts from the homepage and the client's key pages (never sitemap URLs, so orphans can be found) and follows links breadth-first on the same host, with or without `www.`. `includeSubdomains: true` adds subdomains. Links to other sites are counted but not fetched.
- **Politeness.** Reads robots.txt first and obeys the `crawlmark` group (or `Googlebot` with `userAgent: "googlebot"`, which also sends Googlebot's user agent), else `*`. A robots.txt that returns a server error or can't be read means nothing on that host is crawled. `Crawl-delay` is honoured up to 10 seconds; otherwise requests to one host are at least 250 ms apart. The user agent is `crawlmark/<version> (+https://github.com/idrewlong/crawlmark-mcp)`.
- **Safety.** Every URL, including each redirect hop, goes through the same guard as the other tools: http(s) only, every resolved address public (unless `ALLOW_PRIVATE_URLS=true`), the connection pinned to the checked addresses, and `RESTRICT_TO_CLIENT_DOMAINS` applied. At most 5 redirect hops; a redirect off the site is recorded, not followed.
- **Limits.** `maxPages` 300 by default (up to 2,000), `maxDepth` 10 (up to 20), `concurrency` 4 (up to 8), HTML only, 2 MB per page, 15 seconds per request, 10 minutes per crawl (4 minutes inside `run_audit`). No JavaScript rendering; use `render_check` for that.
- **Exhaustive.** A crawl is exhaustive when it followed every internal link it found: no cap reached, no page that failed (including a server error or a 429 rate limit) or couldn't be parsed, no page cut at the size cap. Only an exhaustive crawl judges orphans or clears duplicate findings, and orphans also need the crawl to have started at the homepage (the default; `startUrls` without the homepage turns them off).
- **Ports.** Links and redirects to another port on the client's host are out of scope unless a start URL uses that port.

| Finding (source `crawl`) | Severity |
|---|---|
| `broken-internal-link`: a linked page returns 4xx or 5xx (evidence: the first linking page and the link count) | high |
| `missing-title` | high |
| `redirect-chain`: two or more hops | medium |
| `duplicate-title`, `missing-description`, `canonical-to-non-200` | medium |
| `internal-link-to-redirect`, `duplicate-description`, `canonical-elsewhere`, `deep-page` (more than 4 clicks from the start pages), `noindex-linked` | low |

`local_crawl` returns a summary (pages by status, redirects, broken links, duplicate and missing titles and descriptions, canonical issues, noindex pages, a depth histogram and the orphan count) and the top 50 findings. The crawl is saved (the newest 10 per client); `local_crawl_pages` lists its pages with their issues, and the `site_crawl` report section summarises the newest one.

In a saved audit, every page the crawl checked is recorded, so `compare_audits` resolves a crawl finding only when the later audit's crawl fetched that page again. Duplicate and canonical-target findings resolve only after a later exhaustive crawl; an audit without `localCrawl` leaves earlier crawl findings `unverified`.

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

It also counts unpublished changes per workspace. The Consent Mode check is a heuristic: it runs only when some tag requires consent or a Consent Initialization trigger exists, and skips tag types with built-in consent checks.

**In `run_audit` (opt-in).** `run_audit` with `includeTagManager: true` (or `crawlmark-cli audit --include-tag-manager`) adds the container audit as `site.tagManager` and its findings with source `gtm`, URL `gtm://<publicId>/<kind>/<id>`. They are medium or low, so scheduled audits never alert on them. A later audit run without the option lists earlier Tag Manager findings as `unverified`, never `resolved`. Default audits, `monthly_report` and the starter report template leave Tag Manager out.

## Core Web Vitals history (CrUX)

`crux_history` reads the Chrome UX Report History API: the 75th percentile of LCP, INP, CLS, FCP and TTFB for each weekly period (a 28-day window, updated Mondays), 25 periods by default and up to 40. Each period gets a rating (LCP good up to 2,500 ms and poor above 4,000; INP 200 / 500 ms; CLS 0.1 / 0.25; FCP 1,800 / 3,000 ms; TTFB 800 / 1,800 ms) and each metric a trend: the mean of the last 4 periods with data against the first 4, flat within 5%. `available: false` means Chrome has too little traffic data for that origin or URL. Cached for a day.

`run_audit` with `cruxHistory: true` adds it for the client's origin as `site.cruxHistory` and adds `crux` findings from the latest period: `field-lcp-poor` (high), `field-lcp-needs-improvement` (medium), and the same for INP and CLS. Off by default.

## Server logs

`log_analysis` (and `crawlmark-cli logs`) reads web server access logs on your machine and counts what crawlers asked for. **Logs never leave the machine**: nothing is uploaded, nothing is written to crawlmark's database, and the result holds aggregates only. IP addresses, full user agents, referrers and raw lines are never returned or stored; paths are shown without query strings or `;`-parameters (such as `;jsessionid=`), anything from an encoded `%3F` on is dropped, and token-like segments (UUIDs and long mixed letter-and-digit strings) appear as `:token`. Only regular files are read: symlinks that point outside the allowed folders, FIFOs and hard-linked files are refused, and every name that can't be read gets the same message, so nothing is revealed about files outside them.

- **Which files.** The tool reads only regular files inside the directories in `LOG_DIRS` (comma-separated absolute paths) or the `logs` folder in your crawlmark home. Name files relative to one of them, with `*` and `?` allowed in the file name (`access.log*`, `nginx/example.com.access.log`). `..`, absolute paths elsewhere and symlinks that point outside are refused. Without `LOG_DIRS` or a `logs` folder the tool is unavailable and says how to set it up. `crawlmark-cli logs --client example.com /var/log/nginx/access.log` reads the files you type, with no setting needed.
- **Formats.** Apache and Nginx `combined` and `common`, detected per file, plain or `.gz`. Other lines are counted as skipped. The common format has no user agent, so its hits can't be attributed to bots.
- **Limits.** At most 50 files, 2 GB (after decompression) and 20 million lines per call; lines over 16 KB are skipped.
- **Bots.** Googlebot, Google-InspectionTool, GoogleOther, Bingbot, GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, CCBot, Applebot, Amazonbot, Bytespider and Meta-ExternalAgent, each with a family (Amazonbot is `ai-training`, as Amazon's own page describes it): `search`, `ai-training`, `ai-search`, `ai-user` or `other`. Google-Extended is a robots.txt token only and never appears in logs. The table is in `src/analysis/bots.ts`.
- **Verification.** Googlebot, Google-InspectionTool and GoogleOther hits are checked against Google's published crawler IP ranges (`common-crawlers.json` and `special-crawlers.json`), downloaded at most once a week. The download is a plain request for a public file and sends nothing about you or your logs. A hit from inside the ranges is `verified`, outside is `unverified` (someone using Googlebot's name). Other bots are `unknownVerification`; there is no reverse-DNS lookup. `verify: false` (`--no-verify`) makes no network request at all.

Per bot it returns hits, verified / unverified / unknown counts, 2xx/3xx/4xx/5xx counts, the top 20 paths, top 404 and 5xx paths, hits per day, the share of hits on URLs with a query string, and when it was last seen.

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
