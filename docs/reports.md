# Report files and templates

crawlmark turns a client's data into a report file: Markdown, HTML, PDF or Word (`.docx`). The same templates drive both ways of making one:

- **In Claude**, the `template-report` prompt (or `monthly-report-writeup`) runs a template, writes commentary per section, and calls `export_report`. The files say "Commentary written with Claude; all figures come from the data below," and each commentary box sits next to the data it discusses.
- **From cron**, `crawlmark-cli report` writes the same files without commentary. They say "Data-only report" at the top. There is no model in cron, so crawlmark never writes interpretation itself; the only sentences it adds are computed highlights (facts such as "Clicks rose 12.0% (from 1,000 to 1,120) vs August 2026.").

## Templates

The builtin `monthly` template is always there and has the same data as the `monthly_report` tool. To change it or add your own, create the template file:

```bash
crawlmark-cli report templates init       # writes <home>/config/report-templates.yaml once; never overwrites
crawlmark-cli report templates list       # id, title, source (builtin, global or client)
crawlmark-cli report templates validate   # exit 1 when invalid, naming the YAML path of each problem
```

In Claude, `list_report_templates`, `get_report_template` and `validate_report_template` do the same.

The starter file has `monthly` and `quarterly`:

```yaml
version: 1
branding:
  agencyName: Example Agency
  # logo: branding/logo.png              # relative to the config home; PNG or JPEG, at most 512 KB
  primaryColor: "#1f4e79"
  accentColor: "#2e8540"
  footer: "Prepared by Example Agency"
  paper: Letter                          # Letter or A4 (PDF and Word)
defaults:
  template: monthly
  formats: [md, html]
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
      # - { id: gap, type: keyword_gap, optional: true, paid: true, limit: 25 }
```

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
| `top_queries` | Top queries (branded ones marked) | `limit` (20, up to 100), `includeBranded` |
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
| `data_spend` | Paid data used this month | |
| `text` | Your own text | `text` |

A paid `keyword_gap`, `local_profile` or `ai_visibility` section is estimated with the other paid sections before the report makes its first paid request; if the estimate doesn't fit the client's or the global cap, the run stops with the cap message (and a limit that would fit) and nothing is spent.

Every section has an `id` and `type`, and optionally a `title`, `optional: true` (included only when asked: `include: ["cwv"]` or `--include cwv`) and `paid: true`. A paid section runs only when the template marks it paid **and** you allow it at run time (`allowPaid: true`, or `--paid`); otherwise it is listed as skipped. Each section reports its own status: `ok`, `error`, `unavailable` (no Search Console or GA4 property, no CrUX key) or `skipped`, and the report's "Data sources and notes" section names each one that has no data and why.

## Files and formats

Files go to `<home>/reports/<client>/<YYYY-MM>/<template>-<period>.<ext>` (set `REPORTS_DIR` to move them), for example `reports/example.com/2026-09/monthly-2026-09.pdf`, `quarterly-2026-q3.html` or `monthly-2026-07-01-to-2026-09-30.docx`. `YYYY-MM` is the month the period ends in. Folders are created readable only by you (0700) and files are 0600, since they hold client data. Exporting the same template and period again overwrites the file (`overwritten: true`). Reports are kept until you delete them; delete a client's folder to remove its reports.

| Format | Notes |
|---|---|
| `md` | Plain Markdown. Text from Search Console is escaped, and URLs appear as code, so nothing in the data becomes a link |
| `html` | One self-contained page: no scripts and nothing loaded from the network (the logo is embedded) |
| `pdf` | The HTML printed by the Chrome crawlmark already uses for Lighthouse, with JavaScript and network access off. Letter by default; `paper: A4` in branding. If Chrome isn't installed, the PDF is skipped with a hint and the other formats are still written |
| `docx` | A Word document with real headings, lists and tables, built with the `docx` library for Word, Google Docs and LibreOffice |

`formats` defaults to the template file's `defaults.formats`, else Markdown and HTML.

## Google Docs

crawlmark never writes to Google. If your Claude has a Google Drive connector that can create files, the report prompts offer to save the report as a Google Doc, and only do it after you say yes. Claude asks `export_report` for a docs-friendly HTML copy (`inline: "html"`: no logo, plain tables) and passes it to your Drive connector, which converts it to a Google Doc. Nothing is shared and no permissions change. Without such a connector, the prompts don't mention Google Docs.

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
crawlmark-cli report --all --dry-run       # periods and file paths; fetches and writes nothing
```

Exit codes and a cron line are in [scheduling.md](scheduling.md#report-files).
