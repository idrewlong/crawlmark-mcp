<!--
Status: draft (awaiting approval; user decisions of 2026-10-13 already applied)
Created: 2026-10-13 13:44 CDT (file slot 19:00 as requested)
Author: Claude Code / my-skills:planner / branch phase-12-plan
Owner: backend
Reasoning: the 2026-10-13 gap analysis ranks report output and reusable templates as crawlmark's biggest gaps, followed by stored rank history, keyword ideas and gap, a free local crawl, Bing, local SEO, AI-search visibility, CrUX History and server logs. The user chose 12a (reports and quick wins), 12c (rank history and keyword gap) and the later items, and not the Claude plugin / MCP Registry work. This plan splits them into three stages that each merge on their own, free work first and paid work behind estimates and caps.
Research:
  - docs/research/2026-10-13-seo-mcp-landscape.md (gap analysis; the basis for this phase)
  - docs/research/2026-10-13-phase-12-apis.md (written for this plan: CrUX History, Bing Webmaster, DataForSEO Labs / Business Data / AI Optimization, Ahrefs and Semrush keyword endpoints, Google crawler IP lists, DOCX options, the Drive connector's create_file)
  - docs/research/ahrefs-api-v3.md, docs/research/semrush-api.md (Phase 9)
  - specs/2026-10-13-1500-phase-9-seo-data-providers.md (provider layer, D2 "no silent fallback", unit and USD caps)
  - There is no docs/decisions/DECISIONS.md. Decisions binding on this plan: the Phase 9 decisions (9.10), the Phase 10 rules (plain installer output unchanged, stripControl on untrusted text), and the user's Phase 12 decisions quoted in 12.0.
Supersedes: none.

Lives in specs/ (my-skills convention); implementation.md gets a "Phase 12" entry linking here (Stage A, task A-1).
-->

## Phase 12: Report files, templates, trends and the remaining gaps

**Status:** draft, 2026-10-13. Owner: backend, for every file below (code, tests and docs, as in Phases 8 to 10). Three stages, built and merged in order: **Stage A** (12a: report files, templates, the Google Docs handoff, CrUX History, opt-in Tag Manager findings in audits), **Stage B** (12c: stored rank history, keyword ideas, competitor keyword gap), **Stage C** (later items, each its own sub-stage: local crawler, server logs, Bing Webmaster, local SEO, AI-search visibility). Each stage has its own Done-when and can ship without the next.

**Goal.** An agency can turn any client's data into a branded Markdown, HTML, PDF or Word file from a reusable YAML template, from Claude (with written commentary) or from cron (data only, clearly labelled), and save it to Google Docs through their own Drive connector. crawlmark also keeps rank history, finds keyword ideas and competitor gaps through the user's own provider under the existing caps, and covers the free sources it lacks (a bounded local crawl, CrUX History, Bing, server logs) plus opt-in paid local and AI-search data.

**Non-goals.**
- Claude plugin bundle, MCP Registry, npm publishing (user decision).
- Writing to Google (Drive, Docs, Search Console, GBP, Tag Manager), Bing or any other service: no submissions, IndexNow, sitemap pings, review replies.
- Emailing or uploading reports; a report webhook. Files stay on disk; the user's own Drive connector is the only handoff.
- A hosted mode, a web UI, scheduled delivery beyond cron/launchd/CI.
- GA4 funnels/realtime, Search Console beyond 25k rows, Google Trends, backlink detail (ranked 11 to 14 in the gap analysis; later).
- LLM-written prose in CLI/cron mode (there is no model there).

### 12.0 Rules that apply to every stage

User decisions (binding):
1. **Tag Manager findings are opt-in everywhere.** `run_audit({ includeTagManager: true })` (default false), `crawlmark-cli audit --include-tag-manager`, and an `optional: true` section `tag_manager` in templates. Never in a default audit, a default scheduled audit, `monthly_report`, or the starter template's default sections.
2. **Google Docs only through the user's own Drive tool.** crawlmark stays read-only on Google. Prompts offer "save as a Google Doc" only when a Drive tool that creates files is available, and only after the user says yes. HTML is the handoff format (tables survive).
3. Scope is 12a, 12c and the later items.

Principles (each is checked in a Done-when):
- **Local.** Reports, rank history, crawls and log summaries are written only under the config home (`HOME.dir`, `src/config.ts`). No client data is sent anywhere except the provider the call is for (Google, Bing, DataForSEO, Ahrefs, Semrush) and, by the user's choice, their Drive connector.
- **Read-only access** to Google and Bing (allowlisted read methods only; a test asserts it).
- **Free first.** Every new free tool works with no paid provider. Paid tools and paid template sections never run unless asked: a paid template section needs `paid: true` in the template **and** `allowPaid: true` (tool) / `--paid` (CLI) at run time.
- **Spend caps with pre-flight estimates.** Every new paid call computes an estimate, checks `assertBudget` (USD) or `assertUnits` (units) for the **whole** operation before the first request, and records actual cost after (`recordSpend` / `recordUnits`, `src/lib/budget.ts`). Every new paid tool takes `estimateOnly: true`, which returns the estimate and the remaining cap without any provider request.
- **No silent provider fallback.** Routed capabilities go through `resolveProvider` (`src/providers/seo-data.ts`); DataForSEO-only ones through `requireDataForSeo`. A missing key is a `ProviderUnavailableError` with the fix command, never another account.
- **No client data leaves the machine** beyond the above. Server logs are never uploaded; only aggregates are returned; IP addresses are never returned, stored or logged.
- **Secrets never echoed.** Keys sent as query parameters (CrUX `key`, Bing `apikey`, Semrush `key`) are never part of a cache key, error message, log line, usage row or tool result. Errors pass through a redactor (reuse `redact()` in `src/providers/units-billing.ts` or a shared `redactSecrets(text, secrets[])`).
- **Untrusted text through `stripControl`** (`src/lib/terminal-text.ts`) before it reaches a report, a terminal or a tool result: queries, page titles, URLs, review text, AI answers, GTM entity names, log paths and user agents. Rendering adds format-specific escaping on top (12.A.3 D4).
- **Test isolation.** No real network, no real app configs, never the real `.env`. `test/setup.ts` gains: `REPORTS_DIR` in the temp dir; `CRUX_API_KEY`, `PSI_API_KEY`, `BING_WEBMASTER_API_KEY`, `AI_VISIBILITY_ENABLED`, `LOG_DIRS` deleted; `CRUX_BASE_URL`, `BING_BASE_URL` and `CRAWLER_IPRANGES_BASE_URL` pointed at `http://127.0.0.1:9` (shell-only overrides, same pattern as `AHREFS_BASE_URL` via `shellUrlOverride` in `src/config.ts`). Browser-dependent code takes an injected printer/fetcher so unit tests never start Chrome.
- **example.com** (and example.org / example.net) in every fixture, doc, sample and screenshot. No real client names or domains.
- **Additive-only output changes.** No existing tool's input or output field changes meaning or disappears. New `run_audit` keys appear only when their option is set, so a default `run_audit` result is key-for-key identical to today's. `monthly_report` output is unchanged (golden test).
- **Plain installer output unchanged.** New keys (`CRUX_API_KEY`, `BING_WEBMASTER_API_KEY`) are set with `setup --step crux` / `setup --step bing` only; they are not in the default wizard flow or the returning-user menu. `setup status` shows the new `crux` / `bing` rows in `--json` always and in human output only when configured. The Phase 10 byte-identical transcript test (`setup --dry-run < /dev/null`, `setup --yes --dry-run`) is extended to this branch.
- **Blog outline.** Every new tool, prompt and command is added to `docs/launch/blog-outline.md` section 5, marked **Coming** in the stage's docs task and flipped to **Shipped** in the commit that merges the stage.
- **MCP annotations.** Every new tool has a `title` and annotations. Read tools use `READ_ONLY` (`src/tools/util.ts`). Tools that write local files (`export_report`, `local_crawl`, `check_ranks`) use `{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }`. Each new tool and prompt is added to `mcpb/manifest.json` (checked by `test/mcpb-manifest.test.ts`).

### 12.1 Context (existing code this phase builds on)

- Stack (package.json / lockfile): Node >= 22.13 (ESM, `node:sqlite`), TypeScript 7.0, `@modelcontextprotocol/sdk` 1.32, `zod` 4.6, `yaml` 2.9, `cheerio` 1.2, `puppeteer` 25.13, `lighthouse` 13.5, `googleapis` 185, vitest 5. No new runtime dependency is planned (12.A.3 D6).
- Reports: `src/reports/monthly.ts` (`monthlyReport`, `compare`, `movers`), `src/reports/section.ts` (`section()`, `Section<T>`, `unavailable`), `src/reports/audit.ts` (`runAudit`, `collectAudit`, `AuditOptions`), `src/reports/gtm.ts` (`runGtmAudit`), `src/reports/site-hygiene.ts` (orphans from a stored DataForSEO crawl, `ORPHAN_MAX_CRAWL_AGE_DAYS`), `src/reports/opportunities.ts` (`opportunitiesForMonth`).
- Findings and diffs: `src/analysis/findings.ts` (`FindingSource` already includes an unused `"crawl"`; `checkOf`, `checkedPairs`, `findingId`), `src/analysis/diff.ts`, `src/analysis/alerts.ts` (`Alert`, `exitCodeFor`), `src/analysis/gtm.ts` (`GtmFinding`, source `gtm`, severities medium/low).
- Providers: `src/providers/seo-data.ts` (routing, `CAPABILITIES`, `ROUTED_CAPABILITIES`, `requireDataForSeo`, `ProviderMeta`), `src/providers/dataforseo.ts` (`paid()`, `ESTIMATE_USD`, `billedRequest`), `src/providers/ahrefs.ts` / `semrush.ts` (unit estimates, limiters, `billed`/`v3Report`), `src/providers/lighthouse.ts` (`fetchFieldData` via PSI), `src/providers/browser.ts` (`withBrowser`, `launchGuardedBrowser`, egress proxy), `src/providers/render.ts` (`fetchRaw`, `getPinned`, manual redirects with `assertSafeUrlResolved`), `src/providers/gtm.ts`.
- Infra: `src/lib/store.ts` (SQLite tables, `migrateSpendUnits` pattern), `src/lib/cache.ts` (`cached`, `cacheKey`, `TTL`, `peekCache`, `putCache`), `src/lib/budget.ts`, `src/lib/url-guard.ts`, `src/lib/rate.ts` (`createLimiter`), `src/lib/concurrency.ts` (`mapLimit`), `src/analysis/robots.ts` (`parseRobots`, `rulesFor`, `isAllowed`), `src/lib/atomic-file.ts` (`writeFileAtomic`), `src/lib/dates.ts`, `src/lib/home.ts`, `src/config.ts` (`HOME`, `env`, `shellUrlOverride`).
- Tools and prompts: `src/tools/reports.ts` (`monthly_report`, `run_audit`), `src/tools/util.ts` (`handler`, `READ_ONLY`), `src/prompts/index.ts` + `src/prompts/templates/*.md` (`monthly-report-writeup.md`).
- Scheduling: `src/scheduled.ts` (`RunReport`, `finish`, skip/exit rules), `src/cli.ts` (`scheduledCommand`, `parseArgs` options, exit 1 for usage in scheduled commands), `src/cli-help.ts`, `docs/scheduling.md`.
- Tests: `test/setup.ts` (isolation), fixtures in `test/fixtures/{ahrefs,dataforseo,google,gtm,render,semrush}`.

---

## Stage A (12a): report files, templates, Google Docs handoff, CrUX History, opt-in Tag Manager findings

Branch `phase-12a`. Merge when A's Done-when passes.

### 12.A.1 What the user sees

In Claude:

```
> Write the September report for example.com and save it as a PDF and a Word file.
  (template-report prompt) run_report_template { client: "example.com", template: "monthly", month: "2026-09" }
  ... Claude writes the commentary ...
  export_report { reportId: "rpt_01J...", formats: ["pdf","docx"], narrative: { summary: "...", sections: { search: "..." } } }
  → Saved: ~/.crawlmark/reports/example.com/2026-09/monthly-2026-09.pdf
           ~/.crawlmark/reports/example.com/2026-09/monthly-2026-09.docx
  I can also save it as a Google Doc with your Google Drive connector. Want me to?
> yes
  export_report { reportId: "rpt_01J...", inline: "html", narrative: {...} }  → HTML content
  (Drive) create_file { title: "Example Co - SEO report - September 2026", textContent: "<!doctype html>...", contentMimeType: "text/html" }
```

From cron (no model, data only):

```
$ crawlmark-cli report --all --template monthly --format pdf,docx
{ "command": "report", "ranAt": "2026-10-03T06:00:12Z", "dryRun": false,
  "results": [ { "client": "example.com", "template": "monthly", "period": { "label": "September 2026", ... },
                 "dataOnly": true,
                 "files": [ { "format": "pdf", "path": "/home/me/.crawlmark/reports/example.com/2026-09/monthly-2026-09.pdf", "bytes": 182311, "overwritten": false }, ... ],
                 "sections": { "ok": 11, "error": 0, "unavailable": 1, "skipped": 0 } } ],
  "skipped": [ { "client": "example.org", "reason": "ignore: true in clients.yaml" } ],
  "errors": [], "exitCode": 0 }
```

Other new commands:

```
crawlmark-cli report templates list            # id, title, source (builtin | global | client:<domain>)
crawlmark-cli report templates validate [file] # exit 0 valid, 1 invalid (errors with YAML path)
crawlmark-cli report templates init            # writes the starter config/report-templates.yaml if absent; never overwrites
crawlmark-cli report --client example.com --quarter 2026-Q3 --template quarterly --format md,html
crawlmark-cli report --client example.com --start 2026-07-01 --end 2026-09-30 --format html --include cwv,gtm
crawlmark-cli audit --client example.com --include-tag-manager
```

New tools: `list_report_templates`, `get_report_template`, `validate_report_template`, `run_report_template`, `export_report`, `crux_history`. New prompt: `template-report`. Changed (additively): `run_audit` (`includeTagManager`, `cruxHistory`), prompt `monthly-report-writeup` (export and Docs offer).

**Sample template file** (`<home>/config/report-templates.yaml`; this is the starter `templates init` writes, with the optional sections included but marked optional):

```yaml
# crawlmark report templates. Docs: docs/reports.md
version: 1
branding:                                # optional; a per-client file can override any field
  agencyName: Example Agency
  logo: branding/logo.png                # relative to the config home; PNG or JPEG, at most 512 KB
  primaryColor: "#1f4e79"
  accentColor: "#2e8540"
  footer: "Prepared by Example Agency"
  paper: Letter                          # Letter or A4 (PDF only)
defaults:
  template: monthly
  formats: [md, html]
templates:
  monthly:
    title: Monthly SEO report
    description: The same data as monthly_report.
    period: { range: last_month }
    compare: [previous_period, previous_year]
    sections:
      - { id: search, type: search_overview, metrics: [clicks, impressions, ctr, position] }
      - { id: brand, type: branded_split }
      - { id: traffic, type: organic_traffic, metrics: [sessions, users, engagementRate, keyEvents] }
      - { id: queries, type: top_queries, limit: 20 }
      - { id: query-movers, type: query_movers, limit: 10 }
      - { id: pages, type: top_pages, limit: 15 }
      - { id: page-movers, type: page_movers, limit: 10 }
      - { id: landing, type: landing_pages, limit: 15 }
      - { id: tracked, type: tracked_keywords }
      - { id: opportunities, type: opportunities, limit: 5 }
      - { id: audit, type: audit_changes }
      - { id: spend, type: data_spend }
      # Optional: rendered only when asked for (include: [cwv] or --include cwv).
      - { id: cwv, type: core_web_vitals_history, optional: true, formFactor: PHONE, weeks: 25 }
      - { id: gtm, type: tag_manager, optional: true, limit: 20 }
  quarterly:
    title: Quarterly SEO review
    period: { range: last_quarter }
    compare: [previous_year]
    sections:
      - { id: search, type: search_overview }
      - { id: brand, type: branded_split }
      - { id: traffic, type: organic_traffic }
      - { id: queries, type: top_queries, limit: 25, includeBranded: false }
      - { id: pages, type: top_pages, limit: 25 }
      - { id: audit, type: audit_changes }
      - { id: note, type: text, text: "Next review: early next quarter." }
```

Per-client override: `<home>/config/report-templates/example.com.yaml` (file name = `client.slug` + `.yaml`) with the same schema; its `branding` fields override the global ones field by field, its `defaults` override, and a template with the same id replaces the global one entirely (no section-level merge).

**Sample rendered report outline** (all formats share it):

```
[logo]  Example Agency
Example Co (example.com)
Monthly SEO report · September 2026 (1–30 Sep 2026)
Compared with August 2026 and September 2025 · Generated 3 Oct 2026

┌ Data-only report ───────────────────────────────────────────────┐
│ Built automatically from Search Console and Google Analytics.   │
│ It has no written commentary.                                   │   (with narrative: "Commentary written with
└─────────────────────────────────────────────────────────────────┘    Claude; all figures come from the data below.")

Key figures       Clicks 1,120 (+12.0% vs 1,000) · Impressions ... · CTR ... · Avg position 7.5 (from 8.2; lower is better)
Highlights (computed automatically)
  • Clicks rose 12.0% (from 1,000 to 1,120) vs August 2026.
  • Non-branded clicks: 640 (+18.5% vs 540).
  • 3 audit issues resolved, 1 new high-severity issue since the last audit.
[Summary]                         ← narrative.summary, only when given
1 Search performance              ← table: metric | Sep 2026 | Aug 2026 | change | Sep 2025 | change
  [Commentary]                    ← narrative.sections.search, only when given
2 Branded vs non-branded          ← table + the anonymized-queries note
3 Organic traffic (GA4)
4 Top queries                     ← table, branded marked
...
11 Changes since the last audit   ← resolved / new / persistent / unverified counts + top new findings
Data sources and notes            ← periods, sources per section, section errors ("Organic traffic: unavailable: no GA4 property"), the Search Console row-limit note
Footer: Prepared by Example Agency · crawlmark 0.x · page n of m (PDF)
```

### 12.A.2 Contract

#### Template schema (zod, strict; `src/reports/templates/schema.ts`)

| Field | Rule |
|---|---|
| `version` | literal `1` (required) |
| `branding` | optional `{ agencyName?: string(1..80), logo?: path string, primaryColor?: /^#[0-9a-fA-F]{6}$/, accentColor?: same, footer?: string(0..200), paper?: "Letter" \| "A4" }` |
| `defaults` | optional `{ template?: TemplateId, formats?: Format[] }` |
| `templates` | record of `TemplateId` (`/^[a-z0-9][a-z0-9-]{0,39}$/`) → Template; 1..50 entries |
| Template | `{ title: string(1..120), description?: string(..300), period?: Period (default {range: last_month}), compare?: ("previous_period" \| "previous_year")[] (default both; `[]` = none), sections: Section[] (1..40, unique ids) }` |
| Period | `{ range: "last_month" }` \| `{ range: "last_quarter" }` \| `{ range: "last_n_days", days: int 7..480 }` \| `{ range: "custom", start: YYYY-MM-DD, end: YYYY-MM-DD }` (start <= end, span <= 480 days) |
| Section (common) | `id` (`/^[a-z0-9][a-z0-9-]{0,39}$/`), `type` (below), `title?: string(1..120)` (default per type), `optional?: boolean`, `paid?: boolean` |
| Format | `"md" \| "html" \| "pdf" \| "docx"` |

Section types (each lists its extra fields; unknown fields are an error):

| type | Data from | Extra fields | Free? |
|---|---|---|---|
| `search_overview` | `gscTotals` for current + each comparison | `metrics?: ("clicks"\|"impressions"\|"ctr"\|"position")[]` | yes |
| `branded_split` | `splitBranded`/`compareSplit` on query rows (as `monthlyReport`) | — | yes |
| `organic_traffic` | `ga4OrganicSummary` | `metrics?: ("sessions"\|"users"\|"engagementRate"\|"keyEvents")[]` | yes |
| `top_queries` | `gscQuery` query rows | `limit?: 1..100` (20), `includeBranded?: boolean` (true; rows carry `branded`) | yes |
| `query_movers`, `page_movers` | `movers()` | `limit?: 1..50` (10) | yes |
| `top_pages` | `gscQuery` page rows | `limit?: 1..100` (15) | yes |
| `landing_pages` | `ga4TopLandingPages` | `limit?: 1..100` (15) | yes |
| `tracked_keywords` | as `monthlyReport` tracked rows | `liveRanks?: boolean` (false); `liveRanks: true` requires `paid: true` | GSC yes / live no |
| `opportunities` | `opportunitiesForMonth` (whole-period window) | `limit?: 1..25` (5) | yes |
| `audit_changes` | `monthlyAuditSection` | `limit?: 1..50` (10 new findings listed) | yes |
| `core_web_vitals_history` | `cruxHistory` (A.3) | `formFactor?: PHONE\|DESKTOP\|TABLET\|ALL` (PHONE), `weeks?: 1..40` (25), `scope?: origin\|url` (origin), `url?` | yes (key needed) |
| `tag_manager` | `runGtmAudit` | `limit?: 1..100` (20); **must be `optional: true`** (validation error otherwise, decision 1) | yes |
| `data_spend` | `spentThisMonth`, units this month | — | yes |
| `text` | the template's own text | `text: string(1..2000)` | yes |
| Stage B adds `rank_trend` (free), `keyword_gap` (paid). Stage C adds `bing_overview` (free), `site_crawl` (free), `local_profile` (paid), `ai_visibility` (paid). | | | |

Validation rules beyond the shape: a section whose type is paid (`keyword_gap`, `local_profile`, `ai_visibility`, or `tracked_keywords` with `liveRanks: true`) must set `paid: true`; `compare` entries are unique; `custom` periods must not end after today minus 2 days (Search Console lag); a `logo` path that doesn't exist is a **warning** in `validate` and a missing logo at render time (rendered without it, noted).

Period resolution (pure `resolvePeriod(period, runOverride, today)` in `src/reports/templates/period.ts`, reusing `src/lib/dates.ts`):
- `last_month` = `lastCompleteMonth()`; `previous_period` = previous month; `previous_year` = same month last year (exactly as `monthlyReport`). Run override `month: "YYYY-MM"`.
- `last_quarter` = last complete calendar quarter; `previous_period` = the quarter before; `previous_year` = same quarter last year. Run override `quarter: "YYYY-Qn"`.
- `last_n_days` = `lastDays(days, 3, today)`; `previous_period` = `previousRange`; `previous_year` = same dates minus one year (29 Feb maps to 28 Feb).
- `custom` / run override `startDate`+`endDate`: `previous_period` = same length immediately before; `previous_year` = minus one year.
- Label: "September 2026", "Q3 2026", or "1 Jul – 30 Sep 2026". Folder month (`YYYY-MM`) = the month of the period's end date.
- Run overrides are mutually exclusive (`month` | `quarter` | `startDate`+`endDate`); a `month` on a quarter template is allowed and makes it a one-month report (label says so).

#### Tools

All take `client` like today (`clientArg` in `src/tools/reports.ts`). Errors are tool errors through `handler()`.

1. **`list_report_templates({ client? })`** (READ_ONLY, free) → `{ templates: [{ id, title, description?, source: "builtin"|"global"|"client", period, sections: number, optionalSections: string[], paidSections: string[] }], files: { global: { path, exists, valid, errors? }, client?: { path, exists, valid, errors? } }, defaults }`. An invalid file never hides the builtin `monthly`; its errors are listed.
2. **`get_report_template({ client?, template })`** (READ_ONLY) → `{ id, source, file?, template (parsed, defaults filled), branding (resolved, logo as path + exists) }`; unknown id → error listing the ids.
3. **`validate_report_template({ yaml?: string(..100000), file?: "global"|"client", client? })`** (READ_ONLY, no network) → `{ valid: boolean, errors: [{ path: "templates.monthly.sections[3].limit", message }], warnings: [...] }`. Exactly one of `yaml` or `file`.
4. **`run_report_template({ client, template?, month?, quarter?, startDate?, endDate?, include?: string[], allowPaid?: boolean })`** (READ_ONLY; free unless `allowPaid` and the template has paid sections) → `TemplateReport`:

```ts
interface TemplateReport {
  reportId: string;                      // "rpt_" + ulid; the data is kept for 24 h (cache table) so export_report renders exactly this
  client: { slug: string; name: string; domain: string };
  template: { id: string; title: string; source: "builtin" | "global" | "client" };
  period: { current: DateRange; label: string; folderMonth: string; comparisons: { previous_period?: DateRange; previous_year?: DateRange } };
  generatedAt: string;                   // ISO
  sections: SectionResult[];             // template order; optional ones only when listed in include
  highlights: Highlight[];               // computed, deterministic (12.A.3 D3)
  notes: string[];                       // e.g. the anonymized-queries note, row-limit note
  spend: { usd: number; units: { ahrefs: number; semrush: number } };  // this run's paid spend (0 when free)
}
type SectionResult =
  | { id: string; type: string; title: string; status: "ok"; data: unknown }
  | { id: string; type: string; title: string; status: "error"; error: string }
  | { id: string; type: string; title: string; status: "unavailable"; reason: string }   // ProviderUnavailableError, no GA4 property, no CrUX key
  | { id: string; type: string; title: string; status: "skipped"; reason: string };      // paid section without allowPaid
interface Highlight { kind: string; sectionId: string; text: string; value?: number }
```

   `include` ids that don't exist or aren't optional → error. `data` per type is the same shape `monthly_report` uses for that part (e.g. `search_overview.data` = `{ vsPreviousPeriod, vsPreviousYear }` built by `compare()`), so prompt guidance carries over.
5. **`export_report({ client, reportId?, template?, month?, quarter?, startDate?, endDate?, include?, allowPaid?, formats?: Format[] (1..4), narrative?: { summary?: string(..6000), sections?: Record<sectionId, string(..6000)> }, inline?: "html" | "md" })`** (writes files; annotations `{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }`; timeout `TIMEOUTS.auditMs`).
   - With `reportId`: renders that stored report (client must match; period/template args must be absent); expired/unknown id → error "run run_report_template again". Without: runs the template first (same args as 4).
   - `formats` default: the template file's `defaults.formats`, else `["md","html"]`. `formats: []` with `inline` writes no file.
   - Narrative total <= 30,000 characters; unknown section ids → error. Narrative is model-written text: rendered as a tiny Markdown subset (paragraphs, `- ` bullets, `**bold**`), everything else literal, after `stripControl`.
   - Output: `{ client, template, period: { label, folderMonth }, dataOnly: boolean, files: [{ format, path, bytes, overwritten }], inline?: { mimeType: "text/html" | "text/markdown", title, content }, sectionErrors: [{ id, error }], warnings: string[] }`. `inline.content` is at most 1,000,000 characters (else error suggesting `md`), and the HTML variant is "docs-friendly": no logo image, no `<style>` beyond inline basics, plain `<table>`s.
   - Errors: PDF requested and Chrome missing → that format fails with the Chrome hint from `setup_status`, other formats still written (`warnings`), tool succeeds unless every format failed.
6. **`crux_history({ client?, url?, origin?, formFactor?: "PHONE"|"DESKTOP"|"TABLET"|"ALL", weeks?: 1..40, metrics?: ("lcp"|"inp"|"cls"|"fcp"|"ttfb")[] })`** (READ_ONLY, free; exactly one of `client` (origin `https://<domain>`, or `https://www.<domain>` when the client's key pages use www), `url`, `origin`) →

```ts
{ key: { origin?: string; url?: string; formFactor: string }, keySource: "CRUX_API_KEY" | "PSI_API_KEY",
  available: true,
  periods: { start: string; end: string }[],                       // YYYY-MM-DD, ascending
  metrics: { lcp?: Series; inp?: Series; cls?: Series; fcp?: Series; ttfb?: Series },
  fromCache: boolean }
  | { key, keySource, available: false, reason: string }            // no CrUX data for this origin/url
type Series = { unit: "ms" | "score"; p75: (number | null)[];
  latest: number | null; first: number | null; change: number | null;      // latest - first non-null
  rating: ("good" | "needs-improvement" | "poor" | null)[];                 // per period: LCP 2500/4000, INP 200/500, CLS 0.1/0.25, FCP 1800/3000, TTFB 800/1800
  trend: "improving" | "worsening" | "flat" | "insufficient-data" }        // compares mean of last 4 vs first 4 non-null periods; +/-5% band = flat
```

   No key → `ProviderUnavailableError`-style tool error: "CrUX History needs CRUX_API_KEY (or a PSI_API_KEY whose Google Cloud project has the Chrome UX Report API enabled). Run setup --step crux." A 403 mentioning the API not enabled → same hint plus "enable the Chrome UX Report API". The key is never in the result, error or cache key.
7. **`run_audit` additions** (additive): `includeTagManager?: boolean` (default false), `cruxHistory?: boolean` (default false). When set, `site.tagManager: Section<GtmAuditResult>` / `site.cruxHistory: Section<CruxHistoryResult>` appear; when not set, those keys are absent.

#### Prompts

- **`template-report`** (`{ client, template?, period?: string }` where `period` is `YYYY-MM`, `YYYY-Qn` or `YYYY-MM-DD..YYYY-MM-DD`): calls `list_report_templates` if `template` is missing and asks which one; `run_report_template`; checks sections' `status`; writes commentary per section with the same number-reading and honesty rules as `monthly-report-writeup` (quoted, not duplicated: both templates include a shared block `{{numberRules}}` rendered from one string in `src/prompts/index.ts`); asks which formats to save (default md + pdf), calls `export_report` with `reportId` and `narrative`; reports the file paths; then the Docs offer (below). Paid sections: it never passes `allowPaid` unless the user asked, and states the estimate first.
- **`monthly-report-writeup`** (additive steps 6 and 7): 6. "Offer to save it: call `export_report` with `client`, `template: \"monthly\"` (same month), the formats the user picks and your text as `narrative` (`summary` = your Summary; the other sections keyed by the template's section ids: search, brand, traffic, opportunities, audit). Tell the user the file paths." 7. the Docs offer.
- **Docs offer (both prompts, same text):** "Only if this conversation has a Google Drive tool that can create files (for example one named `create_file`): ask whether to save the report as a Google Doc in their Drive, and say that this puts the report in their Google Drive. Only after a yes: call `export_report` with the same `reportId`, `inline: \"html\"` and the same `narrative`, then call the Drive tool with `title` = the inline `title`, `textContent` = the inline `content`, `contentMimeType: \"text/html\"`, and no `parentId` unless the user names a folder. Don't share the file or change its permissions. If no such tool is available, don't mention Google Docs. If the Drive call fails, give the error and the local file path instead."

### 12.A.3 Decisions

- **D1. One report model, four renderers.** `buildReportDoc(report: TemplateReport, narrative?, branding)` (pure) produces `ReportDoc = { meta, banner, kpis, highlights, blocks: Block[], sourcesAndNotes, footer }` with `Block = heading | paragraph | list | table | kpiRow | note | commentary`. Renderers `toMarkdown`, `toHtml`, `toDocx` are pure functions of `ReportDoc`; `toPdf` prints `toHtml`'s output. Section-to-block mapping lives in one table (`src/reports/render/sections.ts`), so the four formats can't drift. Why: one place to escape, test and extend (Stages B/C add section types by adding a mapper).
- **D2. Data-only in CLI/cron, prose only from the model.** CLI renders `dataOnly: true`: the banner says so, highlights are computed facts, and no sentence interprets causes. The prompt path passes `narrative`, rendered in boxes labelled "Commentary" next to the data it discusses, and the banner changes to "Commentary written with Claude; all figures come from the data below." crawlmark never generates prose itself. Why: no model in cron; the label stops a reader mistaking computed text for analysis.
- **D3. Computed highlights** (pure `computeHighlights(report)`, deterministic, at most 8, ordered as listed): (1) clicks change vs previous period when |change| >= 5% and |delta| >= 20 clicks; (2) the same vs previous year; (3) non-branded clicks change (same thresholds); (4) GA4 organic sessions change (same thresholds); (5) top gaining and top losing query by clicks delta (non-branded first); (6) audit: resolved count, new critical/high count (unverified never counted as fixed); (7) tracked keywords that moved >= 3 positions (GSC average); (8) CrUX: a metric whose latest rating differs from the first period's. Every sentence quotes the absolute numbers beside the percent ("rose 12.0% (from 1,000 to 1,120)"); position changes say "lower is better". No highlight when a comparison is null.
- **D4. Escaping and safety per format.** Every string from data passes `stripControl`, then: HTML escapes `& < > " '`; Markdown escapes `\ ` `` ` `` `* _ [ ] < > | #` at line start and `|` in tables, and never emits raw HTML or links from data (URLs render as code spans); DOCX XML-escapes and drops characters invalid in XML 1.0. The HTML document has `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`, no script, no external resource; the logo is a `data:` URI. Why: queries, titles and URLs from Search Console are attacker-controllable.
- **D5. PDF through the managed Chrome, offline.** `toPdf(html)` uses `withBrowser` (`src/providers/browser.ts`) → new page, `page.setJavaScriptEnabled(false)`, request interception that aborts every request except `data:` URLs, `page.setContent(html, { waitUntil: "load" })`, `page.pdf({ format: branding.paper ?? "Letter", printBackground: true, margin: 15 mm, displayHeaderFooter: true, footerTemplate: page n of m })`, 90 s limit via `withChrome`. The printer is injected (`PdfPrinter`) so unit tests never start Chrome. Why: no new dependency; Chrome is already installed and guarded.
- **D6. DOCX via the `docx` library (decided by the user, 2026-10-13).** `src/reports/render/docx.ts` builds WordprocessingML from `ReportDoc` with `docx@9.8.1` pinned exactly (MIT, released 2026-09-28, the newest release at least two weeks old; about 7M weekly downloads, the de facto Node standard): headings 1–3, paragraphs with bold runs, bullet lists, tables with a header row and borders, the banner as a shaded one-cell table, an optional PNG/JPEG logo, footer text, branding colours. Why: building the file directly from the report model (not converting HTML) gives clean tables and headings in Word, Google Docs and LibreOffice; a hand-built OOXML writer risks "repair this file" prompts and was rejected for simplicity. Rejected: `html-to-docx` (unmaintained since 2023), `html-docx-js` and `officegen` (abandoned), Pandoc (external binary). Cost: about 18 MB unpacked and a few small deps (jszip, nanoid, xml, xml-js, hash.js); check `npm audit --omit=dev`, confirm no install scripts, and check the effect on the MCPB bundle size (prune unused builds if the bundle script allows). No `src/lib/zip.ts`.
- **D7. Where files go.** `REPORTS_DIR` (default `./reports`, resolved against the config home like `DATA_DIR`) → `<REPORTS_DIR>/<client>/<YYYY-MM>/<template>-<label-slug>.<ext>`, e.g. `monthly-2026-09.pdf`, `quarterly-2026-q3.html`, `monthly-2026-07-01-to-2026-09-30.docx`. `<client>` = `safeSegment(client.slug)`: lowercase, `[a-z0-9.-]` only (others → `-`), no leading `.` or `-`, no `..`, 1..100 chars; template ids are already constrained by the schema. The resolved path must stay inside `REPORTS_DIR` (checked after `resolve`), and existing `<client>` / `<YYYY-MM>` directories must not be symlinks (`lstat`). Directories `0700`, files `0600` (client data), written with `writeFileAtomic`. Re-running the same template and period overwrites (`overwritten: true`): the same report regenerated is the same file. `.gitignore` gains `reports/` (a source checkout's home is the repo root).
- **D8. Templates: YAML in the config home, builtin as code.** The builtin `monthly` template is a TypeScript constant (`src/reports/templates/builtin.ts`, no build-copy step); `templates init` writes the starter YAML (12.A.1) only when the file is absent. Lookup order for an id: client file → global file → builtin. Template files are read on each call (edits apply without a restart), parsed with `yaml` (`maxAliasCount: 10`, size cap 256 KB) and validated with zod; YAML errors carry line/column.
- **D9. `reportId` keeps prose and numbers in sync.** `run_report_template` stores the `TemplateReport` in the existing `cache` table (`cacheKey("report-run", reportId)`, `TTL.day`); `export_report({ reportId })` renders that exact data. Why: otherwise the commentary could describe numbers that changed between the two calls.
- **D10. CLI `report`** reuses `scheduledCommand`'s structure (`src/cli.ts`): `--client` | `--all` (discovery first, ignored clients skipped, as `audit --all`), `--template`, `--month` | `--quarter` | `--start`+`--end`, `--format` (comma list), `--include`, `--paid`, `--dry-run` (resolves templates, periods and paths, fetches nothing, writes nothing). Clients run one at a time. Output JSON on stdout (`{ command: "report", ranAt, dryRun, results, skipped, errors, discovery, exitCode }`). **Exit codes:** 0 every requested report written and no section `error`; 2 at least one report written but a section had `status: "error"` or a requested format failed (attention needed; `unavailable` and `skipped` don't count, so a client without GA4 isn't a permanent 2); 1 usage error, invalid template, unknown `--client`, every client failed, or a file couldn't be written. A client where every section is `error`/`unavailable` is listed in `skipped` and gets no file.
- **D11. CrUX key.** `CRUX_API_KEY`, else `PSI_API_KEY`. `setup --step crux` asks for a key (blank = use PSI_API_KEY) and checks it with one free History query for `https://developer.chrome.com` (a public origin, no client data). `setup_status` gains a `crux` row: `working` / `configured` / `missing` with the step. Cached `TTL.day` per (origin|url, formFactor, weeks, metrics) (data changes weekly). `CRUX_BASE_URL` is a shell-only test override.
- **D12. CrUX in audits produces findings only when asked.** With `cruxHistory: true`, `extractFindings` adds source `"crux"` findings at the origin: `field-lcp-poor` (high) / `field-lcp-needs-improvement` (medium), the same for INP and CLS, from the **latest** period; checked pair `{ url: "site:crux <origin>", source: "crux" }`. `FindingSource` gains `"crux"` and `"gtm"` (additive union members).
- **D13. GTM findings in `run_audit`.** With `includeTagManager: true`, `collectAudit` runs `runGtmAudit(client)` as a site-level `section()`; `extractFindings` maps each `GtmFinding` to a `Finding` with `source: "gtm"`, `rule`, `severity`, `title` (entity name through `stripControl`), `url: "gtm://<publicId>/<kind>/<entityId>"`, `evidence`. Checked pair `{ url: "gtm://<publicId>", source: "gtm" }`; `checkOf` maps every gtm finding to its container key, so a later audit without `includeTagManager` shows earlier GTM findings as `unverified`, never `resolved`. GTM severities are medium/low, so they never raise scheduled alerts (`ALERT_SEVERITIES`). Not in `monthly_report`, not in default templates.

### 12.A.4 Data

- No schema migration. Report runs live in the existing `cache` table (24 h). Report files are outside SQLite.
- New env: `REPORTS_DIR` (default `./reports`), `CRUX_API_KEY` (optional), `CRUX_BASE_URL` (shell-only test override). `.env.example` documents the first two. `mcpb/manifest.json` gains an optional sensitive `crux_api_key` user_config mapped to `CRUX_API_KEY`.
- Rollback: delete the branch; generated files under `reports/` are inert; no stored data changes shape.

### 12.A.5 Files (all backend)

| File | Change |
|---|---|
| `src/reports/templates/schema.ts` (new) | zod schema, section type catalogue, `validateTemplateFile` (errors with YAML paths) |
| `src/reports/templates/builtin.ts` (new) | builtin `monthly` (+ the starter YAML text for `templates init`) |
| `src/reports/templates/load.ts` (new) | file lookup (global, per-client), merge of branding/defaults, `resolveTemplate(id, client)` |
| `src/reports/templates/period.ts` (new) | `resolvePeriod`, labels, folder month (pure) |
| `src/reports/templates/run.ts` (new) | `runTemplate(client, template, opts)` → `TemplateReport`; section fetchers reuse monthly.ts helpers; `reportId` storage |
| `src/reports/monthly.ts` | extract shared helpers (`searchOverview`, `brandedSplitFor`, `trackedRows`, ...) without changing `monthlyReport`'s output |
| `src/reports/highlights.ts` (new) | `computeHighlights` (pure) |
| `src/reports/render/doc.ts`, `sections.ts`, `markdown.ts`, `html.ts`, `docx.ts`, `pdf.ts`, `narrative.ts`, `escape.ts` (new) | D1, D4–D6; `narrative.ts` parses the Markdown subset |
| `src/reports/export.ts` (new) | `exportReport` (paths D7, formats, inline), `safeSegment`, `reportPath` |
| `src/lib/zip.ts` (new) | minimal ZIP writer |
| `src/providers/crux.ts` (new) | `cruxHistory` client (key, redaction, cache, 404 → unavailable) |
| `src/analysis/crux.ts` (new) | p75 parsing (CLS strings), ratings, trend, crux findings (pure) |
| `src/analysis/findings.ts` | `"gtm"`, `"crux"` sources; mapping; `checkOf`/`checkedPairs` for both |
| `src/reports/audit.ts` | `includeTagManager`, `cruxHistory` options and sections (keys only when set) |
| `src/tools/reports.ts` | the five report tools, `run_audit` options |
| `src/tools/raw.ts` | `crux_history` |
| `src/prompts/index.ts`, `src/prompts/templates/template-report.md` (new), `monthly-report-writeup.md` | prompt, shared `{{numberRules}}`, export and Docs steps |
| `src/cli.ts`, `src/cli-help.ts`, `src/scheduled.ts` | `report` command group, `audit --include-tag-manager`, `RunReport.command` gains `"report"` |
| `src/config.ts` | `REPORTS_DIR`, `CRUX_API_KEY`, `CRUX_BASE_URL` |
| `src/setup/*` (`checks.ts`, `status.ts`, `status-render.ts`, `wizard.ts` step registry, `cli-setup.ts`) | `--step crux`; `crux` status row (human output only when configured) |
| `mcpb/manifest.json` | 6 tools, 1 prompt, `crux_api_key` |
| `test/setup.ts` | isolation additions (12.0) |
| `test/*.test.ts`, `test/fixtures/crux/*.json`, `test/fixtures/reports/*` | 12.A.7 |
| `README.md`, `docs/reports.md` (new), `docs/audits.md`, `docs/scheduling.md`, `.env.example`, `.gitignore`, `docs/launch/blog-outline.md`, `implementation.md` | docs (task A-9) |

### 12.A.6 Tasks

Each is its own commit on `phase-12a`. Parallel where marked (contract above is locked; no file overlap between parallel tasks).

1. **A-1** Spec link: `implementation.md` "Phase 12" entry pointing here. — first.
2. **A-2** Template schema, builtin, loader, period resolution, `validate`/`list`/`get` tools, `templates list|validate|init` CLI. — after A-1.
3. **A-3** `runTemplate` + monthly.ts helper extraction (golden test: `monthly_report` output unchanged) + `computeHighlights` + `run_report_template`. — after A-2.
4. **A-4** Report doc model, Markdown and HTML renderers, escaping, narrative parser. — after A-2; **parallel with A-3** (works against the `TemplateReport` type and fixtures).
5. **A-5** DOCX renderer (`docx@9.8.1`). — after A-4. **Parallel with A-6.**
6. **A-6** PDF printer via `withBrowser`. — after A-4.
7. **A-7** `exportReport`, paths, `export_report` tool, CLI `report` (exit codes). — after A-3, A-5, A-6.
8. **A-8** CrUX: provider, analysis, `crux_history`, `setup --step crux` + status row, template section, `run_audit cruxHistory` + findings. — after A-1; **parallel with A-2..A-7** (touches only its own files plus `findings.ts`/`audit.ts`, which A-2..A-7 don't touch); the `core_web_vitals_history` section mapper lands after A-4.
9. **A-9** GTM in `run_audit` + findings + `audit --include-tag-manager` + `tag_manager` section. — parallel with A-8 except `findings.ts`/`audit.ts`: **sequence A-8 then A-9** for those two files.
10. **A-10** Prompts: `template-report`, `monthly-report-writeup` steps, shared number rules. — after A-7.
11. **A-11** Docs, manifest, `.env.example`, `.gitignore`, blog outline (Coming). — last before review.
12. **A-12** QA run of Done-when; security review (file writes, escaping, PDF offline, key redaction); reviewer. Then the merge commit flips the blog items to Shipped.

### 12.A.7 Tests (no network, no Chrome, temp home)

- Schema: the starter YAML is valid; each section type's fields; unknown field, duplicate id, bad id, `tag_manager` without `optional`, paid type without `paid: true`, custom period ending in the lag window, span > 480 days → errors with YAML paths; invalid YAML gives line/column; alias bomb refused; > 256 KB refused.
- Loader: client file overrides global overrides builtin; branding merges field by field; an invalid global file leaves the builtin available and reports errors.
- Periods: last_month, last_quarter across a year boundary, last_n_days, custom, 29 Feb previous_year, labels and folder month; mutually exclusive overrides.
- `runTemplate` with stubbed providers: section order, optional sections only when included, unknown include → error, paid section without `allowPaid` → `skipped`, provider unavailable → `unavailable`, a throwing source → `error` and other sections still ok; `reportId` round-trip; expired id error.
- **Golden:** `monthlyReport` on fixtures returns byte-identical JSON before and after the helper extraction (fixture captured from `main` in A-3's first commit).
- Highlights: each rule fires at and not below its thresholds; null comparisons give nothing; unverified findings never counted as resolved; wording includes absolute numbers.
- Renderers: snapshot of MD and HTML for a fixture report (data-only and with narrative); XSS fixture (a query `<img src=x onerror=alert(1)>`, a title with `](javascript:...)`, a bidi override, a `|` in a table cell) is inert in every format; the HTML has the CSP meta and no `<script>`, `http(s)://` resource or event handler attribute; narrative subset (bold, bullets, paragraphs; raw HTML stays literal).
- DOCX: open the output with jszip (a docx dependency) → expected parts present, `[Content_Types].xml` lists them, every XML part parses (cheerio `xmlMode`), headings/tables/lists present, logo in `word/media` only when configured, no untrusted control characters.
- PDF: with an injected fake page, JavaScript is disabled, every non-`data:` request is aborted, paper size follows branding; Chrome missing → that format in `warnings`, others written.
- Paths: `safeSegment` cases (`../x`, `.hidden`, unicode, 200 chars), path escape attempt refused, symlinked client dir refused, modes 0700/0600, overwrite flag.
- CLI `report`: `--client` and `--all` with fake deps, dry run writes nothing, exit codes 0/1/2 per D10, unknown client exit 1, usage errors exit 1, JSON shape.
- CrUX: fixture response (CLS strings, null p75s, NaN densities) → series, ratings, trend; 404 → `available: false`; key never in cache key, error text or result (assert on the serialized result and on the thrown message); `CRUX_API_KEY` preferred over `PSI_API_KEY`; status row states.
- Findings: gtm and crux mapping, stable ids, `checkOf`; diff of an audit with `includeTagManager` followed by one without → GTM findings `unverified`; default `run_audit` result has no `tagManager`/`cruxHistory` keys (key-set equality with a pre-change fixture).
- Prompts: `template-report` args, Docs offer text present only as conditional instructions; `monthly-report-writeup` keeps its existing sections (existing tests pass).
- Manifest test passes with the new tools/prompts; Phase 10 plain transcripts byte-identical.

### 12.A.8 Done when

- [ ] `npm run typecheck`, `npm run build`, `npm test` pass; `npm test` leaves the mtimes of `~/.claude.json`, the Claude Desktop config, `~/.cursor/mcp.json`, `~/.codex/config.toml` and `~/.crawlmark` unchanged.
- [ ] With a temp `CRAWLMARK_HOME` and fixture-backed fakes (or a real Google account with the user's OK), `crawlmark-cli report --client example.com --format md,html,pdf,docx` writes four files under `<home>/reports/example.com/<YYYY-MM>/`, modes 0600, directories 0700, and prints JSON with `exitCode` 0.
- [ ] The PDF starts with `%PDF-`; the DOCX passes `unzip -t` and opens without a repair prompt in Microsoft Word (or LibreOffice when Word isn't available) and in Google Docs (import by hand); the HTML opens offline with no network requests (DevTools network panel empty) and shows the data-only banner.
- [ ] `crawlmark-cli report --all --dry-run` writes nothing (file list and mtimes of the temp home unchanged).
- [ ] `crawlmark-cli report templates init` creates the starter file once; a second run leaves it unchanged and says so; `templates validate` on a file with an error exits 1 naming the YAML path.
- [ ] In Claude Code with the MCP Inspector or a session: `template-report` produces files whose banner says "Commentary written with Claude" and whose commentary boxes match the narrative; with a Drive connector present the prompt offers a Google Doc and creates it only after "yes" (manual check by the user; untested end to end until then).
- [ ] A default `run_audit` result has the same key set as on `main`; `includeTagManager: true` adds `site.tagManager` and `gtm` findings; `compare_audits` on (with, without) shows them `unverified`.
- [ ] `crux_history` on a fixture returns 25 periods by default; with no key it errors with the `setup --step crux` hint; the key string appears nowhere in tool output, errors, `tool_calls` rows or the cache table (grep of the temp DB).
- [ ] `monthly_report` golden test passes (output unchanged).
- [ ] Plain `setup --dry-run < /dev/null` and `setup --yes --dry-run` transcripts are byte-identical to `main`.
- [ ] README tool table, `docs/reports.md` (templates, formats, paths, branding, Docs handoff, cron example), `docs/scheduling.md` (`report`, `--include-tag-manager`), `.env.example`, `.gitignore`, manifest and blog outline updated; `grep -ri` finds no real client names or domains.

### 12.A.9 Open questions (recommendations)

1. Default PDF paper size → **Letter**, configurable per branding (`A4`). Needs a human decision? No.
2. DOCX: **decided** — use `docx@9.8.1` (see D6).
3. Should `crawlmark-cli report` post a short "reports ready" message to `ALERT_WEBHOOK_URL`? → **No** in Phase 12 (non-goal; webhook stays for alerts). No decision needed unless the user wants it.
4. Include `core_web_vitals_history` as a default (non-optional) section of the starter `monthly`? → **No**: the starter mirrors today's monthly report; the section is in the file as optional. User may flip it.
5. Keep generated reports forever? → **Yes**, no automatic cleanup; document deleting the folder. No decision needed.

---

## Stage B (12c): stored rank history, keyword ideas, competitor keyword gap

Branch `phase-12b`, after Stage A merges (it adds template sections and uses the export pipeline).

### 12.B.1 What the user sees

```
> How have our tracked keywords moved since July for example.com?
  rank_history { client: "example.com", since: "2026-07-01" }
  → plumber example city: GSC avg 8.4 → 5.1 (better by 3.3); live rank 7 → 4 (4 checks)
> Check live ranks now.
  check_ranks { client: "example.com", live: true, estimateOnly: true }  → 12 keywords, est. $0.024 of $5.00 left ($4.71 remaining this month)
  check_ranks { client: "example.com", live: true }                    → saved 12 live ranks; 2 moved out of the top 10
> What keywords do our competitors rank for that we don't? (keyword-research prompt)
  keyword_gap { client: "example.com", estimateOnly: true } → semrush: 2 competitors × 50 lines × 80 units = 8,000 units; client cap 5,000 → would exceed
  "That needs 8,000 Semrush units but example.com has 5,000 left this month. Use limit 25 (4,000 units), or raise monthlyUnits.semrush."
```

```
crawlmark-cli check-ranks --all                 # free: Search Console 7-day average position for every tracked keyword, stored
crawlmark-cli check-ranks --client example.com --live   # paid: DataForSEO live SERP, pre-flight checked against the caps
crawlmark-cli check-ranks --all --live --dry-run        # lists keywords and the estimate; calls nothing
```

New tools: `check_ranks`, `rank_history`, `keyword_ideas`, `keyword_gap`. New prompt: `keyword-research`. New CLI: `check-ranks`. New template sections: `rank_trend` (free), `keyword_gap` (paid).

### 12.B.2 Contract

**Data** (in `src/lib/store.ts`, additive):

```sql
CREATE TABLE IF NOT EXISTS rank_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client      TEXT NOT NULL,        -- client.slug
  keyword     TEXT NOT NULL,        -- normalised: trimmed, lowercased, inner whitespace collapsed
  source      TEXT NOT NULL,        -- 'serp' (live, DataForSEO) | 'gsc' (7-day average position)
  day         TEXT NOT NULL,        -- YYYY-MM-DD: check date (serp) or window end date (gsc)
  checked_at  INTEGER NOT NULL,     -- ms epoch
  rank        REAL,                 -- serp: absolute organic rank; gsc: average position; NULL = not found in depth / no impressions
  url         TEXT,                 -- ranking URL (serp) or top page (gsc)
  depth       INTEGER,              -- serp depth checked
  market      TEXT NOT NULL,        -- area (location_name) or location code as text
  language    TEXT NOT NULL,
  device      TEXT NOT NULL DEFAULT 'desktop',
  clicks      INTEGER,              -- gsc only
  impressions INTEGER,              -- gsc only
  UNIQUE (client, keyword, source, day, market, language, device)
);
CREATE INDEX IF NOT EXISTS rank_history_lookup ON rank_history (client, keyword, source, day);
```

Upsert on the unique key (latest check of the day wins). Only keywords in the client's `trackedKeywords` are stored. Older builds ignore the table; no rollback step needed. Rows are written by `check_ranks`, `crawlmark-cli check-ranks`, `monthly_report` with `liveRanks` (side effect only; output unchanged) and `serp_check` when the keyword is tracked for that client.

**Tools**

1. **`check_ranks({ client, live?: boolean (false), keywords?: string[] (subset of tracked; others → error), estimateOnly?: boolean })`** (writes SQLite; local-write annotations). GSC mode: one `gscQuery` for `lastDays(7, 3)` with `dimensions: ["query","page"]` filtered to tracked keywords (free). Live mode: also `serp()` per keyword (DataForSEO-only, `requireDataForSeo("serpLive")`), estimate = n × `ESTIMATE_USD.serp`, `assertBudget` for the total before the first call. → `{ client, day, gscWindow, results: [{ keyword, gsc: { position, clicks, impressions, page } | null, live: { rank, url } | null, previous: { gsc: number|null, live: number|null }, change: { gsc: number|null, live: number|null } }], saved: number, costUsd, estimate? }`. `estimateOnly` returns `{ estimate: { provider: "dataforseo", usd, requests }, remaining: { clientUsd, globalUsd }, wouldExceed }` and writes nothing.
2. **`rank_history({ client, keyword?, source?: "serp"|"gsc"|"both" ("both"), since?: YYYY-MM-DD (180 days ago), until? })`** (READ_ONLY, free, local only) → `{ client, keywords: [{ keyword, series: { gsc?: [{ day, rank, clicks, impressions }], serp?: [{ day, rank, url }] }, summary: { latest, first, best, worst, change, change30d, change90d } per source }] }` ("lower is better" in the description).
3. **`keyword_ideas({ client, seeds: string[] (1..20), mode?: "related"|"matching" ("related"), limit?: 1..200 (50), estimateOnly? })`** (READ_ONLY, paid, routed capability `keywordIdeas`) → `{ ideas: [{ keyword, volume, cpc, competition: number|null, difficulty: { metric: "dataforseo_kd"|"ahrefs_kd"|"semrush_kd", value: number|null }, intent: string|null, seed }], notes?, ...ProviderMeta }`. Provider mapping and estimates:

   | Provider | related | matching | Estimate |
   |---|---|---|---|
   | DataForSEO | Labs `keyword_ideas/live` (all seeds, one task) | Labs `keyword_suggestions/live` (one task per seed) | tasks × $0.012 + limit × $0.00012 per task |
   | Ahrefs | `keywords-explorer/related-terms` (`terms=also_rank_for`) | `matching-terms` (`match_mode=terms`) | max(50, 22 × limit) units per request, one request with all seeds |
   | Semrush | `phrase_related` (40/line) | `phrase_fullsearch` (20/line) | per seed: lines × price, `display_limit = ceil(limit / seeds)` (never omitted) |
4. **`keyword_gap({ client, competitors?: string[] (default: the client's saved competitors, at most 3), limit?: 1..500 (50, per competitor), minVolume?: int (0), estimateOnly? })`** (READ_ONLY, paid, routed capability `keywordGap`) → `{ gaps: [{ keyword, volume, difficulty, competitors: [{ domain, position, url }], clientPosition: number|null, clientCheck: "provider"|"gsc" }], perCompetitor: [{ domain, returned }], notes?, ...ProviderMeta }`, sorted by volume, deduped across competitors. No competitors saved and none passed → error pointing at `suggest_competitors`. Provider mapping:

   | Provider | Request per competitor | Estimate |
   |---|---|---|
   | DataForSEO | Labs `domain_intersection/live` with `target1` = competitor, `target2` = client, `intersections: false`, `item_types: ["organic"]` | $0.012 + limit × $0.00012 |
   | Semrush | `domain_domains` with `domains = *|or|<competitor>|-|or|<client>`, `display_limit = limit` | limit × 80 units |
   | Ahrefs | `site-explorer/organic-keywords` for the competitor, `select=keyword,best_position,best_position_url,volume` (13 units/row), then exclude keywords the client already ranks for: from Search Console (free; queries with impressions in the last 90 days, `clientCheck: "gsc"`), or when the client has no Search Console property, one `organic-keywords` call for the client with limit 1000 (included in the estimate) | max(50, 13 × limit) per competitor (+ max(50, 13 × 1000) without GSC) |

**Routing.** `Capability` gains `"keywordIdeas" | "keywordGap"`, both in `ROUTED_CAPABILITIES` and in all three providers' `CAPABILITIES`; `SeoDataProvider` gains optional `keywordIdeas` / `keywordGap`. Resolution, missing-key errors and "no silent fallback" are unchanged (`resolveProvider`). Caching `TTL.week` per (provider, normalised args, market). Estimates are computed once for the whole call; `assertUnits` / `assertBudget` run on the total before the first request; actual units/cost recorded per request as today (timeouts record the estimate).

**Alerts.** `Alert` gains `{ kind: "rank-drop", client, keyword, previousRank: number|null, currentRank: number|null, source: "serp" }` (additive union member). Only live SERP checks alert: a keyword that was in the top 10 and is now outside it or not found, or one that worsened by at least `ALERT_RANK_DROP` places (default 5; new env). GSC averages are trend data and never alert. `formatAlertText` gets a line format for it (keyword through `stripControl` and the mrkdwn escaper).

**CLI `check-ranks`.** `--client` | `--all`, `--live`, `--dry-run`; JSON like `audit`; webhook on alerts; exit codes from `exitCodeFor` (0/1/2). `--live --all` checks the summed estimate against each client's cap per client (a client over cap is skipped with the cap message, others run).

**Template sections.** `rank_trend` (`{ since?: "90d"|"180d"|"365d" (180d), source?: "gsc"|"serp"|"both" }`, free, local only) and `keyword_gap` (`{ limit?, competitors? }`, requires `paid: true` and `allowPaid`). Renderers add mappers (table with sparkline-free text trend: first → latest).

**Prompt `keyword-research`** (`{ client, seeds?: string }`): always calls the tool with `estimateOnly: true` first, states the provider and cost/units and the remaining cap, and runs the real call only after the user agrees; then groups ideas or gaps by intent and suggests which page should target each (from `top_pages`).

### 12.B.3 Decisions

- **B-D1.** Store only tracked keywords (keeps the table small and avoids storing every ad-hoc query a user asks about). `serp_check` on an untracked keyword stores nothing.
- **B-D2.** Free GSC history by default; live SERP is opt-in and the only alerting source (GSC averages move with impressions mix; alerting on them would be noisy).
- **B-D3.** The Ahrefs gap uses the client's own Search Console data to decide "client already ranks" (free, and the client's data is first-party), labelled `clientCheck: "gsc"`. Why: Ahrefs has no gap endpoint, and a 1,000-row client call costs 13,000 units.
- **B-D4.** Difficulty is labelled per provider (`dataforseo_kd`, `ahrefs_kd`, `semrush_kd`) and never mixed, like Phase 9's authority metric (D7).
- **B-D5.** Defaults are sized to fit the default per-client caps where possible (Semrush gap: 50 lines × 80 = 4,000 units per competitor vs a 5,000 default cap), and the estimate message says exactly which limit would fit.

### 12.B.4 Files (all backend)

`src/lib/store.ts` (table), `src/lib/rank-history.ts` (new: upsert, queries, summaries), `src/analysis/ranks.ts` (new: changes, alert rule, pure), `src/analysis/alerts.ts` (`rank-drop`), `src/providers/seo-data.ts` (capabilities, routed `keywordIdeas`/`keywordGap`, estimates), `src/providers/dataforseo.ts` + `dataforseo-shape.ts` (Labs endpoints, `ESTIMATE_USD` entries), `src/providers/ahrefs.ts` + `ahrefs-shape.ts`, `src/providers/semrush.ts` + `semrush-shape.ts`, `src/reports/monthly.ts` (persist live ranks; output unchanged), `src/tools/raw.ts` (`serp_check` persistence), `src/tools/ranks.ts` (new: `check_ranks`, `rank_history`), `src/tools/competitors.ts` (`keyword_ideas`, `keyword_gap`), `src/scheduled.ts` + `src/cli.ts` + `src/cli-help.ts` (`check-ranks`), `src/reports/templates/schema.ts` + `src/reports/render/sections.ts` (two sections), `src/prompts/index.ts` + `templates/keyword-research.md`, `src/config.ts` (`ALERT_RANK_DROP`), `mcpb/manifest.json`, tests and fixtures (`test/fixtures/{dataforseo,ahrefs,semrush}/` new files built from the documented responses), README, `docs/clients.md`, `docs/scheduling.md`, `docs/reports.md`, `.env.example`, `docs/launch/blog-outline.md`.

### 12.B.5 Tasks

1. **B-1** Table + `rank-history.ts` + `rank_history` tool. — first.
2. **B-2** `check_ranks` (GSC + live), persistence from `monthly_report` and `serp_check`, alerts, CLI `check-ranks`. — after B-1.
3. **B-3** Capability plumbing + DataForSEO Labs `keyword_ideas` / `keyword_gap`. — after B-1; **parallel with B-2** (different files except `src/cli.ts`, which only B-2 touches).
4. **B-4** Ahrefs and Semrush implementations. — after B-3.
5. **B-5** Template sections `rank_trend`, `keyword_gap`; prompt `keyword-research`. — after B-2, B-4.
6. **B-6** Docs, manifest, blog outline (Coming). Then QA, security (cap enforcement, key redaction), reviewer.

### 12.B.6 Tests

- Store: upsert keeps one row per key; normalisation; only tracked keywords stored; queries by range; summaries (best/worst/change30d/90d) with gaps in data.
- `check_ranks`: GSC mode makes no paid call (DataForSEO fetch stub asserts zero calls); live mode estimate equals n × serp estimate; `assertBudget` is called once with the total before the first request; cap exceeded → no request; `estimateOnly` writes nothing; `ProviderUnavailableError` when DataForSEO isn't configured; Ahrefs-provider client still gets GSC mode.
- Alerts: top-10 exit, not-found, drop >= threshold, improvement and GSC-only changes don't alert; webhook text escaped; CLI exit codes.
- Ideas/gap per provider with fixtures: request params (Semrush `display_limit` always present; `domains` string exact; DataForSEO `intersections: false`; Ahrefs `select` exact), estimates equal the documented formula, units/cost recorded, caching, normalised output, difficulty labels; Ahrefs gap uses GSC when available and includes the client call in the estimate when not; no fallback when the chosen provider's key is missing (error names the step).
- `monthly_report` golden test still passes with `liveRanks` (rows written, output unchanged).

### 12.B.7 Done when

- [ ] typecheck, build and tests pass; isolation mtimes unchanged.
- [ ] `crawlmark-cli check-ranks --all` against fixture-backed fakes (or the user's Google account with their OK) stores GSC rows; a second run on the same day keeps one row per keyword; `rank_history` returns them.
- [ ] `check_ranks { live: true, estimateOnly: true }` returns an estimate and makes no request (fake server request log empty).
- [ ] With a fake provider server, `keyword_gap` for a Semrush client with the default 5,000-unit cap and 2 competitors refuses before any request, naming a limit that fits.
- [ ] `monthly_report` output is unchanged (golden), and a `rank-drop` alert reaches a local fake webhook from `check-ranks --live`.
- [ ] Docs, manifest, blog outline updated; no real client names.
- [ ] **Live check (deferred, needs the user's approval and keys):** one `keyword_ideas` and one `keyword_gap` call per configured provider at the smallest limit, confirming the estimates against the reported cost/units (answers 12.Q-B1).

### 12.B.8 Open questions (recommendations)

1. **B1** Do Semrush `domain_domains` partial results (when units run low) need special handling? → Treat fewer lines than `display_limit` as "possibly partial" in `notes`, like Phase 9. No decision needed.
2. **B2** Retention of `rank_history` → keep everything (a year of daily GSC rows for 50 keywords is about 18k rows). No decision needed.
3. **B3** Should `check-ranks --all --live` be allowed in cron at all? → Yes, but only with `--live` explicit; recommend weekly. User may prefer manual only.

---

## Stage C (later items): each sub-stage merges on its own

Order: **C1** local crawler, **C2** server logs (both free, fully verifiable locally), **C3** Bing Webmaster (free; live check needs the user's Bing key), **C4** local SEO and **C5** AI-search visibility (paid; live check needs DataForSEO spend and the user's approval). Each sub-stage: own branch (`phase-12c1` ...), own docs/manifest/blog-outline commit, own Done-when.

### C1. Free bounded local crawler

**User sees.** `local_crawl { client: "example.com", maxPages: 300 }` → "Crawled 287 pages in 2m 10s (exhaustive: yes). 4 broken internal links, 2 redirect chains, 11 duplicate titles, 3 orphan pages (in the sitemap, not linked)." `crawlmark-cli crawl --client example.com --max-pages 500`. `run_audit { localCrawl: true }` adds the crawl's findings; `site_hygiene` orphans use the newest exhaustive crawl, local or DataForSEO.

**Contract.**
- `local_crawl({ client, maxPages?: 1..2000 (300), maxDepth?: 1..20 (10), concurrency?: 1..8 (4), userAgent?: "crawlmark"|"googlebot" ("crawlmark"), includeSubdomains?: boolean (false), startUrls?: string[] (default: the homepage plus key pages) })` (local-write annotations; timeout 10 min) → `{ crawlId, client, ranAt, durationMs, exhaustive: boolean, stoppedBy: null|"maxPages"|"time"|"aborted", pages: number, summary: { byStatus, redirects, brokenLinks, duplicateTitles, missingTitles, duplicateDescriptions, missingDescriptions, canonicalIssues, noindex, depthHistogram, orphans: { available, count, reason? } }, topIssues: Finding[] (max 50), findingCount }`.
- `local_crawl_pages({ crawlId, issue?: rule, status?: number, limit?: 1..500 (100) })` (READ_ONLY) → pages `{ url, status, depth, title, description, canonical, robots, h1Count, inlinks, outlinks, redirectChain, issues }`.
- Rules: robots.txt for the chosen UA group (`crawlmark` or `Googlebot`, else `*`) via `parseRobots`/`isAllowed`; `Crawl-delay` honoured up to 10 s; otherwise one request per 250 ms per host (`createLimiter`). Every request through the URL guard: `assertSafeUrlResolved` + pinned connection (refactor `getPinned` in `src/providers/render.ts` into an exported single-hop `fetchHop(url, { ua, signal })`), each redirect hop re-checked, at most 5 hops; same registrable host only (plus subdomains when asked); `RESTRICT_TO_CLIENT_DOMAINS` applies. HTML only (by `content-type`), 2 MB body cap, 15 s per request, 10 min per crawl, `mapLimit` concurrency. Query strings kept but fragments dropped; URL normalisation reuses `normalizeUrl`. Honest UA: `crawlmark/<version> (+https://github.com/idrewlong/crawlmark-mcp)`; `googlebot` mode sends the existing `GOOGLEBOT_UA` and obeys the Googlebot robots group.
- Storage: `local_crawls (id TEXT PRIMARY KEY, client TEXT NOT NULL, ran_at INTEGER NOT NULL, settings TEXT, summary TEXT, exhaustive INTEGER NOT NULL, pages TEXT NOT NULL)` + index `(client, ran_at DESC)`; keep the last 10 per client (older rows deleted on insert).
- Findings (source `crawl`, already in `FindingSource`): `broken-internal-link` high (target 4xx/5xx; url = target, evidence = first linking page and count), `redirect-chain` medium (>= 2 hops), `internal-link-to-redirect` low, `missing-title` high, `duplicate-title` medium, `missing-description` medium, `duplicate-description` low, `canonical-to-non-200` medium, `canonical-elsewhere` low, `deep-page` low (depth > 4), `noindex-linked` low. Checked pairs: every crawled URL with source `crawl`, plus `site:crawl`. Orphans: `site-hygiene.ts` picks the newest **exhaustive** crawl among local crawls and the stored DataForSEO task within `ORPHAN_MAX_CRAWL_AGE_DAYS`; orphan rule and finding unchanged (`orphanUrls`, `orphanFlags`), and the reason/notes name the crawl source.
- `run_audit({ localCrawl?: boolean, maxLocalCrawlPages? })` (keys only when set). Template section `site_crawl` (free; summarises the latest stored crawl, never starts one).

**Decisions.** Seeds are the homepage and key pages, never sitemap URLs (otherwise nothing could be an orphan). A capped crawl is `exhaustive: false` and never judges orphans (same rule as today's DataForSEO crawl). No JavaScript rendering (cost; `render_check` covers it). No new dependency (cheerio for links).

**Tests.** Fake fetcher over an in-memory site: BFS depth, caps (`stoppedBy`), robots disallow and crawl-delay, redirect chains, off-host links ignored, private-address hop refused (guard stub), body cap, duplicate detection, findings and checked pairs, retention of 10, orphans picking local vs DataForSEO by age. No real network.

**Done when.** Tests pass; on a site the user names and owns (manual, with their OK), `crawlmark-cli crawl --client <it> --max-pages 50` finishes, respects its robots.txt (a disallowed path never appears in the server's access log or the result), and `site_hygiene` reports orphans from it; `run_audit` default output unchanged; docs/manifest/blog updated.

### C2. Server-log analysis (local files, never uploaded)

**User sees.** `log_analysis { client: "example.com", files: ["access.log*"] }` → "Googlebot (verified): 4,210 hits in 14 days; 3.1% 404s (top: /old-page ×120); GPTBot 1,904 hits, ClaudeBot 640, PerplexityBot 212; 38% of Googlebot hits were on parameter URLs." CLI: `crawlmark-cli logs --client example.com /var/log/nginx/access.log /var/log/nginx/access.log.2.gz`.

**Contract.**
- `log_analysis({ client, files: string[] (1..50; names or globs relative to an allowed log directory), since?, until?, bots?: string[] (default all known), verify?: boolean (true) })` (READ_ONLY) → `{ files: [{ name, lines, parsed, skipped, format }], window, bots: [{ bot, family: "search"|"ai-training"|"ai-search"|"ai-user"|"other", hits, verified: number, unverified: number, unknownVerification: number, byStatus: { "2xx", "3xx", "4xx", "5xx" }, topPaths: [{ path, hits, status }] (20), top404: [...], top5xx: [...], byDay: [{ day, hits }], parameterShare, lastSeen }], notes }`. Paths have query strings removed; no IPs, user agents beyond the bot name, referrers or raw lines in the output.
- **File access:** the MCP tool reads only regular files inside `LOG_DIRS` (comma-separated absolute directories; new env, unset = the tool is unavailable with a setup hint) or `<home>/logs`; each path is `realpath`ed and must stay inside an allowed directory; symlinks out are refused; `.gz` streamed through `createGunzip`; at most 2 GB and 20 million lines per call. The CLI takes explicit paths (the user typed them) and needs no `LOG_DIRS`.
- Formats: Apache/Nginx `combined` and `common` (auto-detected per file); other lines are counted as `skipped`.
- Bot table (UA substring → bot, family): Googlebot, Google-InspectionTool, GoogleOther, Google-Extended (robots token only; noted), Bingbot, GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, CCBot, Applebot, Amazonbot, Bytespider, Meta-ExternalAgent. Kept in `src/analysis/bots.ts`, editable.
- **Verification** (`verify: true`): Googlebot IPs against Google's published `common-crawlers.json` and `special-crawlers.json` (research G1), fetched once a week (`TTL.week`) from `CRAWLER_IPRANGES_BASE_URL` (default `https://developers.google.com/static/crawling/ipranges/`); the request sends nothing about the user. Other bots: `unknownVerification` (no reverse DNS in Phase 12). `verify: false` makes no network request at all.
- Nothing is written to SQLite (no IPs at rest).

**Tests.** Parser on fixture lines (both formats, malformed lines, IPv6, gz); bot matching; CIDR matching for v4/v6; path containment (`../`, absolute outside, symlink out, non-regular file) refused; output contains no IP or raw UA (assert by regex over the serialized result); `verify: false` makes zero fetches; large-file caps.

**Done when.** Tests pass; `crawlmark-cli logs` on a fixture log prints the summary; the MCP tool refuses a path outside `LOG_DIRS`; docs say logs never leave the machine.

### C3. Bing Webmaster Tools (read-only)

**User sees.** `bing_report { client: "example.com" }` → clicks/impressions by day for the last 28 days vs the 28 before, top queries and pages, crawl stats and crawl issues. `setup --step bing` (key checked with the free `GetUserSites`); `setup_status` row `bing` (human output only when configured). Template section `bing_overview`.

**Contract.**
- Env `BING_WEBMASTER_API_KEY` (optional), `BING_BASE_URL` (shell-only test override; default `https://ssl.bing.com/webmaster/api.svc/json`). Manifest user_config `bing_webmaster_api_key` (sensitive).
- `src/providers/bing.ts`: `bingGet(method, params)` accepts only methods in `BING_READ_METHODS = ["GetUserSites", "GetRankAndTrafficStats", "GetQueryStats", "GetPageStats", "GetCrawlStats", "GetCrawlIssues", "GetUrlInfo"]` (a test asserts no name matching `/^(Add|Remove|Submit|Save|Update|Enable|Verify|Fetch)/` is reachable). The key goes in the `apikey` query parameter as Bing requires; the URL is never logged or put in an error; cache key = `cacheKey("bing", method, siteUrl)`; errors map `{"ErrorCode":3}` → "Bing rejected the API key; run setup --step bing". `/Date(ms±hhmm)/` parsed to ISO dates.
- Client matching: `GetUserSites` URLs matched to clients with the existing normaliser (`src/lib/clients.ts`), cached a day; clients.yaml `bingSite` overrides (new optional field, set via `clients set --bing-site` and `set_client_profile`).
- `bing_report({ client, days?: 7..180 (28) })` (READ_ONLY) → `{ site, window, previous, totals: { clicks, impressions, ctr, change }, byDay, topQueries: [{ query, clicks, impressions, avgPosition }] (25), topPages (25), crawl: { stats (latest 30 days), issues: [{ url, issue }] (50) }, notes: ["Bing updates query stats weekly"] }`. No key → unavailable with the step; site not verified for this key → error naming `bingSite`.

**Tests.** Allowlist; key redaction (key absent from errors/results/cache/`tool_calls`); date parsing; client matching; fixture responses from the documented samples; status row and plain transcript unchanged.

**Done when.** Tests pass; **live check (deferred; needs the user's Bing key, free):** `setup --step bing` succeeds and `bing_report` returns data for one verified site; Not-confirmed items 3 in the research doc answered.

### C4. Local SEO via DataForSEO Business Data (paid, opt-in)

**User sees.** `local_profile { client: "example.com", estimateOnly: true }` → "$0.0054, one request". Then: profile (name, category, rating 4.7 from 132 reviews, claimed, hours, photos) and a prompt to confirm the matched place before saving its `placeId`. `local_pack { client: "example.com" }` → map-pack position for the first 5 tracked keywords in `area`, plus the top 3 businesses. `local_reviews { client: "example.com", depth: 20 }` → rating distribution and the latest reviews (text, rating, date, owner replied yes/no; **no reviewer names**).

**Contract.**
- DataForSEO-only capabilities `localProfile`, `localPack`, `localReviews` (via `requireDataForSeo`; no Ahrefs/Semrush equivalent). New clients.yaml field `gbpPlaceId` (saved only by `set_client_profile` / `clients set --place-id`, after the user confirms the match; never automatically).
- `local_profile({ client, query? (default client.name), placeId?, estimateOnly? })` → `my_business_info/live` (`keyword` = `place_id:<id>` when known, else the name; location from `area`, else `locationCode`). Estimate `ESTIMATE_USD.myBusinessInfo = 0.0054` (to confirm live). → `{ matched: { title, address, phone, url, domain, category, additionalCategories, rating, votes, ratingDistribution, isClaimed, placeId, cid, totalPhotos, workHours }, domainMatchesClient: boolean, costUsd }`.
- `local_pack({ client, keywords? (default first 5 tracked), depth?: 10..100 (20), estimateOnly? })` → `serp/google/maps/live/advanced` per keyword ($0.002 each) → `{ results: [{ keyword, clientRank: number|null, top: [{ rank, title, domain, rating, votes }] (3) }], costUsd }`. Client matched by `placeId`/`cid`, else by domain.
- `local_reviews({ client, depth?: 10..100 (20), sortBy?: "newest"|"lowest_rating"|"highest_rating"|"relevant" ("newest"), taskId?, estimateOnly? })` → reviews are task-based: `task_post` with `priority: 2` (up to about 1 minute; $0.0015 per 10 reviews), then poll `task_get` every 5 s for up to 75 s; if not ready, return `{ pending: true, taskId }` and the next call with `taskId` reads it (no new charge). → `{ rating, votes, distribution, reviews: [{ rating, date, text (stripControl, max 1,000 chars), ownerReplied: boolean }], costUsd }`.
- Template section `local_profile` (paid; profile + pack summary).

**Tests.** Request bodies, estimates and ledger rows; budget refusal before any request; polling with fake timers and the pending path; reviewer names absent from output; text sanitised; `gbpPlaceId` never written by these tools.

**Done when.** Tests pass. **Live check (deferred; needs DataForSEO live spend, under $0.10 total, and the user's approval):** one call of each tool on the user's own business; record actual costs and the review item fields (research Not-confirmed 5).

### C5. AI-search visibility via DataForSEO LLM Mentions (paid, strictly opt-in)

**User sees.** Off by default. With `AI_VISIBILITY_ENABLED=true`: `ai_visibility { client: "example.com", estimateOnly: true }` → "$0.12 for 20 rows (minimum $0.10 per request). DataForSEO has required a $100 monthly top-up for LLM Mentions access; their July 2026 update says this was removed, so check your account." Then: questions in Google AI Overviews (or ChatGPT, US English only) where the domain is cited, with the cited URL and AI search volume; or aggregate metrics.

**Contract.**
- Gate: env `AI_VISIBILITY_ENABLED=true` (new; default off) **and** DataForSEO configured (`requireDataForSeo("aiVisibility")`). Its own monthly sub-cap `AI_VISIBILITY_MONTHLY_BUDGET_USD` (default 2, global) checked in addition to the client and global USD caps (ledger endpoint prefix `ai_optimization/`).
- `ai_visibility({ client, mode?: "mentions"|"metrics" ("mentions"), platform?: "google"|"chat_gpt" ("google"), limit?: 1..100 (20), estimateOnly? })`:
  - `mentions` → `llm_mentions/search_mentions/live` (fall back to the documented legacy `search/live` path only if the new path returns 404 in the live check; decided then, not at runtime) with `target: [{ domain: <client domain>, search_scope: "sources" }]`, `order_by: ["ai_search_volume,desc"]`. → `{ items: [{ question (stripControl, 300 chars), platform, aiSearchVolume, citedUrl, position, answerExcerpt (stripControl, 500 chars) }], total, costUsd }`.
  - `metrics` → `llm_mentions/target_metrics/live` for the domain → counts as returned (shape confirmed in the live check; until then the raw `result[0]` minus unknown nested arrays, sanitised).
  - `chat_gpt` with a non-US/non-English client → error before any request.
  - Estimate = $0.10 + limit × $0.001 (research D11).
- The tool description, README and `docs/reports.md` state the possible $100 monthly top-up, the per-request minimum, and that sandbox mode is free for trying it.
- Template section `ai_visibility` (paid).

**Tests.** Gate off → unavailable with the exact enable instructions; sub-cap enforced before any request; estimate formula; sanitising of answers; `chat_gpt` market check; no request in `estimateOnly`.

**Done when.** Tests pass. **Live check (deferred; needs the user's approval for at most $0.30 of DataForSEO spend and confirmation of LLM Mentions access on their account):** one `metrics` and one `mentions` call; confirm paths, response fields and the minimum-commitment status (research Not-confirmed 6).

### 12.C Files (all backend)

C1: `src/providers/crawler.ts` (new), `src/analysis/crawl.ts` (new, pure: issues, duplicates, findings), `src/providers/render.ts` (`fetchHop`), `src/lib/store.ts` (`local_crawls`), `src/lib/crawls.ts` (new), `src/reports/site-hygiene.ts` (orphan source choice), `src/reports/audit.ts`, `src/analysis/findings.ts`, `src/tools/crawl.ts` (new), `src/cli.ts` (`crawl`). C2: `src/analysis/logs.ts`, `src/analysis/bots.ts`, `src/analysis/cidr.ts`, `src/providers/crawler-ipranges.ts`, `src/tools/logs.ts`, `src/cli.ts` (`logs`), `src/config.ts` (`LOG_DIRS`, `CRAWLER_IPRANGES_BASE_URL`). C3: `src/providers/bing.ts`, `src/tools/bing.ts`, `src/lib/clients.ts` + `clients-file.ts` (`bingSite`), `src/setup/*` (`--step bing`, status row), `src/config.ts`. C4: `src/providers/dataforseo.ts` + `dataforseo-shape.ts` (business data, maps), `src/providers/seo-data.ts` (capabilities), `src/tools/local.ts`, `src/lib/clients.ts` + `clients-file.ts` (`gbpPlaceId`). C5: same provider files, `src/tools/ai-visibility.ts`, `src/lib/budget.ts` (sub-cap), `src/config.ts`. Each: template section mapper (`src/reports/templates/schema.ts`, `src/reports/render/sections.ts`), `mcpb/manifest.json`, tests, fixtures, README, `docs/*.md`, `.env.example`, `config/clients.example.yaml` (new fields), `docs/launch/blog-outline.md`.

### 12.C Tasks (per sub-stage, in order)

For each of C1 to C5: (1) provider/analysis with fixtures and tests; (2) tools and CLI; (3) template section and `run_audit` option where listed; (4) docs, manifest, blog outline (Coming); (5) QA, security review (C1: SSRF and politeness; C2: path containment and PII; C3: key handling), reviewer; merge flips the blog items to Shipped. C1 and C2 may be built in parallel (no shared files except `src/cli.ts` and `src/config.ts`: C2 rebases on C1). C4 and C5 share `dataforseo.ts`: sequence C4 then C5.

---

### 12.2 Ownership

| Agent | Owns |
|---|---|
| backend | every file named in 12.A.5, 12.B.4 and 12.C (code, tests, fixtures, docs, manifest, `.gitignore`, `.env.example`, `implementation.md`, `docs/launch/blog-outline.md`) |
| qa | no files; runs each stage's Done-when and reports |
| security | no files; reviews Stage A (file writes, escaping, PDF offline mode, key redaction), C1, C2, C3 |
| reviewer | no files; final gate per stage/sub-stage |
| planner | this spec and `docs/research/2026-10-13-phase-12-apis.md` |

No file is owned by two agents. Within backend, the parallel tasks above name which shared files force a sequence.

### 12.3 Execution order

- **Sequential across stages:** A → B → C1 → C2 → C3 → C4 → C5 (each merges before the next starts; C1 ∥ C2 allowed).
- **Within A:** A-1 → A-2 → (A-3 ∥ A-4) → (A-5 ∥ A-6) → A-7 → A-10 → A-11 → A-12; A-8 runs in parallel from A-1 on; A-9 after A-8 (shared `findings.ts`, `audit.ts`).
- **Within B:** B-1 → (B-2 ∥ B-3) → B-4 → B-5 → B-6.
- **Live checks** (all deferred to the end of their stage, each needs the user's explicit OK): B (provider ideas/gap, small limits), C3 (Bing key, free), C4 (DataForSEO < $0.10), C5 (DataForSEO <= $0.30 and LLM Mentions access). Stage A and C1/C2 are fully verifiable without keys or spend (A's real-Google run is optional).

### 12.4 Risks

- **DOCX doesn't open cleanly somewhere** → test in Word/LibreOffice/Google Docs in Done-when.
- **Google Docs import mangles tables** → the inline HTML is deliberately plain (no CSS classes, simple `<table>`); if it still fails, the prompt offers Markdown (`inline: "md"`, `contentMimeType: "text/markdown"`). Untested end to end until the user's manual check.
- **`monthly.ts` refactor changes `monthly_report` output** → golden test captured before the refactor.
- **CrUX key confusion** (PSI key without the CrUX API enabled) → specific 403 hint and `setup --step crux` check.
- **Crawler politeness** → honest UA, robots, crawl-delay, low default concurrency, 300-page default.
- **Paid endpoints' real prices differ from estimates** → estimates are conservative ceilings; live checks record actual cost; ledger stores actuals.
- **LLM Mentions minimum commitment unclear** → stated in the tool and docs; off by default with its own sub-cap.
- **Logs contain personal data (IPs)** → never output, stored or logged; aggregates only.

### 12.5 Open questions needing a human decision

1. **DOCX** — decided: `docx@9.8.1` (D6).
2. **Default PDF paper size** Letter (recommended) or A4.
3. **`check-ranks --live` in cron** (12.B.8 B3): allowed with explicit `--live` (recommended) or manual only.
4. **AI visibility gate**: off by default behind `AI_VISIBILITY_ENABLED` with a $2/month sub-cap (recommended), or a per-client opt-in instead.
5. **Starter template**: keep CrUX History as optional (recommended) or make it a default section.

### 12.6 Not confirmed (carried from the research doc; answered by the live checks)

See `docs/research/2026-10-13-phase-12-apis.md` "Not confirmed" 1–9. Items 1–2 are answerable with the user's free Google key in Stage A; 3 in C3; 4, 6, 7, 8 in B/C live checks; 5 in C4; 9 in Stage A's manual Docs check.


## Decisions recorded 2026-10-13 (user)

- DOCX: `docx@9.8.1` library (D6).
- PDF default paper size: Letter (changeable per branding).
- AI-search visibility: off by default; global `AI_VISIBILITY_ENABLED=true` switch with its own $2/month sub-cap.
- Core Web Vitals (CrUX) history: optional section in the starter template, not on by default.
- `check-ranks --live` allowed in cron only when `--live` is given explicitly.
- Tag Manager: opt-in only in audits and templates.
- Google Docs: via the user's own Drive connector; crawlmark stays read-only on Google.
