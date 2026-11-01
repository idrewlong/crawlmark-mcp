# Field notes triage: which reported crawlmark problems are real, checked against the source
Date: 2026-11-01 · Author: my-skills:researcher · Requested by: orchestrator · Status: final (D1's SQLite part is still "likely": the exact error text is missing)

Scope: we checked each field-note claim (written from the compiled npm 0.1.3) against `main` (0.1.3 plus a lockfile fix and docs). Nothing was edited. We made no paid or live Google calls. Local checks: `test/lighthouse-real.test.ts` (9/9 pass, 52 s), a parallel-Lighthouse script in the scratchpad against the repo's fixture site, and a SQLite lock test on a scratch database.

## Answer (TL;DR)
- Most claims are accurate. Two need correcting: D1's "SQLite error" did not reproduce, and D9a only partly holds. We did reproduce a separate D1 cause: two Lighthouse runs at once in one process make one of them fail. Confidence: high.
- These accuracy bugs are confirmed in the source and are cheap to fix:
  - **D7:** URL Inspection is sent the URL with its trailing slash removed. On sites whose URLs end in `/`, Google then reports "URL is unknown to Google".
  - **D8:** a finding counts as "new" even when the earlier audit never checked that page or source.
  - **D2:** the Tag Manager container is never checked against the `GTM-` ID in the live page.
  - **D3 and D4:** there is no per-client GA4 hostname filter and no Search Console query exclusion.
- The report items (R1 to R6) are gaps in features, not regressions. R5 (Google Docs) can be done without adding a Drive scope: the user's Drive connector already accepts a base64 `.docx` and converts it to a Google Doc.

## Findings (one block per item)

Each block gives: (1) whether the claim is accurate, (2) the root cause, (3) what already partly covers it, (4) the fix, (5) the size, (6) the severity.

### D1 Lighthouse fails with a SQLite error or times out
1. **Partly accurate.**
   - **Reproduced, but not as a SQLite error:** two `runLighthouse` calls at once in one process. One succeeds. The other fails after about 11 s with `SyntaxError: The "start lh:runner:gather" performance mark has not been set`, plus `LanternError: Could not find any top level events`. With 6 at once, 5 of 6 failed. The setup was Lighthouse 13.5.0 and a script in the scratchpad that ran `runLighthouse` against `test/helpers/fixture-site.ts`.
   - **Why it happens:** Lighthouse keeps global performance marks and trace state for each process. Nothing in crawlmark serialises Lighthouse across tool calls. `run_audit` runs pages one at a time (`src/reports/audit.ts:147-152`), but parallel `lighthouse` tool calls from the model, or a `lighthouse` call during `run_audit`, overlap. Searching for a semaphore or a browser slot finds nothing.
   - **The SQLite error is not reproduced.** The Lighthouse path holds no transaction while Chrome runs. `cached()` reads, runs Chrome, then does one `INSERT OR REPLACE` (`src/lib/cache.ts:24-40`). The usage-log write is wrapped in try/catch (`src/tools/util.ts:52-64`). Every `BEGIN`…`COMMIT` in `src` is synchronous with no `await` inside (`src/lib/crawls.ts:47-66`, `issue-snapshots.ts:79-108`, `rank-history.ts:102-125`, `provider-data.ts:63-84`), so nothing in the same process can block it.
   - **The likely SQLite failure:** another crawlmark process holds the write lock for more than `busy_timeout = 5000` (`src/lib/store.ts:18`). That could be Claude Desktop, Claude Code and the cron CLI all sharing `~/.crawlmark/data/crawlmark.db`. Another possibility is a filesystem where WAL can't be used (`store.ts:20-24` falls back silently).
   - **What that failure looks like:** in a scratch database, a cache write under a lock held by another process fails after 5,216 ms with `ERR_SQLITE_ERROR 5 database is locked`. Because the cache write runs **after** Lighthouse (`cache.ts:38`), a completed 30 to 60 s run is thrown away when that write fails. We need the user's exact error text to confirm.
   - **Timeouts:** the tool-level limit is 90 s for everything (`src/tools/raw.ts:30,289`; `TIMEOUTS.browserMs`, `src/lib/timeout.ts:4`). That includes DNS checks, Chrome start, Lighthouse and the PSI fetch, while the description says "~30s". `withChrome` also has its own 90 s limit (`src/providers/browser.ts:142`). A heavy mobile page behind the egress proxy can pass 90 s. So can any run slowed by a second Chrome on the machine.
2. **Root cause:** concurrent Lighthouse runs in one process (confirmed). Cache writes are fatal after an expensive run (confirmed in code). The lock source is likely cross-process. The 90 s budget is tight.
3. **Already covered:** `busy_timeout` and WAL (`store.ts:16-24`, test `test/store-busy.test.ts`). `run_audit` already serialises its own pages.
4. **Fix:**
   - Add a process-wide FIFO mutex around `runLighthouse`. Start the timeout after the slot is taken, so queued calls don't use up their 90 s waiting.
   - Make the cache write in `cached()` best effort for free providers: catch `SQLITE_BUSY`, log it, and still return the result.
   - Raise the Lighthouse tool limit to about 150 s, and include the error code in the message.
5. **Size:** S
6. **Severity:** accuracy/reliability bug

### D2 Wrong Tag Manager container matched by name
1. **Mostly accurate, but "by name" is usually not the mechanism.**
   - Discovery matches containers by their **domain list** first. When several containers list the host, the lowest `GTM-` ID wins (`src/lib/gtm.ts:87-123`). Name matching only applies to containers that list no domains (`gtm.ts:111-117`).
   - So an old container that still lists the domain can win just because its ID sorts first.
   - `gtm_audit` never compares the chosen container with the `GTM-XXXX` actually on the live page. `src/providers/gtm.ts:145-165` and `src/reports/gtm.ts:27-49` have no HTML fetch. The only `GTM-`/`googletagmanager` references in `src` are in the GTM modules.
2. **Root cause:** ambiguous matches are settled by ID order, not by what the live site loads.
3. **Already covered:**
   - Pinning `gtmContainerId` (numeric or `GTM-XXXX`, `gtm.ts:154-157`) and `gtmAccountId` in `clients.yaml` (`src/lib/clients.ts:391-393`). A pin turns discovery off (`clients.ts:604`).
   - Discovery notes list the alternate containers (`gtm.ts:145-159`).
   - However, `set_client_profile` has no GTM field (`src/tools/competitors.ts:136-165`), and neither does `clients set` (`src/cli.ts:411`). Today the only way to pin is editing the YAML by hand.
4. **Fix:**
   - In `gtm_audit` (and the audit section), fetch the homepage through the guarded raw fetch and extract `GTM-[A-Z0-9]+`.
   - If the chosen container isn't on the page and one of the alternates is, use that alternate and add a note. If none match, warn.
   - Add `gtmContainerId` to `set_client_profile` and to `clients set --gtm-container`.
5. **Size:** S to M
6. **Severity:** accuracy bug

### D3 GA4 mixes the old site, staging and localhost
1. **Accurate.** `ga4Report` only filters by channel when `organicOnly` is set (`src/providers/ga4.ts:48-55`). `ga4_report` exposes no filter at all (`src/tools/raw.ts:118-131`). Nothing in `src` uses `hostName`.
2. **Root cause:** there is no hostname dimension filter.
3. **Already covered:** nothing.
4. **Fix:**
   - Add `ga4Hostnames: string[]` to `clients.yaml` and `set_client_profile`.
   - Default to the client domain and `www.`.
   - AND an `inListFilter` on `hostName` into every `dimensionFilter`, and include it in the cache key.
   - Add an optional hostname list to `ga4_report`.
5. **Size:** S
6. **Severity:** accuracy bug

### D4 Automated or bot queries skew Search Console totals
1. **Accurate.** `gscQuery` supports `contains` and `includingRegex` only (`src/providers/gsc.ts:57-63`). There is no per-client exclusion and no spike detection. The only alert is a traffic drop (`src/analysis/alerts.ts:16,35`).
2. **Root cause:** not built. One caveat for the design: totals come from a query with no dimensions (`gsc.ts:90-93`), which includes anonymised queries. You cannot exclude queries from that number exactly.
3. **Already covered:** the branded split (`brandTerms`). `queryRegex` for including queries.
4. **Fix:**
   - Add `gscExcludeQueries` (an RE2 regex) to the client profile.
   - Apply `excludingRegex` to the query-dimension sections.
   - For totals, show "adjusted = total − excluded queries' clicks/impressions", marked as an estimate.
   - Add an impressions-spike check: daily impressions above the 28-day median times 3, with flat clicks, flagged as "possible automated queries".
5. **Size:** M
6. **Severity:** accuracy/missing feature

### D5 Search Console only keeps 16 months
1. **Accurate: crawlmark doesn't keep GSC history.**
   - `seo_snapshots` only stores `backlinks` and `visibility` from paid providers (`src/lib/snapshots.ts:13-14`).
   - GSC responses sit in the general cache for 1 day (`gsc.ts:66`).
   - The only GSC history saved is `rank_history` with `source = "gsc"`: daily positions, clicks and impressions for **tracked keywords only** (`src/lib/rank-history.ts:10`, `src/ranks.ts:371`).
2. **Root cause:** never designed in.
3. **Already covered:** `rank_history` for tracked keywords, and the `rank_trend` section (up to 365 days).
4. **Fix:**
   - Add a `gsc_monthly` table: client, month, totals, top N pages, top N queries, device and country. Write it on every `monthly_report` and report run.
   - Add a one-off CLI `crawlmark-cli gsc backfill` that pulls the last 16 months now.
   - Yearly sections read this table for anything older than 16 months.
5. **Size:** M
6. **Severity:** missing feature. Act soon: every month without it loses a month for good.

### D6 Crawl reached only 108 of 253 pages
1. **Plausible and explained by design.**
   - `local_crawl` only follows links from the homepage and key pages. Sitemap URLs are deliberately never used as start points, so that orphans can be found (`src/reports/local-crawl.ts:69-72`, `src/tools/crawl.ts:43`).
   - The crawl is HTML only, with no JavaScript, so links in menus built by JavaScript are missed.
   - Limits: 300 pages by default, depth 10, 10 minutes (`src/providers/crawler.ts:24-30`). Inside `run_audit` the time limit is **4 minutes** (`src/reports/audit.ts:43`). A `Crawl-delay` of 2 s would stop at about 120 pages.
   - Unreached sitemap URLs are counted as orphans but **never fetched**, so their titles, descriptions and H1s are never checked.
2. **Root cause:** no sitemap phase. There are rules for a missing title or description (`src/analysis/crawl.ts:48-59`), but no `missing-h1` rule (only `h1Count` is recorded, `crawl-parse.ts:69`) and no check for a brand name repeated in titles.
3. **Already covered:** `stoppedBy` and the cap/time notes (`crawler.ts:430-431`). Orphan detection. `local_crawl_pages` shows the H1 count.
4. **Fix:**
   - Add `includeSitemapUrls` (default on): after the link crawl, fetch unreached sitemap URLs (marked `orphan`, depth null) under the same caps, and run the same on-page rules on them.
   - Add the rules `missing-h1`, `multiple-h1`, `title-brand-repeated` (the client name or a brand term appears at least twice), and `description-empty` (blank content).
5. **Size:** M
6. **Severity:** accuracy/missing feature

### D7 Index sample falsely reported 49 URLs as "unknown to Google"
1. **Accurate. This is a confirmed bug.**
   - `planPool` normalises every candidate URL with `normalizeUrl`, which **removes trailing slashes** (`src/analysis/findings.ts:39-47`, `src/analysis/indexing.ts:86-91`).
   - It then sends that normalised URL to the API: `deps.inspect(client, p.url)` → `inspectionUrl: url` (`src/reports/indexing.ts:285`, `src/providers/gsc.ts:139`).
   - On a site whose URLs end in `/`, `/about/` is inspected as `/about`. That is a redirecting URL Google may never have crawled, so it comes back as "URL is unknown to Google".
   - `gsc_inspect_url` and the audit pass the URL unchanged, so only the batch sampler is affected.
2. **Root cause:** the normalised form is used both as the dedupe key and as the URL sent to the API.
3. **Already covered:** nothing.
4. **Fix:**
   - Keep the original URL (from the sitemap, GSC top pages or key pages) in `PoolEntry` and send that to the API.
   - Keep `normalizeUrl` only for dedupe and storage keys.
   - Re-inspect the stored "unknown" results that were affected.
5. **Size:** S
6. **Severity:** accuracy bug (high: it produces false alarms in client reports)

### D8 Audit comparisons mislead
1. **Accurate.**
   - **`compare_audits`:** `added = target.findings.filter(f => !baseIds.has(f.id))` (`src/analysis/diff.ts:55`). This has no "did the base check this?" test. Removed findings do get that test (`resolved` against `unverified`, `diff.ts:58-59`), so the logic is asymmetric. A page or source added since the base shows all its findings as "new".
   - **`technical_issues`:** same pattern, `change: before.has(itemId) ? "persistent" : "new"` (`src/analysis/tech-issues.ts:198`).
   - **GTM:** findings are keyed `gtm://<publicId>/...` and the check key is `gtm://<publicId>` (`findings.ts:89-97,263-271,304`). When the audited container changes, every old-container finding becomes "unverified" in `compare_audits`. In `technical_issues` it can even count as "resolved", because an audit rerun with the gtm check clears it (`tech-issues.ts:171-185`). All new-container findings show as "new". Nothing says "the container changed".
2. **Root cause:** "new" never consults `base.checked`, and the container identity isn't compared.
3. **Already covered:** the `unverified` bucket, the `resolved` rule that requires a re-check, and the settings warnings (`diff.ts:77-84`).
4. **Fix:**
   - Mark a finding as `new` only when `base.checked` contains its check key. Otherwise use a new `firstChecked` bucket.
   - Warn when the page lists differ.
   - When the container changes, move old findings to `retired` and add a warning naming both IDs. Apply the same to `diffIssues`.
5. **Size:** S to M
6. **Severity:** accuracy bug

### D9a setup_status suggests a `crawlmark-cli` that isn't on PATH
1. **Partly accurate.**
   - `setup_status` itself builds its `next` steps with `commandPrefix`. That gives `npx crawlmark-mcp` when `crawlmark-cli` isn't on PATH (`src/setup/status-providers.ts:68-90`), and `src/index.ts` sends subcommands to the CLI.
   - But dozens of error messages hardcode `crawlmark-cli`: `LOGIN_COMMAND` (`src/lib/google-auth.ts:34`, used at :113, :132, :218, :252, :256, :304, :326), `google-access.ts:25-59`, `bing.ts:250-255`, `url-guard.ts:206`, `indexing.ts:348`, and others. That is most likely what the session saw.
   - Also, the npx form has no `@latest`, while the registered server runs `npx -y crawlmark-mcp@latest` (`src/setup/apps.ts:87-92`). An old cached copy may run instead.
   - The package bins are `crawlmark-mcp` and `crawlmark-cli` (`package.json` `bin`). `npx -y crawlmark-mcp@latest <subcommand>` works.
2. **Root cause:** hardcoded strings.
3. **Already covered:** `cliPrefix()`. `seo-data.ts:327-334` already uses it lazily.
4. **Fix:**
   - Replace the hardcoded strings with a lazily resolved `cliPrefix()`.
   - Change the npx base to `npx -y crawlmark-mcp@latest`.
5. **Size:** S
6. **Severity:** polish

### D9b A rejected Semrush key blocks backlinks
1. **Accurate, by design.**
   - Routing rule 4: "chosen has it but no key: unavailable (never falls back, D2)" (`src/providers/seo-data.ts:278-305`).
   - A key that is set but rejected fails on the first paid call, with no fallback. `semrush_status` says it has "no free key check" (`src/tools/raw.ts:258-266`).
   - `backlinks_summary` takes no provider override (`raw.ts:196-197`).
2. **Root cause:** a deliberate no-silent-fallback rule. A rejected key isn't told apart from other errors.
3. **Already covered:** `set_client_profile dataProvider: "dataforseo"` (or `"ahrefs"`) switches the client (`competitors.ts:143-146`). The fallback to DataForSEO works only when the provider *lacks* the capability (`seo-data.ts:296-298`).
4. **Fix:**
   - When the provider rejects the key (401/403), say so and name the switch (`set_client_profile dataProvider=dataforseo`).
   - Add an optional `provider` argument to the routed paid tools, still under the caps.
   - Keep "no silent fallback".
5. **Size:** S
6. **Severity:** polish/missing feature

### D9c Tag Manager rate limits need retries
1. **Accurate.**
   - `classifyGtmError` recognises `rateLimitExceeded`, `userRateLimitExceeded` and 429, and returns "wait a minute and retry" (`src/lib/gtm.ts:195,228`). crawlmark adds no retry of its own.
   - The googleapis default (gaxios) retries GETs on **429 only**: 3 attempts at about 0.6, 1.5 and 3.5 s (`node_modules/googleapis-common/build/src/apirequest.js:264`, `node_modules/gaxios/build/cjs/src/retry.js:23-64,153-161`).
   - **403** `rateLimitExceeded` is never retried.
   - crawlmark runs 5 Tag Manager calls at once (`src/providers/gtm.ts:22,90,203`). Tag Manager's per-user quota is low, so bursts hit it.
2. **Root cause:** no pacing, and no retry on the 403 form.
3. **Already covered:** the error is classified, and listings are cached (1 day for the per-account lists, 1 hour for audits).
4. **Fix:** a Tag Manager request wrapper with concurrency 1 to 2, a small spacing between requests, and retries on 429 and on 403 rate-limit reasons. Use exponential backoff with jitter up to about 60 s total, and honour `Retry-After`.
5. **Size:** S
6. **Severity:** reliability bug

### R1 Reusable report layout
1. **Accurate.**
   - **Section order is already configurable:** the `sections` array order (`src/reports/templates/schema.ts:265-273`).
   - **Not configurable:**
     - cover fields: fixed in `doc.ts`/`html.ts:350-360` and `docx.ts:283`;
     - a contents page: there is no TOC;
     - page breaks: only CSS `break-inside` (`html.ts:286`) and DOCX `keepNext`;
     - reusable text blocks: the `text` section is limited to 2,000 characters, written inline, with no shared library (`schema.ts:178`).
2. **Root cause:** the template schema has only `title`, `description`, `period`, `compare`, `layout` and `sections`.
3. **Already covered:** template order and titles, the `text` section, `layout: onepage`, and the template builder (`create_report_template` and related tools).
4. **Fix:**
   - Add `cover: {fields: [...], subtitle}` and `contents: true` to the template (a DOCX TOC field, an HTML/PDF anchor list).
   - Add a `pageBreakBefore` flag for each section.
   - Add a top-level `blocks:` library (named markdown) and a `block` section type that references it (for example a glossary).
5. **Size:** M
6. **Severity:** missing feature

### R2 Fonts in branding
1. **Accurate.**
   - DOCX: `const FONT = "Calibri"` (`src/reports/render/docx.ts:44,203,351-354`).
   - HTML and PDF: system font stack (`html.ts:183`, `pdf.ts:39`).
   - `BrandingSchema` has no font field (`schema.ts:56-66`).
2. **Root cause:** never parameterised.
3. **Already covered:** colours, logo, paper and white label in branding (`branding-settings.ts:36`).
4. **Fix:**
   - Add `branding.headingFont` and `branding.bodyFont`, each a family name plus a fallback.
   - DOCX uses the name; Word substitutes when the font isn't installed.
   - HTML/PDF uses the CSS stack. Optionally embed a local `.woff2`/`.ttf` path for the PDF.
   - Add the fields to the branding setup step.
5. **Size:** S
6. **Severity:** polish

### R3 Tables, charts and longer commentary
1. **Accurate.**
   - The narrative supports only paragraphs, `- ` bullets and `**bold**` (`src/reports/render/narrative.ts:1-6`).
   - Limits: `MAX_NARRATIVE_CHARS = 30_000` and `MAX_NARRATIVE_FIELD = 6_000` per field (`narrative.ts:20-21,74-83`, tool text at `src/tools/reports.ts:199`).
   - Data sections already render tables and charts (native DOCX charts, `docx.ts:203-241`); the commentary can't.
2. **Root cause:** a narrow Markdown subset was chosen on purpose (sanitisation, three renderers).
3. **Already covered:** section data tables and charts.
4. **Fix:**
   - Raise the limits to about 100k total and 20k per field.
   - Add `###` subheadings, numbered lists and pipe tables (cells escaped by each renderer).
   - Optionally add a narrative "chart" block that references section data by id rather than taking free-form numbers.
5. **Size:** M
6. **Severity:** missing feature

### R4 Client-facing vs internal notes; block internal tool terms
1. **Accurate.**
   - The narrative is one string per section, with no internal/client split (`narrative.ts:68-72`).
   - `hideCrawlmark` removes the crawlmark name (`doc.ts:193,250-270`, `sections.ts:99`). It does not remove provider names, for example "via DataForSEO (paid)" (`doc.ts:261-262`, `sections.ts:225-246,710,753`).
   - `COMMENTARY_TEXT = "Commentary written with Claude…"` is always printed (`doc.ts:164,245,287`).
   - Nothing checks the commentary for tool names like `striking_distance`.
2. **Root cause:** not designed for this.
3. **Already covered:** `hideCrawlmark`, and SEC-1 error and path scrubbing (`test/report-leaks.test.ts`).
4. **Fix:**
   - Let the narrative take either a plain string or `{client, internal}` for each section.
   - Write the internal notes to a separate `*-internal.md`.
   - Before export, check the client text against every registered tool name, the provider names and "crawlmark". Refuse, with a list of hits, unless `allowTerms` is set.
   - Add `branding.hideProviders` for neutral source wording.
   - Make the AI-commentary line configurable.
5. **Size:** M
6. **Severity:** missing feature (it carries a client-trust risk)

### R5 Optional "save to Google Docs" with the .docx
1. **Accurate about today's behaviour.**
   - The Docs handoff is `export_report inline: "html"`: "docs-friendly HTML copy (no logo, plain tables)" (`src/tools/reports.ts:200,222`, `src/reports/render/html.ts:5`, `src/prompts/index.ts:27-33`).
   - That HTML is passed to the **user's own** Drive connector.
   - crawlmark's Google scopes are `webmasters.readonly`, `analytics.readonly`, `tagmanager.readonly`, `openid` and `email` (`src/lib/google-auth.ts:13-32`). There is no Drive scope.
   - This was a recorded decision: "Google Docs only through the user's own Drive tool. crawlmark stays read-only on Google" (`specs/2026-10-13-1900-phase-12-reports-and-gaps.md:36`, also :26-27).
2. **Root cause:** the decision above, plus HTML as the handoff format.
3. **Already covered:** the user's Drive connector `create_file` accepts `base64Content` with a `contentMimeType`, and **converts to a Google Doc by default**. We checked its schema in this session.
4. **Fix, two options:**
   - **Option A (keeps the decision):** add `export_report inline: "docx"`, which returns the `.docx` as base64. Update the prompt to call `create_file` with `contentMimeType: application/vnd.openxmlformats-officedocument.wordprocessingml.document`, which keeps the logo and styled tables. Cost: the base64 passes through the model's context; a 100 KB file is about 135k characters, so add a size cap.
   - **Option B (reverses the decision):** add the `drive.file` scope (non-sensitive, limited to files the app creates) and upload directly with conversion. This needs a re-login and a new decision entry.
5. **Size:** A is S; B is M.
6. **Severity:** missing feature

### R6 Year-to-date and last-year periods; yearly sections
1. **Accurate.**
   - Periods are `last_month`, `last_quarter`, `last_n_days` (up to 480) and `custom` (`schema.ts:68-73`, `src/reports/templates/period.ts:138-147`). YTD and last year are only possible as a `custom` range that someone has to edit every time.
   - Comparisons are `previous_period` and `previous_year`.
   - None of the requested sections exist:
     - **YoY by channel:** `organic_traffic` is organic only.
     - **Clicks by page type:** no URL grouping.
     - **Content by publish year:** no publish-date data.
     - **Wins and misses:** `highlights.ts` gives up to 8 computed facts, not goals.
2. **Root cause:** not built.
3. **Already covered:** custom ranges, `previous_year`, highlights, `top_pages`/`page_movers`, `rank_trend` (365d).
4. **Fix:**
   - Add the period ranges `year_to_date`, `last_year` and `last_12_months`.
   - Add the sections `channel_yoy` (GA4 `sessionDefaultChannelGroup`), `page_groups` (regex groups defined in the template or client profile), `content_by_year` (from a sitemap `lastmod`, a `/YYYY/` URL pattern or WordPress REST `date`), and `wins_misses` (highlights split by sign, plus goals from the profile).
   - Dependency: comparing last year with the year before needs data from 24 months back, which is older than GSC's 16 months. That needs D5.
5. **Size:** L in total (periods S, each section S to M).
6. **Severity:** missing feature

## Options compared
| Item | Accurate? | Size | Severity | Partial cover today |
|---|---|---|---|---|
| D1 Lighthouse | Partly: concurrency failure reproduced; SQLite not reproduced (likely a lock held by another process) | S | reliability bug | busy_timeout 5 s, WAL, run_audit serialises its own pages |
| D2 GTM container | Yes (picked by ID order, not "by name") | S-M | accuracy | pin `gtmContainerId` in clients.yaml only |
| D3 GA4 hostnames | Yes | S | accuracy | none |
| D4 GSC bot queries | Yes | M | accuracy/feature | brandTerms, queryRegex include |
| D5 GSC history | Yes | M | feature (time-sensitive) | rank_history (tracked keywords only) |
| D6 Crawl coverage | Yes (by design) | M | accuracy/feature | stoppedBy notes, orphans, h1Count |
| D7 Inspection URLs | Yes, confirmed bug | S | accuracy (high) | none |
| D8 Audit diffs | Yes | S-M | accuracy | unverified bucket for removed findings |
| D9a CLI hint | Partly | S | polish | cliPrefix() in setup_status |
| D9b Semrush key | Yes (by design) | S | polish | set_client_profile dataProvider |
| D9c GTM rate limit | Yes | S | reliability | gaxios 3 short retries on 429 only |
| R1 Layout | Yes (order already works) | M | feature | section order, text section, onepage |
| R2 Fonts | Yes | S | polish | colours/logo branding |
| R3 Commentary | Yes | M | feature | section tables and charts |
| R4 Client vs internal | Yes | M | feature | hideCrawlmark, SEC-1 scrub |
| R5 Google Docs | Yes | S (A) / M (B) | feature | inline HTML plus the user's Drive tool |
| R6 Yearly | Yes | L | feature | custom range, previous_year, highlights |

## Recommendation

**Release A: accuracy and reliability, all small or medium.** Ship first. These change numbers already going to clients.
1. **D7:** inspect the original URL. Re-inspect stored "unknown" results.
2. **D1:** Lighthouse mutex, timeout starting after the slot is taken, best-effort cache writes, a longer tool limit.
3. **D8:** `new` only when the base checked it; `firstChecked`; container change becomes `retired` with a warning.
4. **D2:** check the live `GTM-` ID and prefer a matching alternate. Add `gtmContainerId` to `set_client_profile` and `clients set`.
5. **D3:** `ga4Hostnames` filter.
6. **D9c:** GTM pacing and backoff. **D9a:** `cliPrefix()` everywhere, using `@latest`. **D9b:** rejected-key message and an optional provider override.
7. **D6:** sitemap phase plus the `missing-h1`, `multiple-h1` and `title-brand-repeated` rules. This one is medium; it can slip to B without blocking anything.
8. **D4:** exclusion regex and spike flag. Medium; can follow in A.x.
9. **D5:** the `gsc_monthly` table and the backfill CLI. Start this in A even though it's a feature, because every month of delay loses data permanently.

**Release B: report layout, client-safe notes, fonts.**
- R2 fonts (S).
- R4 client/internal split and the term lint (M).
- R3 longer commentary with tables and headings (M).
- R1 cover fields, TOC, page breaks and the block library (M).
- Order and dependencies: R4's narrative shape change should land with or before R3's syntax change, because both touch `narrative.ts` and its validation. R1's `block` section reuses R3's Markdown subset. The DOCX TOC and fonts both touch `docx.ts` styles, so build them together.

**Release C: yearly reporting and Google Docs.**
- R6: periods first (S). Then `channel_yoy` and `page_groups`. Then `content_by_year` and `wins_misses`.
  - R6's year-over-year comparisons depend on **D5** having stored data, so ship D5 in A.
  - Its exclusions and hostname scoping depend on **D3 and D4**.
- R5 option A (inline base64 docx through the user's Drive connector). It depends on B's DOCX changes, so the uploaded file shows the new layout.
  - Option B (`drive.file` scope) only if the user explicitly revisits the 2026-10-13 "read-only on Google" decision.

**What would change this plan:**
- The user's exact D1 error text. If it is `database is locked`, also look at which other crawlmark processes share `~/.crawlmark` and consider a longer `busy_timeout` for cache writes. If it is a disk I/O or read-only error, check WAL support on the data directory's filesystem.
- How big a typical DOCX is: that decides whether R5 option A is practical.

## Sources
- [Lighthouse: using it programmatically and running in parallel](https://github.com/GoogleChrome/lighthouse/blob/main/docs/readme.md#using-programmatically) — accessed 2026-11-01. Supports what we reproduced locally: concurrent runs in one process share global state.
- [SQLite: busy timeout and WAL behaviour](https://www.sqlite.org/wal.html) — accessed 2026-11-01.
- [Search Console URL Inspection API: `inspectionUrl` must be the exact URL in the property](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect) — accessed 2026-11-01.
- [Search Console API `dimensionFilterGroups` operators (`excludingRegex`)](https://developers.google.com/webmaster-tools/v1/searchanalytics/query) — accessed 2026-11-01.
- [GA4 Data API `FilterExpression` / `hostName` dimension](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema) — accessed 2026-11-01.
- [Google Drive API scopes (`drive.file` is non-sensitive)](https://developers.google.com/drive/api/guides/api-specific-auth) — accessed 2026-11-01.
- Local evidence:
  - `node_modules/gaxios/build/cjs/src/retry.js` and `node_modules/googleapis-common/build/src/apirequest.js:264` (retry defaults)
  - `node_modules/lighthouse/package.json` (13.5.0)
  - the Drive connector `create_file` schema loaded in this session
  - scratch scripts in `/private/tmp/claude-501/-Users-idrew-Desktop-git-repo-MCP-crawlmark-mcp/7917c841-76bb-4422-b28b-5c5c29319e25/scratchpad/lhscripts/par.mts` and `.../scratchpad/lock/t.mjs`
