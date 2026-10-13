# seo-ops-mcp: Implementation Plan

This document is a build spec for extending the `seo-ops-mcp` scaffold. Work through the phases in order. Each phase lists what to build, where it goes, and how to know it's done.

## How to work

- **One phase per commit.** Run `npm run typecheck` and `npm test` before each commit.
- **Read the existing code first.** Keep these patterns:
  - Providers live in `src/providers/`, one file per data source.
  - Every external call goes through `cached()` from `src/lib/cache.ts`.
  - Paid calls (DataForSEO) call `assertBudget()` before and `recordSpend()` after.
  - Report composers in `src/reports/` wrap each source in `section()` so one failure doesn't break the report.
  - Tool handlers are wrapped in `handler()` from `src/tools/util.ts` so errors become tool errors.
  - stdout is the MCP channel. Log to stderr only.
- **Put analysis logic in pure functions** (no I/O) so it can be unit tested with fixtures. Providers fetch; analysis functions compute.
- **No brand names** in code, config, prompts or docs. Use generic examples (`acme-plumbing`).
- **Update `README.md`** (tool table, config fields, layout) as part of each phase.
- **Ask before** adding a dependency not listed in this plan, or changing an existing tool's input or output shape in a breaking way.

## Phase 0: Setup and scaffold fixes

1. **Add a test runner.** Add `vitest` as a dev dependency and a `test` script. Create `test/fixtures/` for recorded API payloads.
2. **Silence the SQLite warning.** Node prints an `ExperimentalWarning` for `node:sqlite` on startup. Change the `start` script and the README's client configs to run `node --disable-warning=ExperimentalWarning dist/index.js`.
3. **Resolve paths from the project root.** `CLIENTS_FILE`, `DATA_DIR` and `GOOGLE_APPLICATION_CREDENTIALS` currently resolve from the working directory, so the server breaks when a client launches it from elsewhere. Resolve relative paths against the project root, i.e. the directory above `dist/` or `src/`, found via `import.meta.url`. Also load `.env` from the project root.
4. **Shape the DataForSEO results.** `rankedKeywords`, `competitorDomains`, `backlinksSummary` and `instantPage` currently return unshaped results. Define typed output interfaces with only the fields a report needs:
   - **Ranked keywords:** keyword, position, search volume, URL, estimated traffic.
   - **Competitors:** domain, intersecting keywords, average position, estimated traffic.
   - **Backlinks:** backlinks, referring domains, rank, spam score, and new/lost counts if available.
   - **Instant page:** status, title, description, H1, canonical, word count, failed checks.

   Record one real payload per endpoint from the sandbox into `test/fixtures/dataforseo/` and write a mapping test against it.

**Done when** tests run, the server starts without the warning from any working directory, and the DataForSEO tools return typed, compact objects.

## Phase 0b: Google OAuth alongside service accounts

Support two ways to authenticate to Google, chosen by `GOOGLE_AUTH_MODE`:

- **`oauth`** (new default): a person signs in once with their Google account through an OAuth client the team creates in Google Cloud. The server then sees every Search Console, GA4 and Tag Manager property that person already has access to. Nobody has to add a service account email to each client property.
- **`service_account`**: the current behavior. Keep it for unattended jobs (Phase 6c) and for properties shared only with the service account.

### Setup to document in the README

1. In Google Cloud, enable the Search Console, Analytics Data, PageSpeed Insights and (later) Tag Manager APIs.
2. Configure the OAuth consent screen with user type **Internal**. Internal apps are limited to accounts in the team's Google Workspace organization and skip Google's app verification. Note in the README that Internal requires the Cloud project to belong to a Workspace organization; personal Gmail accounts can't use it.
3. Create an OAuth client of type **Desktop app**. Put its client ID and secret in `.env` as `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
4. Run the login command (below) once per machine.

### Implementation

1. **Login command.** Add a `seo-ops-cli auth login` command (create `src/cli.ts` now if Phase 6c hasn't yet). It runs the OAuth loopback flow:
   - Start a temporary HTTP server on `127.0.0.1` with a random port.
   - Open the browser to Google's consent URL with `access_type=offline` and `prompt=consent`, so a refresh token is returned.
   - Request only the read-only scopes: `webmasters.readonly`, `analytics.readonly`, and `tagmanager.readonly` once Phase 6b exists.
   - Exchange the code with PKCE, then shut down the server.
   - Print the signed-in email address.
   - Use `google-auth-library`'s `OAuth2Client`, which `googleapis` already includes. Don't add a new dependency for this.
2. **Token storage.** Store the refresh token in `DATA_DIR/google-token.json` with file mode `0600`, and add it to `.gitignore`. Never log token values.
3. **Other commands.** Add `auth status` (shows the signed-in email and granted scopes) and `auth logout` (revokes the token and deletes the file).
4. **Shared auth.** Update `src/providers/google.ts` so `googleAuth()` returns either the `OAuth2Client` (with stored credentials, auto-refreshing) or the existing `GoogleAuth` for service accounts, based on `GOOGLE_AUTH_MODE`. GSC and GA4 providers shouldn't need changes beyond that.
5. **Clear errors.** If OAuth mode has no token, tools return an error telling the user to run `seo-ops-cli auth login`. If a refresh fails with `invalid_grant`, the error says the sign-in expired or was revoked and to log in again.
6. **Health check.** The `client-health-check` prompt (Phase 5) reports which auth mode is active and which email it's using.

**Done when** OAuth login works end to end on a real Workspace account, the GSC and GA4 tools work in both modes, and switching modes needs only an `.env` change.

## Phase 1: Audit snapshots and diffs

Goal: every audit is saved, and any two audits can be compared. This lets a monthly report say "12 issues fixed, 3 new."

### 1.1 Normalized findings

Create `src/analysis/findings.ts`:

```ts
export type FindingSource =
	| 'lighthouse'
	| 'axe'
	| 'indexing'
	| 'onpage'
	| 'rendering'
	| 'crawl'
	| 'site';
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
	id: string; // stable hash of source + rule + url (+ selector for axe)
	source: FindingSource;
	rule: string; // e.g. "color-contrast", "largest-contentful-paint", "not-indexed"
	url: string;
	severity: Severity;
	title: string; // human-readable
	evidence?: string; // short detail: selector, metric value, coverage state
}

export function extractFindings(audit: AuditResult): Finding[];
```

Map each source to findings:

- **axe:** one finding per violation per URL. Map axe impact `critical`, `serious`, `moderate` and `minor` to `critical`, `high`, `medium` and `low`. Evidence is the first example selector.
- **Lighthouse:**
  - Category score below 50 is `high`; 50–89 is `medium`.
  - Lab LCP over 4000ms is `high`; over 2500ms is `medium`.
  - CLS over 0.25 is `high`; over 0.1 is `medium`.
  - Each opportunity with savings over 500ms is `low`.
- **Indexing:** a verdict other than `PASS` is `high`, with the coverage state as evidence. A Google canonical that differs from the user canonical is `medium`.
- **On-page:** failed instant-page checks, with severity from a lookup table in the same file. Missing title, broken page, noindex and 4xx/5xx status are `high`; missing description, duplicate title and missing H1 are `medium`; everything else is `low`.
- **Site:** each sitemap with errors is `high`; each with warnings is `low`.

The finding ID must be deterministic so the same issue gets the same ID across runs.

### 1.2 Storage

Add an `audits` table in `src/lib/store.ts`:

```sql
CREATE TABLE IF NOT EXISTS audits (
  id         TEXT PRIMARY KEY,   -- ulid or timestamp-based
  client     TEXT NOT NULL,
  ran_at     INTEGER NOT NULL,
  settings   TEXT NOT NULL,      -- JSON
  summary    TEXT NOT NULL,      -- JSON (the existing summary object)
  findings   TEXT NOT NULL,      -- JSON Finding[]
  checked    TEXT NOT NULL,      -- JSON: list of { url, source } pairs that ran successfully
  result     TEXT NOT NULL       -- JSON full audit result
);
CREATE INDEX IF NOT EXISTS audits_client ON audits (client, ran_at DESC);
```

`runAudit` saves every run and returns `auditId` in its result. The `checked` list matters because a finding is only "resolved" if that check actually ran the second time.

### 1.3 Diff

Create `src/analysis/diff.ts`:

```ts
export interface AuditDiff {
	base: { auditId: string; ranAt: string };
	target: { auditId: string; ranAt: string };
	new: Finding[]; // in target, not in base
	resolved: Finding[]; // in base, not in target, and the check ran in target
	persistent: Finding[]; // in both
	unverified: Finding[]; // in base, not in target, but the check did not run in target
	scoreChanges: { url: string; category: string; from: number; to: number }[];
	counts: {
		new: number;
		resolved: number;
		persistent: number;
		unverified: number;
	};
}

export function diffAudits(base: StoredAudit, target: StoredAudit): AuditDiff;
```

Sort each list by severity, then URL.

### 1.4 Tools

Add these in `src/tools/reports.ts`:

- `list_audits({ client, limit? })` returns audit IDs, run times, page counts and summary scores, newest first.
- `get_audit({ auditId })` returns the stored full result.
- `compare_audits({ client, baseAuditId?, targetAuditId? })` defaults to the latest audit versus the one before it. It errors clearly if there are fewer than two.

### 1.5 Monthly report integration

`monthly_report` adds an `audit` section with the latest audit's summary and its diff against the most recent audit from before the report month, if both exist. Otherwise the section is `null`.

**Done when:**

- Running `run_audit` twice on the same client lets `compare_audits` show identical runs as all `persistent`.
- Unit tests cover new, resolved, persistent and unverified cases with hand-built fixtures, including a case where a check errored in the target run.

## Phase 2: Opportunity tools (free, Search Console only)

Create `src/analysis/opportunities.ts` with pure functions over `GscRow[]`, and thin tool wrappers in a new `src/tools/opportunities.ts`. All of them default to the last 28 complete days, exclude branded queries by default (Phase 3), and accept `includeBranded`.

Add an expected-CTR-by-position curve as a constant in `src/analysis/ctr-curve.ts`, with a comment saying it's an editable industry-average approximation: position 1 is about 28%, 2 about 15%, 3 about 10%, 4 about 7%, 5 about 5%, 6–10 from about 4% down to 2%, and 11–20 about 1%. It's used to estimate click upside.

| Tool                | Logic                                                                                                                                                                                         | Output per row                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `striking_distance` | Query rows at positions 5–20 (configurable `minPosition`/`maxPosition`) with impressions ≥ `minImpressions` (default 100). Upside = impressions × (expected CTR at position 3 − current CTR). | query, top page, position, impressions, clicks, CTR, estimated extra clicks            |
| `quick_wins`        | Page rows at positions 11–20 with impressions ≥ threshold, i.e. pages just off page one.                                                                                                      | page, position, impressions, top 3 queries for that page                               |
| `low_ctr`           | Query rows in positions 1–5 whose CTR is below 60% of the expected CTR. These are title and meta description rewrite candidates.                                                              | query, page, position, CTR, expected CTR, estimated extra clicks                       |
| `cannibalization`   | Query + page rows. Flag queries where 2+ pages each have ≥10% of the query's impressions and the query has ≥ `minImpressions` total.                                                          | query, total impressions, pages with impression share, position and clicks             |
| `declining_pages`   | Page rows for the current period vs the previous equal-length period. Flag pages whose clicks dropped by ≥ `minDropPct` (default 30%) and ≥ `minClickLoss` (default 10).                      | page, clicks before/after, change, position before/after, top queries that lost clicks |

Each tool also returns a short `method` string explaining the thresholds used, so the agent can describe it accurately.

Add an `opportunities` section to `monthly_report` with the top 5 from `striking_distance`, `low_ctr` and `cannibalization` for the report month.

**Done when** each analysis function has unit tests with fixture rows covering thresholds, sorting and branded exclusion, and the tools return results against a real property.

## Phase 3: Branded vs non-branded split

1. **Config.** Add `brandTerms: string[]` to the client schema in `src/config.ts`. If it's empty, default to the domain stem (`acmeplumbing.com` gives `["acmeplumbing", "acme plumbing"]`; split camel case or hyphens where possible). Document it in `config/clients.example.yaml`.
2. **Helper.** Create `src/lib/brand.ts` with `isBranded(query: string, client: Client): boolean`. Make it case-insensitive and ignore spaces and punctuation, so "acme-plumbing" and "acmeplumbing" both match "acme plumbing."
3. **Monthly report.** `monthly_report` adds `search.branded` and `search.nonBranded` totals (clicks, impressions, CTR, average position weighted by impressions) for the current and previous month, built from query-dimension rows. Add a note in the output that query-level totals exclude anonymized queries, so they won't add up to the site totals.
4. **Movers.** Query movers and tracked keywords mark each row with `branded: boolean`. Opportunity tools exclude branded rows by default.

**Done when** `isBranded` has unit tests, including punctuation and spacing variants, and the monthly report shows the split.

## Phase 4: Rendered vs raw HTML check

This catches SEO elements that only appear after JavaScript runs, which is common on headless and SPA sites, and elements that differ between the server response and the rendered page.

1. **Dependency.** Add `cheerio`.
2. **Provider.** Create `src/providers/render.ts`:
   - `fetchRaw(url)` uses plain `fetch` with a Googlebot-like user agent and a 20s timeout. It returns status, final URL after redirects, headers (`x-robots-tag`, `content-type`) and HTML.
   - `fetchRendered(url)` uses puppeteer via the existing `chromePath()`, waits for `networkidle2`, and returns `page.content()`.
3. **Extraction.** `extractSeo(html)` uses cheerio to return title, meta description, canonical, robots meta, H1 list, H2 count, internal/external link counts, image count, images missing alt, JSON-LD `@type` list, hreflang list, Open Graph title/image, and word count of visible body text.
4. **Comparison.** `compareRender(raw, rendered)` in `src/analysis/render.ts` flags:
   - Title, canonical or robots meta missing in raw but present after render: `high`.
   - Raw and rendered values that differ for title, canonical, robots or H1: `high`.
   - Rendered word count more than 3× raw, meaning content depends on JS: `medium`.
   - JSON-LD present only after render: `medium`.
   - Links present only after render (rendered internal links more than 2× raw): `medium`.
5. **Tool.** `render_check({ url })` returns both extractions plus flags.
6. **Audit integration.** `run_audit` adds a `rendering` section per page and feeds its flags into findings as source `rendering`.

**Done when** the comparison logic has unit tests with fixture HTML pairs (SSR page, SPA shell, mismatched canonical), and `render_check` works on a real headless site.

## Phase 5: MCP prompts

Register prompts with `server.registerPrompt` in a new `src/prompts/index.ts`. Keep prompt text in markdown files under `src/prompts/templates/` loaded at runtime, so non-developers can edit wording. Copy the templates into `dist/` at build time with a small copy step in the `build` script.

| Prompt                   | Args           | Instructs the agent to                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monthly-report-writeup` | client, month? | Call `monthly_report`, then write a client-facing report: a 3-sentence summary, what went up and why, what went down and why, issues fixed since last audit (if available), top 3 opportunities, and next month's priorities. Plain language, no jargon without a one-line explanation, numbers rounded sensibly, and percent changes always with the absolute numbers. |
| `audit-findings`         | client         | Call `run_audit` (or use the latest stored audit if it's under 7 days old), then `compare_audits`. Write findings grouped by severity, each with the affected URLs, why it matters and a specific fix. End with a prioritized fix list. Note that automated accessibility checks don't replace a manual review.                                                         |
| `opportunity-review`     | client         | Call the Phase 2 tools and write a prioritized content and on-page action list with estimated click upside.                                                                                                                                                                                                                                                             |
| `client-health-check`    | client         | Verify each configured source works (GSC, GA4, DataForSEO balance, Chrome) with the cheapest possible call, and report what's misconfigured. Useful when onboarding a new client.                                                                                                                                                                                       |

Every prompt says to prefer free tools and to state clearly when a section was unavailable instead of guessing.

**Done when** the prompts appear in the MCP Inspector and each one produces a sensible write-up against a configured client.

## Phase 6: Later

Build these after Phases 1–5 are working against real clients.

### 6a. Site hygiene checks

Tool `site_hygiene({ client })`, a new section in `run_audit`, and findings with source `site`:

- **robots.txt:** fetch and parse it. Flag missing robots.txt, `Disallow: /` for all agents, key pages blocked, and no sitemap reference.
- **Sitemaps:**
  - Find them from robots.txt and GSC, and follow sitemap indexes.
  - Count URLs and sample up to 50 for status codes. Flag non-200 URLs, redirects and noindex pages listed in the sitemap.
  - Flag key pages missing from the sitemap.
- **Structured data:** validate JSON-LD for common types (Organization, LocalBusiness, Article, Product, BreadcrumbList, FAQPage) against a small table of required properties per type. This is basic validation, not a replacement for Google's Rich Results Test.
- **hreflang:** check reciprocal links and self-references on key pages, and that `x-default` exists when multiple languages are present.
- **Orphan pages:** if a full crawl exists, list sitemap URLs that the crawl never reached through links.

### 6b. Tag Manager container audit

- **Config and auth.** Add optional `gtmAccountId` and `gtmContainerId` to the client schema. Add the `https://www.googleapis.com/auth/tagmanager.readonly` scope to `src/providers/google.ts` for both auth modes. In OAuth mode, the signed-in user needs Read access to the container; in service-account mode, document adding the service account to each container with Read access.
- **Tool.** `gtm_audit({ client })` reads the live published version through the Tag Manager API v2 and flags:
  - paused tags
  - tags with no firing trigger
  - legacy Universal Analytics tags
  - more than one GA4 configuration/Google tag for the same measurement ID
  - variables and triggers no tag uses
  - custom HTML tags (listed for review, since they're a common source of performance and security issues)
  - tags missing consent settings when Consent Mode is in use elsewhere in the container
- **Workspaces.** Also report unpublished workspace changes, by count of changed entities.

### 6c. Scheduled audits and alerts

Keep the MCP server itself stateless. Scheduling lives in a separate CLI entry point.

- **CLI.** Add `src/cli.ts` with a `bin` entry, `seo-ops-cli`:
  - `audit --client <slug>` or `audit --all` runs `runAudit`, saves the snapshot and diffs it against the previous one.
  - `check-traffic --all` compares the last 7 days of Search Console clicks with the previous 7.
- **Alert rules.** Alert on any new `critical` or `high` finding, or a non-branded click drop of ≥ `ALERT_TRAFFIC_DROP_PCT` (default 25%) with at least 50 clicks lost.
- **Output.** Write JSON to stdout. If `ALERT_WEBHOOK_URL` is set, POST a short text summary to it in an incoming-webhook-compatible format: `{ "text": "..." }`.
- **Docs.** Document running it from cron or a scheduled job.

### 6d. URL safety and timeouts

- **URL guard.** Create `src/lib/url-guard.ts`. Before any browser check or raw fetch on a user-supplied URL (`lighthouse`, `accessibility_check`, `render_check`, audit `urls` overrides):
  - Allow only `http:` and `https:`.
  - Resolve the hostname and refuse loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, which includes cloud metadata endpoints), CGNAT, and IPv6 equivalents.
  - Add `ALLOW_PRIVATE_URLS=true` to bypass this for local development.
  - Add `RESTRICT_TO_CLIENT_DOMAINS=true` to only allow URLs on configured client domains.
- **Timeouts.** Add a `withTimeout(promise, ms, label)` helper and apply it per tool: browser tools 90s, network calls 30s, `run_audit` overall 10 minutes. The timeout must also close the browser.
- **Usage log.** Write one row per tool call to a `tool_calls` table (tool name, client, duration, ok/error). Add a `usage_summary` tool.

## Final checklist

- [ ] All phases typecheck and tests pass.
- [ ] README updated: tools table, config fields, new environment variables, layout.
- [ ] `config/clients.example.yaml` documents every new field with a comment.
- [ ] `.env.example` lists every new environment variable, including `GOOGLE_AUTH_MODE`, `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
- [ ] No brand names anywhere: `grep -ri` for any company names before the final commit.
