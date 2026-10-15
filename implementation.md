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

## Phase 0d: Competitor and keyword management

Once `clients.yaml` exists, anyone should be able to add a client's competitors and tracked keywords at any time, and get AI help finding more in the client's niche and area. Everything except the suggestions is free and local.

1. **Storage** (`src/lib/clients.ts`). A `competitors` item is a plain domain string or `{ domain, note?, source?: manual|suggested, addedAt? }`; a `trackedKeywords` item is a plain string or `{ keyword, note?, source?, addedAt? }`. Plain strings stay valid. Domains go through the host normaliser (URLs and `www.` forms become the bare domain); keywords are lowercased with whitespace collapsed. A competitor that isn't a domain, or an empty keyword, is a config error. New optional client fields: `area` (a DataForSEO `location_name`, e.g. `Austin,Texas,United States`, stored without spaces after commas) and `niche` (a few words, e.g. `emergency plumber`).
   - **For later phases:** read `client.competitors` and `client.trackedKeywords`, which are normalised, de-duplicated string arrays whichever form the yaml uses. `client.competitorEntries` and `client.keywordEntries` carry the note, source and date. Never read the raw yaml arrays.
2. **Planning** (`src/lib/client-lists.ts`, pure). Add: normalise, then skip non-domains, the client's own domain and its subdomains (`own-domain`), entries already listed and repeats in the request, each with a reason. New entries are written in object form with `source` (default `manual`) and `addedAt` (local date). Remove: matches every written form of the value, so hand-written duplicates go too; a list left empty is removed.
3. **Edits** (`src/lib/clients-file.ts`, `src/clients.ts`). `appendListItems`, `removeListItems` and `setEntryFields` use the same comment-preserving Document API, atomic write and in-process queue as Phase 0c. Appending to a flow list (`[a, b]`) switches it to block style; values and comments are kept. A client discovery found but couldn't write gets a `domain:`-only entry first.
4. **Tools** (`src/tools/competitors.ts`), all free and local: `add_competitors { client, domains[], note?, source? }`, `remove_competitors`, `list_competitors`, `add_keywords { client, keywords[], note?, source? }`, `remove_keywords`, `list_keywords`, and `set_client_profile { client, area?, niche?, name? }` (an empty string clears a field). Add and remove return what changed, what was skipped and why, and the full list. `list_clients` also shows each client's `area`, `niche` and competitor count.
5. **CLI.** `crawlmark-cli competitors add|remove|list <client> [domain...] [--note]`, `keywords add|remove|list <client> [keyword...] [--note]`, and `clients set <client> [--area] [--niche] [--name]`.
6. **`suggest_competitors { client, area?, niche?, seeds?, limit? }`** (`src/competitors.ts`; paid, read-only, never writes):
   - **Organic overlap:** `competitorDomains()` (DataForSEO `competitors_domain`, organic, top 50).
   - **Local SERP presence:** up to 5 seed keywords: the niche, tracked keywords, then the client's top non-branded Search Console queries for the last 28 days (free; only with Google and a `gscProperty`). DataForSEO `rankedKeywords` is used only when none of those give a seed. Each seed runs `serpOrganic()` (depth 20) with `area` as `location_name` when set, else the client's `locationCode`. Branded queries are dropped with a simple stem/name check until Phase 3's `isBranded`.
   - **Seeds:** optional `seeds` input (up to 5, passed by the AI), then niche, tracked keywords and GSC queries; with seeds or a niche, GSC queries must share a meaningful token with them.
   - **Merge, filter and rank** (`src/analysis/competitor-suggestions.ts`, pure, unit tested): one candidate per normalised domain with evidence (intersecting keywords, average position, estimated traffic, SERP appearances, best position, per-seed positions, a sample URL). Excludes the client's own site, current competitors and `ignore: true` domains (each with subdomains), brand lookalikes (`brand-lookalike`: domain stem starts or ends (3+ other characters) with the client's short brand token, or contains a longer one; common words never count), and a denylist of platforms (`src/lib/competitor-denylist.ts`: social, review/listing, marketplaces, encyclopedias, video, big-box retail, search engines, `*.gov`/`*.edu` and similar), extendable with `config/competitor-denylist.txt` (gitignored, optional; `COMPETITOR_DENYLIST_FILE` moves it) and `COMPETITOR_DENYLIST`; `!domain` exempts one. Score: `100 × (0.5 × overlap + 0.5 × serp)` (0.3 / 0.7 when a local `area` is in effect and the SERPs returned kept candidates; with a local area, candidates with SERP evidence sort before overlap-only ones, which keep their score and get `weakEvidence: true`), where overlap is intersecting keywords relative to the best candidate and serp is the mean over seeds of `(21 − position) ÷ 20`; a source that contributed nothing (failed, no rows, or every row filtered out) gets weight 0 and the other 1. Ties break on SERP appearances, intersecting keywords, then domain. Returns the top `limit` (default 10), excluded domains with reasons, per-source status, the method, `costUsd` and `fromCache`. Fails only when both sources fail.
   - Every paid call goes through `paid()` (cache, `assertBudget()`, `recordSpend()`). The tool description tells the agent to show candidates and call `add_competitors` with `source: "suggested"` only after the user confirms.
7. **Prompt.** `find-competitors { client }` (`src/prompts/index.ts`, text in `src/prompts/templates/find-competitors.md`, copied to `dist/` by the build): confirm or set the area and niche (`set_client_profile`), propose 3-5 non-branded service keywords and confirm them with the user, call `suggest_competitors` with them as `seeds`, present candidates with evidence, ask which to add, then `add_competitors`. This sets up the prompt layout Phase 5 uses.

**Done when** typecheck, tests and build pass; tests cover the normalisers, the mixed yaml forms, add/remove planning and skip reasons, the yaml list and field edits (comments kept, flow lists, empty lists removed), the denylist rules, seed picking, the merge, filter and score (with the recorded sandbox SERP fixture) and the prompt template; and a live run against a scratch `CLIENTS_FILE` adds, lists and removes competitors and keywords through the CLI, runs `suggest_competitors` and fetches `find-competitors` over stdio, and leaves `config/clients.yaml` unchanged.

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

Deviation: axe IDs do not include the selector (axe gives one entry per rule per page and node order is unstable); the first selector and node count are kept as evidence.

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
4. **Movers.** Query movers and tracked keywords mark each row with `branded: boolean`. Opportunity tools exclude branded rows by default. Read tracked keywords from `client.trackedKeywords` (normalised strings; Phase 0d), not the raw yaml, which may hold `{ keyword, ... }` objects.
5. **Suggestions.** Replace `looksBranded()` in `src/analysis/competitor-suggestions.ts` (used to drop branded Search Console seeds) with `isBranded()`.

**Done when** `isBranded` has unit tests, including punctuation and spacing variants, and the monthly report shows the split.

## Phase 3b: Automatic brand terms

Nobody should have to type brand terms. A domain often isn't how people search for a business (`bellafornino.example` is searched as "bella forno pizza"), so crawlmark infers the names from each client's own queries. A brand term only ever applies to the client it belongs to.

1. **Pure extraction** (`src/analysis/brand-terms.ts`, unit tested with fixtures). Input: query rows `{ query, clicks, impressions, position }` (Search Console) or `{ query, position, searchVolume, estimatedTraffic }` (DataForSEO), the client, the other clients, and `source: "gsc" | "dataforseo"`.
   - Candidates are 1-3 word phrases from queries `isBranded` doesn't already match. Stop words, intent words, navigational modifiers (menu, hours, reviews...), the niche, the area, US state names and trade words seen in the queries (words in "near me"/"best" queries that don't name the client, or whose queries mostly rank below position 3; niche, area and trade words also match plurals and endings) never start or end a phrase, unless it strongly resembles the client's name. A phrase made only of generic words is dropped unless it strongly resembles a name that has a distinctive part; a name made entirely of trade words and places (niche, area, place names, discovery-search words; not the rank-based tier, since a client's own word can rank poorly when other businesses share it) never counts. So neither "pizza near me" nor an exact-match domain's head term ("austin plumber" for `austinplumbing.example`, from Search Console or DataForSEO) becomes a brand term, while "la forna" for `lafornina.example` still does.
   - Signals: (a) name similarity to the domain stem, client name or GA4 name (edit-distance and start-of-name similarity; a phrase that is only the end of the name is weak); (b) navigational, Search Console only: average position <= 2 and CTR >= 1.5x the `ctr-curve.ts` value over 3+ clicks, ignoring "near me"-style queries; (c) concentration: several distinct queries carrying a real share of clicks (impressions, estimated traffic or volume), on page one.
   - Output: candidates with `confidence` (high/medium/low), `score`, `source`, the signals and up to 10 evidence queries; `excluded` (reason `other-client-brand`); the top 20 non-branded queries no candidate covers; and a `METHOD` string with every threshold.
   - `high` needs strong name similarity to this client plus a behaviour signal at average position <= 3; DataForSEO-only candidates are `high` only with very strong similarity. Behaviour without name similarity is at most `medium`.
   - **Scoping.** A phrase matching another client's domain stem, name or brand terms is excluded with `other-client-brand`, including fragments and misspellings (every distinctive word within one edit of a word of the other client's names or terms, or a fuzzy substring of them at ratio >= 0.75), unless the phrase is clearly closer to this client's own name. Inference for a client reads only its own Search Console property or DataForSEO rows for its own domain, and writes only its own entry.
2. **Sources** (`src/brand-inference.ts`). Search Console query rows for the last 90 days (rowLimit 1,000; free) first. DataForSEO `rankedKeywords` for its domain (limit 100, through `paid()`, cached 7 days, about $0.02) is used by default only when Search Console isn't usable (Google not set up, or no property). Under 20 Search Console rows needs an explicit `allowPaid: true`; `allowPaid: false` never pays. A Search Console error is reported and never falls back to paid. Takes a resolved `Client`, so discovery can call it without a cycle.
3. **Storage and undo.** A `brandTerms` item is a string or `{ term, source?: manual|auto-gsc|auto-dataforseo|suggested, addedAt? }`. `client.brandTerms` stays a normalised `string[]` (`isBranded` is unchanged); `client.brandTermEntries` carries source and date. `set_client_profile` still replaces the list, and terms it keeps keep their written form and metadata. `add_brand_terms { client, terms[], source? }`, `remove_brand_terms { client, terms[] }` and `crawlmark-cli brand add|remove|list <client> [term...]` edit through the comment-preserving writer.
4. **`suggest_brand_terms { client, apply?, minConfidence?: high|medium, allowPaid? }`** (`src/brand-terms.ts`, `src/tools/brand.ts`). Returns candidates, exclusions, the remaining non-branded queries, per-source status, `method`, `costUsd` and `fromCache`. With `apply: true`, saves candidates at or above `minConfidence` (default `high`) that pass the strict auto-add check, with `source: auto-gsc` or `auto-dataforseo`. Each candidate carries `autoQualified` and a `reviewReason` (`needs-review: generic-name-match`, `needs-review: no-distinctive-name` or `needs-review: confidence`, else null). The description tells the AI to confirm medium and low candidates with the user, then call `add_brand_terms` with `source: "suggested"`. Prompt `review-brand-terms { client? }` (none = every client) walks through it, and asks the user before passing `allowPaid: true` for sparse Search Console data.
5. **Strict auto-add and the distinctive part of a name.** Name similarity is measured against each name's distinctive remainder: the squashed name minus its generic segments (trade words from the niche and discovery searches, places from the area and state names, and company suffixes co/inc/llc/company/corp/ltd/group/services/pros/team/solutions), found by a covering split. For a client with no `area`, a remaining segment next to a trade word counts as a probable place. A candidate is saved automatically (discovery, `apply`, `--apply`) only when one of its words (4+ letters, not the niche, area, a place, a suffix or a filler) fuzzily matches that remainder (ratio >= 0.75). Everything else is a suggestion for review, capped at `medium`. A name with no remainder (a pure exact-match domain, e.g. `austinplumbing.example` or `austinplumbingco.example`) never gets anything auto-added.
6. **Automation.** (a) When discovery sync appends a new client with a Search Console property, the free Search Console inference runs and saves `high` candidates that pass the strict auto-add check (`auto-gsc`). It is best-effort (a failure becomes a note and never changes the sync result), waits at most 20 seconds before letting the rest finish in the background, never calls DataForSEO, and is reported in the `list_clients` discovery notes. (b) `crawlmark-cli brand suggest <client>|--all [--apply] [--min-confidence high|medium] [--paid] [--paid-sparse] [--no-paid]`: with `--all`, the Search Console pass runs for every client first and **no paid call is made** unless `--paid` is given (then DataForSEO for clients that still have no candidates and no usable Search Console, including when Google isn't set up) or `--paid-sparse` (also clients with under 20 Search Console rows); never after a Search Console error. A single client keeps the tool's default (paid only when it has no Search Console property; `--paid-sparse` for sparse data; `--no-paid` never). It prints a table with an `AUTO` column (yes, or why it needs review).

**Done when** typecheck, tests and build pass; tests cover the similarity measure, the extraction with realistic fixtures (including generic high-CTR queries such as "pizza near me", lookalike businesses at poor positions, trade-word name endings, exact-match and company-suffix domains for both sources without a profile, and the strict auto-add check), DataForSEO-only confidence caps, the other-client exclusion (including fragments and misspellings) and a two-client `isBranded` check, the mixed yaml forms, add/remove planning, the `set_client_profile` replace with object entries, `suggest_brand_terms` (Search Console only, DataForSEO fallback without a property, no paid call for sparse data by default or after a Search Console error, apply, paid off, failures) the `--all` paid policy (no paid call without `--paid`, even with Google unconfigured) and the discovery automation (applies, notes, never paid, failure isolated, never auto-adds for an exact-match domain); and a live run against a scratch `CLIENTS_FILE` suggests the spoken brand of a client whose domain differs from it as a high-confidence candidate, only for that client.

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
   - Deviations: `content-js-dependent` also needs rendered words >= 50 and at least 30 more than raw; robots directives compare normalised (case, spacing, order); a non-2xx, non-HTML or failed fetch produces no comparison, and a truncated raw body skips the word-count rule. HTML extraction runs in a worker thread (10s timeout, 256 MB heap) so hostile markup cannot hang the server.
5. **Tool.** `render_check({ url })` returns both extractions plus flags.
6. **Audit integration.** `run_audit` adds a `rendering` section per page and feeds its flags into findings as source `rendering`.

**Done when** the comparison logic has unit tests with fixture HTML pairs (SSR page, SPA shell, mismatched canonical), and `render_check` works on a real headless site.

## Phase 5: MCP prompts

Register prompts with `server.registerPrompt` in `src/prompts/index.ts`. Keep prompt text in markdown files under `src/prompts/templates/` loaded at runtime, so non-developers can edit wording. Copy the templates into `dist/` at build time with a small copy step in the `build` script. (Phase 0d set this up with the `find-competitors` prompt; add the prompts below alongside it.)

| Prompt                   | Args           | Instructs the agent to                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monthly-report-writeup` | client, month? | Call `monthly_report`, then write a client-facing report: a 3-sentence summary, what went up and why, what went down and why, issues fixed since last audit (if available), top 3 opportunities, and next month's priorities. Plain language, no jargon without a one-line explanation, numbers rounded sensibly, and percent changes always with the absolute numbers. |
| `audit-findings`         | client         | Call `run_audit` (or use the latest stored audit if it's under 7 days old), then `compare_audits`. Write findings grouped by severity, each with the affected URLs, why it matters and a specific fix. End with a prioritized fix list. Note that automated accessibility checks don't replace a manual review.                                                         |
| `opportunity-review`     | client         | Call the Phase 2 tools and write a prioritized content and on-page action list with estimated click upside. Where it compares against competitors, use `client.competitors` (normalised domains).                                                                                                                                                                    |
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

**Status:** done as `gtm_audit` (`src/analysis/gtm.ts`, `src/providers/gtm.ts`, `src/reports/gtm.ts`). Findings use a local type with source `gtm` and are not yet part of `run_audit` or `src/analysis/findings.ts`; wiring them in (add `gtm` to `FindingSource`, a `gtm` audit section) is a follow-up once Phase 6a has landed. In OAuth mode the Tag Manager scope is requested at login but not required by the missing-scope check, so older tokens keep working for everything else.

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
  - Chrome guard (replaces the interim `guardPage` request interception, which only sees http(s) requests and checks IP literals): start Chrome with `--proxy-server` pointing at an in-process forward proxy that resolves DNS itself and checks the resolved IP for every connection (CONNECT included), plus `--proxy-bypass-list=<-loopback>` so loopback is not exempted. That covers WebSockets, popups, service workers, DNS rebinding and Lighthouse (chrome-launcher) as well as axe and the rendered fetch. `guardPage` is an interim measure until then.
  - Add the remaining ranges to the guard: SIIT `::ffff:0:0/96` and NAT64 local-use `64:ff9b:1::/48`.
- **Timeouts.** Add a `withTimeout(promise, ms, label)` helper and apply it per tool: browser tools 90s, network calls 30s, `run_audit` overall 10 minutes. The timeout must also close the browser.
- **Usage log.** Write one row per tool call to a `tool_calls` table (tool name, client, duration, ok/error). Add a `usage_summary` tool.

## Phase 6s: Guided setup and distribution

Goal: a new user can install crawlmark, enter credentials once with each one checked live, and have it registered with Claude, without reading the whole README. Secrets are never pasted into chat.

1. **Per-user config home.** Resolve `.env`, `clients.yaml`, `data/` and `secrets/` from `CRAWLMARK_HOME` (default `~/.crawlmark`) when crawlmark runs as an installed package, and keep the project root for a source checkout. `CRAWLMARK_HOME` overrides both. Migrating an existing project-root setup is a copy with a confirmation, never a move.
2. **Setup wizard.** `crawlmark-cli setup` (and `npx crawlmark-mcp setup`) walks through each step and can be re-run to change one:
   - Node version check, and a build if running from source.
   - DataForSEO login and password, checked with the free `/v3/appendix/user_data` call (shows the balance). The wizard explains that the API password differs from the account password, and offers sandbox or live.
   - Google: choose option A, B or C (see the README), show the matching Google Cloud steps, then check the key file or run `auth login`. It ends by listing the Search Console and GA4 properties found.
   - Optional PageSpeed Insights key, checked with one request.
   - Discover clients, write `clients.yaml`, and offer to run brand-term inference (GSC only, free).
   - Register with Claude: `claude mcp add crawlmark …` for Claude Code, or add the server to Claude Desktop's config file (after showing the change and asking). Otherwise print the snippet.
   - Write secrets to `CRAWLMARK_HOME/.env` with mode `0600`.
3. **In-Claude guidance.** A `setup_status` tool reports, per integration, configured / working / missing and the exact next step (a command to run, never a request to paste a secret). A `getting-started` prompt calls `setup_status`, explains what crawlmark can do, and runs a first useful flow (`list_clients`, then an opportunities or audit summary for one client).
4. **npm package.** Done in part 2; publishing is not. `package.json` is no longer `private`, with `bin` entries for `crawlmark-mcp` and `crawlmark-cli`, a `files` allowlist (`dist/` without source maps, `README.md`, `.env.example`, `config/clients.example.yaml`, `LICENSE` if present), repository/keywords/bugs/homepage, and a `prepublishOnly` that fails unless `CRAWLMARK_PUBLISH_OK=1` and then rebuilds `dist/` from scratch, typechecks and runs the tests. `crawlmark-mcp` with a CLI subcommand, `--help` or `--version` now runs the CLI (`src/index.ts` dispatches; the server moved to `src/server.ts`), so `npx crawlmark-mcp setup` works while no arguments still starts the stdio server. Verified with `npm pack` (104 files, 212 KB, nothing from `src/`, `test/`, `data/`, `secrets/`, `.env` or `clients.yaml`) and an install of the tarball into a clean project: `crawlmark-cli --help`, `crawlmark-mcp --version`, `crawlmark-cli setup status --json` and a stdio tool listing (42 tools, 7 prompts) all work with a temporary `CRAWLMARK_HOME`; the pure home resolver gives `~/.crawlmark` for the installed package without it. Installing downloads puppeteer's Chrome plus headless shell (about 570 MB) into `~/.cache/puppeteer`; the README documents `PUPPETEER_SKIP_DOWNLOAD=true` with `CHROME_PATH` or a system Chrome (crawlmark now falls back to a system Chrome when puppeteer's download is absent). **Needs the user:** the actual publish, the license (`UNLICENSED` today, left as is), and an npm account/login.
5. **Claude Desktop bundle.** Done in part 2, untested in Claude Desktop. `mcpb/manifest.json` (MCPB manifest 0.3) collects the DataForSEO login and password (sensitive), a live/sandbox checkbox (default sandbox, mapped to `DATAFORSEO_LIVE`), the Google key file (file picker), the optional OAuth client ID and secret (sensitive), the PSI key (sensitive), an optional Chrome path and the data folder (`${HOME}/.crawlmark`), and passes them as env vars; every field is optional. `npm run build:mcpb` (`scripts/build-mcpb.mjs`) stages `dist/`, production `node_modules` (no Chrome download; unused googleapis clients pruned, 245 MB to under 1 MB) and the manifest, and zips them with the system `zip` to `build/crawlmark.mcpb` (about 41 MB, gitignored). `test/mcpb-manifest.test.ts` checks the manifest against the spec's shape and against the registered tools, prompts and env names. An unzipped bundle starts over stdio with a temporary home and fake credentials, lists 42 tools, and `setup_status` reports the home as working (configured by env). **Needs the user:** install `crawlmark.mcpb` in Claude Desktop and confirm the form, the keychain-stored secrets, that blank optional fields do not break startup (the server already ignores unsubstituted `${user_config.*}` placeholders and empty values), and that audits find Chrome. OAuth sign-in for the bundle needs one terminal step (`CRAWLMARK_HOME=<folder> npx crawlmark-mcp setup --step google`), which only works once the package is published.

**Done when** a fresh machine (or a clean `CRAWLMARK_HOME` and a tarball install) gets from nothing to a working `list_clients` in Claude Code and in Claude Desktop by following only the wizard or the bundle form, and `setup_status` reports every integration correctly in each state.

## Phase 7: OAuth end-to-end verification

Deferred from Phase 0b until there's a way to test it. The OAuth code is built and unit tested; this phase proves it against Google.

1. **Login.** On a real account (Workspace/Internal, or personal/External-Testing if no Workspace account is available), run `crawlmark-cli auth login`. Confirm the browser flow completes, the token file is written with mode `0600`, and the printed email and scopes are right.
2. **Data in OAuth mode.** With `GOOGLE_AUTH_MODE=oauth` (or auto-detected with no service-account key set), `auth status` shows `Token check: OK`, `list_clients` discovers the account's properties, and `gsc_query` and `ga4_report` return real data for a discovered client.
3. **Switching modes.** Switch between `oauth` and `service_account` with only an `.env` change. Each mode sees its own identity's properties; cached data from one identity is never served to the other.
4. **Logout and re-login.** `auth logout` revokes and deletes the token; tools then return the "run `crawlmark-cli auth login`" error; a fresh login works again. For External-Testing apps, confirm the `invalid_grant` message after the 7-day expiry (or after revoking access at myaccount.google.com).
5. **Docs.** Remove the "OAuth not yet verified" notes from the README and `.env.example`.

**Done when** all of the above works on a real account and the README's Known limits and Google sections no longer say OAuth is unverified.

**Status:** done on 2026-10-13 with a personal Gmail account (External, Testing). Login wrote a 0600 token with all four read-only scopes; OAuth discovery found 14 clients (the service account sees 7); `gsc_query` and `ga4_report` returned real data, including a GA4 property only the Gmail account can open; forcing `service_account` for one process got Google's permission error for that property instead of the OAuth-cached result; `auth logout` revoked and deleted the token, tools then pointed at `auth login`, and a second login worked. Not exercised: the 7-day Testing expiry (`invalid_grant`) and a Workspace Internal app.

## Phase 8: Premium installer

Planned in [specs/2026-10-13-1400-phase-8-premium-installer.md](specs/2026-10-13-1400-phase-8-premium-installer.md): an `init` installer with arrow-key prompts and spinners, registration with Claude Code, Claude Desktop, Cursor and Codex, a readable `setup status` and `--help`, and a Tag Manager name-match fix.

**Status:** merged.

## Phase 9: Ahrefs and Semrush as data providers

Planned in [specs/2026-10-13-1500-phase-9-seo-data-providers.md](specs/2026-10-13-1500-phase-9-seo-data-providers.md), with API notes in `docs/research/`.

**Status:** merged (tasks 1 to 9): a provider layer (`src/providers/seo-data.ts`) routing keyword volume, ranked keywords, competitors and backlinks to DataForSEO, Ahrefs (API v3) or Semrush per client; monthly API-unit budgets beside the USD caps; the `provider`, `ahrefs` and `semrush` setup steps with a provider choice at install; `seoprovider`, `ahrefs` and `semrush` rows in `setup_status`; the `ahrefs_status` and `semrush_status` tools; `dataProvider`, `country` and `monthlyUnits` in clients.yaml. Tested with fixtures built from the documented responses and a local fake server only. **Task 10 (live verification) is deferred until after launch** (user decision, 2026-10-15); it needs a real Ahrefs or Semrush key and the user's approval of any billable call, and answers 9.11 N1 to N16. The README marks Ahrefs and Semrush as beta until then.

## Phase 10: Installer polish

Planned in [specs/2026-10-13-1700-phase-10-installer-polish.md](specs/2026-10-13-1700-phase-10-installer-polish.md). After Phase 9. A menu when `init` runs on a finished setup; step timings and "Done in Ns"; "Try asking Claude" example prompts (the user's own client names when they have clients, read locally and shown only in an interactive terminal; example.com otherwise and in plain/CI mode); clickable links and "Press Enter to open" browser shortcuts; dim tips under results; a daily update notice (never in CI, opt-out env var, sends no client data).

**Status:** merged.

## Phase 11: Launch post and demo

The launch blog outline lives in [docs/launch/blog-outline.md](docs/launch/blog-outline.md). **Every phase that adds a tool, prompt, command or feature also adds it there**, marked Shipped or Coming. Before launch: write the post from the outline, check every claim against the README, and produce the 15–30 second demo video from its shot list using example.com data only.

**Status:** the outline is complete (every item Shipped) and the draft post is in [docs/launch/blog-post.md](docs/launch/blog-post.md), with a fact-check table to remove before publishing. The demo video is pending (it needs real recordings).

## Phase 12: Report files, templates, trends and the remaining gaps

Planned in [specs/2026-10-13-1900-phase-12-reports-and-gaps.md](specs/2026-10-13-1900-phase-12-reports-and-gaps.md), with API notes in [docs/research/2026-10-13-phase-12-apis.md](docs/research/2026-10-13-phase-12-apis.md). Three stages, each merged on its own: **Stage A** (report files in Markdown, HTML, PDF and Word from YAML templates, the Google Docs handoff through the user's own Drive connector, CrUX History, opt-in Tag Manager findings in audits), **Stage B** (stored rank history, keyword ideas, competitor keyword gap), **Stage C** (local crawler, server logs, Bing Webmaster, local SEO, AI-search visibility).

**Status:** Stage A merged (`70e32ed`, tasks A-1 to A-11): report templates (`config/report-templates.yaml`, per-client files, a builtin `monthly`), `run_report_template` and `export_report` writing Markdown, HTML, PDF (managed Chrome, offline) and Word (`docx`, pinned exactly; 9.8.1 at the time, now 9.10.0) files under `REPORTS_DIR`, the `template-report` prompt and the Google Docs handoff through the user's own Drive connector, `crawlmark-cli report`, `crux_history` with `setup --step crux`, and opt-in Tag Manager and CrUX findings in `run_audit`. Since then, CI opens every builtin template's DOCX with LibreOffice and checks it has pages and text. Checked by hand on 2026-10-15: the executive sample opens in Pages and converts to a Google Doc. Not yet checked: Microsoft Word itself, and a Claude session with a Drive connector.

**Stage B status:** merged (`3ab7310`, tasks B-1 to B-6): the `rank_history` table (guarded `CREATE ... IF NOT EXISTS` on start), `check_ranks` (free Search Console 7-day positions; live DataForSEO ranks only with `live: true`, one pre-flight cap check for the whole run, `estimateOnly`), `rank_history`, rank rows from `serp_check` and `monthly_report` with `liveRanks` (tracked keywords only; output unchanged), the `rank-drop` alert (live ranks only, `ALERT_RANK_DROP`), `crawlmark-cli check-ranks [--live] [--dry-run]` (paid only with an explicit `--live`), the routed `keywordIdeas` / `keywordGap` capabilities for DataForSEO Labs, Ahrefs (gap checked against the client's own Search Console) and Semrush with whole-call estimates and a "use limit N" refusal, the `keyword_ideas` and `keyword_gap` tools, the `rank_trend` (free, optional `ranks` in the builtin monthly) and `keyword_gap` (paid) report sections, and the `keyword-research` prompt. The DataForSEO live check below is done.

**Stage B live check, DataForSEO: done 2026-10-13** (user-approved, about $0.04). On one of the user's own clients with `estimateOnly` first: `keyword_ideas` related (limit 1), `keyword_ideas` matching (limit 1) and `keyword_gap` with one competitor (limit 1) each returned real data in the documented shape, and each cost exactly its $0.01212 estimate (balance $0.8773 → $0.8409, a $0.0364 drop). Ahrefs and Semrush remain pending until the user has keys.

**Stage B live check (Ahrefs and Semrush deferred until after launch; needs the user's approval and keys, answers 12.Q-B1 and research "Not confirmed" 4, 7, 8).** One call of each per configured provider, on a client of the user's own (shown as `example.com`), smallest limit, each preceded by its `estimateOnly: true` call to compare against the cost the real call reports (`costUsd` / `units`, and the spend ledger):

| Provider | Calls | Estimated cost |
|---|---|---|
| DataForSEO (live mode, `DATAFORSEO_LIVE=true`; the sandbox is free) | `keyword_ideas { client: "example.com", seeds: ["<one service keyword>"], mode: "related", limit: 1 }`, `keyword_ideas { ..., mode: "matching", limit: 1 }`, `keyword_gap { client: "example.com", competitors: ["<one competitor>"], limit: 1 }` | $0.01212 each ($0.012 per task + $0.00012 per item), about $0.037 in total |
| Ahrefs | `keyword_ideas { ..., mode: "related", limit: 1 }`, `keyword_ideas { ..., mode: "matching", limit: 1 }`, `keyword_gap { ..., competitors: ["<one competitor>"], limit: 1 }` on a client with a Search Console property | 50 units each (the minimum), 150 units in total; a gap for a client without Search Console adds 13,000 units, so don't use one |
| Semrush | `keyword_ideas { ..., mode: "related", limit: 1 }` (40 units a line), `keyword_ideas { ..., mode: "matching", limit: 1 }` (20), `keyword_gap { ..., competitors: ["<one competitor>"], limit: 1 }` (80) | at most 140 units in total |
| Optional: `check_ranks { client: "example.com", live: true, keywords: ["<one tracked keyword>"] }` | DataForSEO live SERP | about $0.002 |

Things to confirm: Ahrefs `related-terms` / `matching-terms` answer with a `keywords` array and charge 1 unit for `keyword` and `cpc`; DataForSEO `keyword_suggestions` takes `keyword` + `limit` and returns the `keyword_ideas` item shape; Semrush's header texts for `Kd` and for `domain_domains`' `P0` / `P1` columns (the fixtures in `test/fixtures/semrush/phase12b/` assume "Keyword Difficulty" and the domain names); and that the reported cost or units match the estimate.

**Stage C1 status:** merged (`c11929f`): the free bounded local crawler (`src/providers/crawler.ts`: robots.txt for the `crawlmark` or `Googlebot` group, Crawl-delay up to 10 s, 250 ms per host otherwise, every URL and redirect hop through the guarded single-hop `fetchHop` and `RESTRICT_TO_CLIENT_DOMAINS`, page/depth/concurrency/time caps, 2 MB pages), its analysis and `crawl` findings (`src/analysis/crawl.ts`), the `local_crawls` table (newest 10 per client), `local_crawl` and `local_crawl_pages`, `crawlmark-cli crawl`, `run_audit` with `localCrawl`, orphans in `site_hygiene` from the newest complete local or DataForSEO crawl, and the `site_crawl` report section. Pending: the manual check on a site the user owns (spec C1 Done-when).
**Stage C2 status:** merged (`5a29479`): server-log analysis. `log_analysis` reads only regular files inside `LOG_DIRS` or `<home>/logs` (realpath containment; `..`, absolute paths elsewhere and symlinks out refused), Apache/Nginx combined and common formats and `.gz`, 50 files / 2 GB / 20 million lines per call; a bot table (`src/analysis/bots.ts`) with families; Googlebot-family hits verified against Google's published crawler ranges (`CRAWLER_IPRANGES_BASE_URL`, cached a week; `verify: false` makes no request); aggregates only, no IPs or user agents in output or storage, nothing written to SQLite apart from the cached public range files. `crawlmark-cli logs` takes explicit paths.
**Stage C3 status:** merged (`d0b52e3`): Bing Webmaster Tools, read-only. `src/providers/bing.ts` calls only `BING_READ_METHODS` (GetUserSites, GetRankAndTrafficStats, GetQueryStats, GetPageStats, GetCrawlStats, GetCrawlIssues, GetUrlInfo; anything else is refused before a request), sends `BING_WEBMASTER_API_KEY` as Bing's `apikey` query parameter and keeps it out of errors, logs, cache keys (`cacheKey("bing", <8-hex SHA-256 fingerprint of the key>, method, siteUrl)`, so a new key never sees the old account's cache; the site list is cached parsed, without verification codes), usage rows, status JSON and reports; one retry with jitter on throttling or 5xx; `ErrorCode` 3 is "Bing rejected the API key; run setup --step bing". `src/analysis/bing.ts` parses `/Date(ms±hhmm)/` days and the CrawlIssues flags, matches sites to clients with `normalizeHost` (clients.yaml `bingSite` overrides; never written automatically, never part of discovery), and sanitises Bing's text. `bing_report` (28 days ending on Bing's newest day vs the 28 before), the `bing_overview` report section, `clients set --bing-site` / `set_client_profile bingSite`, `setup --step bing` (one free GetUserSites check) and a `bing` setup_status row (human output only when configured; plain installer output unchanged), `BING_BASE_URL` (shell-only, https or loopback http), and the optional sensitive bundle field. Deferred until after launch: the free live check with the user's Bing key (spec C3 Done-when): `setup --step bing`, then `bing_report` for one verified site, answering Not-confirmed 3.
**Stage C4 status:** merged (`e242752`): local SEO through DataForSEO Business Data and the Google Maps SERP (never the Google Business Profile API). DataForSEO-only capabilities `localProfile`, `localPack`, `localReviews` (requireDataForSeo; no silent fallback). `local_profile` (my_business_info/live by name in the client's `area`, or `place_id:` once saved; returns the match plus up to 4 other listings and whether its website is the client's domain; never saves), `local_pack` (maps/live/advanced per keyword, first 5 tracked by default, client recognised by `gbpPlaceId` else domain, top 3), `local_reviews` (task_post with priority 2, task_get every 5 s for up to 75 s, else `{ pending, taskId }`; a taskId is accepted only for the client that started it; no reviewer data; needs the confirmed `gbpPlaceId`). Every call takes `estimateOnly`, reserves the whole operation's USD estimate with `withUsdReservation` before the first request, and records actual costs. New clients.yaml field `gbpPlaceId`, written only by `set_client_profile` / `clients set --place-id`. Paid `local_profile` report section (confirmed place ID only; estimated in the run's pre-flight). The live check below is done.

**Stage C4 live check: done 2026-10-13** ($0.0148, user-approved). The map pack call worked. The listing lookup for the user's business returned DataForSEO's 40102 "No Search Results" and was still billed; that led to recording billed failures in the spend ledger and a plain "no Business Profile" message. The plan as run: On the user's own business (shown as `example.com`), with `DATAFORSEO_LIVE=true` and the client's `area` set, each preceded by its `estimateOnly: true` call:

| Step | Call | Estimated cost |
|---|---|---|
| 1 | `local_profile { client: "example.com" }`, then confirm the match and `set_client_profile { client: "example.com", gbpPlaceId: "<matched.placeId>" }` (free) | $0.0054 |
| 2 | `local_pack { client: "example.com", keywords: ["<one tracked keyword>"], depth: 20 }` | $0.002 |
| 3 | `local_reviews { client: "example.com", depth: 10 }` (if pending, call again with the `taskId`, free) | $0.0015 |
| Total | | about $0.009 (well under $0.10) |

Things to confirm: the actual `cost` of each against the estimate (the my_business_info price page returned 404 during research); the priority-queue reviews price and that results arrive within 75 s; the review item fields (`review_text`, `timestamp`, `rating`, `owner_answer`) match the fixtures; and that `place_id:<id>` lookups return the same listing at the same price (the my_business_info docs list `place_id:` / `cid:` as identifiers with no surcharge; the 5x price is documented only for search operators on Reviews, so the estimate assumes 1x). Replace the hand-built fixtures in `test/fixtures/dataforseo/` with scrubbed recordings.

**Stage C5 status:** merged (`7ccd3cf`): AI-search visibility from DataForSEO LLM Mentions. Off unless `AI_VISIBILITY_ENABLED=true` (exactly "true", any case); otherwise `ai_visibility` and the `ai_visibility` report section are unavailable with the enable instructions and make no request. DataForSEO-only capability `aiVisibility` (requireDataForSeo). `ai_visibility` (`mentions`: `search_mentions/live` with the client's domain as a source, by AI search volume; `metrics`: `target_metrics/live`; `platform` `google` or `chat_gpt`, the latter refused before any request for a non-US or non-English client); estimate $0.10 + rows × $0.001; its own monthly sub-cap `AI_VISIBILITY_MONTHLY_BUDGET_USD` (default $2, global; the sum of ledger rows under `/ai_optimization/`) checked with the client and global caps before the request, with in-flight reservations (`withAiUsdReservation`); cached a week; answers stripControl'd and capped. The $100 top-up warning is in the tool description, the estimate, every result, the `template-report` prompt, the `aivisibility` setup_status row (always in `--json`, human output only when switched on or mistyped), README, `docs/reports.md` and `.env.example`. Bundle fields `ai_visibility_enabled` (default off) and `ai_visibility_monthly_budget_usd`. The paid `ai_visibility` report section needs `paid: true`, `allowPaid`/`--paid` and the switch. Pending: the optional live check below.

**Stage C5 live check (pending; needs the user's approval for at most $0.30 of DataForSEO live spend and confirmation that their account has LLM Mentions access; answers research Not-confirmed 6).** With `DATAFORSEO_LIVE=true` and `AI_VISIBILITY_ENABLED=true`, on the user's own site (shown as `example.com`), each preceded by its `estimateOnly: true` call:

| Step | Call | Estimated cost |
|---|---|---|
| 0 | Check the DataForSEO dashboard: is LLM Mentions enabled without a $100 top-up? (free) | $0 |
| 1 | `ai_visibility { client: "example.com", mode: "metrics" }` | up to $0.11 (example task: $0.101) |
| 2 | `ai_visibility { client: "example.com", mode: "mentions", limit: 5 }` | $0.105 |
| Total | | at most about $0.215 (under the $0.30 approval and the $2 sub-cap) |

Things to confirm: `search_mentions/live` answers (if it 404s, switch to the legacy `search/live`, decided then, not at runtime); the item and `aggregated_metrics` fields match the fixtures; the actual costs against the estimates; and the minimum-commitment status for the account. Replace the hand-built fixtures with scrubbed recordings.

## Phase 13: Provider report sections and a technical-issues report

Planned in [specs/2026-10-13-2100-phase-13-report-sections.md](specs/2026-10-13-2100-phase-13-report-sections.md), with API notes in [docs/research/2026-10-13-phase-13-report-sections.md](docs/research/2026-10-13-phase-13-report-sections.md). Three stages, each merged on its own: **Stage A** (free: the local snapshot store, a deduplicated `technical_issues` section from crawlmark's own stored results and a stored DataForSEO crawl, the opt-in `indexing_issues` section from URL Inspection and Sitemaps, whole-run unit reservations and `estimateOnly` for report runs), **Stage B** (paid, opt-in: `backlinks`, `organic_visibility`, `competitor_overview`, and Ahrefs / Semrush Site Audit as technical-issue sources), **Stage C** (building templates by picking sections, in the CLI and through Claude with a confirm step).

**Stage A status:** merged (`dbd7506`, tasks A-1 to A-7): the `seo_snapshots`, `issue_snapshots`, `url_inspections` and `gsc_inspection_quota` tables (guarded `CREATE ... IF NOT EXISTS`); whole-run unit reservations (`withUnitsReservation`) and `estimateOnly` for `run_report_template`, `export_report` and `report --dry-run`; `technical_issues` (one deduplicated list from the saved audit, site checks, the newest local crawl, a stored DataForSEO crawl's summary and stored URL Inspection results; canonical catalogue, merged severity, snapshot diff with new / persistent / resolved / unverified); URL Inspection coverage (`inspect_index_coverage`, `index_coverage`, `crawlmark-cli index-coverage`: key pages, top Search Console pages and a weekly-rotating sitemap sample within `GSC_INSPECTION_DAILY_BUDGET` per property per Pacific day, stopping on a quota error; `gsc_inspect_url` and `run_audit` record their inspections with unchanged output); the `technical_issues` and `indexing_issues` report sections (optional in the builtin templates), highlights 11 and 12, docs. The Ahrefs and Semrush Site Audit sources are Stage B (listed as unavailable; nothing requested). The live check below is done.

**Stage A live check: done 2026-10-13** (free). URL Inspection works with the `webmasters.readonly` scope, and the inspected homepage came back indexed. The plan as run: `inspect_index_coverage { client: "example.com", maxInspections: 5 }` on one property the user owns, then `index_coverage { client: "example.com" }`. Confirms that URL Inspection works with the `webmasters.readonly` scope crawlmark already has, records Google's real `coverageState` strings (the coverage mapping matches them by keyword), and, if a quota error is ever seen, its exact status and reason and when the day resets (assumed midnight Pacific). Optionally `technical_issues { client: "example.com" }` on a client with a stored DataForSEO crawl (Not confirmed 10: the summary read should cost nothing).

**Stage B status:** merged (`8424dc6`): the provider layer gains `organicOverview` and `competitorOverview` (routed, no fallback) plus visibility and backlink history and per-call plans for DataForSEO (Labs domain rank overview and history, backlinks history, competitors with full-domain metrics; backlinks summary estimate raised to $0.025), Ahrefs (metrics, keywords history, metrics history, referring-domains and Domain Rating history, organic competitors) and Semrush (domain overview and its history, competitors; no backlink history); `src/reports/provider-sections.ts` (plan with no request, reuse within `SNAPSHOT_REUSE_DAYS`, comparisons by tolerance with monthly provider-history points matched by month, history bought at most once a month per series and only when a stored figure can't serve a comparison or the trend, one provider per series with a note on a switch); the `backlinks`, `organic_visibility` and `competitor_overview` report sections (optional and paid in the builtin `monthly` and `quarterly`), priced in the run's pre-flight and reserved for the whole run; tools `organic_visibility`, `competitor_overview`, `seo_trends`; `backlinks_summary` stores a snapshot for the client's own domain (output unchanged); `crawlmark-cli seo-snapshot`; Ahrefs and Semrush Site Audit as `technical_issues` sources through read-only GET allowlists (existing projects only; `ahrefsSiteAuditProject` / `semrushProject` in clients.yaml); the Ahrefs storage rules (counts only, 25 months, purge with `crawlmark-cli data purge`, on client removal and on key removal; Semrush 31 days); renderers with a "Source:" line kept in white label; highlights 9 and 10; docs.

**Stage B live checks (deferred until after launch; each needs the user's explicit OK; answers research Not confirmed 1-7):**
- DataForSEO (under $0.25): `organic_visibility { client: "<user's own site>", history: true }`, a `backlinks` section run (summary plus `backlinks/history`), `competitor_overview` with one saved competitor (Not confirmed 6, 7: the real costs, and whether the saved competitor is in the list).
- Ahrefs (about 50 units): `technical_issues { sources: ["ahrefs_site_audit"], allowPaid: true }` on a project the user has (projects is free; issues 50), and `organic_visibility` / `competitor_overview` against Ahrefs' free test target `ahrefs.com` (0 units) to confirm the keywords-history and organic-competitors responses (Not confirmed 1, 2).
- Semrush (about 640 units): `domain_rank` (10), `domain_rank_history` 13 lines (130), `domain_organic_organic` (400 at 10 lines, or 200 with `limit` 5 and 5 lines), the project list (100), `/siteaudit/info` (100) and `/meta/issues` (100) (Not confirmed 3-5: which key the Projects API takes, the Site Audit tool name in the project list, the `Date` header, `current_snapshot.snapshot_id`, the issue-detail URL field, and the window of v4 `new_count` / `lost_count`).

**Stage C status:** merged (`f6b4019`, tasks C-1 to C-3): `src/reports/templates/write.ts` (plan then apply: the change is made on the file's text so comments and layout survive, with a standard-layout fallback that is flagged in the warnings; the whole result validated before writing; only `<home>/config/report-templates.yaml` and `<home>/config/report-templates/<client>.yaml`, never through a symlink; 0600, one `.bak`; a refusal when the file changed since the plan; a small line diff capped at 20,000 characters), `proposals.ts` (single-use `tpl_` tokens, 15 minutes, bound to the tool, path, both file hashes, client and an arguments hash), `builder.ts` (the grouped catalogue, default section specs, per-client estimates with no request), tools `create_report_template` / `update_report_template` (propose, confirm, `paidAcknowledged`, MCP elicitation when the client supports it), `get_report_template`'s `catalogue` field, the `build-report-template` prompt and wording in `template-report` and `getting-started`, `crawlmark-cli report templates new` (`new-cli.ts`, clack or plain, grouped multiselect, paid sections confirmed with default No, sample-data preview under `<REPORTS_DIR>/.preview/`, diff, save / change / cancel; `--client`, `--file`, `--replace`, `--dry-run`, `--yes`), docs, manifest. Pending: the user's manual checks (a run on a real terminal and a save from Claude Code with elicitation).

**Indexing additions:** merged (`834b6cc`). "Check all pages" (`inspect_index_coverage { all: true }`, `index-coverage --all-pages`) and the import of Search Console's Pages report (`import_index_report`, `index-coverage import`), parsed locally.

## Hardening before launch (2026-10-14 and 15)

All merged and pushed:

- A whole-repo bug scan and security scan, with fixes: in-flight budget reservations for DataForSEO calls (no parallel overspend), the on-page crawl estimate corrected to $0.00045 a page, SQLite `busy_timeout` and WAL, the CLI cleanup running for `report`, `audit` and `check-ranks`, `RESTRICT_TO_CLIENT_DOMAINS` on redirects and final URLs in render checks, axe and Lighthouse, 0600/0700 data files, cache tracking per client, audit retention (400 days, newest two kept), and a neighbouring month's snapshot no longer shown as the requested month.
- CodeQL: one real issue fixed (link injection through backslash-pipe in Markdown table cells), read-side file checks hardened (no-follow, size re-checked on the bytes read), the rest triaged and dismissed with reasons.
- CI on Ubuntu, macOS and Windows with a packaged-install smoke test and a LibreOffice DOCX check; a Security workflow (npm audit, gitleaks, CodeQL); Dependabot; `SECURITY.md` with private vulnerability reporting.
- Windows fixes found by CI: a failed Chrome launch reports its own error instead of a profile-cleanup EBUSY, install detection handles forward-slash paths, and Claude Desktop config paths use the target OS's separator. On Windows, which has no file modes, token and `.env` files rely on the user profile's permissions.
- More tests: the Google OAuth flow against a fake Google, the setup wizard with a scripted UI (which found Ctrl-C at the Claude Desktop or Cursor confirm being swallowed; fixed), real Lighthouse and axe against a local fixture site, provider contract tests with an endpoint coverage map, and an opt-in `npm run test:live` against free endpoints.

**Deferred until after launch** (user decision, 2026-10-15): the Bing, Ahrefs and Semrush live checks and the paid Phase 13 Stage B checks.

## Final checklist

- [x] All phases typecheck and tests pass.
- [x] README updated: tools table, config fields, new environment variables, layout.
- [x] `config/clients.example.yaml` documents every new field with a comment.
- [x] `.env.example` lists every new environment variable, including `GOOGLE_AUTH_MODE`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `DEFAULT_LOCATION_CODE`, `DEFAULT_LANGUAGE_CODE` and `DEFAULT_CLIENT_MONTHLY_BUDGET_USD`.
- [x] No brand names anywhere: `grep -ri` for any company names before the final commit (history scanned before every push, 2026-10-14 and 15).
