# crawlmark-mcp: Implementation Plan

This document is a build spec for extending the `crawlmark-mcp` scaffold. Work through the phases in order. Each phase lists what to build, where it goes, and how to know it's done.

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
- **No brand names** in code, config, prompts or docs. Use generic examples (`example.com`, `exampleplumbing.com`).
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

- **`oauth`**: a person signs in once with their Google account through an OAuth client the team creates in Google Cloud. The server then sees every Search Console, GA4 and Tag Manager property that person already has access to. Nobody has to add a service account email to each client property.
- **`service_account`**: the current behavior. Keep it for unattended jobs (Phase 6c) and for properties shared only with the service account.

### Setup to document in the README

1. In Google Cloud, enable the Search Console, Analytics Data, PageSpeed Insights and (later) Tag Manager APIs.
2. Configure the OAuth consent screen. The code is the same either way; document both options in the README:
   - **Internal** (Google Workspace): limited to accounts in the team's Workspace organization, skips Google's app verification, and refresh tokens don't expire on a schedule. Requires the Cloud project to belong to a Workspace organization.
   - **External, publishing status Testing** (personal Gmail): add each person's Google account as a test user (up to 100). No app verification is needed, but Google expires refresh tokens for Testing apps after 7 days, so these users re-run `auth login` weekly. For unattended jobs on a personal account, use `service_account` mode instead.
3. Create an OAuth client of type **Desktop app**. Put its client ID and secret in `.env` as `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
4. Run the login command (below) once per machine.

### Implementation

1. **Login command.** Add a `crawlmark-cli auth login` command (create `src/cli.ts` now if Phase 6c hasn't yet). It runs the OAuth loopback flow:
   - Start a temporary HTTP server on `127.0.0.1` with a random port.
   - Open the browser to Google's consent URL with `access_type=offline` and `prompt=consent`, so a refresh token is returned.
   - Request only the read-only scopes: `webmasters.readonly`, `analytics.readonly`, and `tagmanager.readonly` once Phase 6b exists.
   - Exchange the code with PKCE, then shut down the server.
   - Print the signed-in email address.
   - Use `google-auth-library`'s `OAuth2Client`, which `googleapis` already includes. Don't add a new dependency for this.
2. **Token storage.** Store the refresh token in `DATA_DIR/google-token.json` with file mode `0600`, and add it to `.gitignore`. Never log token values.
3. **Other commands.** Add `auth status` (shows the signed-in email and granted scopes) and `auth logout` (revokes the token and deletes the file).
4. **Shared auth.** Update `src/providers/google.ts` so `googleAuth()` returns either the `OAuth2Client` (with stored credentials, auto-refreshing) or the existing `GoogleAuth` for service accounts, based on `GOOGLE_AUTH_MODE`. GSC and GA4 providers shouldn't need changes beyond that.
5. **Clear errors.** If OAuth mode has no token, tools return an error telling the user to run `crawlmark-cli auth login`. If a refresh fails with `invalid_grant`, the error says the sign-in expired or was revoked and to log in again (and notes that Testing-mode apps expire sign-ins after 7 days).
6. **Health check.** The `client-health-check` prompt (Phase 5) reports which auth mode is active and which email it's using.

**Done when** the code is built and unit tested for both modes, the GSC and GA4 tools work live in `service_account` mode, and switching modes needs only an `.env` change.

**Status:** done as above. Live OAuth verification (a real login, OAuth GSC and GA4 calls, mode switching, logout and re-login) is deferred to [Phase 7](#phase-7-oauth-end-to-end-verification), the last phase, once there's a way to test it. Until then `GOOGLE_AUTH_MODE` auto-detects (Phase 0c) and the README recommends the service account.

## Phase 0c: Client discovery, a persisted client list, and optional Google

Nobody should have to write a client list, and nobody should need Google to use the rest of crawlmark. `config/clients.yaml` is the client list: discovery fills it, users add to it, and crawlmark never changes what a user wrote. This is an approved breaking change to how clients resolve and to `list_clients` output.

1. **Discovery** (`src/providers/discovery.ts`). Through `googleAuth()`, so both auth modes work:
   - Search Console `sites.list` gives `siteEntry[]` (`siteUrl`, `permissionLevel`).
   - GA4 Admin API v1beta: `accountSummaries.list` gives the properties, then `properties.dataStreams.list` per property gives each web stream's `defaultUri`. Stream lookups run with limited concurrency.
   - Each list is wrapped in `cached()` for a day, keyed by the auth identity, and per-property stream lookups are cached separately so one failure doesn't discard the rest. Concurrent calls share one in-flight run.
   - Needs the **Google Analytics Admin API** enabled in Cloud. The existing read-only scopes are enough.
2. **Pure join** (`src/lib/clients.ts`, unit tested with fixture payloads in `test/fixtures/google/`):
   - Normalise hosts: lowercase, punycode, drop the scheme, path, port and a leading `www.`; `sc-domain:x.com` and `https://www.x.com/` both give `x.com`.
   - Join GSC and GA4 on the host. Prefer a `sc-domain:` property, then root-path URL-prefix properties, then `https`, then the shorter URL; skip unverified sites.
   - Several GA4 properties on one host: use the lowest ID; the others become `alternates`. A GA4 property with no web stream is skipped with a note.
3. **Persistence.** After a successful discovery, any newly discovered domain is appended to `CLIENTS_FILE` (created if missing), keyed by domain, with its GA4 `name`, `gscProperty` and `ga4PropertyId`. Rules:
   - Never change or remove anything a user wrote. Only append new domains, and fill a missing `gscProperty` or `ga4PropertyId` on an existing entry. Entries for domains no longer discovered are kept, and `list_clients` notes properties the account can no longer see or that differ from what discovery would pick.
   - No "discovered" marker: since discovery never overwrites a set value, it doesn't need to know who wrote it. The cost is that a value discovery wrote is never updated automatically; the notes above flag drift.
   - Edits use the `yaml` Document API, so comments, order and values survive (indentation is normalised, long strings aren't folded). Writes are atomic (temp file next to the real target, then rename; symlinks followed and permissions kept), re-read the file first, and are serialised in-process; coalesced discovery runs write once. An empty-string property counts as missing.
4. **Manual entries and `ignore`.** A user can add a client with only `domain:`. It works for DataForSEO, Lighthouse and axe with no Google. `crawlmark-cli clients add <domain> [--name ...]` and `clients remove <domain> [--ignore]` edit the file the same way. `ignore: true` hides a domain and stops discovery re-adding it.
5. **Identity.** A client's key is its normalised domain. Tools accept the domain, any URL or `www.` form of it, or the entry's yaml key (an alias). `resolveClient()` in `src/clients.ts` is async.
6. **Defaults** for fields an entry leaves out: name from the GA4 property (else the domain), `DEFAULT_LOCATION_CODE` (2840) and `DEFAULT_LANGUAGE_CODE` (`en`), the homepage as the only key page, no competitors or tracked keywords, and `DEFAULT_CLIENT_MONTHLY_BUDGET_USD` (5).
7. **Google is optional.** `GOOGLE_AUTH_MODE` auto-detects when unset: `service_account` if `GOOGLE_APPLICATION_CREDENTIALS` is set, else `oauth` if both OAuth client vars are set, else no Google. Explicit values win. With no Google:
   - discovery is skipped quietly (one `discovery.info` line, no per-call warnings, CLI exit 0);
   - Search Console and GA4 tools return "Google isn't set up; see README > Google";
   - DataForSEO, Lighthouse and axe work on `clients.yaml` clients, and reports keep their non-Google sections.
   If Google is configured but failing, the `clients.yaml` entries are still served and `list_clients` reports why. If the Admin API is disabled, Search Console clients are still listed, with a warning to enable the "Google Analytics Admin API".
8. **Tools and CLI.** `list_clients` returns domain, name, sources, properties, alternates and missing pieces, plus what this run added to or filled in `clients.yaml`, ignored domains and discovery status, and takes `refresh` to bypass the cache. `crawlmark-cli clients list` prints the same as a table.

**Done when** typecheck, tests and build pass; tests cover the normaliser, the join edge cases, merging, resolution by domain, URL, `www.` and alias, the fallbacks, the sync rules (append only, fill only, comments kept, idempotent, ignore) and auth auto-detection; a live run with the service account writes the discovered domains to a fresh `clients.yaml` and a second run leaves it unchanged; and with Google switched off, `clients list` exits 0 and a hand-added client works with a DataForSEO sandbox tool.

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

`runAudit` saves every run and returns `auditId` in its result. The `client` column holds the client's canonical key (its normalised domain, `client.slug`), so lookups by alias or URL resolve to the same rows. The `checked` list matters because a finding is only "resolved" if that check actually ran the second time.

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

1. **Config.** Add optional `brandTerms: string[]` to the clients.yaml schema and the `Client` type in `src/lib/clients.ts`. Discovered entries won't have it, so the default matters: if it's empty, use the domain stem (`exampleplumbing.com` gives `["exampleplumbing", "example plumbing"]`; split camel case or hyphens where possible), plus the GA4 property name when it differs. Document it in `config/clients.example.yaml`.
2. **Helper.** Create `src/lib/brand.ts` with `isBranded(query: string, client: Client): boolean`. Make it case-insensitive and ignore spaces and punctuation, so "example-plumbing" and "exampleplumbing" both match "example plumbing."
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
| `client-health-check`    | client         | Call `list_clients` and report the client's sources, missing pieces and any discovery warnings, then verify each source works (GSC, GA4, DataForSEO balance, Chrome) with the cheapest possible call, and report what's misconfigured. Useful when onboarding a new client.                                                                                              |

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

- **Config and auth.** Add optional `gtmAccountId` and `gtmContainerId` to the overrides schema. Prefer discovering containers too: list the account's containers with the Tag Manager API and match each container's domain list through the Phase 0c normaliser, keeping yaml as the override. Add the `https://www.googleapis.com/auth/tagmanager.readonly` scope to `src/providers/google.ts` for both auth modes. In OAuth mode, the signed-in user needs Read access to the container; in service-account mode, document adding the service account to each container with Read access.
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

- **CLI.** Add `src/cli.ts` with a `bin` entry, `crawlmark-cli`:
  - `audit --client <domain or slug>` or `audit --all` runs `runAudit`, saves the snapshot and diffs it against the previous one. `--all` means every client in `clients.yaml` (discovery runs first, so new domains are included); skip and report clients whose discovery is incomplete instead of failing the run. Scheduled jobs typically use `service_account` mode, so discovery sees only properties shared with the service account.
  - `check-traffic --all` compares the last 7 days of Search Console clicks with the previous 7.
- **Alert rules.** Alert on any new `critical` or `high` finding, or a non-branded click drop of ≥ `ALERT_TRAFFIC_DROP_PCT` (default 25%) with at least 50 clicks lost.
- **Output.** Write JSON to stdout. If `ALERT_WEBHOOK_URL` is set, POST a short text summary to it in an incoming-webhook-compatible format: `{ "text": "..." }`.
- **Docs.** Document running it from cron or a scheduled job.

### 6d. URL safety and timeouts

- **URL guard.** Create `src/lib/url-guard.ts`. Before any browser check or raw fetch on a user-supplied URL (`lighthouse`, `accessibility_check`, `render_check`, audit `urls` overrides):
  - Allow only `http:` and `https:`.
  - Resolve the hostname and refuse loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, which includes cloud metadata endpoints), CGNAT, and IPv6 equivalents.
  - Add `ALLOW_PRIVATE_URLS=true` to bypass this for local development.
  - Add `RESTRICT_TO_CLIENT_DOMAINS=true` to only allow URLs on client domains in `clients.yaml` (including their subdomains).
- **Timeouts.** Add a `withTimeout(promise, ms, label)` helper and apply it per tool: browser tools 90s, network calls 30s, `run_audit` overall 10 minutes. The timeout must also close the browser.
- **Usage log.** Write one row per tool call to a `tool_calls` table (tool name, client, duration, ok/error). Add a `usage_summary` tool.

## Phase 7: OAuth end-to-end verification

Deferred from Phase 0b until there's a way to test it. The OAuth code is built and unit tested; this phase proves it against Google.

1. **Login.** On a real account (Workspace/Internal, or personal/External-Testing if no Workspace account is available), run `crawlmark-cli auth login`. Confirm the browser flow completes, the token file is written with mode `0600`, and the printed email and scopes are right.
2. **Data in OAuth mode.** With `GOOGLE_AUTH_MODE=oauth` (or auto-detected with no service-account key set), `auth status` shows `Token check: OK`, `list_clients` discovers the account's properties, and `gsc_query` and `ga4_report` return real data for a discovered client.
3. **Switching modes.** Switch between `oauth` and `service_account` with only an `.env` change. Each mode sees its own identity's properties; cached data from one identity is never served to the other.
4. **Logout and re-login.** `auth logout` revokes and deletes the token; tools then return the "run `crawlmark-cli auth login`" error; a fresh login works again. For External-Testing apps, confirm the `invalid_grant` message after the 7-day expiry (or after revoking access at myaccount.google.com).
5. **Docs.** Remove the "OAuth not yet verified" notes from the README and `.env.example`.

**Done when** all of the above works on a real account and the README's Status section lists OAuth as tested.

## Final checklist

- [ ] All phases typecheck and tests pass.
- [ ] README updated: tools table, config fields, new environment variables, layout.
- [ ] `config/clients.example.yaml` documents every new field with a comment.
- [ ] `.env.example` lists every new environment variable, including `GOOGLE_AUTH_MODE`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `DEFAULT_LOCATION_CODE`, `DEFAULT_LANGUAGE_CODE` and `DEFAULT_CLIENT_MONTHLY_BUDGET_USD`.
- [ ] No brand names anywhere: `grep -ri` for any company names before the final commit.
