# crawlmark-mcp

An MCP server for automated SEO audits and monthly reports. It combines:

| Source | What it provides | Cost |
|---|---|---|
| Google Search Console | Clicks, impressions, CTR, position, URL inspection, sitemaps | Free |
| GA4 Data API | Organic sessions, engagement, key events, landing pages | Free |
| DataForSEO | Keyword volume, live SERPs, ranked keywords, competitors, backlinks, site crawls | Pay per call |
| Lighthouse | Performance/SEO/best-practices scores, lab Core Web Vitals | Free (runs locally) |
| PageSpeed Insights | Real-user CrUX field data | Free with API key (optional) |
| axe-core | Automated WCAG A/AA/AAA checks | Free (runs locally) |

On top of the raw sources it adds a client list in `config/clients.yaml` that fills itself from Google (every Search Console site and GA4 property your Google account can see is added automatically) and that you can add to by hand, so the DataForSEO, Lighthouse and axe tools work even without Google, a SQLite response cache, a per-client and global monthly spend cap, and report-shaped tools.

## Tools

**Report tools** (start here)

| Tool | Does |
|---|---|
| `list_clients` | Every client: domain, name, sources, GSC property, GA4 property, alternates, what's missing, what was just added to `clients.yaml`, and discovery status (its notes include brand terms added automatically for new clients). `refresh: true` re-lists from Google |
| `monthly_report` | GSC + GA4 month vs previous month and last year (`vsPreviousMonth` and `vsLastYear` include a `previous` object, and `change` is null when the earlier period has no impressions), top/moving queries and pages, landing pages, tracked keyword positions, an [`opportunities`](#opportunities) section (top 5 each of striking distance, low CTR and cannibalization), a [branded vs non-branded split](#branded-queries) (`search.branded`, `search.nonBranded`; query rows and tracked keywords carry `branded: boolean`), and an `audit` section (the latest saved audit plus its diff against the most recent audit from before the month; `null` unless there is one from before the month and a newer one; a back-dated `month` still diffs against the latest audit) |
| `striking_distance` | Queries at positions 5-20 with top page and estimated extra clicks if they reached position 3. Free, Search Console only; see [Opportunities](#opportunities) |
| `quick_wins` | Pages at positions 11-20 with their top 3 queries |
| `low_ctr` | Queries at positions 1-5 with CTR under 60% of expected (title and meta rewrite candidates) |
| `cannibalization` | Queries where 2+ pages each hold at least 10% of the impressions |
| `declining_pages` | Pages whose clicks fell versus the previous equal-length period, with the queries that lost the most |
| `run_audit` | Lighthouse + axe + a rendered-vs-raw HTML check (`rendering`) + GSC index status + on-page check per key page, sitemap health; optional full crawl and backlinks. Every run is saved and returns an `auditId`. Runs are fresh by default (the response cache is skipped, so the on-page check is a paid call per page); `fresh: false` reuses results up to a day old, and `compare_audits` warns when the later audit was not fresh |
| `list_audits` | A client's saved audits, newest first: ID, run time, page count, average scores, finding count |
| `get_audit` | One saved audit's full result and normalised findings, by ID |
| `compare_audits` | Diffs two saved audits (default: latest vs the one before): `new`, `resolved`, `persistent` and `unverified` findings plus Lighthouse score changes. A finding is `resolved` only if its check ran in the later audit; otherwise it is `unverified` |
| `render_check` | Fetches a URL as plain HTML (Googlebot-like user agent) and as rendered by headless Chrome, extracts title, description, canonical, robots, H1s, links, JSON-LD types, hreflang, Open Graph and visible word count from each, and flags SEO elements that only exist after JavaScript runs (`title-js-only`, `canonical-mismatch`, `robots-js-only`, `content-js-dependent`, `jsonld-js-only`, `links-js-only`, ...). http/https only; private and loopback IP literals are refused unless `ALLOW_PRIVATE_URLS=true` (hostname-resolution checks come in Phase 6d). Free, cached 1 day; `refresh` bypasses |
| `crawl_status` | Progress and issue counts for a full crawl started by `run_audit` |
| `crawl_issue_pages` | URLs failing one crawl check (e.g. `no_description`) |
| `spend_summary` | Paid API spend this month by client |
| `purge_cache` | Drop expired cache entries |

**Competitors, keywords and brand terms** (free and local, except `suggest_competitors` and the DataForSEO fallback in `suggest_brand_terms`)

| Tool | Does |
|---|---|
| `list_competitors` | A client's competitors with any note, source (`manual` or `suggested`) and date added, plus its `area` and `niche` |
| `add_competitors` | Adds domains (bare, `www.` or full URLs; saved as the bare domain). Skips the client's own domain and subdomains, ones already listed, repeats and non-domains, and says why. Takes `note` and `source` |
| `remove_competitors` | Removes domains, in any URL or `www.` form |
| `list_keywords`, `add_keywords`, `remove_keywords` | The same for tracked keywords (saved lowercase with single spaces). `monthly_report` reports their positions |
| `set_client_profile` | Sets or clears (`""`) a client's `area` (a DataForSEO location name, e.g. `Austin,Texas,United States`), `niche` (e.g. `emergency plumber`) and `name`; `brandTerms` (a list; replaces the stored one, `[]` clears it) feeds the [branded split](#branded-queries) |
| `add_brand_terms` | Adds [brand terms](#branded-queries) to one client (saved as `{ term, source, addedAt }`). Skips terms already listed (ignoring case, spacing and punctuation) and repeats. Takes `source`: `manual` (default) or `suggested` |
| `remove_brand_terms` | Removes brand terms, matched ignoring case, spacing and punctuation, including ones added automatically |
| `suggest_brand_terms` | Infers how people search for the client by name from its own Search Console queries (free), or DataForSEO ranked keywords for its domain only when it has no Search Console property (paid, about $0.02; `allowPaid: true` also allows it for sparse Search Console data, `false` never). Returns candidates with confidence, score, evidence and source, plus the top remaining non-branded queries. Read-only unless `apply: true` (saves candidates at or above `minConfidence`, default `high`). See [Automatic brand terms](#automatic-brand-terms) |
| `suggest_competitors` | **Paid, read-only.** Ranked candidate competitors with evidence, from DataForSEO organic keyword overlap and live Google results for up to 5 seed keywords in the client's area. Never saves; the agent shows you the candidates and adds only the ones you confirm. See [Competitor suggestions](#competitor-suggestions) |

**Prompts**

| Prompt | Args | Does |
|---|---|---|
| `find-competitors` | `client` | Confirms or sets the client's area and niche, runs `suggest_competitors`, presents the candidates with evidence, asks which to add, then adds them |
| `review-brand-terms` | `client` (optional; empty = every client) | Runs `suggest_brand_terms`, presents the candidates and remaining non-branded queries, asks which uncertain ones to add, then adds them with `source: "suggested"` |
| `monthly-report-writeup` | `client`, `month` (optional, `YYYY-MM`) | Calls `monthly_report` and writes a client-facing report: 3-sentence summary, what went up and down and why, branded vs non-branded, issues fixed since the last audit, top 3 opportunities, next month's priorities. Plain language, percentages always beside absolute numbers; unavailable sections are named, not guessed |
| `audit-findings` | `client` | Uses the latest stored audit if it's under 7 days old (`list_audits`, `get_audit`), otherwise runs `run_audit`; then `compare_audits` (or says there's nothing to compare against). Findings by severity with URLs, why it matters and a fix, a prioritized fix list, and the manual accessibility review caveat |
| `opportunity-review` | `client` | Runs the five free opportunity tools, reads competitors from `list_competitors`, and writes a prioritized action list with estimated click upside. Paid checks (`ranked_keywords`, `suggest_competitors`) are offered with their approximate cost, never run unasked |
| `client-health-check` | `client` | `list_clients`, then one cheap check per source: a small `gsc_query`, a small `ga4_report`, a `render_check` of the homepage (proves Chrome works) and `dataforseo_status`; ends with a status table and a fix list. Useful when onboarding |

Every prompt says to prefer free tools and to say so when a section was unavailable instead of guessing.

Prompt text lives in `src/prompts/templates/*.md` (copied to `dist/` by `npm run build`), so wording can be edited without touching code.

**Lower-level tools** (for follow-up questions)

`gsc_query`, `gsc_inspect_url`, `ga4_report`, `dataforseo_status` (free: credentials check, sandbox or live mode, balance), `keyword_volume`, `serp_check`, `ranked_keywords`, `competitor_domains`, `backlinks_summary`, `lighthouse`, `accessibility_check`, `render_check`

Tools that take a `client` accept its domain (`example.com`), any URL or `www.` form of it, or its `clients.yaml` key. See [Clients](#clients).

Report tools return structured JSON. The agent (or a skill) turns that into the written report, so formatting and tone live in your prompts, not in this server.

## Setup

Requires Node 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install            # also downloads a Chrome build for Lighthouse + axe
cp .env.example .env
npm run build
```

Google is optional. Without it, add clients by hand (`npm run cli -- clients add example.com`) and use the DataForSEO, Lighthouse and axe tools; set up Google (below) to add Search Console and GA4 data and to fill the client list automatically.

Scripts: `npm run dev` (tsx), `npm run build`, `npm start` (runs `dist/` with the SQLite ExperimentalWarning silenced), `npm run cli -- <command>` (the `crawlmark-cli` admin CLI), `npm run typecheck` (source and tests), `npm test` (vitest), `npm run inspect`.

### Config and paths

Settings come from environment variables, with `.env` in the project root loaded automatically (a missing `.env` is fine). `.env.example` lists every variable. Relative `CLIENTS_FILE` (the client list, see [Clients](#clients)), `DATA_DIR` (which also holds the Google OAuth token), `COMPETITOR_DENYLIST_FILE` and `GOOGLE_APPLICATION_CREDENTIALS` values resolve against the project root (the directory above `src/` or `dist/`), not the working directory, so the server works no matter where a client launches it. Absolute paths are used as-is.

### Google

Google (Search Console + GA4) is optional. Without it, the Search Console and GA4 tools return "Google isn't set up", reports skip those sections, and everything else works.

The server signs in to Google one of two ways. Leave `GOOGLE_AUTH_MODE` unset to auto-detect: a service account if `GOOGLE_APPLICATION_CREDENTIALS` is set, otherwise OAuth if `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` are both set, otherwise no Google. Set `GOOGLE_AUTH_MODE=oauth` or `service_account` to choose explicitly. If both a key path and an OAuth client are set and the mode is unset, the service account wins, and `auth status` and `list_clients` say the OAuth vars are being ignored (the key path may come from your shell rather than `.env`). Switching modes is only an `.env` change; the tools are the same.

> **Status:** the service-account path (option C) is tested live. The OAuth code (options A and B) is built and unit tested, but its end-to-end verification against a real account is deferred (Phase 7 in `implementation.md`). Prefer option C for now.

#### Choose a setup

| Option | Mode | You need | Pros | Cons | Steps |
|---|---|---|---|---|---|
| **A. OAuth, Google Workspace** | `oauth` | A Workspace (business) account, with the Cloud project inside that organization | Sign in once; the server sees every property you can already open; sign-ins don't expire on a schedule | Requires Workspace | 1, 2 (Internal), CLI check |
| **B. OAuth, personal Gmail** | `oauth` | Any Google account | Same property access as A, no Workspace needed | Sign-in expires every 7 days while the app is in Testing; Google shows an "unverified app" screen | 1, 2 (External + Testing), CLI check |
| **C. Service account** | `service_account` | Any Google account that can create a Cloud project | Never expires, no sign-in, works for unattended jobs | You must add the service account's email to every client's Search Console and GA4 property | 1, 3, CLI check |

**Which one?** With Workspace, use A. Without it, use C for daily work and unattended jobs, and B if you'd rather not share each property with a service account. You can set up more than one and switch with `GOOGLE_AUTH_MODE`. Unset, it auto-detects as described above.

All options request read-only scopes only: `webmasters.readonly` and `analytics.readonly`. OAuth also requests `openid email` so it can show which account is signed in.

#### 1. Google Cloud project and APIs

In the [Google Cloud console](https://console.cloud.google.com/), create (or pick) a project. Under **APIs & Services > Library**, enable:

- **Google Search Console API**
- **Google Analytics Data API**
- **Google Analytics Admin API** (lists your GA4 properties so clients can be discovered; without it only Search Console clients are found, and `list_clients` says so)
- **PageSpeed Insights API** (only for `PSI_API_KEY`, see below)

#### 2. OAuth mode setup

1. **Configure the consent screen.** Open **Google Auth Platform** (APIs & Services > OAuth consent screen) and fill in the app name and support email. Pick the audience:
   - **Internal**: for a Google Workspace organization. Only accounts in that organization can sign in, Google doesn't review the app, and sign-ins don't expire on a schedule. The Cloud project must belong to the Workspace organization.
   - **External**, publishing status **Testing**: for personal Gmail accounts. Under **Audience > Test users**, add the Google account of everyone who will sign in (up to 100). During sign-in Google shows a "Google hasn't verified this app" screen; test users click **Continue**. No app review is needed, but **Google expires Testing-mode sign-ins after 7 days**, so each person re-runs `crawlmark-cli auth login` about once a week. When a sign-in expires, tools return an error saying so. For unattended jobs on a personal account, use `service_account` mode instead.
2. **Create the OAuth client.** In **Google Auth Platform > Clients**, create a client of type **Desktop app**. Copy its client ID and secret into `.env`:

   ```bash
   GOOGLE_AUTH_MODE=oauth
   GOOGLE_OAUTH_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=...
   ```

   Desktop clients accept any `http://127.0.0.1:<port>` redirect, so there's nothing else to register.
3. **Sign in** once per machine (after `npm run build`):

   ```bash
   npm run cli -- auth login        # or: crawlmark-cli auth login (after npm link)
   ```

   Your browser opens Google's consent page; if it doesn't, open the URL printed in the terminal. Leave every permission ticked. The command prints the signed-in email and the granted scopes.

#### 3. Service-account mode setup

1. In **IAM & Admin > Service accounts**, create a service account (no project roles needed). Under **Keys**, add a JSON key and save it as `secrets/google-service-account.json` (`secrets/` is gitignored). If key creation is blocked, your Workspace organization enforces the `iam.disableServiceAccountKeyCreation` policy; ask an admin to allow it for this project, or use option A.
2. Add the service account's email (`...@<project>.iam.gserviceaccount.com`):
   - in each **Search Console** property: **Settings > Users and permissions > Add user** (Restricted is enough)
   - in each **GA4** property: **Admin > Property access management > Add users**, role **Viewer**
3. In `.env`:

   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=./secrets/google-service-account.json
   # GOOGLE_AUTH_MODE=service_account   # optional: auto-detected from the line above
   ```

One service account covers every client; you just add it to each property, and discovery picks the property up (within a day, or at once with `list_clients` `refresh: true`). A `sc-domain:` domain property and a `https://` URL-prefix property are separate in Search Console, so add the account to the one you want used; discovery prefers the domain property when it sees both.

#### Check it works

```bash
npm run build
npm run cli -- auth status
```

It prints the mode (`auto → service_account` when auto-detected, or `auto → not configured` with exit code 0 when Google isn't set up), the account in use, and `Token check: OK` (OAuth) or `Key check: OK` (service account). If something is missing, it says what to set or run. A tool that returns a 403 for one client usually means that account or service account hasn't been added to that client's property.

#### CLI

`crawlmark-cli` (`dist/cli.js`, or `npm run cli -- <command>`) handles local admin tasks. Unlike the MCP server, it prints to stdout.

| Command | Does |
|---|---|
| `crawlmark-cli auth login` | OAuth loopback sign-in (`127.0.0.1`, random port, PKCE, state check, 5-minute timeout). Stores the token at `DATA_DIR/google-token.json` with mode `0600`. |
| `crawlmark-cli auth status` | Shows the active mode and account (OAuth email or service-account email), then checks the token or key against Google and lists the granted scopes. Exits non-zero with setup guidance if something is missing. |
| `crawlmark-cli auth logout` | Revokes the stored token with Google and deletes the file. If revoking fails it still deletes the file and warns. |
| `crawlmark-cli clients list [--refresh]` | Runs discovery (when Google is set up), adds any new domains to `clients.yaml`, then prints every client: domain, name, sources, GSC property, GA4 ID, what's missing, aliases and alternate properties, followed by what was added, ignored domains, and discovery warnings and notes. `--refresh` skips the one-day discovery cache. Exits 0 when Google isn't set up; non-zero only if a configured Google fails entirely. |
| `crawlmark-cli clients add <domain>... [--name <name>]` | Adds clients to `clients.yaml`, keyed by their normalised domains. No Google needed. If a domain is there with `ignore: true`, removes the `ignore`. `--name` only with one domain. |
| `crawlmark-cli clients remove <domain>... [--ignore]` | Deletes the clients' entries. If Google still lists the domain, discovery adds it back on the next run; `--ignore` instead keeps the entry with `ignore: true`, which hides it and stops discovery re-adding it. |
| `crawlmark-cli clients set <client> [--area <location>] [--niche <text>] [--name <name>] [--brand-terms "a,b"]` | Sets a client's area (DataForSEO location name, e.g. `--area "Austin,Texas,United States"`), niche, display name and brand terms (replaces the list). `--niche ""` clears one. |
| `crawlmark-cli competitors list <client>` | Lists the client's competitors with source, date added and note, plus its area and niche. |
| `crawlmark-cli competitors add <client> <domain>... [--note <text>]` | Adds competitors (URLs and `www.` forms become bare domains) and prints what was skipped and why. Exits 1 only if nothing valid was given. |
| `crawlmark-cli competitors remove <client> <domain>...` | Removes competitors. Exits 1 if none were listed. |
| `crawlmark-cli keywords list\|add\|remove <client> [keyword...] [--note <text>]` | The same for tracked keywords. Quote keywords with spaces: `keywords add example.com "emergency plumber"`. |
| `crawlmark-cli brand list\|add\|remove <client> [term...]` | Lists, adds or removes a client's brand terms (with source and date). Quote terms with spaces. |
| `crawlmark-cli brand suggest <client>\|--all [--apply] [--min-confidence high\|medium] [--paid] [--paid-sparse] [--no-paid]` | Infers brand terms and prints a table of candidates (term, confidence, score, source, signals, `AUTO`: `yes` or why it needs review, saved) and any `other-client-brand` exclusions. **`--all` makes no paid calls** unless you pass `--paid` (DataForSEO, about $0.02 a client, for clients that still have no candidates and no Search Console property, including when Google isn't set up) or `--paid-sparse` (also clients whose Search Console returned under 20 rows). For a single client, DataForSEO is used when it has no Search Console property, also for sparse data with `--paid-sparse`, never with `--no-paid`. A Search Console error is reported and never retried on the paid source. `--apply` saves only candidates at or above `--min-confidence` (default `high`) that match the distinctive part of the client's name (see strict auto-add below). |

The server reads the token on demand and picks up a new login without a restart. Refreshed access tokens are written back to the same file. Never commit or share `google-token.json`; it's gitignored.

### DataForSEO

1. Create an account and copy the API login and password from the dashboard into `.env`.
2. Leave `DATAFORSEO_BASE_URL` on the **sandbox** while building. It's free and returns fake data in the real response shape.
3. Switch to `https://api.dataforseo.com/v3` when you're ready, and fund the account.

### PageSpeed Insights (optional)

Create an API key in Google Cloud with the PageSpeed Insights API enabled and set `PSI_API_KEY`. Without it, Lighthouse still runs locally; you just don't get real-user field data.

### Clients

The client list is `config/clients.yaml` (path set by `CLIENTS_FILE`, gitignored). You don't have to write it:

- **From Google.** When Google is set up, crawlmark lists every Search Console site and GA4 property (with its web streams) the account can access, joins them by domain, and adds any new domain to `clients.yaml` with its name, `gscProperty` and `ga4PropertyId`. This happens on first use and then at most once a day (cached in SQLite); `list_clients` with `refresh: true` or `clients list --refresh` re-lists now. The file is created if it's missing.
- **By hand.** `npm run cli -- clients add example.com` (or edit the file). Only `domain` is required. A hand-added client works for DataForSEO, Lighthouse and axe with no Google setup at all.

**crawlmark never changes or removes what you write.** Discovery only appends domains that have no entry and fills a missing `gscProperty` or `ga4PropertyId`. It keeps your comments, order and values (indentation is normalised), writes atomically (following a symlinked file and keeping its permissions), and leaves entries for domains it no longer sees (`list_clients` notes them). If you pin a property that differs from what discovery would pick, your value wins and `list_clients` notes the difference. To drop a client for good, set `ignore: true` on its entry (or `clients remove <domain> --ignore`): it's hidden and never re-added. Deleting an entry outright only lasts until the next discovery if Google still lists the domain.

Every field is in `config/clients.example.yaml`. The file is re-read on every call, so edits apply without a restart.

**Competitors, tracked keywords, area and niche**

Add them whenever you like, with the tools above, the CLI (`crawlmark-cli competitors add example.com rival.example`) or by editing the file. Each competitor is a domain string or an object with a note, source and date; tracked keywords work the same way. The tools and CLI write the object form:

```yaml
    competitors:
      - rival.example                 # a plain string is fine
      - domain: other.example
        note: Same neighbourhood
        source: suggested             # manual (default) or suggested
        addedAt: 2026-10-12
    trackedKeywords:
      - emergency plumber
    area: Austin,Texas,United States  # DataForSEO location name, for local searches
    niche: emergency plumber
    brandTerms:                       # see Branded queries; usually filled automatically
      - example plumbing
      - term: ex plumbing
        source: auto-gsc              # manual, suggested, auto-gsc or auto-dataforseo
        addedAt: 2026-10-12
```

Competitors are stored as bare domains (`https://www.rival.example/page` becomes `rival.example`), keywords lowercase with single spaces, and duplicates are skipped. The client's own domain can't be a competitor.

#### Competitor suggestions

`suggest_competitors` (or the `find-competitors` prompt) proposes competitors from two sources:

1. **Organic overlap:** DataForSEO's list of domains ranking for the same keywords as the client.
2. **Local search presence:** live Google results for up to 5 seed keywords, searched in the client's `area` (or its `locationCode` market when no area is set). Seeds are, in order: `seeds` the AI passes (3-5 non-branded service keywords, confirmed with you), the `niche`, tracked keywords, then the top non-branded Search Console queries of the last 28 days (free; needs Google). When seeds or a niche are given, a Search Console query is used only if it shares a meaningful word with them. Only if none of those exist does it fall back to the client's DataForSEO ranked keywords.

**Pass service-keyword `seeds`.** A small site's own ranked keywords are mostly branded, so organic overlap returns companies that share its name. `find-competitors` has the AI propose 3-5 non-branded service keywords, confirm them with you, and pass them as `seeds`. Candidates whose domain starts or ends with the client's brand initialism (`abbuild.com`, `buildingwithab.com`) or contains a longer brand name are excluded with reason `brand-lookalike` (still listed under `excluded`); common-word brand names are never used for this.

**Set `area` and `niche` first.** Without them, seeds fall back to Search Console queries and the search is national, which gives weaker candidates. The `find-competitors` prompt makes the AI set or confirm both before suggesting; if they're unset it proposes values inferred from the client's homepage title and description (from a web fetch of the homepage, or by asking you). Seeds that look like the client's own brand (including initialisms and suffix variants such as "ab building inc") are dropped, and sample URLs have tracking parameters stripped.

It drops the client's own site, current competitors, `ignore: true` domains, and a built-in denylist of platforms that rank for everything (social networks, review, listing and contractor-directory sites, business-data directories, home-improvement lead marketplaces, marketplaces, encyclopedias, video sites, big-box retailers, search engines, `.gov`/`.edu` and similar). Add your own rules in `config/competitor-denylist.txt` (optional, gitignored; one per line) or `COMPETITOR_DENYLIST` (comma-separated): `directory.example` (that domain and its subdomains), `*.example-tld`, `portal.*` (any short suffix), and `!domain` to exempt one.

Each candidate has a score from 0 to 100: half from keyword overlap (relative to the strongest candidate) and half from local search presence (the average over seeds of `(21 − position) ÷ 20`, so position 1 counts 1.0 and position 20 counts 0.05). When a local `area` is in effect and the SERPs returned candidates, the weights are 30% overlap and 70% local presence, and candidates with local search evidence are listed before overlap-only ones, which keep their score but carry `weakEvidence: true` (overlap for a small site is mostly brand noise). If one source contributes nothing (it failed, returned no rows, or all its domains were filtered out), the other counts fully. The response includes the evidence (shared keywords, average position, appearances, positions per seed, a sample URL), excluded domains with reasons, `costUsd` and `fromCache`. A run costs one overlap call plus one SERP call per seed (cached 30 days and 1 day). It never saves anything; add the ones you want with `add_competitors` (`source: "suggested"`).

**How matching works**

- Every site is reduced to a host: lowercased, with the scheme, path, port and a leading `www.` dropped. `sc-domain:example.com`, `https://www.example.com/` and an `https://example.com` GA4 stream all become `example.com`. Internationalised domains are compared in punycode, so `bücher.example` and `xn--bcher-kva.example` match. Subdomains stay separate (`shop.example.com` is its own client).
- Search Console: if a host has both a domain property (`sc-domain:`) and URL-prefix properties, the domain property is used and the others are listed as `alternates`. Among URL-prefix properties, a root-path property (`https://example.com/`) wins over a path-scoped one (`https://example.com/blog/`), then `https` over `http`, then the shorter URL. Sites where the account is an unverified user are skipped.
- GA4: a property maps to the host of each of its web streams. If several properties share a host, the lowest property ID is used and the rest are listed as `alternates`. Properties with no web stream (app-only) are skipped with a note.
- A client can have only one side, or neither. Tools that need a missing one return an error such as "No GA4 property found for example.com"; reports mark just that section as failed.
- Entries are keyed by domain. Tools accept the domain, any URL or `www.` form of it, or the entry's key if you used a different one (e.g. `example-co:`). A key that names a different client's domain is a config error, since it would hide that client. Spend recorded under such a key counts toward the client's budget.

**Defaults** for fields an entry leaves out:

| Field | Default |
|---|---|
| `name` | GA4 property name, else the domain |
| `locationCode`, `languageCode` | `DEFAULT_LOCATION_CODE` (2840, United States) and `DEFAULT_LANGUAGE_CODE` (`en`) |
| `keyPages` | The homepage: the GA4 stream URL, else `https://<domain>/` |
| `competitors`, `trackedKeywords` | Empty |
| `area`, `niche` | Unset: suggestions search the `locationCode` market and use tracked keywords and Search Console queries as seeds, falling back to the client's DataForSEO ranked keywords (paid) when there are none |
| `monthlyBudgetUsd` | `DEFAULT_CLIENT_MONTHLY_BUDGET_USD` (5) |

Arrays you set (`competitors`, `trackedKeywords`, `keyPages`) replace the defaults rather than append.

**When discovery doesn't run or fails**

- Google not set up: discovery is skipped, `list_clients` says so in one `discovery.info` line, and the clients come from `clients.yaml` only.
- Google set up but failing (missing key file, expired sign-in): `clients.yaml` entries are still available, and `list_clients` reports why in `discovery.error`.
- Google Analytics Admin API disabled: Search Console clients are still listed (and added), with a warning to enable the "Google Analytics Admin API".
- A new property doesn't show up: discovery is cached for a day. Use `list_clients` with `refresh: true` or `crawlmark-cli clients list --refresh`.

## Connect it

**Claude Code**

```bash
claude mcp add crawlmark -- node --disable-warning=ExperimentalWarning /absolute/path/to/crawlmark-mcp/dist/index.js
```

The `--disable-warning=ExperimentalWarning` flag hides Node's `node:sqlite` warning. The `crawlmark-mcp` bin entry has the same flag in its shebang. Config paths resolve from the project root, so the working directory doesn't matter.

**Claude Desktop / other clients** (`mcpServers` config)

Secrets and paths come from the project's `.env`, so no `env` block is needed (you can still set one to override).

```json
{
  "mcpServers": {
    "crawlmark": {
      "command": "node",
      "args": ["--disable-warning=ExperimentalWarning", "/absolute/path/to/crawlmark-mcp/dist/index.js"]
    }
  }
}
```

**Debug with the MCP Inspector**

```bash
npm run inspect
```

## Cost controls

- Every paid call checks the client's `monthlyBudgetUsd` (default `DEFAULT_CLIENT_MONTHLY_BUDGET_USD`) and the global `GLOBAL_MONTHLY_BUDGET_USD` before running, and refuses with a clear error once a cap would be crossed.
- The actual cost DataForSEO reports is written to a ledger; `spend_summary` reads it.
- Responses are cached in `data/crawlmark.db` (volume 30 days, ranked keywords and backlinks 7 days, SERPs, Google data and client discovery 1 day), so re-running a report mostly costs nothing.
- `suggest_competitors` is the only paid competitor tool; managing competitors and keywords is free.
- `monthly_report` is free by default. Live rank checks (`liveRanks: true`), full crawls and backlinks are opt-in.
- The pre-flight estimates in `src/providers/dataforseo.ts` are conservative placeholders. Tune them against DataForSEO's pricing page.

#### Branded queries

`monthly_report` splits Search Console queries into branded (people looking for the client by name) and non-branded (people looking for what the client sells). Non-branded is the number that shows SEO growth; branded mostly tracks existing awareness. The report gives clicks, impressions, CTR and average position for each group (position weighted by impressions) for the report month and the one before, with the change, and marks every query row, mover and tracked keyword with `branded: true | false`.

A query counts as branded when, ignoring case, spacing, punctuation and accents, it:

- contains one of the client's `brandTerms` (4+ characters anywhere in the query; shorter terms such as initials only as a whole word);
- matches the domain stem, the client name or the GA4 property name (`exampleplumbing.com` matches "example plumbing", "Example-Plumbing hours" and "exampleplumbing");
- uses spaced initials or a generic suffix ("a b building", "ab building inc"), or the short brand token alone ("ab construction").

`brandTerms` add to this built-in matching; they never replace it, and each client's terms apply only to that client. You don't have to type them: crawlmark [infers them](#automatic-brand-terms) from how people actually search. To set them by hand, use `add_brand_terms` / `remove_brand_terms`, `crawlmark-cli brand add|remove <client> <term>...`, `set_client_profile` (`brandTerms: ["example plumbing", "ex plumbing"]` replaces the list, `[]` clears it; terms you keep keep their source and date), or edit `clients.yaml`. Each entry is a plain string or `{ term, source, addedAt }`, where `source` is `manual`, `suggested`, `auto-gsc` or `auto-dataforseo`. Add misspellings, old names and product names the client is known by. Terms of 4+ characters match across word boundaries (a squashed "ex co" would match inside longer words), so prefer distinctive terms.

#### Automatic brand terms

A domain often isn't how people search for a business: `bellafornino.example` gets searched as "bella forno pizza" and "bella forno menu", which the domain-stem matching misses. `suggest_brand_terms` finds those names in the client's own queries:

1. **Data.** Search Console query rows for the last 90 days (up to 1,000; free). Only when Search Console isn't usable at all (Google isn't set up, or the client has no property) does it use DataForSEO ranked keywords for the client's own domain (top 100, paid, about $0.02, cached 7 days, through the budget cap). If Search Console returns fewer than 20 rows, the paid fallback runs only with `allowPaid: true` (the `review-brand-terms` prompt asks you first); `allowPaid: false` turns it off. A Search Console error is reported and never falls back to the paid source. Each candidate says which `source` it came from.
2. **Candidates.** 1-3 word phrases from queries the client's current matching doesn't already cover. Generic words never start or end a candidate: stop words, intent words ("near", "best", "how"), navigational modifiers ("menu", "hours", "reviews"), the niche, the area, US state names, and trade words seen in the queries (words used in "near me"/"best" searches that don't name the client, or words whose queries mostly rank below position 3); niche, area and trade words also match their plurals and endings ("plumber"/"plumbing"). So "pizza near me" never becomes a brand term, however well the site does for it. A phrase made only of generic words is dropped unless it strongly resembles the distinctive part of a name ("la forna" for `lafornina.example`, even though "forna" also shows up in "forna near me").
3. **Signals.** (a) Name similarity to the *distinctive part* of the domain stem, client name or GA4 name: the name minus trade words, places and company suffixes (co, inc, llc, company, corp, ltd, group, services, pros, team, solutions). For a client with no `area`, a part of the name next to a trade word counts as a probable place, so `austinplumbing.example` and `austinplumbingco.example` have no distinctive part and "austin plumber" never matches them. Similarity is edit-distance based ("la forna" scores 0.86 against "lafornina"); a phrase that is only the end of the name, like "building systems" in "AB Building Systems", counts as weak. (b) Navigational behaviour, Search Console only: the phrase's queries average position 2 or better with CTR at least 1.5x the [CTR curve](#opportunities). (c) Concentration: the phrase recurs across several queries that carry a real share of the site's clicks (or impressions, or estimated traffic), on page one.
4. **Confidence.** `high` needs strong name similarity plus navigational behaviour or concentration, at an average position of 3 or better; DataForSEO-only candidates (no CTR) are `high` only with very strong similarity. Behaviour without name similarity is at most `medium`. A similar name the site ranks poorly for is usually another business, so it stays `low`. The response's `method` string has every threshold.
5. **Other clients.** A phrase that matches any other client's domain, name or brand terms is never proposed (it's listed under `excluded` with reason `other-client-brand`), so an agency site whose queries mention its clients' names doesn't adopt them, and each client's terms stay its own. Fragments and misspellings count too: a phrase is excluded when every distinctive word is within one edit of a word of the other client's names or terms ("bela", "fornos") or a fuzzy substring of them ("belaforno"), unless the phrase is clearly closer to this client's own name.

**Strict auto-add.** A candidate is only ever saved automatically (by discovery, `apply: true` or `--apply`) when one of its words (4+ letters, not the niche, area, a place, a company suffix or a filler word) matches the distinctive part of the client's name (`autoQualified: true`). Everything else, including a strong-looking match against a generic name, comes back as a suggestion with a `reviewReason`: `needs-review: generic-name-match`, `needs-review: no-distinctive-name` (a pure exact-match domain, where nothing is ever auto-added), or `needs-review: confidence`. Candidates that fail the check are capped at `medium`.

The response also lists the top 20 non-branded queries no candidate covers, so the AI can spot misspellings or old names. With `apply: true` it saves the auto-qualified candidates at or above `minConfidence` (default `high`) with `source: "auto-gsc"` or `"auto-dataforseo"`; otherwise nothing is saved, and the AI should confirm medium and low candidates with you before calling `add_brand_terms` with `source: "suggested"`. The `review-brand-terms` prompt walks through that for one client or all of them, and `crawlmark-cli brand suggest --all` does it in bulk.

**Automatically for new clients.** When discovery adds a new client that has a Search Console property, crawlmark runs the free Search Console inference for it and saves the `high` candidates that pass the strict auto-add check (`source: auto-gsc`). It never calls DataForSEO here, and a failure never affects the sync; `list_clients` notes what was added. Remove any you disagree with with `remove_brand_terms` or `crawlmark-cli brand remove`.

The split sums query-level rows (up to 5,000 per month), which leave out anonymized queries, so branded + non-branded will be lower than the site totals in the same report; the report says so in `search.note`. Matching is heuristic: a client whose name is a common word can have a few non-brand queries marked branded, so spot-check `topQueries` and add terms where it misses.

#### Opportunities

Free Search Console tools that find where more clicks are likely. Each takes `client`, optional `startDate`/`endDate` (both or neither; default is the last 28 days ending 3 days ago, since Search Console lags 2-3 days), `includeBranded` (default false: branded queries are excluded), `limit` (default 25) and the thresholds below. Each returns the window used, `total` found, and a `method` string describing the thresholds. Rows are sorted by estimated extra clicks (or impressions or clicks lost where there is no estimate), then by name.

| Tool | Finds | Defaults |
|---|---|---|
| `striking_distance` | Queries at positions 5-20: query, top page, position, impressions, clicks, CTR, estimated extra clicks if they reached position 3 | `minPosition` 5, `maxPosition` 20, `minImpressions` 100 |
| `quick_wins` | Pages at positions 11-20 with their top 3 queries | `minPosition` 11, `maxPosition` 20, `minImpressions` 100 |
| `low_ctr` | Queries at positions 1-5 with CTR under 60% of expected: title and meta rewrite candidates | `ctrRatio` 0.6, `minImpressions` 100 |
| `cannibalization` | Queries where 2+ pages each hold at least 10% of the impressions | `minShare` 0.1, `minImpressions` 100 |
| `declining_pages` | Pages whose clicks fell versus the previous equal-length period, with the queries that lost the most | `minDropPct` 30, `minClickLoss` 10 |

Estimates use the expected-CTR-by-position curve in `src/analysis/ctr-curve.ts`, an editable industry-average approximation: treat the numbers as a ranking signal, not a forecast. Positions are impression-weighted averages, and page URLs are normalised (fragment and trailing slash ignored). The first four tools make one Search Console call with `query` + `page` dimensions (up to 25,000 rows); `declining_pages` makes two (current and previous window), or four with `includeBranded`. Query-level rows leave out anonymized queries. Small sites often return nothing at the default thresholds; lower `minImpressions` to see more.

## Layout

```
src/
  index.ts              server entry (stdio)
  cli.ts                crawlmark-cli: auth, clients list | add | remove | set, competitors, keywords, brand
  config.ts             env loading and validation (paths resolved from project root), client defaults
  clients.ts            resolveClient()/loadRegistry(): discovery, clients.yaml sync (atomic, serialised), add/remove,
                        competitor/keyword edits, set_client_profile
  competitors.ts        suggest_competitors: gathers overlap + seed SERPs, loads the denylist
  brand-inference.ts    fetches one client's query rows (GSC, DataForSEO fallback) and infers brand-term candidates
  brand-terms.ts        suggest_brand_terms: inference plus optional apply
  lib/
    store.ts            SQLite (cache, spend ledger, saved audits)
    audits.ts           save/list/get saved audits, sortable audit IDs
    cache.ts            TTL cache wrapper
    budget.ts           per-client / global spend caps
    dates.ts            month ranges and comparisons
    paths.ts            project-root path resolution (pure)
    env.ts              empty env values count as unset (pure)
    clients.ts          host normaliser, GSC/GA4 join, clients.yaml schema + merge, sync plan, resolution (pure)
    clients-file.ts     comment-preserving clients.yaml edits via the yaml Document API (pure)
    client-lists.ts     competitor/keyword/brand-term add and remove planning with skip reasons (pure)
    brand.ts            isBranded(): branded-query classifier and the name/domain normalisers (pure)
    competitor-denylist.ts  built-in platform denylist and rule matching (pure)
    spend.ts            spend-ledger key and alias merging (pure)
    concurrency.ts      mapLimit: bounded-concurrency map (pure)
    google-auth.ts      Google auth mode selection, consent URL, callback check, token merge, error messages (pure)
    url-guard.ts        http/https only; refuses loopback/private/link-local IP literals (no DNS resolution until Phase 6d) unless ALLOW_PRIVATE_URLS=true (pure)
    token-store.ts      OAuth token file: atomic 0600 write, read, delete
  providers/            one file per data source
    gsc.ts  ga4.ts  dataforseo.ts  lighthouse.ts  axe.ts  browser.ts
    render.ts           fetchRaw (Googlebot UA, 20s, 5 MB cap, guarded redirects), fetchRendered (headless Chrome), checkRender; both cached 1 day
    discovery.ts        lists Search Console sites and GA4 properties + web streams (cached 1 day)
    google.ts           googleAuth(): OAuth client or service account, by GOOGLE_AUTH_MODE or auto-detected; googleAuthStatus()
    google-login.ts     OAuth loopback login flow
    google-oauth-client.ts  OAuth2Client that maps invalid_grant; token-file client loader (refresh persistence)
    dataforseo-shape.ts pure mappers: raw DataForSEO results -> typed compact objects
  analysis/
    competitor-suggestions.ts  seed picking, merge, filter and score for suggest_competitors (pure)
    branded.ts          branded vs non-branded totals from query rows (pure)
    brand-terms.ts      brand-term candidates from query rows: n-grams, signals, confidence, other-client exclusion (pure)
    ctr-curve.ts        expected CTR by position (editable constant)
    opportunities.ts    striking distance, quick wins, low CTR, cannibalization, declining pages (pure)
    render-extract.ts   extractSeo(): SEO elements from an HTML string with cheerio (pure)
    render.ts           compareRender(): raw vs rendered flags (pure)
    findings.ts         normalised findings from an audit result, stable IDs, severity tables, checked pairs (pure)
    diff.ts             diffAudits: new / resolved / persistent / unverified, score changes (pure)
  prompts/
    index.ts            MCP prompt registrations
    templates/          prompt text (markdown), copied to dist/ at build
  reports/
    monthly.ts          monthly_report composer
    opportunities.ts    fetch + wrap for the opportunity tools; monthly `opportunities` section
    audit.ts            run_audit composer
    section.ts          per-section error isolation
  tools/
    reports.ts          report tool registrations
    raw.ts              lower-level tool registrations
    opportunities.ts    striking_distance, quick_wins, low_ctr, cannibalization, declining_pages
    competitors.ts      competitor, keyword, profile and suggestion tool registrations
    brand.ts            add_brand_terms, remove_brand_terms, suggest_brand_terms
scripts/
  record-fixtures.ts    records raw DataForSEO sandbox responses (refuses non-sandbox); scrub before committing
test/
  *.test.ts             vitest unit tests (pure functions)
  fixtures/dataforseo/  API payloads used by the mapping tests (see its README)
  fixtures/google/      Search Console and GA4 Admin payloads for the discovery tests
```

## Adding a source

1. Add `src/providers/<name>.ts`. Wrap calls in `cached()`, and for paid APIs call `assertBudget()` before and `recordSpend()` after.
2. Register any raw tools in `src/tools/raw.ts`.
3. Pull it into a report composer in `src/reports/` inside a `section()` so a failure doesn't break the report.

Candidates: Bing Webmaster Tools, Google Business Profile, a rank tracker, or the CMS (to check for drafts, missing alt text, etc).

## Status

Scaffold. It typechecks and the server starts and serves all tools.

- **Tested live:** Google in `service_account` mode: discovery lists real Search Console sites and GA4 properties and writes them to `clients.yaml`, and `gsc_query` and `ga4_report` return real data for discovered clients. A hand-added client with Google switched off works with the DataForSEO sandbox, and `run_audit` on it ran Lighthouse and axe on one page in local Chrome, with only the Google sections failing.
- **Not yet tested live:**
  - DataForSEO calls against the paid API. The ranked keywords, competitors, backlinks, instant page and SERP mappers are tested only against scrubbed sandbox recordings (see `test/fixtures/dataforseo/README.md`).
  - Lighthouse and axe beyond a single simple page, and PageSpeed Insights field data.
  - Google OAuth end to end against a real account. The login flow is unit tested only (Phase 7).
