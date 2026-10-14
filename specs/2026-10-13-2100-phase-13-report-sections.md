<!--
Status: draft (awaiting approval)
Created: 2026-10-13 20:13 CDT (file slot 21:00 as requested)
Author: Claude Code / my-skills:planner / branch phase-13-plan
Owner: backend (data, providers, tools, CLI, docs) and frontend (report renderers and the interactive template builder), per 13.9
Reasoning: Phase 12 shipped report files and templates, and the report redesign (branch report-redesign) turns them into an agency dashboard. Agencies still have to open Ahrefs or Semrush for the numbers clients ask about most (backlinks, keyword visibility, competitors) and still have no single list of technical problems or a view of Google's indexing. The user approved six items (backlinks, organic visibility, competitor overview, technical issues, optional Search Console indexing issues, and a way to build templates by picking sections). This plan builds them in three stages: free data first, paid provider sections second, the template builder last.
Research:
  - docs/research/2026-10-13-phase-13-report-sections.md (written for this plan: Ahrefs and Semrush Site Audit, Ahrefs/Semrush/DataForSEO visibility and backlink history, URL Inspection and Sitemaps)
  - docs/research/ahrefs-api-v3.md, docs/research/semrush-api.md (Phase 9), docs/research/2026-10-13-phase-12-apis.md (Phase 12)
  - specs/2026-10-13-1500-phase-9-seo-data-providers.md (provider layer, D2 "no silent fallback", D7 labelled authority metric, unit and USD caps)
  - specs/2026-10-13-1900-phase-12-reports-and-gaps.md (templates, D1 one report model, D4 escaping, D9 reportId, Stage B/C sections, run-level paid pre-flight)
  - Branch report-redesign (commit 9c5eb3a): dashboard layout, hidden empty sections, operator-only content out of files, white label, PDF-only default. Its `setup --step branding` preview loop is still in flight and not yet committed; 13.C reuses it once merged.
  - There is no docs/decisions/DECISIONS.md. Binding decisions: Phase 9 9.10, Phase 10 rules, Phase 12 12.0 and "Decisions recorded 2026-10-13", and the user's Phase 13 scope (13.0).
Supersedes: none.

Lives in specs/ (my-skills convention); implementation.md gets a "Phase 13" entry linking here (task A-1).
-->

## Phase 13: Provider report sections and a technical-issues report

**Status:** draft, 2026-10-13. **Starts after `report-redesign` merges to `main`.** Three stages, each merged on its own:

- **Stage A (free):** the shared snapshot store and run-level unit reservation, the `technical_issues` section from crawlmark's own stored results (plus a stored DataForSEO crawl), and the opt-in `indexing_issues` section from URL Inspection and Sitemaps.
- **Stage B (paid, opt-in):** `backlinks`, `organic_visibility` and `competitor_overview` sections through the client's provider, with month-over-month comparisons from local snapshots, and Ahrefs / Semrush Site Audit as extra sources for `technical_issues`.
- **Stage C (UX):** `crawlmark-cli report templates new` (pick sections, see cost, preview, save) and MCP tools that draft a template from a request and save it only after the user confirms.

**Goal.** An agency can put backlinks, keyword visibility, competitors, one deduplicated technical-issues list and Google's indexing picture into the same branded report as Search Console and GA4, see what changed since last month, and build its own templates by picking sections, without leaving crawlmark and without surprise spend.

**Non-goals.**
- Starting crawls or audits from a report: no DataForSEO `on_page/task_post`, no Ahrefs/Semrush project or audit creation, no Semrush `launch`/`enable`/`save`. Reports read stored results only.
- Writing to Google, Ahrefs or Semrush (no sitemap submission, no URL inspection "request indexing", no project management).
- Per-URL backlink lists, anchor text, link-building outreach, toxic-link audits.
- Rank Tracker / Position Tracking project data (later).
- The full Search Console Page indexing report (the API doesn't expose it; 13.3 D9).
- Template deletion through MCP; a web template editor.
- LLM-written prose in CLI/cron mode (unchanged from Phase 12 D2).

### 13.0 Rules that apply to every stage

User-approved scope (2026-10-13), binding:
1. `backlinks`: referring domains, total backlinks, the authority metric labelled per provider and never mixed, new/lost when the provider offers it, change vs the previous period from local snapshots even when the provider has no history.
2. `organic_visibility`: ranked keywords, distribution top 3 / 4–10 / 11–20 / 21–100, estimated traffic, trend from stored snapshots, per the client's provider.
3. `competitor_overview`: top organic competitors (saved first, else provider-suggested), keyword overlap, their visibility vs the client's.
4. `technical_issues`: one deduplicated, severity-grouped list from every available source, with sources per issue, changes since the last report (new/resolved/persistent/unverified), and a documented severity mapping. Stored results preferred; paid fetches only with `paid: true` + `allowPaid` and a whole-operation pre-flight.
5. `indexing_issues`: opt-in, free, read-only Google scope; key pages plus a bounded rotating sitemap sample within a locally tracked daily quota; cached; aggregated by coverage state; worst URLs; trend.
6. Template building: interactive CLI with free/paid labels, per-client estimates, period, comparison, format, preview, save; MCP tools that show the YAML/diff and save only after explicit confirmation, never enabling paid sections without the user's OK, validated by the existing schema.
7. New sections go into the builtin `monthly`, `quarterly` and `technical` templates as **optional**; blog outline entries marked **Coming**.

Principles (inherited from Phase 12 12.0; each is checked in a Done-when): local storage only under the config home; read-only Google and provider access (allowlisted paths, tested); free first; spend caps with whole-operation pre-flight **and reservations**; no silent provider fallback (`resolveProvider`, D2); no client data leaves the machine beyond the provider the call is for; secrets never echoed (`redact`); untrusted text through `stripControl` then per-format escaping (Phase 12 D4); test isolation (fixtures built from documented examples, no real network, `test/setup.ts`); example.com/org/net only; additive output only (no existing tool field changes meaning; `run_audit`, `monthly_report`, existing sections byte-identical); plain installer output unchanged; MCP annotations and `mcpb/manifest.json` entries for every new tool; blog outline Coming → Shipped at merge.

Phase 13 additions:
- **Operator-only content stays out of files** (report-redesign): costs, units, project IDs, quota counts, provider error text, cache ages beyond "as of <date>" stay in tool/CLI results. Files say what the data is and how old it is.
- **One provider per figure.** A section's current value and its comparison always come from the same provider and market; a provider change starts a new series (note in the file, no mixed chart).
- **Semrush one-month storage rule.** Anything crawlmark keeps from Semrush is deleted after 31 days (research §2, S5).

### 13.1 Context (existing code this phase builds on)

- Stack (package.json / lockfile): Node >= 22.13 (ESM, `node:sqlite`), TypeScript 7.0, `@modelcontextprotocol/sdk` ^1.32.1, `zod` ^4.6.7, `yaml` ^2.9.1, `@clack/prompts` ^1.8.1, `docx` 9.8.1, `googleapis` ^185, vitest. **No new runtime dependency.**
- Providers: `src/providers/seo-data.ts` (`Capability`, `ROUTED_CAPABILITIES`, `CAPABILITIES`, `resolveProvider`, `choose`, `requireDataForSeo`, `AuthorityMetric`, `PaidPlan`, `estimateFor`, `EstimateResult`), `src/providers/dataforseo.ts` (`paid()`, `ESTIMATE_USD`, `LABS_USD`, `labsTaskUsd`, `labsOperation`, `backlinksSummary`, `competitorDomains`, `onPageSummary`, `onPagePagesWithIssue`), `dataforseo-shape.ts` (`mapBacklinksSummary`, `mapCompetitors`), `src/providers/ahrefs.ts` + `ahrefs-shape.ts` (`AHREFS_PATHS`, `AHREFS_FIELD_UNITS`, `estimateAhrefsUnits`, `ahrefsLimiter`, `ahrefsBacklinksSummary`), `src/providers/semrush.ts` + `semrush-shape.ts` (`SEMRUSH_UNITS`, `estimateSemrushUnits`, `v3Report`, `semrushBacklinksSummary` v4/v3, `semrushLimiter`), `src/providers/units-billing.ts` (`unitsCall`, `pendingFor`, `remainingUnits`, `redact`), `src/providers/gsc.ts` (`gscInspectUrl`, `gscSitemaps`, `gscQuery`).
- Budget: `src/lib/budget.ts` (`assertBudget`, `withUsdReservation` with AsyncLocalStorage own-reservation exclusion, `assertUnits`, `recordSpend`, `recordUnits`, `remainingUsd`).
- Audits and findings: `src/reports/audit.ts` (`runAudit`, `collectAudit`), `src/analysis/findings.ts` (`Finding`, `FindingSource`, `Severity`, `SEVERITY_ORDER`, `checkOf`, `checkKey`, `normalizeUrl`, `ONPAGE_SEVERITY`), `src/analysis/diff.ts` (`diffAudits` new/resolved/persistent/unverified, `monthlyAuditSection`), `src/lib/audits.ts` (`latestAudit`, `latestAuditBefore`, `latestCrawlTask`), `src/reports/site-hygiene.ts` (sitemap collection, `ORPHAN_MAX_CRAWL_AGE_DAYS`), `src/reports/local-crawl.ts`, `src/lib/crawls.ts` (`latestCrawl`), `src/analysis/crawl.ts` (`analyzeCrawl`, `topFindings`).
- Storage: `src/lib/store.ts` (additive `migrate*` pattern: `migrateRankHistory`, `migrateLocalCrawls`), `src/lib/cache.ts` (`cached`, `cacheKey`, `TTL`, `peekCache`, `putCache`), `src/lib/atomic-file.ts`.
- Templates (as on `report-redesign`): `src/reports/templates/schema.ts` (section union, `SECTION_TITLES`, `PAID_SECTION_TYPES`, `isPaidSection`, `semanticIssues`, `validateTemplateText`, `layout`), `builtin.ts` (`BUILTIN_MONTHLY`, `BUILTIN_QUARTERLY`, `BUILTIN_TECHNICAL`, …, `STARTER_YAML`), `load.ts` (`loadTemplates`, `readTemplateFile`, `TemplateSource`), `run.ts` (`RunDeps`, `planRun`, `runTemplate` with the run-level paid pre-flight and `withUsdReservation`), `service.ts` (`initStarterFile`, `listReportTemplates`), `src/reports/paths.ts` (`globalTemplatesFile`, `clientTemplatesFile`), `src/reports/report-types.ts`, `src/reports/highlights.ts`.
- Rendering (as on `report-redesign`): `src/reports/render/doc.ts` (`Block`: `kpiRow`, `table` with `bar`, `chart` `line`/`share`, `columns`, `note`; `Kpi` with `delta`/`tone`), `sections.ts` (`SECTION_MAPPERS`, `MapContext` with `whiteLabel`, `pagePath`, `betterCell`, `severity` tags, mappers return `[]` to hide a section), `svg.ts`, `html.ts`, `docx.ts`, `markdown.ts`.
- CLI and tools: `src/report-cli.ts` (`templatesCommand`, `reportCommand`, `FORMAT_CHOICES`, `chooseFormats`), `src/cli.ts`, `src/cli-help.ts`, `src/scheduled.ts`, `src/tools/reports.ts`, `src/tools/raw.ts` (`backlinks_summary`, `gsc_inspect_url`), `src/tools/competitors.ts` (`set_client_profile`), `src/tools/util.ts` (`handler`, `READ_ONLY`), `src/lib/clients-file.ts` (comment-preserving YAML edits with the `yaml` Document API), `src/setup/ui.ts` / `ui-clack.ts`.
- Google scope: `DATA_SCOPES` in `src/lib/google-auth.ts` already includes `https://www.googleapis.com/auth/webmasters.readonly`, which URL Inspection accepts (research G2).

### 13.2 What the user sees

In Claude:

```
> Add backlinks and keyword visibility to example.com's September report.
  run_report_template { client: "example.com", template: "monthly", month: "2026-09", include: ["backlinks","visibility"], estimateOnly: true }
  → DataForSEO: backlinks $0.025 (summary; last month's snapshot is stored, so no history call) + visibility $0.0122 = $0.0372. example.com has $4.61 left this month.
> Go ahead.
  run_report_template { ..., include: ["backlinks","visibility"], allowPaid: true }
  → Backlinks: 212 referring domains (+14, +7.1% vs 198 in August), 1,840 backlinks, DataForSEO Rank 312 (0–1000 scale).
    Organic visibility: 1,204 ranking keywords (top 3: 41, 4–10: 118, 11–20: 160, 21–100: 885), est. 3,950 visits/month (DataForSEO ETV).

> What's broken on example.com right now? Put it in the technical report.
  technical_issues { client: "example.com" }
  → 23 issues (2 high, 9 medium, 12 low) from the 9 Oct audit, the 11 Oct local crawl and site hygiene.
    New since the last report: 3. Resolved: 5. Not re-checked: 2 (never counted as fixed).

> Draft me a template with search, backlinks and the technical issues, quarterly.
  create_report_template { client: "example.com", id: "board", template: { title: "Quarterly board pack", period: { range: "last_quarter" }, sections: [...] } }
  → (proposal, nothing saved) YAML + diff shown; paid sections: backlinks (~$0.025 per run for example.com).
    "Save this to ~/.crawlmark/config/report-templates.yaml? It includes 1 paid section."
> Yes, save it, paid is fine.
  create_report_template { ..., confirmToken: "tpl_7Q…", paidAcknowledged: true }  → saved; validate passes.
```

From the CLI:

```
$ crawlmark-cli report templates new --client example.com
  ◆ Template id: board        Title: Quarterly board pack
  ◆ Sections (space to select)
    Search Console   ◼ Search performance (free)  ◻ Top queries (free) …
    Site health      ◼ Technical issues (free)    ◻ Indexing issues (free · Google quota)
    SEO data (paid)  ◼ Backlinks (paid · DataForSEO · ~$0.025 / run for example.com)
                     ◻ Organic visibility (paid · ~$0.012)   ◻ Competitor overview (paid · ~$0.018)
  ◆ Period: Last quarter   Compare: previous period, previous year   Layout: standard
  ◆ Default format for this file: PDF
  ◇ Preview written (free sections only): ~/.crawlmark/reports/.preview/example.com/board.html — opened
  ◆ Save to ~/.crawlmark/config/report-templates.yaml?  ● Save  ○ Change sections  ○ Cancel
  ✔ Saved template "board" (validated). Run: crawlmark-cli report --client example.com --template board --paid

$ crawlmark-cli index-coverage --all            # cron, daily: inspects up to the daily budget per property, free
$ crawlmark-cli seo-snapshot --all --paid       # cron, monthly: stores backlinks + visibility snapshots (estimate first; --dry-run)
$ crawlmark-cli report --client example.com --template technical --include issues,indexing
```

New tools: `technical_issues`, `index_coverage`, `inspect_index_coverage` (A); `organic_visibility`, `competitor_overview`, `seo_trends` (B); `create_report_template`, `update_report_template` (C). Changed additively: `run_report_template` / `export_report` (`estimateOnly`), `backlinks_summary` and `gsc_inspect_url` (side effect: store a snapshot / inspection), `set_client_profile` + `clients set` (`ahrefsSiteAuditProject`, `semrushProject`). New CLI: `index-coverage`, `seo-snapshot`, `report templates new`. New template sections: `technical_issues`, `indexing_issues` (A), `backlinks`, `organic_visibility`, `competitor_overview` (B).

### 13.3 Decisions

- **D1. One snapshot store for trends (`seo_snapshots`).** Every paid section result (and the `backlinks_summary` tool for the client's own domain) is upserted as a dated snapshot per (client, kind, target, provider, market). Comparisons and trends read snapshots first; a provider's own history endpoint is used only when no local snapshot is close enough **and** the provider has one, and its points are stored too (`source: "provider_history"`). Why: month-over-month works for every provider (including Semrush, which has no backlink history we can use), re-running a report costs nothing, and history is bought at most once.
- **D2. Snapshot reuse window.** A section reuses a `live` snapshot of the same key captured within `SNAPSHOT_REUSE_DAYS` (default 7, env) instead of calling the provider; `refresh: true` forces a call. This sits on top of the existing response cache (`TTL.week`). Why: free first; a monthly report run twice in a week costs once.
- **D3. Comparison matching.** For a section in a report with period P (end date E): *current* = the snapshot nearest E within ±`tolerance` days (monthly 10, quarterly 20, custom/last_n 10), else a fresh fetch (labelled "as of <today>" when today is more than tolerance after E, with a note). *previous_period* = nearest to E − length(P) within tolerance; *previous_year* = nearest to E − 1 year within 31 days. Same provider and market only. No match → that comparison column is dropped with one note (redesign behaviour). Why: snapshots are dated captures, not period aggregates; tolerance keeps "September vs August" honest without demanding a capture on the exact day.
- **D4. Authority never mixed (Phase 9 D7 extended).** `backlinks` shows `authority: { metric, label, scale, value }` with labels "DataForSEO Rank (0–1000)", "Ahrefs Domain Rating (0–100)", "Semrush Authority Score (0–100)". Charts never plot two metrics on one axis; a provider change mid-series starts a new series and the file says so.
- **D5. New/lost only as the provider reports it.** DataForSEO: `new_referring_domains` / `lost_referring_domains` / `new_backlinks` / `lost_backlinks` for the snapshot's month from `backlinks/history` (only when that call is made). Semrush v4: `new_count` / `lost_count` (backlinks; window not documented, labelled "as reported by Semrush"). Ahrefs: none (fields `null`, row hidden). crawlmark never derives "new/lost" from a net difference; the net change is shown as "change", never as new/lost.
- **D6. Visibility bands.** Distribution = `{ top3, pos4_10, pos11_20, pos21_100 }`. DataForSEO: `pos_1 + pos_2_3`, `pos_4_10`, `pos_11_20`, sum `pos_21_30` … `pos_91_100`; total = `count`; traffic = `etv` ("DataForSEO estimated traffic"). Ahrefs: `keywords-history` (`top3`, `top4_10`, `top11_20`, `top21_50 + top51_plus`) and `metrics` (`org_keywords`, `org_traffic`, "Ahrefs organic traffic"). Semrush: `domain_rank` `Or`, `Ot` ("Semrush organic traffic"), distribution `null` with the note "Semrush's API doesn't report keywords by position band". Traffic labels are never compared across providers.
- **D7. Competitors: saved first.** `competitor_overview` lists the client's saved competitors (clients.yaml `competitors`) first, in saved order, then fills to `limit` with the provider's suggested competitors (`source: "saved_then_suggested"`, default). Overlap and the competitor's visibility come from one provider competitor call; a saved competitor missing from it gets a per-domain visibility call (overlap shown as "not among the provider's top <n> competitors"). Suggested competitors are filtered through the existing denylist (`src/lib/competitor-denylist.ts`).
- **D8. Technical issues: one canonical catalogue, sources kept.** `src/analysis/tech-issues.ts` maps every source's rule/issue ID to a canonical key (table in 13.5.3); unmapped rules keep `"<source>:<rule>"` (never dropped, never merged). Items merge on (canonical key, normalised URL) for URL-level sources and on canonical key for count-only sources (Semrush `/info`, DataForSEO crawl summary, Ahrefs issues). Each item lists its sources with their native severity and counts; `affected` = the largest count any one source reports (not the sum). Why: the same missing title found by the local crawl and DataForSEO is one problem; counts from different crawlers aren't additive.
- **D9. Severity mapping across sources.** crawlmark findings keep their severity. Ahrefs `Error` → high, `Warning` → medium, `Notice` → low. Semrush errors (IDs 1–99) → high, warnings (101–199) → medium, notices (201+) → low. DataForSEO on-page checks → `ONPAGE_SEVERITY` (`findings.ts`), else low. URL Inspection → 13.5.4. Merged severity = the highest across sources, except that a provider-only item is never `critical` (critical stays crawlmark's own: axe critical, Lighthouse < 50 on key pages). The table shows the merged severity and each source's native label.
- **D10. Technical-issue changes reuse audit-diff semantics.** Each `technical_issues` run builds an `IssueSnapshot` = items + `checked` (the source runs it read: audit ID, local crawl ID, DataForSEO task ID, Ahrefs crawl date, Semrush `last_audit`, inspection batch). The base is the newest stored snapshot taken before the report period starts (like `monthlyAuditSection`). new = in current, not in base; persistent = in both; resolved = in base, not in current, **and** the source that reported it has a newer run in `checked` than in base's; otherwise unverified. Why: a provider audit that didn't re-crawl can't clear anything, exactly like `diffAudits`.
- **D11. Reports never start crawls.** `technical_issues` reads: the newest saved audit (findings already extracted), the newest local crawl if newer than the audit's, the newest stored DataForSEO full crawl task within 30 days (GET summary/pages; no task_post), and, only with `paid: true` + `allowPaid`, Ahrefs `/site-audit/issues` and Semrush `/siteaudit/info` for an existing project. Stale sources (older than `maxAgeDays`, default 45) are still shown with their date and a note.
- **D12. Ahrefs and Semrush Site Audit are read through an allowlist.** Ahrefs: `GET /site-audit/projects` (free), `GET /site-audit/issues` (50 units), `GET /site-audit/page-explorer` (50 units, only with `issueUrls > 0`). Semrush: `GET /management/v1/projects` (100 units, cached 7 days), `GET /reports/v1/projects/{id}/siteaudit/info` (100), `GET …/siteaudit/meta/issues` (100, cached 30 days), `GET …/siteaudit/snapshot/{sid}/issue/{iid}` (100, only with `issueUrls > 0`). Never: Ahrefs Management, Semrush `/snapshot?snapshot_id=` (10,000 units), `launch`, `enable`, `save`, any non-GET. A test asserts the only reachable methods/paths. Why: neither vendor offers a read-only key (research §1–2).
- **D13. Project matching.** Ahrefs: `GET /site-audit/projects?project_url=<domain>` (free, cached a day); exactly one match on the client's host (with or without `www.`) is used for this run; zero or several → `unavailable` naming `ahrefsSiteAuditProject`. Semrush: the project list (cached 7 days) filtered to `url` = client host and a Site Audit tool; same rule. Saved IDs in clients.yaml (`ahrefsSiteAuditProject`, `semrushProject`, set with `clients set` / `set_client_profile`) always win. crawlmark never writes these fields itself.
- **D14. Indexing: sample, budget, rotate, store.** `inspect_index_coverage` / `crawlmark-cli index-coverage` inspect URLs through `gscInspectUrl` within a per-property daily budget (`GSC_INSPECTION_DAILY_BUDGET`, default 1,000 of Google's 2,000/day, so the user's other tools keep headroom) and a per-run cap (default 200; section default 25), at most 60 per minute (Google allows 600). Pool and order: (1) key pages not inspected within `staleDays` (default 7); (2) top 50 Search Console pages by impressions (last 28 days) not inspected within `staleDays`; (3) sitemap URLs never inspected, in a deterministic order seeded by client + ISO week; (4) the oldest inspected. Every inspection (including the audit's key-page inspections) is stored in `url_inspections` and counted in `gsc_inspection_quota`. A quota error (429 / `RESOURCE_EXHAUSTED`) marks the property's day as exhausted and stops the run (no retry storm). The report section reads stored results and tops up at most `maxInspections` (default 25). Why: Google's API has no Page indexing report; a rotating sample within the quota is the closest honest view, and labelling it a sample keeps it honest.
- **D15. Quota day.** Counted per property per **Pacific-time day** (`America/Los_Angeles`, via `Intl.DateTimeFormat`), the usual Google quota day (research Not confirmed 8; the live check confirms).
- **D16. Whole-run unit reservation.** `units-billing.ts` gains `withUnitsReservation(client, provider, units, fn)`: checks `assertUnits` for the whole run's estimate, reserves it (in-flight set) for the duration, and marks it as the caller's own in AsyncLocalStorage so the per-call `unitsCall` checks inside don't count it twice (mirror of `withUsdReservation`). `runTemplate` wraps its paid sections in one USD reservation and one units reservation per unit provider. Why: Phase 12 checked unit sums but reserved only per call; concurrent cron + Claude runs could each pass.
- **D17. `estimateOnly` for reports.** `run_report_template` and `export_report` accept `estimateOnly: true`: plan the run, compute every paid section's estimate (honouring snapshot reuse and caches), return `{ estimateOnly: true, sections: [{ id, type, provider, usd, units, requests, reused }], total: { usd, units: { ahrefs, semrush } }, remaining, wouldExceed, message }` with no provider request. The CLI's `report --dry-run` prints the same estimate.
- **D18. Template proposals need a confirm token (MCP).** `create_report_template` / `update_report_template` without `confirmToken` validate and return a proposal only (YAML, unified diff, paid sections with per-client estimates, `confirmToken`, expiry). The token (`tpl_` + 26 base32 chars, 128-bit random) is stored in the cache for 15 minutes, single use, bound to: the target file path, the SHA-256 of the file's current bytes, the SHA-256 of the proposed bytes, and the client. A second call with the same arguments plus `confirmToken` writes the file only if all bindings still match (a changed file → "the file changed since the proposal; propose again"). If the proposal contains any paid section, the confirm call must also pass `paidAcknowledged: true`; the descriptions tell Claude to set it only after the user explicitly agreed to paid sections in this conversation. When the MCP client supports **elicitation** (MCP 2025-06-18 `elicitation/create`, advertised in client capabilities), the confirm call additionally asks the human directly ("Save template 'board' to <path>? It includes 1 paid section (backlinks).") and writes only on accept; without elicitation support the token flow alone applies. Why: the model can't save on its own initiative; the user sees exactly what is written; a stale proposal can't overwrite a hand edit.
- **D19. Template files are edited, not regenerated.** Writes go through a new `src/reports/templates/write.ts` using the `yaml` Document API (as `clients-file.ts` does) so comments and formatting survive; the whole new text is validated with `validateTemplateText` before writing; written with `writeFileAtomic`, mode 0600, the previous version kept as `<file>.bak` (one copy). Only `<home>/config/report-templates.yaml` and `<home>/config/report-templates/<slug>.yaml` can be written; the path must resolve inside the config home and must not be a symlink. A new file starts as `version: 1` + `templates:` (not the starter). Builtin ids may be shadowed only with `replace: true` (warning in the proposal).
- **D20. Preview without spend.** `templates new` previews by running the draft template for the chosen client with `allowPaid: false` (paid sections appear as a placeholder card "Paid section: shown when the report runs with --paid") and rendering HTML into `<REPORTS_DIR>/.preview/<client>/<id>.html` (0700/0600, overwritten each time), reusing the report-redesign branding preview loop (open the file, then "Save / Change / Cancel"). Without `--client` the preview uses the bundled fixture report (`example.com`, no network).

### 13.4 Provider endpoint matrix

Costs: DataForSEO in USD (ceilings; actuals recorded), Ahrefs/Semrush in units. "Hist." calls run only when D3 finds no local snapshot for a requested comparison or the trend is shorter than 2 points; their points are stored.

| Section / need | DataForSEO | Ahrefs (units = max(50, per-row × rows)) | Semrush |
|---|---|---|---|
| Backlinks now | `POST /v3/backlinks/summary/live` (existing; `ESTIMATE_USD.backlinksSummary` raised to **0.025**, +20% since 2026-07 [D6]) | `GET backlinks-stats` + `GET domain-rating` (existing, 100) | v4 `backlinks/v1/overview` (45) or v3 `backlinks_overview` (40) (existing) |
| Backlinks new/lost | from Hist. (month of the snapshot) | none (`null`) | v4 `new_count`, `lost_count` (same call) |
| Backlinks hist. | `POST /v3/backlinks/history/live`, `date_from` = 13 months back, `rank_scale: one_thousand` (est. **$0.025**) | `GET refdomains-history` (`history_grouping=monthly`, 13 rows × 5 = 65) + `GET domain-rating-history` (13 rows, 50) | none (local snapshots only, kept ≤ 31 days) |
| Visibility now | `POST /v3/dataforseo_labs/google/domain_rank_overview/live` (est. `labsTaskUsd(1)` = **$0.01212**) | `GET metrics` (`org_keywords`, `org_keywords_1_3`, `org_traffic`: 12/row → 50) + `GET keywords-history` (`date_from`=`date_to`=latest month, 6 fields × 1 row → 50) = 100 | `type=domain_rank` `Or,Ot,Dt` (10) |
| Visibility hist. | `POST …/historical_rank_overview/live` `date_from` 13 months back (est. **$0.11**) | `GET keywords-history` (13 rows × 6 = 78) + `GET metrics-history` (`org_traffic`, 13 rows × 11 = 143) = 221 | `type=domain_rank_history` `Dt,Or,Ot`, `display_limit=13` (130) |
| Competitors | `POST …/competitors_domain/live` `limit` = max(limit, 20) (est. `labsTaskUsd(20)` = **$0.0144**) + per missing saved competitor `domain_rank_overview` ($0.01212 each) | `GET organic-competitors` `select=competitor_domain,keywords_common,keywords_competitor,share,domain_rating,traffic` (15/row) with `limit` = max(limit,20) → 300; saved ones via `where` on `competitor_domain` in the same call; missing → `GET metrics` (50 each) | `type=domain_organic_organic` `Dn,Np,Or,Ot`, `display_limit` = max(limit,10) (40/line → 400); missing saved → `domain_rank` (10 each) |
| Site audit issues | stored task: `GET /on_page/summary/{id}` + `POST /on_page/pages` filtered by check (reads, existing; any charge recorded) | `GET /site-audit/projects` (free) + `GET /site-audit/issues` (50; with `date_compared` = previous crawl) + optional `page-explorer` per issue (50 each, `issueUrls` 0..5) | `GET /management/v1/projects` (100, cached 7 d) + `GET …/siteaudit/info` (100) + `GET …/meta/issues` (100, cached 30 d) + optional `…/issue/{iid}` (100 each, `issueUrls` 0..5) |
| Indexing | — | — | — (Google: URL Inspection + Sitemaps, free) |

Typical per-client cost of one monthly report with every new paid section, defaults (limit 5), after the first month (local snapshots exist): DataForSEO ≈ $0.025 + $0.012 + $0.014 = **$0.05**; Ahrefs ≈ 100 + 100 + 300 + 50 = **550 units**; Semrush ≈ 45 + 10 + 130 (history every run: snapshots older than 31 days are gone) + 400 + 300 = **885 units**. First month with history: DataForSEO ≈ **$0.19**, Ahrefs ≈ **890 units**. Rate limits: Ahrefs 60/min (existing `ahrefsLimiter` 1 req/s), Semrush 10/s (existing `semrushLimiter`), DataForSEO 2,000/min, URL Inspection 600/min (crawlmark uses 60/min).

### 13.5 Data and storage

All tables are additive, created with `CREATE TABLE IF NOT EXISTS` on start by new `migrate*` functions in `src/lib/store.ts` (pattern of `migrateLocalCrawls`). Older builds never read them; rollback = delete the branch (tables are inert). No backfill.

#### 13.5.1 `seo_snapshots` (Stage A creates it; Stage B writes it)

```sql
CREATE TABLE IF NOT EXISTS seo_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client      TEXT NOT NULL,      -- client.slug
  kind        TEXT NOT NULL,      -- 'backlinks' | 'visibility'
  target      TEXT NOT NULL,      -- bare domain: the client's or a competitor's
  provider    TEXT NOT NULL,      -- 'dataforseo' | 'ahrefs' | 'semrush'
  market      TEXT NOT NULL,      -- visibility: location code (dfs) / country (ahrefs) / database (semrush); backlinks: 'global'
  day         TEXT NOT NULL,      -- YYYY-MM-DD the figures describe (capture day; provider_history: the provider's date, e.g. first of month)
  source      TEXT NOT NULL,      -- 'live' | 'provider_history'
  captured_at INTEGER NOT NULL,   -- ms epoch of the request
  data        TEXT NOT NULL,      -- JSON { v: 1, ...BacklinksFigures | VisibilityFigures }
  UNIQUE (client, kind, target, provider, market, day, source)
);
CREATE INDEX IF NOT EXISTS seo_snapshots_lookup ON seo_snapshots (client, kind, target, provider, market, day);
```

- Upsert on the unique key (latest capture of the day wins). `src/lib/snapshots.ts` (new): `saveSnapshot`, `nearestSnapshot({ ..., day, toleranceDays, prefer: "live" })` (live wins over provider_history on ties), `seriesSince`, `pruneSnapshots(now)`.
- Retention: Semrush rows with `captured_at` older than 31 days are deleted on every save and every read (`pruneSnapshots`, D-rule 13.0). Others: kept (a year of monthly backlinks + visibility for 50 clients with 5 competitors is ~7k rows).
- Writers: `backlinks`, `organic_visibility`, `competitor_overview` sections (competitors: kind `visibility`, target = competitor), `organic_visibility` / `competitor_overview` tools, `seo-snapshot` CLI, and `backlinks_summary` when `target` is the client's own domain (side effect only; its output is unchanged).
- `BacklinksFigures = { backlinks, referringDomains, authority: { metric, value }, newBacklinks, lostBacklinks, newReferringDomains, lostReferringDomains }` (numbers or null). `VisibilityFigures = { keywords, top3, pos4_10, pos11_20, pos21_100, traffic, trafficLabel, commonKeywords?: number|null }`.

#### 13.5.2 `issue_snapshots` (Stage A)

```sql
CREATE TABLE IF NOT EXISTS issue_snapshots (
  id          TEXT PRIMARY KEY,   -- 'iss_' + ulid
  client      TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  items       TEXT NOT NULL,      -- JSON TechIssue[] (without change fields)
  checked     TEXT NOT NULL,      -- JSON SourceRun[] (D10)
  settings    TEXT NOT NULL       -- JSON { sources, maxAgeDays }
);
CREATE INDEX IF NOT EXISTS issue_snapshots_client ON issue_snapshots (client, captured_at DESC);
```

Saved by every `technical_issues` tool call and every template run with that section; newest 24 per client kept.

#### 13.5.3 Canonical issue catalogue (`src/analysis/tech-issues.ts`, pure)

Starter mapping (the table is data; adding a row needs no code change). Unlisted rules map to `"<source>:<rule>"`.

| Canonical key | crawlmark sources (rule) | DataForSEO crawl check | Ahrefs issue (by `name`, case-insensitive prefix) | Semrush issue ID | Category |
|---|---|---|---|---|---|
| `broken-internal-link` | crawl `broken-internal-link` | `is_broken`, `is_4xx_code` | "Page has links to broken page" | 8 | links |
| `server-error` | crawl status 5xx, onpage `is_5xx_code`, sitemap-non200 (5xx) | `is_5xx_code` | "5XX page" | 1 | crawlability |
| `client-error-page` | sitemap-non200 (4xx) | `is_4xx_code` | "4XX page" | 2 | crawlability |
| `missing-title` | crawl `missing-title`, onpage `no_title` | `no_title` | "Title tag missing or empty" | (title missing ID from `/meta/issues`) | content |
| `duplicate-title` | crawl `duplicate-title`, onpage `duplicate_title_tag` | `duplicate_title_tag` | "Multiple pages have same title" / "Duplicate pages without canonical" | (from meta) | duplicates |
| `missing-description` | crawl `missing-description`, onpage `no_description` | `no_description` | "Meta description tag missing or empty" | (from meta) | content |
| `missing-h1` | onpage `no_h1_tag` | `no_h1_tag` | "H1 tag missing or empty" | 103 | content |
| `redirect-chain` | crawl `redirect-chain` | `redirect_chain` | "Redirect chain" | (from meta) | redirects |
| `noindex-in-sitemap` | site `sitemap-noindex` | — | "Noindex page in sitemap" | (from meta) | indexability |
| `canonical-mismatch` | indexing `canonical-mismatch`, gsc_inspection (Google chose a different canonical) | — | — (Ahrefs canonical issues stay their own items) | — | indexability |
| `canonical-js-only` | rendering `canonical-mismatch` (raw vs rendered HTML differ) | — | — | — | indexability |
| `not-indexed` | indexing `not-indexed`, gsc_inspection (13.5.4) | — | — | — | indexability |
| `orphan-page` | site `orphan-page` | — | "Orphan page (has no incoming internal links)" | (from meta) | links |
| `robots-blocks-key-page` | site `robots-blocks-key-page` | — | — | — | crawlability |
| `ai-crawler-blocked` | site `ai-search-crawler-blocked` | — | AI Discoverability category issues | — | ai-discoverability |
| `slow-lcp` | lighthouse `largest-contentful-paint`, crux `field-lcp-*` | — | "Slow page" | — | performance |
| a11y rules | axe `<rule>` (kept per rule) | — | — | — | accessibility |

The Semrush IDs marked "(from meta)" are resolved at build time from the documented ID table (S2) by the backend task and pinned in the table with a test; Ahrefs names are matched on `name` because Ahrefs `issue_id` values aren't documented (research §1). An Ahrefs/Semrush issue that matches no row is kept as its own item (source-labelled title).

#### 13.5.4 Indexing tables (Stage A)

```sql
CREATE TABLE IF NOT EXISTS url_inspections (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client           TEXT NOT NULL,
  property         TEXT NOT NULL,     -- Search Console siteUrl
  url              TEXT NOT NULL,     -- normalizeUrl()
  inspected_at     INTEGER NOT NULL,
  origin           TEXT NOT NULL,     -- 'key' | 'gsc_top' | 'sitemap' | 'audit' | 'manual'
  verdict          TEXT,              -- PASS | FAIL | NEUTRAL | VERDICT_UNSPECIFIED
  coverage_state   TEXT,              -- stripControl, max 200 chars
  indexing_state   TEXT,
  page_fetch_state TEXT,
  robots_txt_state TEXT,
  google_canonical TEXT,
  user_canonical   TEXT,
  last_crawl_time  TEXT,
  crawled_as       TEXT,
  in_sitemap       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS url_inspections_latest ON url_inspections (client, url, inspected_at DESC);
CREATE TABLE IF NOT EXISTS gsc_inspection_quota (
  property  TEXT NOT NULL,
  day       TEXT NOT NULL,            -- Pacific-time YYYY-MM-DD (D15)
  used      INTEGER NOT NULL DEFAULT 0,
  exhausted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (property, day)
);
```

Retention: inspections older than 400 days deleted on insert; quota rows older than 7 days deleted. No referring URLs or sitemap lists are stored (size; they are re-derivable).

Coverage → issue mapping (pure, `src/analysis/indexing.ts`), checked in this order: `pageFetchState` `SERVER_ERROR` → high "Server error (5xx)"; `NOT_FOUND`/`BLOCKED_4XX`/`ACCESS_DENIED`/`ACCESS_FORBIDDEN` → high if key page or in sitemap, else medium; `SOFT_404` → high; `REDIRECT_ERROR` → medium; `robotsTxtState: DISALLOWED` → high if key page or in sitemap, else low; `indexingState` `BLOCKED_BY_META_TAG`/`BLOCKED_BY_HTTP_HEADER` → high if key page or in sitemap, else low ("noindex"); verdict `PASS` → indexed (no issue); `coverageState` contains "Crawled" + "not indexed" → medium; "Discovered" + "not indexed" → medium; "Duplicate" → medium (+ canonical pair); "redirect" → low (medium if in sitemap); "unknown to Google" → medium if in sitemap or key page, else low; anything else with verdict ≠ PASS → medium "Not indexed: <coverageState>".

### 13.6 Contracts

#### 13.6.1 Template schema additions (`src/reports/templates/schema.ts`)

| type | Extra fields (unknown fields are an error) | Paid? | Default title |
|---|---|---|---|
| `technical_issues` | `limit?: 1..200` (25 listed; counts cover all), `minSeverity?: "critical"\|"high"\|"medium"\|"low"` ("low"), `sources?: ("audit"\|"local_crawl"\|"site_hygiene"\|"dataforseo_crawl"\|"gsc_inspection"\|"ahrefs_site_audit"\|"semrush_site_audit")[]` (default: every free source), `issueUrls?: 0..5` (0; provider URL detail per top issue), `maxAgeDays?: 7..120` (45) | only when `sources` includes `ahrefs_site_audit` or `semrush_site_audit` (then `paid: true` required) | "Technical SEO issues" |
| `indexing_issues` | `maxInspections?: 0..200` (25; 0 = stored only), `staleDays?: 1..90` (7), `limit?: 1..50` (10 worst URLs), `trendMonths?: 0..12` (6) | no | "Google indexing" |
| `backlinks` | `trendMonths?: 0..24` (12), `history?: boolean` (true: buy provider history when no snapshot matches; false: local only) | yes (`paid: true`) | "Backlinks" |
| `organic_visibility` | `trendMonths?: 0..24` (12), `history?: boolean` (true) | yes | "Organic search visibility" |
| `competitor_overview` | `limit?: 1..10` (5), `source?: "saved"\|"suggested"\|"saved_then_suggested"` ("saved_then_suggested") | yes | "Competitors" |

`isPaidSection` gains the three provider types and the `technical_issues` rule; `PAID_SECTION_TYPES` gains `backlinks`, `organic_visibility`, `competitor_overview`. `semanticIssues` adds: paid `technical_issues` without `paid: true` → error at `…sections[i].paid`; `issueUrls > 0` without a provider site-audit source → error. Nothing else changes; every existing template stays valid.

Section catalogue for the builder (Stage C reads it): `SECTION_CATALOGUE: Record<SectionType, { group: "search"|"analytics"|"site"|"seo_data"|"local"|"ai"|"other", cost: "free"|"free_key"|"paid"|"paid_optional", needs?: string, summary: string }>` exported from `schema.ts` (backend, Stage A; Stage B adds its three rows).

#### 13.6.2 Section data (`src/reports/report-types.ts`, backend, locked in A-2 / B-1)

```ts
type ProviderId = "dataforseo" | "ahrefs" | "semrush";
type SnapshotOrigin = "live" | "reused" | "provider_history";   // reused = a stored live snapshot within SNAPSHOT_REUSE_DAYS
interface Compared<T> { asOf: string; origin: SnapshotOrigin; previous: T; change: T }   // change = current − previous, per field; null when either is null

// technical_issues
type IssueSource = "audit" | "local_crawl" | "site_hygiene" | "dataforseo_crawl" | "gsc_inspection" | "ahrefs_site_audit" | "semrush_site_audit";
interface SourceRun { source: IssueSource; runId: string; ranAt: string; stale: boolean; checks?: string[] }   // checks: audit finding sources that ran (lighthouse, axe, …)
interface TechIssue {
  key: string; title: string; category: string;
  severity: Severity;                                   // merged (D9)
  url: string | null;                                   // null for count-only items
  affected: number;                                     // pages (D8)
  sources: { source: IssueSource; rule: string; nativeSeverity: string; count: number | null; examples: string[] /* ≤ 3 URLs */ }[];
  change: "new" | "persistent" | "resolved" | "unverified" | "first_run";
}
interface TechnicalIssuesData {
  sources: SourceRun[]; unavailable: { source: IssueSource; reason: string }[];
  counts: Record<Severity, number>;                     // open items only
  changes: { new: number; resolved: number; persistent: number; unverified: number } | null;   // null on first run
  base: { snapshotId: string; capturedAt: string } | null;
  issues: TechIssue[];                                  // open, sorted severity → affected desc → key; ≤ limit
  resolved: TechIssue[];                                // ≤ 10
  limit: number; total: number;
}

// indexing_issues
interface IndexingIssuesData {
  property: string;
  sample: { inspected: number; inspectedThisRun: number; keyPages: number; sitemapUrls: number; sitemapUrlsKnown: number; oldestDays: number | null };
  indexed: { count: number; share: number | null };    // PASS among the latest inspection per URL
  byCoverage: { state: string; count: number; severity: Severity | null }[];   // stripControl'd states
  worst: { url: string; coverage: string; severity: Severity; inSitemap: boolean; keyPage: boolean; lastCrawl: string | null; googleCanonical: string | null; inspectedAt: string }[];
  sitemaps: { path: string; errors: number; warnings: number; submitted: number | null; lastDownloaded: string | null; isPending: boolean }[];
  trend: { month: string; inspected: number; indexedShare: number | null }[];
  quota: { day: string; used: number; budget: number; exhausted: boolean };        // operator-only (tool result; never rendered)
  notes: string[];
}

// backlinks
interface BacklinksNow { backlinks: number | null; referringDomains: number | null; authority: number | null; newBacklinks: number | null; lostBacklinks: number | null; newReferringDomains: number | null; lostReferringDomains: number | null }
interface BacklinksData {
  provider: ProviderId; target: string; asOf: string; origin: SnapshotOrigin;
  authority: { metric: "dataforseo_rank" | "domain_rating" | "semrush_score"; label: string; scale: "0-100" | "0-1000" };
  current: BacklinksNow;
  newLostLabel: string | null;                          // e.g. "September 2026 (DataForSEO, monthly)"; null when no new/lost figures
  comparisons: { previous_period?: Compared<BacklinksNow> | null; previous_year?: Compared<BacklinksNow> | null };
  trend: { day: string; referringDomains: number | null; backlinks: number | null; authority: number | null; origin: SnapshotOrigin }[];
  notes: string[];
}

// organic_visibility
interface VisibilityNow { keywords: number | null; top3: number | null; pos4_10: number | null; pos11_20: number | null; pos21_100: number | null; traffic: number | null }
interface VisibilityData {
  provider: ProviderId; target: string; market: string; asOf: string; origin: SnapshotOrigin;
  trafficLabel: string; distributionAvailable: boolean;
  current: VisibilityNow;
  comparisons: { previous_period?: Compared<VisibilityNow> | null; previous_year?: Compared<VisibilityNow> | null };
  trend: ({ day: string; origin: SnapshotOrigin } & VisibilityNow)[];
  notes: string[];
}

// competitor_overview
interface CompetitorRow { domain: string; origin: "saved" | "suggested" | "client"; commonKeywords: number | null; keywords: number | null; traffic: number | null; inProviderList: boolean; keywordsChange: number | null }
interface CompetitorOverviewData {
  provider: ProviderId; market: string; asOf: string; trafficLabel: string;
  client: CompetitorRow;                                // origin "client"
  competitors: CompetitorRow[];                         // saved first (D7), ≤ limit
  providerListSize: number; notes: string[];
}
```

Every string from a provider or Google (`title`, issue names, `coverageState`, URLs, domains) passes `stripControl` (and URL fields through `normalizeUrl`) in the backend mapper; renderers escape per format (Phase 12 D4).

#### 13.6.3 Provider interface additions (`src/providers/seo-data.ts`)

- `Capability` gains `"organicOverview" | "competitorOverview"`, both in `ROUTED_CAPABILITIES` and all three providers' `CAPABILITIES`. Backlinks reuse `"backlinksSummary"`.
- `SeoDataProvider` gains optional methods, each with a pure `plan*` returning `PaidPlan` (existing type):
  - `organicOverview(client, target, opts)` → `{ figures: VisibilityFigures; market: string } & ProviderMeta`
  - `organicHistory?(client, target, months, opts)` → `{ points: ({ day } & VisibilityFigures)[] } & ProviderMeta` (all three implement)
  - `backlinksHistory?(client, target, months, opts)` → `{ points: ({ day } & BacklinksFigures)[] } & ProviderMeta` (DataForSEO, Ahrefs; Semrush omits it)
  - `competitorOverview(client, req: { saved: string[]; limit: number }, opts)` → `{ rows: CompetitorRow[]; providerListSize: number } & ProviderMeta`
- History is **not** a routed capability: when the client's provider lacks it, the section uses local snapshots only and never asks another provider (no fallback, D4).
- Routed entry points `organicOverview`, `competitorOverview`, `backlinksHistory`, `organicHistory` go through `choose()`; a missing key is `ProviderUnavailableError` with the setup step (unchanged wording rules).
- Site audit readers are separate modules (not routed): `src/providers/ahrefs-site-audit.ts`, `src/providers/semrush-site-audit.ts`, each with `plan(client, opts) → { units, requests }` and `read(client, opts) → { run: SourceRun; issues: RawProviderIssue[] }`, using the existing limiters, `unitsCall`, `redact`, and an exported `ALLOWED` list (D12).

#### 13.6.4 Tools

All take `client` like today. Errors through `handler()`. Annotations as Phase 12 (READ_ONLY for reads; local-write annotations `{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }` for tools that store snapshots or files).

Stage A:
1. **`technical_issues({ client, sources?, minSeverity?, limit?: 1..200 (50), issueUrls?: 0..5, maxAgeDays?, allowPaid?: boolean, estimateOnly?: boolean })`** (local-write: saves an issue snapshot) → `TechnicalIssuesData & { spend: { usd: 0; units: { ahrefs: number; semrush: number } } }`. Provider site-audit sources require `allowPaid: true` (else listed in `unavailable` with "needs allowPaid"); `estimateOnly` returns the units plan and writes nothing. Base for `changes` = the newest snapshot older than 24 h (tool) or before the period start (template).
2. **`index_coverage({ client, trendMonths?: 0..12 (6), limit?: 1..100 (25) })`** (READ_ONLY, local only, free) → `IndexingIssuesData` from stored inspections (no Google call except the free Sitemaps list, cached a day).
3. **`inspect_index_coverage({ client, maxInspections?: 1..500 (100), staleDays?: 1..90 (7), dryRun?: boolean })`** (local-write; free; timeout 10 min) → `{ property, planned: number, inspected: number, failed: number, stoppedBy: null | "budget" | "quota" | "time" | "aborted", quota: { day, used, budget, exhausted }, byOrigin: { key, gsc_top, sitemap, oldest } }`. `dryRun` lists the planned URLs count per origin, inspects nothing.
4. `gsc_inspect_url` and `run_audit`'s key-page inspections additionally record rows in `url_inspections` and count quota (side effect; outputs unchanged).

Stage B:
5. **`organic_visibility({ client, target?: domain (default client), history?: boolean (false), months?: 1..24 (12), refresh?, estimateOnly? })`** (local-write: snapshot) → `VisibilityData & ProviderMeta` (no comparisons unless history/snapshots exist; `asOf` today).
6. **`competitor_overview({ client, limit?: 1..10 (5), source?, refresh?, estimateOnly? })`** (local-write: snapshots) → `CompetitorOverviewData & ProviderMeta`.
7. **`seo_trends({ client, kind: "backlinks" | "visibility", target?, months?: 1..24 (12) })`** (READ_ONLY, local only, free) → `{ provider, market, points: [...], notes }` per (provider, market) series found.
8. `backlinks_summary` (existing): when `target` is the client's domain, also saves a snapshot (output unchanged; golden test).

Stage C:
9. **`create_report_template({ client?, file?: "global" | "client" ("global"), id, template: TemplateSpec (JSON, validated by TemplateSchema), replace?: boolean, confirmToken?: string, paidAcknowledged?: boolean })`** and **`update_report_template({ client?, file?, id, template?: TemplateSpec, patch?: { addSections?: SectionSpec[], removeSectionIds?: string[], set?: { title?, description?, period?, compare?, layout? } }, confirmToken?, paidAcknowledged? })`** (exactly one of `template`/`patch` for update; update requires the id to exist in that file).
   - Without `confirmToken` (READ_ONLY, writes only the proposal to the cache) → `{ proposal: true, path, exists: boolean, yaml: string /* the template's YAML block */, diff: string /* unified diff of the whole file, ≤ 20,000 chars */, valid: true, warnings, paidSections: [{ id, type, estimate: { usd, units, provider } | null }], shadowsBuiltin: boolean, confirmToken, expiresAt, message }`; invalid → `{ proposal: true, valid: false, errors: [{ path, message }] }` and no token.
   - With `confirmToken` (local-write) → `{ saved: true, path, backup: string | null, template: id, validate: { valid: true, warnings } }`, or a tool error: unknown/expired/used token; arguments differ from the proposal; file changed since the proposal; paid sections without `paidAcknowledged: true`; elicitation declined ("Not saved: the user declined.").
10. Existing `run_report_template` / `export_report`: `estimateOnly?: boolean` (D17); new section types run like the others.

Prompt changes: `template-report` gains one step: "If the template has paid sections, call `run_report_template` with `estimateOnly: true` first, state the cost and what is left, and pass `allowPaid` only after the user agrees." New prompt **`build-report-template`** (`{ client?, request: string }`): list sections (`list_report_templates` + the catalogue in `get_report_template`'s new `catalogue` field), draft with `create_report_template`, show the YAML and diff, ask about each paid section by name and cost, confirm only on an explicit yes.

#### 13.6.5 CLI

- `crawlmark-cli index-coverage --client <d> | --all [--max N] [--stale-days N] [--dry-run]` (scheduled command shape, JSON output `{ command: "index-coverage", ranAt, dryRun, results: [{ client, property, inspected, stoppedBy, quota }], skipped, errors, exitCode }`; exit 0 ok / 2 some client failed or quota exhausted before finishing / 1 usage or all failed). Clients without a Search Console property are skipped.
- `crawlmark-cli seo-snapshot --client <d> | --all --paid [--kinds backlinks,visibility,competitors] [--dry-run]` (paid; `--paid` required, else exit 1 "seo-snapshot spends provider credits; add --paid"); per client: estimate → caps (a client over cap is skipped with the cap message) → fetch → store. `--dry-run` prints estimates, fetches nothing.
- `crawlmark-cli report … --dry-run` adds `estimate` (D17) to each dry-run result.
- `crawlmark-cli report templates new [--client <d>] [--file global|client] [--replace]` (Stage C; needs an interactive terminal: otherwise exit 1 with "templates new is interactive; write the YAML and run `report templates validate`").
- `crawlmark-cli clients set <d> --ahrefs-site-audit-project <id> | --semrush-project <id>` ("" clears).

#### 13.6.6 Config

New env (documented in `.env.example`): `SNAPSHOT_REUSE_DAYS` (7), `GSC_INSPECTION_DAILY_BUDGET` (1000, max 2000), `GSC_INSPECTION_PER_MINUTE` (60, max 600). clients.yaml optional fields `ahrefsSiteAuditProject` (string of digits), `semrushProject` (string of digits) in `src/lib/clients.ts` + `clients-file.ts` + `config/clients.example.yaml`. `test/setup.ts`: delete `SNAPSHOT_REUSE_DAYS`, `GSC_INSPECTION_DAILY_BUDGET`, `GSC_INSPECTION_PER_MINUTE`.

### 13.7 UI (report files; frontend, following report-redesign)

Every mapper returns `[]` when there's nothing to show (the section is left out and named once in "About this report"). Operator-only data (cost, units, project IDs, quota, raw errors) never reaches a block. White label (`ctx.whiteLabel`) swaps any "crawlmark" wording for neutral wording.

- **`backlinks`**: `kpiRow` — Referring domains (value, `delta` vs the first comparison with data, detail "vs 198"), Backlinks (same), authority tile labelled with `authority.label` (no delta chip when either value is null), and New / Lost referring domains tiles only when not null (detail = `newLostLabel`). `chart` line "Referring domains by month" from `trend` (≥ 2 points; `format: "count"`; `connectGaps: true`), fallback table. A comparison table (Metric | current | previous | change) only when a comparison exists. Notes: "<Provider> data as of <asOf>." and, when a series changes provider, "Earlier months came from <other provider> and aren't shown."
- **`organic_visibility`**: `kpiRow` — Ranking keywords (top 100), Top 3, Estimated traffic (detail = `trafficLabel`). `chart` share "Keywords by position" with parts Top 3 / 4–10 / 11–20 / 21–100 and one row per period (current, previous) when `distributionAvailable`; else a note. Line chart "Ranking keywords by month" from `trend`. Table: band | current | previous | change (`changeCell`).
- **`competitor_overview`**: paragraph "Organic competitors in <market> (<provider> data, as of <asOf>); saved competitors first." Table: Domain (code) | Saved/Suggested | Shared keywords | Their ranking keywords | Est. traffic, client row first labelled "This site", `bar` on shared keywords; `inProviderList: false` rows show "n/a" for shared keywords with one note. Note on traffic label.
- **`technical_issues`**: `kpiRow` — Critical, High, Medium, Low (tone bad for critical/high > 0), New (tone bad > 0), Resolved (tone good > 0). One table per severity present ("High", "Medium", …): Issue | Pages | Example (pagePath, code for other hosts) | Found by (source names joined: "Site crawl, Ahrefs Site Audit") | Change (tag: new = bad, persistent = neutral, unverified = warn). "Resolved since the last report" short table. Note: "From <source list with dates>. Issues not re-checked by their source are shown as not re-checked, never as fixed." Source display names: Audit, Site crawl, Site checks, DataForSEO crawl, Google URL Inspection, Ahrefs Site Audit, Semrush Site Audit.
- **`indexing_issues`**: `kpiRow` — URLs checked, Indexed (count and share), Not indexed, Canonical chosen differently. `chart` share "Google's verdict for checked URLs" by coverage state (top 6 + "Other"). Table "Pages to look at": Page (pagePath) | Google says | In sitemap | Last crawled. Sitemaps table: Sitemap (code) | Errors | Warnings | URLs submitted. Line chart "Share indexed by month" from `trend` (≥ 2 points). Note (always): "Based on Google's URL Inspection of <n> pages (key pages, top Search Console pages and a rotating sample of sitemap URLs), not Search Console's full Page indexing report."
- Markdown, DOCX and the Google Docs copy use the existing chart fallbacks (tables). a11y: every chart has `summary`; tables have header rows; colours keep the redesign's WCAG AA rules.

Computed highlights (`src/reports/highlights.ts`, backend): rules appended after Phase 12's eight, still at most 8 in total: (9) referring domains changed ≥ 5% and ≥ 10 domains vs the first comparison; (10) ranking keywords changed ≥ 5% and ≥ 20; (11) new critical/high technical issues ≥ 1 (unverified never counted as resolved); (12) indexed share of checked URLs changed ≥ 5 points. Same wording rules (absolute numbers beside the percent).

### 13.8 Builtin templates and starter

- `monthly`: add optional `{ id: issues, type: technical_issues, optional: true }`, `{ id: indexing, type: indexing_issues, optional: true }`, `{ id: backlinks, type: backlinks, optional: true, paid: true }`, `{ id: visibility, type: organic_visibility, optional: true, paid: true }`.
- `quarterly`: optional `backlinks`, `visibility`, `{ id: competitors, type: competitor_overview, optional: true, paid: true }`, `issues`.
- `technical`: optional `issues` (`limit: 30`) and `indexing` (`maxInspections: 25`).
- `STARTER_YAML` gets the same lines (paid ones with a comment "paid: runs with --include <id> --paid"); the existing "starter equals builtin" test keeps them in step. `executive` and `local` unchanged.

### 13.9 Ownership

| Agent | Owns |
|---|---|
| backend | `src/lib/store.ts`, `src/lib/snapshots.ts` (new), `src/lib/inspections.ts` (new), `src/lib/budget.ts`, `src/providers/**` (incl. new `ahrefs-site-audit.ts`, `semrush-site-audit.ts`), `src/analysis/tech-issues.ts` (new), `src/analysis/indexing.ts` (new), `src/analysis/findings.ts`, `src/reports/technical-issues.ts` (new), `src/reports/indexing.ts` (new), `src/reports/provider-sections.ts` (new), `src/reports/report-types.ts`, `src/reports/highlights.ts`, `src/reports/audit.ts`, `src/reports/templates/{schema,builtin,load,run,service,write,proposals}.ts` (`write.ts`, `proposals.ts` new), `src/report-cli.ts`, `src/cli.ts`, `src/cli-help.ts`, `src/scheduled.ts`, `src/config.ts`, `src/lib/clients.ts`, `src/lib/clients-file.ts`, `src/tools/**`, `src/prompts/**`, `mcpb/manifest.json`, `test/setup.ts`, backend tests `test/p13-*.test.ts` (except render tests), fixtures `test/fixtures/{dataforseo,ahrefs,semrush,google}/p13/**`, `test/fixtures/reports/p13-data.ts` (fixture `TemplateReport`s for every new section, data only), README, `docs/*.md`, `.env.example`, `config/clients.example.yaml`, `implementation.md`, `docs/launch/blog-outline.md` |
| frontend | `src/reports/render/sections.ts`, `src/reports/render/{doc,html,docx,markdown,svg}.ts` (only if a new block feature is needed; none is planned), `src/reports/templates/new-cli.ts` (new: the interactive `templates new` flow and preview loop), render tests `test/p13-render-*.test.ts`, snapshots `test/fixtures/reports/__snapshots__/p13-*` |
| qa | no files; runs each stage's Done-when |
| security | no files; reviews A (inspection quota, untrusted Google text, issue snapshot data), B (provider allowlists, key redaction, caps and reservations, Semrush retention), C (file writes, token binding, paid acknowledgement, elicitation) |
| web-quality | no files; a11y check of the new section HTML (axe on the snapshot HTML) |
| reviewer | no files; final gate per stage |
| planner | this spec and `docs/research/2026-10-13-phase-13-report-sections.md` |

No file has two owners. `src/report-cli.ts` (backend) dispatches `templates new` to `new-cli.ts` (frontend) through a narrow interface: `runTemplateBuilder(deps: BuilderDeps): Promise<number>` where `BuilderDeps = { ui, catalogue, estimate(type, client), draftYaml(spec), validate(text), preview(spec, client), propose(spec, file), save(proposal) }` — all backend functions; the frontend module only drives prompts and the preview loop.

---

## Stage A (free): snapshot store, technical issues, indexing issues

Branch `phase-13a`, from `main` after `report-redesign` merged.

### A Files

Backend: `store.ts` (`migrateSeoSnapshots`, `migrateIssueSnapshots`, `migrateUrlInspections`), `snapshots.ts`, `inspections.ts` (save/latest per URL/quota with Pacific day), `budget.ts` (unchanged) + `units-billing.ts` (`withUnitsReservation`, D16), `analysis/tech-issues.ts` (catalogue, merge, severity, diff), `analysis/indexing.ts` (pool ordering, coverage mapping, aggregation; pure), `reports/technical-issues.ts` (source readers: audit, local crawl, hygiene from audit, DataForSEO stored crawl, gsc_inspection; issue snapshots), `reports/indexing.ts` (inspection runner with limiter and quota; aggregate), `providers/gsc.ts` (`gscInspectUrl` records inspections and quota; extra fields `indexingState`, `pageFetchState`, `crawledAs` added to its return, additive; `gscSitemaps` adds `submitted` from `contents[]`, additive), `report-types.ts`, `templates/schema.ts` (two section types, catalogue), `templates/run.ts` (fetchers + `estimateOnly` + units reservation), `templates/builtin.ts` (optional sections), `highlights.ts` (rules 11–12), `tools/reports.ts` (`technical_issues`, `index_coverage`, `inspect_index_coverage`, `estimateOnly`), `cli.ts` / `scheduled.ts` / `cli-help.ts` (`index-coverage`), `config.ts`, manifest, docs. Frontend: two mappers.

### A Tasks

1. **A-1** [backend] `implementation.md` Phase 13 entry; tables + migrations; `snapshots.ts`, `inspections.ts` with tests. — first.
2. **A-2** [backend] Contract lock: `report-types.ts` types for `technical_issues` and `indexing_issues`, schema section types + catalogue, `test/fixtures/reports/p13-data.ts` with fixture data for both. — after A-1. **Unblocks A-6.**
3. **A-3** [backend] `withUnitsReservation` + `runTemplate` whole-run reservation + `estimateOnly` (D16, D17) for existing paid sections. — after A-1; parallel with A-4, A-5.
4. **A-4** [backend] Tech-issues catalogue, merge, severity, diff (pure) + readers + issue snapshots + `technical_issues` tool + section fetcher (free sources only). — after A-2.
5. **A-5** [backend] Indexing: pool/rotation, inspection runner (limiter 60/min, quota, Pacific day, stop on quota error), aggregation, `gscInspectUrl` recording, `index_coverage` + `inspect_index_coverage` tools, `index-coverage` CLI, section fetcher, `gsc_inspection` source for tech issues. — after A-2; parallel with A-4 (shared file `templates/run.ts`: A-4 lands its fetcher first, A-5 rebases).
6. **A-6** [frontend] `technical_issues` and `indexing_issues` mappers + render tests against `p13-data.ts`. — after A-2; **parallel with A-3..A-5**.
7. **A-7** [backend] Builtin optional sections, starter, highlights 11–12, prompt step, docs (`docs/reports.md` section rows, `docs/audits.md` "Technical issues" and "Indexing coverage", README tool table, `docs/scheduling.md` `index-coverage` cron line), `.env.example`, manifest, blog outline (Coming). — after A-4, A-5, A-6.
8. **A-8** QA Done-when; security (inspection quota handling, Google text sanitising, snapshot contents); web-quality axe on rendered HTML; reviewer. Merge flips blog items to Shipped.

### A Tests (no network)

- Store: migrations idempotent on a fresh and an already-migrated DB; `nearestSnapshot` tolerance and live-over-history preference; Semrush rows older than 31 days pruned on save and read.
- `withUnitsReservation`: two concurrent runs whose sum exceeds the cap → the second refused before any request; the run's own inner `unitsCall` checks don't double count (fake ledger, fake clock).
- `estimateOnly`: a template with `keyword_gap` + `local_profile` returns the sum and makes zero provider requests (fetch stubs assert no calls); cap exceeded → `wouldExceed: true`, message names a fitting limit where Phase 12 already does.
- Tech issues: catalogue merges onpage `no_title` + crawl `missing-title` on one URL into one item with two sources; count-only sources merge by key with `affected = max`; unmapped rule kept as `<source>:<rule>`; severity mapping table cases incl. "provider-only never critical"; diff: new/persistent/resolved/unverified with a source that didn't re-run → unverified; first run → `changes: null`; stale source flagged; DataForSEO stored crawl read uses only GET summary/pages (request log) and only when the task is ≤ 30 days old.
- Indexing: pool order (key stale first, then top GSC pages, then never-inspected sitemap URLs in seeded order, then oldest); budget and per-run cap respected; quota error stops the run and marks the day exhausted; Pacific-day rollover at 00:00 America/Los_Angeles (fake clock around DST); coverage mapping table; aggregation (latest per URL); `stripControl` on `coverageState` with a bidi/control-char fixture; `run_audit` default output key-set unchanged while inspections are recorded; `gsc_inspect_url` output keys a superset of before.
- Fixtures: URL Inspection and Sitemaps responses built from the documented schemas (research G3, G4) with example.com.
- Render (frontend): snapshots for both sections (data, empty → no blocks, white label); XSS fixture in an issue title, a coverage state and a URL inert in MD/HTML/DOCX; HTML has no operator fields (grep the snapshot for "quota", "units", "$").

### A Done when

- [ ] `npm run typecheck`, `npm run build`, `npm test` pass; isolation mtimes unchanged (Phase 12 check).
- [ ] With a temp `CRAWLMARK_HOME`, fixture-backed fakes and a stored audit + local crawl for example.com: `technical_issues { client: "example.com" }` returns merged items with `sources`, writes one `issue_snapshots` row, and a second call 25 h later (fake clock) reports `changes` per D10.
- [ ] `crawlmark-cli index-coverage --client example.com --max 5` against a fake Search Console server inspects exactly 5 URLs, stores 5 rows, increments the Pacific-day quota row by 5, and prints JSON with `exitCode` 0; `--dry-run` inspects nothing (fake server request log empty).
- [ ] A fake 429 `RESOURCE_EXHAUSTED` on the 3rd inspection stops the run with `stoppedBy: "quota"`, exit 2, and the next run the same Pacific day inspects nothing.
- [ ] `crawlmark-cli report --client example.com --template technical --include issues,indexing --format html,docx` writes files with both sections; the HTML contains none of: "units", "quota", "$", a project ID, a raw provider error.
- [ ] `run_report_template { …, estimateOnly: true }` makes no provider request and returns totals; a default `run_audit` result has the same key set as on `main`; `monthly_report` golden test passes.
- [ ] axe on the new sections' HTML snapshot: 0 violations.
- [ ] Docs, manifest, blog outline (Coming) updated; `grep -ri` finds no real client names or domains.
- [ ] **Live check (free, needs the user's OK and Google account):** `inspect_index_coverage` with `maxInspections: 5` on one property the user owns confirms `webmasters.readonly` works, records real `coverageState` strings (research Not confirmed 8, 9).

---

## Stage B (paid, opt-in): backlinks, organic visibility, competitors, provider site audits

Branch `phase-13b`, after Stage A merges.

### B Files (backend unless noted)

`providers/seo-data.ts` (capabilities, routed entry points, plans), `providers/dataforseo.ts` + `dataforseo-shape.ts` (`domain_rank_overview`, `historical_rank_overview`, `backlinks/history`, competitors with `full_domain_metrics`; `ESTIMATE_USD` entries: `backlinksSummary: 0.025`, `backlinksHistory: 0.025`, `rankOverview: labsTaskUsd(1)`, `rankHistory: 0.11`), `providers/ahrefs.ts` + `ahrefs-shape.ts` (`AHREFS_PATHS` + `metrics`, `metricsHistory`, `keywordsHistory`, `refdomainsHistory`, `domainRatingHistory`; field units), `providers/semrush.ts` + `semrush-shape.ts` (`domain_rank`, `domain_rank_history` in `SEMRUSH_UNITS`/`SEMRUSH_COLUMNS`), `providers/ahrefs-site-audit.ts`, `providers/semrush-site-audit.ts` (D12, D13), `lib/snapshots.ts` (writers), `reports/provider-sections.ts` (section builders: plan → reuse/fetch → compare → trend; D1–D7), `reports/technical-issues.ts` (two provider sources), `analysis/tech-issues.ts` (Ahrefs name / Semrush ID rows), `report-types.ts`, `templates/schema.ts` (three types, catalogue rows), `templates/run.ts` (fetchers, plans in the pre-flight), `templates/builtin.ts`, `highlights.ts` (rules 9–10), `tools/raw.ts` (`backlinks_summary` snapshot side effect), `tools/competitors.ts` (`organic_visibility`, `competitor_overview`, `seo_trends`; `set_client_profile` project fields), `lib/clients.ts` + `clients-file.ts` (project fields), `cli.ts` / `scheduled.ts` / `cli-help.ts` (`seo-snapshot`, `clients set` flags), `config.ts`, manifest, docs. Frontend: three mappers.

### B Tasks

1. **B-1** [backend] Contract lock: data types, schema types, catalogue rows, provider interface signatures, fixture data in `p13-data.ts`. — first. **Unblocks B-6.**
2. **B-2** [backend] DataForSEO: overview, history (backlinks + rank), competitors; plans; fixtures from the documented responses (D1–D5). — after B-1.
3. **B-3** [backend] Ahrefs: metrics, keywords-history, metrics-history, refdomains-history, domain-rating-history, competitors with `where`; Semrush: `domain_rank`, `domain_rank_history`, `domain_organic_organic` mapping. — after B-1; **parallel with B-2** (no shared files except `seo-data.ts`: B-2 lands the capability plumbing first, B-3 rebases).
4. **B-4** [backend] `provider-sections.ts` (reuse window, comparisons, trends, snapshot writes, no-mix rule), tools `organic_visibility`, `competitor_overview`, `seo_trends`, `backlinks_summary` side effect, `seo-snapshot` CLI, template fetchers + pre-flight plans. — after B-2, B-3.
5. **B-5** [backend] Ahrefs and Semrush Site Audit readers (allowlist, matching, units plans), clients.yaml fields + `clients set` / `set_client_profile`, catalogue rows, `technical_issues` provider sources with `allowPaid`. — after B-1; **parallel with B-2..B-4** (touches `ahrefs-site-audit.ts`, `semrush-site-audit.ts`, `technical-issues.ts`, `tech-issues.ts`, `clients*.ts`; `run.ts` changes sequenced after B-4).
6. **B-6** [frontend] `backlinks`, `organic_visibility`, `competitor_overview` mappers + render tests. — after B-1; **parallel with B-2..B-5**.
7. **B-7** [backend] Builtin optional sections, starter, highlights 9–10, docs (README provider matrix, `docs/reports.md`, `docs/clients.md` project fields, `docs/scheduling.md` `seo-snapshot`), manifest, blog outline (Coming). — after B-4, B-5, B-6.
8. **B-8** QA; security (allowlists, redaction, caps/reservations, Semrush pruning); web-quality axe; reviewer. Live checks (13.11) with the user's OK; then merge.

### B Tests (no network; fake provider servers on 127.0.0.1)

- Per provider: request params exact (DataForSEO bodies incl. `target` bare domain, `date_from`, `rank_scale`; Ahrefs `select`, `history_grouping=monthly`, `country`, `where`; Semrush `type`, `export_columns`, `display_limit` always present, `database`), mapping to bands (D6) incl. nulls, unit/USD estimates equal the 13.4 formulas, ledger rows recorded, keys absent from errors/results/cache keys/`tool_calls` (serialized grep).
- Caps: a template with all three paid sections and a client cap that can't cover them → refused before the first request (request log empty), message names the cap; reservations hold during the run (concurrent run test).
- No fallback: a Semrush client gets no backlinks history call to DataForSEO even when DataForSEO is configured (request log); a missing Ahrefs key → `ProviderUnavailableError` naming `setup --step ahrefs`.
- Snapshots: reuse within 7 days makes no request; `refresh` makes one; comparisons pick by tolerance (D3); provider history stored as `provider_history`; a provider switch between months yields no comparison and the note; Semrush rows deleted after 31 days, so previous-year comparison for Semrush is dropped with a note.
- Competitors: saved first in saved order, suggested fill, denylist applied, missing saved competitor gets a per-domain visibility call and `inProviderList: false`.
- Site audits: allowlist test (the readers' request functions refuse any method other than GET and any path outside `ALLOWED`; `/snapshot?snapshot_id`, `/launch`, `/enable`, `/save`, `/management` writes unreachable); project matching 0/1/many; saved project ID wins; Ahrefs issues mapped by name, Semrush by ID with titles from `/meta/issues` (cached 30 d); `issueUrls` adds exactly n detail calls to the plan; without `allowPaid` no request and the source is listed unavailable.
- `backlinks_summary` output unchanged (golden) while a snapshot row is written for the client's own domain and not for another target.
- Render (frontend): snapshots per section; authority label shown and no cross-provider series; distribution share chart only when available; Markdown/DOCX fallbacks; XSS fixture in a competitor domain and an Ahrefs issue name; no operator fields in HTML.

### B Done when

- [ ] typecheck, build, tests pass; isolation mtimes unchanged.
- [ ] Against fake provider servers: `crawlmark-cli report --client example.com --template monthly --include backlinks,visibility --paid --format pdf` writes a PDF whose HTML source shows the labelled authority metric and a referring-domain change vs the stored August snapshot; a second run the same day makes zero provider requests.
- [ ] `run_report_template { …, include: ["backlinks","visibility","competitors"], estimateOnly: true }` returns per-section estimates and makes no request.
- [ ] `technical_issues { client, sources: [..., "ahrefs_site_audit"], allowPaid: true }` against a fake Ahrefs server calls only `GET /v3/site-audit/projects` and `GET /v3/site-audit/issues` (request log) and records 50 units.
- [ ] `crawlmark-cli seo-snapshot --all` without `--paid` exits 1; with `--paid --dry-run` prints estimates and makes no request.
- [ ] axe 0 violations on the three sections' HTML; docs, manifest, blog outline updated; no real client names.
- [ ] **Live checks** (13.11, each with the user's explicit OK) recorded in the research note's "Not confirmed" list.

---

## Stage C: template building UX

Branch `phase-13c`, after Stage B merges (it needs the full catalogue). May be started after Stage A merges in its own worktree and rebased on B before review; shared files with B: `templates/schema.ts` (catalogue), `cli-help.ts`, `report-cli.ts`, `tools/reports.ts`.

### C Contract details

- `src/reports/templates/write.ts` (backend): `planTemplateWrite({ homeDir, file, clientSlug, id, spec | patch, replace }) → { path, before: string | null, after: string, diff: string, beforeHash, afterHash, shadowsBuiltin, paidSections }` (pure apart from reading the file); `applyTemplateWrite(plan)` re-reads, compares `beforeHash`, writes atomically (0600), keeps `.bak`. Diff: a small line-based unified diff implemented in the module (no dependency), capped at 20,000 characters.
- `src/reports/templates/proposals.ts` (backend): `createProposal(plan, ctx) → token`, `consumeProposal(token, args) → plan` (single use; cache key `cacheKey("tpl-proposal", token)`, TTL 15 min; argument hash = SHA-256 of the canonical JSON of the tool arguments minus `confirmToken`/`paidAcknowledged`).
- Elicitation (backend, `src/tools/reports.ts`): when `server.server.getClientCapabilities()?.elicitation` is present, the confirm call sends one `elicitInput` with a boolean `save` field and the message from D18; `action !== "accept"` or `save !== true` → not saved.
- Estimates for the builder: `estimateSection(client, spec)` reuses each paid section's plan (no request; snapshot reuse honoured) → `{ provider, usd, units } | null`; without a client → "paid" with no number.
- `new-cli.ts` (frontend) flow, all prompts via `src/setup/ui.ts` (clack in fancy mode, plain fallback): id → title → sections (grouped multiselect from `SECTION_CATALOGUE`, label `"<Title> (free)"`, `"(free · needs <key>)"`, `"(paid · <Provider> · ~$0.025 per run for <domain>)"` or `"(paid · ~250 Ahrefs units …)"`) → for each paid section "Include <title>? It costs about … every time the report runs with --paid" (default No) → mark-optional multiselect → period (Last month / Last quarter / Last 28 days / Custom) → compare (multiselect) → layout → formats ("Make these the file's default formats?" only when the file has no `defaults.formats`) → preview (D20; reuse the report-redesign branding preview helper: open file, then Save / Change sections / Cancel) → show the diff → save (`applyTemplateWrite`). Ctrl-C at any point writes nothing.

### C Tasks

1. **C-1** [backend] `write.ts`, `proposals.ts`, catalogue estimates, `create_report_template` / `update_report_template` (proposal, confirm, paid acknowledgement, elicitation), `get_report_template` `catalogue` field, prompt `build-report-template`, `report-cli.ts` dispatch with `BuilderDeps`. — first.
2. **C-2** [frontend] `new-cli.ts` interactive flow + preview loop against `BuilderDeps` fakes. — after C-1's `BuilderDeps` type is committed (first commit of C-1); **parallel with the rest of C-1**.
3. **C-3** [backend] Docs (`docs/reports.md` "Build a template", README), manifest (2 tools, 1 prompt), blog outline (Coming). — after C-1, C-2.
4. **C-4** QA; security (path containment, symlink refusal, token binding, stale file, paid acknowledgement, no write on decline); reviewer.

### C Tests

- `write.ts`: comments and key order preserved on add/replace; new file shape; invalid result refused before write; symlinked file/dir refused; path outside home refused; `.bak` written; mode 0600; builtin shadowing needs `replace`.
- Proposals: no write without a token; token single use; expired (fake clock 16 min); different arguments → refused; file edited between proposal and confirm → refused; paid section without `paidAcknowledged` → refused; with elicitation decline → not saved; with elicitation accept + token → saved; without elicitation support → token flow alone.
- Tool results never contain file content outside the template file (diff only of that file).
- `new-cli.ts` with a scripted fake UI: free-only template saved; paid section declined by default; Ctrl-C writes nothing; non-TTY exit 1; preview written under `.preview` with 0600 and no network when `--client` is absent.

### C Done when

- [ ] typecheck, build, tests pass.
- [ ] In a temp home on an interactive terminal: `crawlmark-cli report templates new --client example.com` (fixture-backed deps) saves a template that `report templates validate` accepts; comments in the existing file are still there (`diff` of the file shows only the added block).
- [ ] In Claude (MCP Inspector or a session): `create_report_template` without a token writes nothing (file mtime unchanged); with the token and, for a paid section, `paidAcknowledged: true`, it saves; in Claude Code (elicitation-capable, if supported at test time) the save asks the user first. Manual check by the user.
- [ ] Docs, manifest, blog outline updated.

---

### 13.10 Execution order

- **Sequential across stages:** report-redesign merged → A → B → C (C may start after A in its own worktree; merges after B).
- **Within A:** A-1 → A-2 → (A-3 ∥ A-4 ∥ A-5 ∥ A-6) → A-7 → A-8. A-4 lands its `run.ts` fetcher before A-5's.
- **Within B:** B-1 → (B-2 ∥ B-3 ∥ B-5 ∥ B-6) → B-4 → B-7 → B-8. B-2 lands `seo-data.ts` plumbing before B-3.
- **Within C:** C-1 (first commit: `BuilderDeps`) → (rest of C-1 ∥ C-2) → C-3 → C-4.
- Frontend and backend work in separate worktrees; contracts are locked by A-2, B-1 and C-1's first commit.

### 13.11 Live checks and spend (each needs the user's explicit OK; none before its stage's tests pass)

| Stage | Check | Provider cost (estimate) | Answers (research Not confirmed) |
|---|---|---|---|
| A | URL Inspection on 5 URLs of the user's property; one Sitemaps list | free (Google) | 8, 9 |
| A | Read a stored DataForSEO crawl task (if one exists) | $0 expected; any charge recorded | 10 |
| B | DataForSEO: `domain_rank_overview`, `historical_rank_overview` (13 months), `backlinks/history`, `competitors_domain` with a `domain in` filter, for the user's own site | about $0.17 (under $0.25) | 6, 7 |
| B | Ahrefs: `site-audit/projects` (free); `site-audit/issues` for one project (50); `metrics`, `keywords-history`, `refdomains-history`, `organic-competitors` against the free test target `ahrefs.com` (0 units) | 50 units | 1, 2 |
| B | Semrush: `domain_rank` (10), `domain_rank_history` 13 lines (130), `domain_organic_organic` 5 lines (200), projects list (100), `/siteaudit/info` (100), `/meta/issues` (100) | about 640 units | 3, 4, 5 |

Total spend if every check runs: under $0.25 of DataForSEO, 50 Ahrefs units, about 640 Semrush units.

### 13.12 Risks

- **Semrush data retention.** The one-month rule (research S5) means Semrush clients get month-over-month but not year-over-year from snapshots, and pay for `domain_rank_history` each run. → Enforced pruning, documented; open question 2.
- **Provider keys aren't read-only.** A bug could call a write endpoint. → Path/method allowlists per reader with tests (D12); reviewer and security check every new request function.
- **Severity mapping disputes.** Agencies may disagree with "Ahrefs Warning = medium". → Native labels shown beside merged severity; the catalogue is a data table that can be tuned without code changes elsewhere.
- **Issue matching drift.** Ahrefs issue names can change. → Unmatched issues still appear (source-labelled); a test pins the fixture names; live check confirms.
- **URL Inspection quota shared with the user's other tools.** → Default budget 1,000/day of 2,000, configurable; quota errors stop immediately and mark the day.
- **Sample bias in indexing.** A rotating sample isn't the Page indexing report. → Always labelled with the sample size and composition in the file; key pages and top traffic pages first.
- **Elicitation support varies by client.** → Token flow works everywhere; elicitation is an extra, not a requirement.
- **Cost estimates for DataForSEO history.** Sample $0.106 for rank history vs Labs formula. → Ceiling $0.11 in the plan; live check records the actual; ledger stores actuals.
- **report-redesign APIs change before merge.** → Stage A starts only after it merges; the mappers use only `Block`/`Kpi`/chart types already committed on that branch.

### 13.13 Open questions (recommendations)

1. **Default inspection budget per property per day** → **1,000** (half of Google's 2,000), section top-up 25, CLI run cap 200. Needs a human decision? No, unless the user runs other URL Inspection tools heavily.
2. **Semrush snapshots beyond 31 days** → **No**: prune at 31 days to follow Semrush's terms; year-over-year for Semrush clients comes from `domain_rank_history` (paid) and is absent for backlinks. Needs a human decision? **Yes** (the user may have Semrush's written consent; if so, add `SEMRUSH_SNAPSHOT_RETENTION_DAYS`).
3. **Provider history purchase default (`history: true`)** → **Yes** for template sections (one-time cost ≤ $0.14 DataForSEO / ~340 Ahrefs units per client, then local snapshots), **No** for the standalone tools. Needs a human decision? Yes (cost policy).
4. **`indexing_issues` and `technical_issues` in builtin templates: optional (as the user asked) or default in `technical`?** → Optional everywhere for Phase 13 (user instruction); revisit after feedback. No decision needed.
5. **Should `run_audit` gain `technicalIssues: true`?** → **No**; `technical_issues` reads saved audits, so it needs no audit change. No decision needed.
6. **Semrush Site Audit default units** → read `/info` + `/meta/issues` only (≈ 300 units incl. the cached project list); never `/snapshot` (10,000). Needs a human decision? No.
7. **Auto-saving matched Ahrefs/Semrush project IDs to clients.yaml** → **No**; match at run time, save only via `clients set` / `set_client_profile` (keeps crawlmark's "never changes what you wrote" rule). No decision needed.
8. **Elicitation** → use it when the client supports it, in addition to the token (D18). Needs a human decision? No, unless the user prefers token-only for predictability.

### 13.14 Not confirmed

See `docs/research/2026-10-13-phase-13-report-sections.md` "Not confirmed" 1–11. Items 8–10 are answered in Stage A's live check; 1–7 in Stage B's; 11 (Ahrefs storage terms) needs the user to read Ahrefs' API terms or ask Ahrefs before Stage B merges (recommendation: treat like Semrush if the terms restrict storage).

## Decisions recorded 2026-10-13 (user)

- **Semrush snapshots:** deleted after 31 days, per Semrush's API terms. Semrush clients get no stored year-over-year; month-over-month uses a paid history call when no stored snapshot qualifies.
- **Provider history in templates:** yes. Template sections (backlinks, organic_visibility, competitor_overview) buy provider history when no stored snapshot is close enough, with the cost shown in the run's pre-flight estimate; standalone tools never buy it unasked.
- **Ahrefs storage terms:** a researcher checks Ahrefs' API terms on storing data locally before Stage B is built; Stage B's snapshot retention for Ahrefs follows that finding.
- **Template builder:** kept (CLI `report templates new` and Claude propose → confirm).
- **Ahrefs storage (researched, see docs/research/2026-10-13-ahrefs-storage-terms.md):** no published cap; store only small derived aggregates (never raw rows), keep up to 25 months, purge on key removal or client removal and on demand, keep a "Source: Ahrefs" line in reports even when white-labelled, REST API v3 only, and tell users to confirm their plan allows client reporting.
