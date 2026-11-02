# Report files and templates

crawlmark turns a client's data into a report file: Markdown, HTML, PDF or Word (`.docx`). The same templates drive both ways of making one:

- **In Claude**, the `template-report` prompt (or `monthly-report-writeup`) runs a template, writes commentary per section, and calls `export_report`. The files say "Commentary written with Claude; all figures come from the data below," and each commentary box sits next to the data it discusses.
- **From cron**, `crawlmark-cli report` writes the same files without commentary. They say "Data-only report" at the top. There is no model in cron, so crawlmark never writes interpretation itself; the only sentences it adds are computed highlights (facts such as "Clicks rose 12.0% (from 1,000 to 1,120) vs August 2026.").

## What a report looks like

Every format follows the same layout, like an agency dashboard export:

- **Cover band**: your logo and agency name (from `branding`), the template's title, the client's name and domain, the period, what it's compared with, the date it was made, and a "Data-only report" or "With commentary" badge.
- **Key figures**: four cards (clicks, impressions, CTR, average position) with the change against the first comparison that has data, as a green or red chip with an arrow. Average position counts a fall as an improvement ("0.7 better"). Without a comparison the cards show the values alone.
- **Summary**: Claude's summary when you asked for commentary, otherwise the computed highlights.
- **One card per section** with charts and tables. Charts are drawn in the file itself (inline SVG in HTML and PDF, no script and nothing loaded from the network): clicks and impressions per day against the previous period, the branded share of clicks, organic sessions per day, Core Web Vitals history with Google's good and poor bands, and tracked keyword positions over time. Tables have right-aligned numbers, coloured changes (positions and Core Web Vitals timings read "0.7 better" or "1.1 worse", as on the key-figure card) and page paths (`/services/emergency`) instead of full URLs; sections about URLs (site crawl, llms.txt, Bing) keep the full URL as code.
- **About this report**: the period and comparisons in plain words, the sources, notes (for example a comparison with no data), and one line naming the sections that had no data this time.

Client files never show operator detail: a section with no data is left out (not "None."), a comparison column with no data is dropped (with one note), and tool hints, internal thresholds, a missing-logo warning and paid-data spend stay in the tool and CLI results (`export_report` and `crawlmark-cli report` return `spend` when the run used paid data). Add the optional `spend` section if you want spend in the file.

Set the branding up with `crawlmark-cli setup --step branding` (also "Set up report branding" in the setup menu). It shows the current values, asks for each one (Enter keeps it): agency name, logo (PNG or JPEG up to 512 KB, copied into `<home>/branding/`), primary and accent colours (with a darker shade suggested when white text on the primary wouldn't meet WCAG AA), footer, white label, paper size and the default report format(s). Then it renders a one-page preview with sample example.com data (`<home>/branding/preview.pdf`, or `.html` without Chrome) and lets you change any field and preview again before saving; nothing is written until you choose save, and cancelling saves nothing. `--client <domain>` writes that client's override file instead, `--dry-run` previews without saving, and `--yes` keeps the current values. `crawlmark-cli report preview-branding [--client <domain>]` renders the saved branding again any time. The preview never uses client data and makes no network or paid call.

White label: `hideCrawlmark: true` in `branding` leaves crawlmark's name and version out of the files (the footer, the Word file's author, and wording such as "crawlmark's own crawl", which becomes "a crawl of the site").

Brand colours: `primaryColor` fills the cover band and colours headings and the main chart line; `accentColor` is the stripe under the cover band. Text on and in them is darkened or switched to dark text when needed, so it stays readable (WCAG AA) whatever colours you choose. Green and red are kept for changes. Without branding the report uses a calm blue.

| Format | Charts |
|---|---|
| HTML, PDF | Inline SVG charts. The PDF is US Letter (or A4) with a running header (client, report, period) from page 2 on and "Page n of m" in the footer. Sections flow across pages so pages stay full; charts, key-figure rows, table rows and callouts never split, and a heading always stays with its first chart or row |
| Word (`.docx`) | Native Word charts (data embedded in the file, so "Edit Data" works); no image and no Chrome needed |
| Markdown, Google Docs copy | Each daily chart becomes a small "by week" table; the other charts' numbers are in the section's table |

## Templates

Five templates are builtin and always there, even with no template file or an invalid one:

| id | What it is |
|---|---|
| `monthly` | The full monthly report, with the same data as the `monthly_report` tool. Optional sections: `spend`, `cwv`, `gtm`, `ranks`, `ai`, `issues` (technical issues), `indexing` (Google indexing) |
| `quarterly` | The last complete quarter against the quarter before and the same quarter last year: search, branded split, organic traffic, rank history (when there is stored history), top and moving queries and pages, tracked keywords, opportunities and audit changes. Optional: `cwv`, `issues` |
| `executive` | One page (`layout: onepage`): the key figures, the clicks trend, the top three wins and the three biggest opportunities. It fits one Letter page with the computed highlights (at most three) or a short summary of about 80 words |
| `technical` | For web teams: the newest local site crawl, Core Web Vitals history, audit changes and AI readiness. Optional: `gtm` (Tag Manager), `issues` (technical issues, up to 30 listed) and `indexing` (Google indexing, up to 25 new URL inspections per run). Sections without data (no crawl saved yet, no CrUX key) are left out and named in "About this report" |
| `local` | Local SEO: search clicks and impressions, the branded split, the Google Business Profile with its rating, review count and stars (no review text) and the map-pack position for up to five tracked keywords (`local_profile`, **paid**: it runs only with `allowPaid` / `--paid` and a confirmed `gbpPlaceId`, otherwise it is left out of the file; without a confirmed profile "About this report" names it as not included), local-intent searches, landing pages and tracked keywords |

To change a builtin template or add your own, create the template file:

```bash
crawlmark-cli report templates init       # writes <home>/config/report-templates.yaml once; never overwrites
crawlmark-cli report templates list       # id, title, source (builtin, global or client)
crawlmark-cli report templates validate   # exit 1 when invalid, naming the YAML path of each problem
```

In Claude, `list_report_templates`, `get_report_template` and `validate_report_template` do the same.

The starter file has copies of the builtin `monthly` and `quarterly` to edit:

```yaml
version: 1
branding:
  agencyName: Example Agency
  # logo: branding/logo.png              # relative to the config home; PNG or JPEG, at most 512 KB, a regular file (not a symlink)
  primaryColor: "#1f4e79"
  accentColor: "#2e8540"
  footer: "Prepared by Example Agency"
  paper: Letter                          # Letter or A4 (PDF and Word)
defaults:
  template: monthly
  formats: [pdf]                         # any of pdf, docx, html, md
templates:
  monthly:
    title: Monthly SEO report
    period: { range: last_month }
    compare: [previous_period, previous_year]
    sections:
      - { id: search, type: search_overview, metrics: [clicks, impressions, ctr, position] }
      - { id: brand, type: branded_split }
      # ...
      - { id: cwv, type: core_web_vitals_history, optional: true, formFactor: PHONE, weeks: 25 }
      - { id: gtm, type: tag_manager, optional: true, limit: 20 }
      - { id: ranks, type: rank_trend, optional: true, since: 180d }
      - { id: ai, type: ai_readiness, optional: true }
      # Paid (the client's SEO data provider): --include backlinks,visibility --paid. Check the cost with --dry-run.
      - { id: backlinks, type: backlinks, optional: true, paid: true }
      - { id: visibility, type: organic_visibility, optional: true, paid: true }
      # - { id: gap, type: keyword_gap, optional: true, paid: true, limit: 25 }
```

The builtin `quarterly` also has an optional paid `competitors` section (`competitor_overview`).

A client can have its own file, `<home>/config/report-templates/<domain>.yaml`, with the same layout. Its `branding` fields override the global ones one by one, its `defaults` override too, and a template with the same id replaces the global one entirely. Files are read on every run, so edits apply at once. An invalid file never hides the builtin `monthly`; its errors are reported instead.

### Periods

| `period` | Current | `previous_period` | `previous_year` |
|---|---|---|---|
| `{ range: last_month }` | The last complete month | The month before | The same month last year |
| `{ range: last_quarter }` | The last complete calendar quarter | The quarter before | The same quarter last year |
| `{ range: last_n_days, days: 28 }` | The last N days, ending 3 days ago | The N days before | The same dates last year |
| `{ range: custom, start: 2026-07-01, end: 2026-09-30 }` | Those dates (up to 480 days, ending at least 2 days ago) | The same length just before | The same dates last year |

`compare` picks which comparisons to show (default both; `[]` for none). At run time, `month`, `quarter` or `startDate` + `endDate` (CLI: `--month`, `--quarter`, `--start` + `--end`) override the template's period; a month on a quarterly template makes a one-month report and its label says so.

### Section types

| type | What it shows | Extra fields |
|---|---|---|
| `search_overview` | Search Console clicks, impressions, CTR and average position vs each comparison | `metrics` |
| `branded_split` | Branded vs non-branded clicks, impressions, CTR and position | |
| `organic_traffic` | GA4 organic sessions, users, engagement rate and key events | `metrics` |
| `top_queries` | Top queries (branded ones marked) | `limit` (20, up to 100), `includeBranded`, `intent: local` (only local-intent searches: "near me", "open now" and the like, or the client's town from its `area`; with none, the top queries overall and a note saying so) |
| `query_movers`, `page_movers` | Queries or pages that gained or lost the most clicks | `limit` (10, up to 50) |
| `top_pages` | Top pages | `limit` (15, up to 100) |
| `landing_pages` | Top GA4 organic landing pages | `limit` (15, up to 100) |
| `tracked_keywords` | Tracked keywords' Search Console positions and their change | `liveRanks: true` adds a paid live rank and needs `paid: true` |
| `opportunities` | Striking distance, low CTR and pages competing for one query | `limit` (5, up to 25) |
| `audit_changes` | Changes since the last saved audit | `limit` (10, up to 50 new findings listed) |
| `core_web_vitals_history` | Real-user Core Web Vitals over time (needs a [CrUX key](../README.md#crux-history-optional)) | `formFactor`, `weeks`, `scope`, `url` |
| `tag_manager` | Tag Manager findings. Must be `optional: true` | `limit` (20, up to 100) |
| `rank_trend` | Tracked keywords' stored positions, first → latest, with the change (lower is better). Local and free; fill the history with `crawlmark-cli check-ranks` or `check_ranks`. The builtin `monthly` has it as optional section `ranks` | `since` (`90d`, `180d` default, `365d`, counted back from the period's end), `source` (`gsc`, `serp`, `both` default) |
| `keyword_gap` | Keywords competitors rank for and the client doesn't, from the client's SEO data provider. **Paid**: needs `paid: true` | `limit` (50 per competitor, up to 500), `competitors` (up to 5; default the client's saved ones, at most 3) |
| `site_crawl` | The newest saved local crawl: pages fetched, broken links, redirects, missing and duplicate titles and descriptions, canonical issues, noindex and orphan counts, and the top issues. Local and free; it never starts a crawl (run `crawlmark-cli crawl` or `local_crawl` first) | `limit` (10 issues listed, up to 50) |
| `bing_overview` | Bing Webmaster Tools for the report period vs its first comparison: clicks, impressions, CTR, the top queries and pages, and the latest crawl day (pages in Bing's index, crawled, crawl errors, URLs with issues). Free with a [Bing key](../README.md#bing-webmaster-tools-optional); unavailable without one. Bing's history is limited (crawl stats cover the last six months; how far traffic goes back isn't documented) and query and page stats update weekly, so a comparison period Bing has no data for shows n/a with a note | `limit` (10 queries and pages, up to 25) |
| `ai_readiness` | From the newest saved audit: whether the site has an llms.txt (status, type, size, title, section and link counts, format issues, sampled links that don't return 200, and whether llms-full.txt exists), and a table of AI crawlers with their purpose (AI search, answering a user's question, or training only), the robots.txt group that applies, and whether the homepage and key pages are allowed. Local and free; it never fetches (run `run_audit` first). Nothing from the llms.txt file is rendered except its title (escaped text) and the URLs of sampled links that don't return 200 (as code). The builtin `monthly` has it as optional section `ai` | |
| `local_profile` | The client's confirmed Google Business Profile (rating, review count, star distribution, category, claimed, photos, website) and its Google Maps position for the first tracked keywords, with the business in first place. **Paid** (DataForSEO, about $0.0054 plus $0.002 per keyword): needs `paid: true`. Unavailable until the client has a confirmed `gbpPlaceId` ([Google Business Profile](clients.md#google-business-profile)), so a report never shows a guessed business | `packKeywords` (3 tracked keywords, 0 to 5; 0 is the profile only) |
| `ai_visibility` | Questions in Google AI Overviews (or ChatGPT, US English only) whose answer cites the client's site, with AI search volume and the cited page (`mentions`), or mention counts and the domains cited alongside (`metrics`). No answer text is included. **Paid** (DataForSEO LLM Mentions, at least $0.10 per request): needs `paid: true` **and** `AI_VISIBILITY_ENABLED=true`; checked against `AI_VISIBILITY_MONTHLY_BUDGET_USD` as well as the client and global caps. DataForSEO may require a $100 monthly top-up for LLM Mentions access ([details](../README.md#ai-search-visibility-optional-paid)). Unavailable while the switch is off | `mode` (`mentions` default, `metrics`), `platform` (`google` default, `chat_gpt`), `limit` (10 answers, up to 50) |
| `technical_issues` | One deduplicated list of technical problems from every stored source: the newest saved audit (Lighthouse, axe, index status, on-page and rendering checks), its site checks (robots.txt, sitemaps, orphans, AI crawlers), the newest local crawl, the newest stored DataForSEO full crawl within 30 days (its summary; no crawl is started) and stored URL Inspection results. The same problem from two sources is one row listing both ("Found by"); "Pages" is the largest count any one source reports. Key figures per severity, one table per severity, and what changed since the newest snapshot taken before the period ended (normally the previous report's): new, still open, resolved (only when the source that reported it ran again) or not re-checked (never counted as fixed; dropped as no longer checked once its source isn't read any more or its data is older than `maxAgeDays`). Stale sources (older than `maxAgeDays`) are shown with their date. Free by default; the Ahrefs Site Audit source reads the client's existing project and spends units, so they need `paid: true` and `--paid` / `allowPaid` (without it they're left out and nothing is requested). Severity mapping: see [audits.md](audits.md#technical-issues) | `limit` (25 listed, up to 200; counts cover all), `minSeverity` (`low` default), `sources` (default every free source: `audit`, `local_crawl`, `site_hygiene`, `dataforseo_crawl`, `gsc_inspection`; `ahrefs_site_audit` needs `paid: true`; `semrush_site_audit` is no longer available and is skipped with a note), `issueUrls` (0, up to 5; only with `ahrefs_site_audit`), `maxAgeDays` (45, 7 to 120) |
| `backlinks` | **Paid** (the client's SEO data provider). Referring domains, backlinks and the provider's own authority metric, labelled with its scale ("DataForSEO Rank (0–1000)", "Ahrefs Domain Rating (0–100)", "Semrush Authority Score (0–100)"; never mixed), with the change against the comparison periods, new and lost referring domains when the provider reports them (DataForSEO, for the report's month; Semrush gives new and lost backlinks; Ahrefs neither), and referring domains by month. Comparisons and the trend come from figures stored locally (see [Stored provider figures](#stored-provider-figures)) | `trendMonths` (12, 0 to 24), `history` (true: buy the provider's monthly history when no stored figure is close enough; false: stored figures only) |
| `organic_visibility` | **Paid** (the client's SEO data provider). Ranking keywords (top 100), keywords by position band (top 3, 4–10, 11–20, 21–100) as a share chart, and the provider's estimated organic traffic (labelled; never compared across providers), with the change and keywords by month. Semrush's v4 API has no organic visibility, so a Semrush client's section is served by DataForSEO when it is set up, and fails with a clear message otherwise | `trendMonths` (12, 0 to 24), `history` (true) |
| `competitor_overview` | **Paid** (the client's SEO data provider). The client's saved competitors first, in saved order, then the provider's suggested ones (big platforms and denylisted domains left out), each with keywords shared with the client, its own ranking keywords (with the change when last month's figures are stored) and estimated traffic, and the client's own row. A saved competitor the provider doesn't list is looked up on its own: shared keywords show "n/a" with a note | `limit` (5, up to 10), `source` (`saved_then_suggested` default, `saved`, `suggested`) |
| `indexing_issues` | Google's indexing of a sample of the site's URLs from stored URL Inspection results: URLs checked, indexed (and the share), not indexed, canonicals Google chose differently, a share chart of Google's coverage states, the worst pages (with whether each is in a sitemap and when Google last crawled it), Search Console's sitemap errors and warnings, and the indexed share by month. Before reading, it inspects up to `maxInspections` more URLs (free, within the daily budget; see [audits.md](audits.md#indexing-coverage)). The file says it's a sample (key pages, top Search Console pages and a rotating sample of sitemap URLs), not Search Console's Page indexing report, which the API doesn't offer, and how many sitemap URLs were checked in the last 30 days; once every sitemap URL has a recent check (run `crawlmark-cli index-coverage --all-pages` daily) it says "all N sitemap pages" instead. When an export of Search Console's Pages report was imported (`import_index_report` or `crawlmark-cli index-coverage import`), the section starts with Google's own counts from it ("From Search Console's Pages report exported on 14 Oct 2026: 128 pages not indexed and 412 indexed"), a table of reasons with example pages, and "(indexed now)" beside examples URL Inspection found indexed after the export; with an import and no inspections it shows only that. Needs a Search Console property | `maxInspections` (25, 0 to 200; 0 reads stored results only), `staleDays` (7, 1 to 90), `limit` (10 worst pages, up to 50), `trendMonths` (6, 0 to 12) |
| `data_spend` | Paid data used this month. Operator information: optional (`spend`) in the builtin monthly, and always in the tool and CLI results | |
| `text` | Your own text | `text` |

A paid `keyword_gap`, `local_profile` or `ai_visibility` section is estimated with the other paid sections before the report makes its first paid request; if the estimate doesn't fit the client's or the global cap, the run stops with the cap message (and a limit that would fit) and nothing is spent. While the paid sections run, the whole estimate is reserved (dollars for DataForSEO, units per provider for Ahrefs and Semrush), so a scheduled run and a Claude session can't both spend the same budget.

To see the cost first, pass `estimateOnly: true` to `run_report_template` or `export_report` (or run `crawlmark-cli report ... --dry-run`): it returns each paid section's estimate (`sections: [{ id, type, provider, usd, units, requests, reused }]`), the `total`, what's `remaining` for the client and globally, `wouldExceed` and a one-line `message`, and fetches, spends and writes nothing.

Every section has an `id` and `type`, and optionally a `title`, `optional: true` (included only when asked: `include: ["cwv"]` or `--include cwv`) and `paid: true`. A paid section runs only when the template marks it paid **and** you allow it at run time (`allowPaid: true`, or `--paid`); otherwise it is listed as skipped. Each section reports its own status: `ok`, `error`, `unavailable` (no Search Console or GA4 property, no CrUX key) or `skipped`. The tool result has the reasons; the files leave those sections out and "About this report" names them in one line (a section that failed says it couldn't be fetched).

A template can set `layout: onepage` for the compact one-page layout the builtin `executive` uses (search shows only the clicks chart, movers only the gains, opportunities only the top three, and query-mover and opportunity sections sit side by side).

The charts need daily rows: run_report_template adds them to the `search_overview` and `organic_traffic` data as `daily` (Search Console and GA4 `date` dimension; free, extra fields only), and stored rank points to `rank_trend` keywords as `series`. When the daily rows can't be fetched, the section still renders, without its chart.

## Build a template

You don't have to write the YAML by hand. Both ways below show you exactly what will be saved, save nothing until you say so, and only ever write a report template file (never branding, `clients.yaml` or settings). Comments and layout in an existing file are kept: the new template is added as its own block, and the previous version is saved next to it as `<file>.bak`.

### From the terminal

```bash
crawlmark-cli report templates new --client example.com
```

It asks for an id and a title, then shows every section type grouped (Search Console, Analytics, Site health, SEO data, Local search, AI search, Other), each marked `(free)`, `(free · needs <key>)` or `(paid · DataForSEO · ~$0.025 per run for example.com)`. The paid numbers are estimates for that client from its own data provider and caches; working them out makes no request and spends nothing. Each paid section you tick is confirmed once more by name and cost (the default is No). Then the optional sections (paid ones start optional, so they run only with `--include <id> --paid`), the period (last month, last quarter, last 28 days or the last N days), the comparisons, the layout (standard or one page) and, when the file has none yet, its default formats.

Before saving it writes a one-page preview with **sample example.com data** (never the client's own) to `<home>/reports/.preview/<client>/<id>.html`, offers to open it, shows the diff of the template file, and asks: save, change something, or cancel. Ctrl-C at any point writes nothing.

| Flag | Does |
|---|---|
| `--client <domain>` | Prices the paid sections for that client and uses its branding in the preview. Without it, paid sections show as `(paid)` and the preview uses the global branding |
| `--file global\|client` | Where to save: the global file (default) or the client's own file (needs `--client`) |
| `--replace` | Allow an id that is already in the file (overwritten) or a builtin id (your copy then hides the builtin) |
| `--dry-run` | Everything up to save, then writes nothing but the preview |
| `--yes` | Asks nothing and creates nothing (the builder is interactive) |

It needs an interactive terminal; in a pipe or cron it exits 1 and points at `report templates validate` for hand-written YAML.

### In Claude

```
> Draft me a quarterly board pack for example.com with search, backlinks and the technical issues.
  get_report_template { template: "monthly" }                          # the `catalogue` of section types
  create_report_template { client: "example.com", id: "board", template: { title: "Quarterly board pack", period: { range: "last_quarter" }, sections: [...] } }
  → nothing saved: the YAML, the diff of report-templates.yaml, paid sections with estimates (backlinks about $0.025 per run), a confirmToken
> Yes, save it, paid is fine.
  create_report_template { ...same arguments..., confirmToken: "tpl_...", paidAcknowledged: true }  → saved
```

The `build-report-template` prompt walks through this. The rules:

- A call without `confirmToken` only proposes: it validates the template with the same schema as `report templates validate`, returns the template's YAML, a diff of the whole target file and the paid sections with this client's estimates, and stores a single-use token for 15 minutes. Nothing is written.
- Saving needs the same arguments plus the token. It fails if the token is unknown, used or expired, if the arguments changed, or if the file changed since the proposal (propose again and look at the new diff).
- A template with paid sections also needs `paidAcknowledged: true`, which Claude may pass only after you agreed to those sections by name and cost.
- When your app supports MCP elicitation (Claude Code, for example), crawlmark also asks you directly before saving ("Save template "board" to ...? It includes 1 paid section (backlinks). Sections: ...", with the start of any free-text section) and saves only on yes.
- Without elicitation, the token is only a two-step the model can complete by itself: it shows that Claude made the proposal first, not that you agreed. So without elicitation crawlmark saves only simple new templates (no paid sections, no free-text `text` sections, not replacing a template in the file, not hiding a builtin, and no `update_report_template` changes). Anything else is refused with a pointer to `crawlmark-cli report templates new`, where you make the choices yourself. This keeps text injected into a page Claude read from reaching every client report.
- `update_report_template` changes a template that is already in a file: the whole `template`, or a `patch` that adds sections (at the end), removes sections by id, or sets the title, description, period, comparisons or layout. Builtin templates aren't in a file; copy one with `create_report_template` and `replace: true`.

## Files and formats

Files go to `<home>/reports/<client>/<YYYY-MM>/<template>-<period>.<ext>` (set `REPORTS_DIR` to move them), for example `reports/example.com/2026-09/monthly-2026-09.pdf`, `quarterly-2026-q3.html` or `monthly-2026-07-01-to-2026-09-30.docx`. `YYYY-MM` is the month the period ends in. Folders are created readable only by you (0700) and files are 0600, since they hold client data. Exporting the same template and period again overwrites the file (`overwritten: true`). Reports are kept until you delete them; delete a client's folder to remove its reports.

| Format | Notes |
|---|---|
| `md` | Plain Markdown. Text from Search Console is escaped, and URLs appear as code, so nothing in the data becomes a link |
| `html` | One self-contained page: no scripts and nothing loaded from the network (the logo is embedded) |
| `pdf` | The HTML printed by the Chrome crawlmark already uses for Lighthouse, with JavaScript and network access off. Letter by default; `paper: A4` in branding. If Chrome isn't installed, an HTML file is written in the PDF's place (unless HTML was asked for too), `warnings` gives the setup hint, and the other formats are still written |
| `docx` | A Word document with real headings, lists, tables and native charts, built with the `docx` library for Word, Google Docs and LibreOffice |

`formats` defaults to the template file's `defaults.formats`, else **PDF only**: a report is never exported in every format unless you ask. On an interactive terminal, `crawlmark-cli report --client` without `--format` shows a list with the default ticked (PDF, Word, HTML, Markdown); `--all`, `--dry-run`, `--yes`, CI and pipes use the saved default without asking, and `--format` always wins. In Claude, the report prompts ask which format(s) you want (PDF by default) and export exactly those. If the PDF can't be made (Chrome isn't installed), an HTML file is written in its place and the result's `warnings` says so; the file itself never mentions it.

## Google Docs

crawlmark never writes to Google. If your Claude has a Google Drive connector that can create files, the report prompts offer to save the report as a Google Doc, and only do it after you say yes. Claude asks `export_report` for a docs-friendly HTML copy (`inline: "html"`: no logo and no styling Google Docs would drop; the key figures and charts become plain tables, and changes keep their green or red) and passes it to your Drive connector, which converts it to a Google Doc. Nothing is shared and no permissions change. Without such a connector, the prompts don't mention Google Docs.

## In Claude

```
> Write the September report for example.com and save it as a PDF and a Word file.
  run_report_template { client: "example.com", template: "monthly", month: "2026-09" }
  ... Claude writes the commentary ...
  export_report { client: "example.com", reportId: "rpt_01J...", formats: ["pdf", "docx"], narrative: { summary: "...", sections: { search: "..." } } }
```

`run_report_template` keeps its data for 24 hours under the `reportId`, so the files show exactly the numbers the commentary was written from. Commentary supports paragraphs, `- ` bullets and `**bold**`; anything else appears as typed.

## From cron

```bash
crawlmark-cli report --all --template monthly --format pdf,docx
crawlmark-cli report --client example.com --quarter 2026-Q3 --template quarterly --format md,html
crawlmark-cli report --client example.com --start 2026-07-01 --end 2026-09-30 --format html --include cwv,gtm
crawlmark-cli report --all --dry-run       # periods, file paths and paid estimates; fetches and writes nothing
crawlmark-cli report --client example.com --template technical --include issues,indexing
```

Exit codes and a cron line are in [scheduling.md](scheduling.md#report-files).

## Notes in reports and saved history

`monthly_report` returns a top-level `notes` array, and template runs add the same notes to the report's About section. They say when the numbers were adjusted:

- **GA4 hostnames.** `GA4: 120 organic sessions from other hostnames were left out (staging.example.com 120). If a hostname belongs to this site, add it with set_client_profile ga4Hostnames.` By default GA4 counts only the client's domain and its `www.` form ([Clients](clients.md#per-client-settings-for-ga4-search-console-and-tag-manager)).
- **Excluded queries.** `Search Console: 340 clicks and 12,000 impressions from excluded queries were left out of totals (positions are unadjusted).` when the client has `gscExcludeQueries`.
- **Query spikes.** `monthly_report` has `search.querySpikes`: days in the month when impressions jumped on a few queries with no clicks, with the queries and their share of the jump. Template runs add one note per flagged day. Check these before reading a rise in impressions as growth.
- **Saved history.** `Saved Search Console history for 2 month(s) (2026-08…2026-09).` or why it couldn't be saved.

### Search Console history

Google keeps only 16 months of Search Console data, so crawlmark saves each month as it goes. Run `crawlmark-cli gsc-history backfill --all` once after upgrading to save what Google still has (or call `gsc_history` with `backfill: true` for one client from Claude). `gsc-history show <client>` lists the saved months. After that, `monthly_report` and each template run save up to two missing months per run and add a note.

- Months are saved with raw numbers (no query exclusions). Exclusions are applied to saved query rows when a report reads them. Saved totals are adjusted only for months saved under the same exclusions as the client has now; otherwise the totals are read raw and the report notes it (re-save the months with refresh). Saved page rows can't have exclusions subtracted.
- The oldest month Google still has may be partial (`complete: false`).
- A report range that starts more than 16 months back reads saved history only when every month in the range is saved.
- It is free: Search Console only. Backfill paces its requests, backs off at quota limits, and only fetches months not saved yet.

## Stored provider figures

The `backlinks`, `organic_visibility` and `competitor_overview` sections (and the `organic_visibility`, `competitor_overview` and `backlinks_summary` tools, and `crawlmark-cli seo-snapshot`) store what they fetch as small dated figures in the local database: counts per site, metric and day, never link lists, keyword lists or anything else row by row. Reports compare months from these:

- **Reuse.** A section reuses figures stored in the last `SNAPSHOT_REUSE_DAYS` (7) instead of calling the provider, so running a report twice costs once. A month's report uses a figure captured within 10 days of the period's last day (20 for a quarter; last year's comparison looks within 31 days), or else the provider's history point for that same month. A history point from a neighbouring month is never used in its place.
- **History, only when needed.** When no stored figure covers a comparison or the trend, a report template buys the provider's monthly history once (DataForSEO about $0.025 for backlinks and $0.11 for visibility; Ahrefs about 128 and 221 units; Semrush has no history call, so its backlinks are compared from stored figures only) and stores it. The cost is in the run's estimate (`--dry-run`, `estimateOnly`) before anything is spent. Set `history: false` to use stored figures only. The standalone tools never buy history unless you pass `history: true`.
- **One provider per figure.** A figure and its comparison always come from the same provider and market. If a client changes provider, the new provider starts a new series and the file says the earlier months came from another provider.
- **Source line.** Each section ends with "Source: DataForSEO" (or Ahrefs, or Semrush) and the date of the figures, also in white-label files: the providers' terms ask for attribution. If you send Ahrefs figures to clients, check that your Ahrefs plan allows sharing Ahrefs-derived metrics with them.
- **What's kept, for how long.** Only counts are kept long-term. Ahrefs row lists (keywords, competitors, keyword ideas, the keyword gap) are cached for at most a day so asking again is free, and are purged with the rest; Ahrefs Site Audit example URLs appear only in that run's result and its stored report (24 hours, for export).
- **Retention.** Semrush figures are deleted 31 days after they were fetched (Semrush's API terms), so Semrush clients get month-over-month but not year-over-year for backlinks. Ahrefs figures are kept for 25 months, and deleted when you remove a client, when the Ahrefs key is removed from the `.env` (or from the Claude Desktop extension's settings), or on demand with `crawlmark-cli data purge --provider ahrefs [--client example.com]`. crawlmark reads Ahrefs only through its REST API v3, never Ahrefs' hosted MCP server.

