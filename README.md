# crawlmark: an MCP server for SEO audits and client reports

crawlmark gives Claude (or any MCP client) the data an SEO consultant or agency needs for monthly client work, and turns it into report-shaped tools. Ask for a monthly report, an audit with what changed since last time, or a list of quick wins, and the agent writes it from real data.

It combines:

| Source | What it provides | Cost |
|---|---|---|
| Google Search Console | Clicks, impressions, CTR, position, URL inspection, sitemaps | Free |
| GA4 Data API | Organic sessions, engagement, key events, landing pages | Free |
| Google Tag Manager | Live container contents for tag audits | Free |
| DataForSEO | Keyword volume, live SERPs, ranked keywords, competitors, backlinks, site crawls | Pay per call |
| Lighthouse | Performance, SEO and best-practice scores, lab Core Web Vitals | Free (runs locally) |
| PageSpeed Insights | Real-user field data (CrUX) | Free with an API key (optional) |
| axe-core | Automated WCAG A/AA/AAA checks | Free (runs locally) |

Every source is optional. Your client list fills itself from the Search Console sites and GA4 properties your Google account can see, and you can add clients by hand, so DataForSEO, Lighthouse and axe work without Google. Responses are cached in SQLite, and paid calls stop at a per-client and a global monthly spend cap.

Install crawlmark
-----------------

```bash
npx crawlmark-mcp@latest init
```

That one command sets up crawlmark and adds it to your AI apps: **Claude Code, Claude Desktop, Cursor and Codex**. It needs **Node 22.13 or later** (crawlmark uses the built-in `node:sqlite`). Other ways to install are below; whichever you pick, [set up your credentials](#set-up-credentials) next.

| System or use | Installation method |
|---|---|
| Claude Code, Claude Desktop, Cursor, Codex, or any MCP client | [npx and the setup wizard](#npx-and-the-setup-wizard) |
| Claude Desktop | [Claude Desktop bundle (MCPB)](#claude-desktop-bundle-mcpb) |
| Scheduled jobs, development, or before the first release | [From source](#from-source) |

> crawlmark is not on npm yet, and there's no published bundle. Until the first release, install [from source](#from-source).

### npx and the setup wizard

```bash
npx crawlmark-mcp@latest init
```

The wizard checks Node, asks for each credential and checks it live, and discovers your clients. Then it asks which AI apps to add crawlmark to, with the ones it found on your machine already ticked:

| App | How crawlmark is added |
|---|---|
| Claude Code | `claude mcp add` (user scope, so every project sees it) |
| Claude Desktop | An entry in `claude_desktop_config.json` |
| Cursor | An entry in `~/.cursor/mcp.json` (global, not per project) |
| Codex | `codex mcp add`, or an entry in `~/.codex/config.toml` when the `codex` command isn't installed |

Every change is shown before it's made, other servers are listed by name only, and each config file keeps a `.bak` copy. An app that already has a different crawlmark entry is only changed if you say yes. Your settings live in `~/.crawlmark`.

In a terminal you get arrow-key choices, masked secrets and a spinner for each live check. With piped input, `CI=true`, `TERM=dumb`, `NO_COLOR` or `--yes`, the same steps run as plain numbered prompts. `init` and `setup` are the same command.

`crawlmark-mcp` with no arguments is the MCP server, which is what clients launch. With a subcommand it runs the admin CLI instead, so `npx crawlmark-mcp setup status` and `npx crawlmark-mcp clients list` work too.

Installing the package downloads a Chrome build for Lighthouse and axe (about 570 MB in `~/.cache/puppeteer`). To skip it, set `PUPPETEER_SKIP_DOWNLOAD=true` before installing and either install Google Chrome or point `CHROME_PATH` at a Chrome or Chromium binary.

### Claude Desktop bundle (MCPB)

Download `crawlmark.mcpb` from the release page and double-click it, or drag it onto Claude Desktop (**Settings > Extensions**). Claude Desktop shows a form. Every field is optional, so fill in only what you use:

| Field | What it is |
|---|---|
| DataForSEO API login / password | From [DataForSEO API access](https://app.dataforseo.com/api-access). The password is stored in your OS keychain. Leave empty to skip the paid tools |
| Use the live DataForSEO API | Off (default) uses the free sandbox with sample data. On uses real data, billed to your balance |
| Google service-account key file | The JSON key from [option C](#option-c-service-account) |
| Google OAuth client ID / secret | Only for signing in with your own Google account ([options A and B](#options-a-and-b-oauth)). After installing, sign in once from a terminal: `CRAWLMARK_HOME=<data folder> npx crawlmark-mcp setup --step google` |
| PageSpeed Insights API key | Adds real-user field data |
| Chrome executable | Optional path to Chrome or Chromium |
| crawlmark data folder | Where the client list, cache and spend log live. Default `~/.crawlmark` |

The bundle doesn't include Chrome. Audits use the Chrome path from the form, or the Chrome installed on your machine. Then ask Claude to run `setup_status`, or use the `getting-started` prompt, to see what's working.

### From source

```bash
git clone https://github.com/idrewlong/crawlmark-mcp.git
cd crawlmark-mcp
npm install            # also downloads a Chrome build for Lighthouse and axe
npm run build
npm run cli -- setup
```

A source checkout keeps its settings in the project folder instead of `~/.crawlmark`. See [Configuration](#configuration).

Set up credentials
------------------

The setup wizard covers everything here. Each step shows its current status first and can be skipped, so it's safe to re-run, and anything you don't need can be left out.

| Command | Does |
|---|---|
| `crawlmark-cli init` (or `setup`) | The whole wizard |
| `crawlmark-cli setup --step <node\|dataforseo\|google\|psi\|discovery\|register>` | One step |
| `crawlmark-cli setup --dry-run` | Runs the free checks and shows what each step would do, without writing, signing in or registering anything |
| `crawlmark-cli setup --yes` | Accepts every default. Steps that need input (a password, a key file) are skipped |
| `crawlmark-cli setup status` | Each integration's state and the next step (`--json` for machine output) |

From a source checkout, run these as `npm run cli -- setup …` from the project folder. With npx, use `npx crawlmark-mcp setup …`. The commands that `setup status` and the wizard print already use the right form for your install.

`setup status` prints one line per integration, with the next step under anything that needs attention:

```
crawlmark status   home ~/.crawlmark (installed package)

✔ DataForSEO          Credentials work (sandbox mode, balance $1.00). Sandbox
                      returns sample data at no cost.
✖ Google              Google rejected the key: invalid_grant
                      → npx crawlmark-mcp setup --step google
○ PageSpeed Insights  Optional. Without a key, Lighthouse still runs locally but
                      without real-user (CrUX) field data.
                      → npx crawlmark-mcp setup --step psi
…

5 working · 0 needs attention · 2 errors · 2 not set up
```

Secrets are typed into the terminal without echo and saved to `.env` with mode `0600`. Never paste them into a chat.

### DataForSEO

DataForSEO is optional and paid per call. It powers keyword volume, live SERPs, ranked keywords, competitor suggestions, backlinks, crawls and the on-page audit check.

1. Create an account at [dataforseo.com](https://dataforseo.com/) and open [API access](https://app.dataforseo.com/api-access). Copy the **API login** and **API password**. The API password is generated there and is not your account password.
2. Run `crawlmark-cli setup --step dataforseo`. It checks the credentials with DataForSEO's free account call and shows your balance.
3. Start with the **sandbox** (the default). It's free and returns sample data in the real response shape. Switch to live when you're ready and the account is funded.

By hand, set `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`, and set `DATAFORSEO_BASE_URL=https://api.dataforseo.com/v3` (or `DATAFORSEO_LIVE=true`) for live data.

### Google (Search Console, GA4, Tag Manager)

Google is optional. Without it, the Search Console, GA4 and Tag Manager tools say "Google isn't set up", reports skip those sections, and everything else works. crawlmark only requests read-only access.

**Choose a setup:**

| Option | You need | Pros | Cons |
|---|---|---|---|
| **A. OAuth, Google Workspace** | A Workspace (business) account | Sign in once and see every property you can already open. Sign-ins don't expire | Requires Workspace |
| **B. OAuth, personal Gmail** | Any Google account | Same access as A, no Workspace needed | Sign-in expires every 7 days while the app is in Testing. Google shows an "unverified app" screen |
| **C. Service account** | Any Google account that can create a Cloud project | Never expires, no sign-in, works for scheduled jobs | You add the service account's email to every client's property |

With Workspace, use A. Without it, use C for daily work and scheduled jobs, or B if you'd rather not share each property with a service account. You can set up more than one and switch with `GOOGLE_AUTH_MODE`.

> Both modes are tested against live Google data. The service account suits scheduled jobs; OAuth sees everything your own account can open.

#### Google Cloud project

In the [Google Cloud console](https://console.cloud.google.com/), create or pick a project. Under **APIs & Services > Library**, enable:

- **Google Search Console API**
- **Google Analytics Data API**
- **Google Analytics Admin API** (lists your GA4 properties so clients can be discovered)
- **Tag Manager API** (only for `gtm_audit`)
- **PageSpeed Insights API** (only for a PageSpeed key)

#### Option C: service account

1. In **IAM & Admin > Service accounts**, create a service account (no project roles needed). Under **Keys**, add a JSON key and download it.
2. Run `crawlmark-cli setup --step google`, pick C and give it the key file. The wizard checks the key and copies it into `secrets/` with mode `0600`.
3. Add the service account's email (`…@<project>.iam.gserviceaccount.com`) to each client's properties:
   - **Search Console:** **Settings > Users and permissions > Add user** (Restricted is enough)
   - **GA4:** **Admin > Property access management > Add users**, role **Viewer**
   - **Tag Manager** (optional): **Admin > User Management**, **Read** access. Granting it at the account level covers every container

One service account covers every client. New properties show up within a day, or at once with `list_clients` and `refresh: true`.

By hand, set `GOOGLE_APPLICATION_CREDENTIALS=./secrets/google-service-account.json`.

If key creation is blocked, your Workspace organization enforces `iam.disableServiceAccountKeyCreation`. Ask an admin to allow it for this project, or use option A.

#### Options A and B: OAuth

1. **Consent screen.** Open **Google Auth Platform** (APIs & Services > OAuth consent screen) and fill in the app name and support email. Pick the audience:
   - **Internal** (option A): only accounts in your Workspace organization can sign in, and sign-ins don't expire.
   - **External**, status **Testing** (option B): under **Audience > Test users**, add the Google account of everyone who will sign in. Google shows a "Google hasn't verified this app" screen; click **Continue**. Testing-mode sign-ins expire after 7 days, so re-run `crawlmark-cli auth login` about once a week.
2. **OAuth client.** In **Google Auth Platform > Clients**, create a client of type **Desktop app**.
3. **Sign in.** Run `crawlmark-cli setup --step google`, pick A or B, and enter the client ID and secret. The wizard saves them and opens Google's consent page. Leave every permission ticked.

By hand, set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, then run `crawlmark-cli auth login`.

#### Check it works

```bash
crawlmark-cli auth status
```

It prints the mode, the account in use and `Key check: OK` or `Token check: OK`. If something is missing, it says what to set or run. A 403 for one client usually means that account hasn't been added to that client's property.

### PageSpeed Insights (optional)

Create an API key in Google Cloud with the PageSpeed Insights API enabled, then run `crawlmark-cli setup --step psi` (or set `PSI_API_KEY`). Without it, Lighthouse still runs locally; you just don't get real-user field data.

Configure your MCP client
-------------------------

`crawlmark-cli setup --step register` does this for you. To do it by hand:

**Claude Code** (from npm):

```bash
claude mcp add crawlmark -s user -- npx -y crawlmark-mcp
```

**Claude Code** (from source):

```bash
claude mcp add crawlmark -s user -- node --disable-warning=ExperimentalWarning /absolute/path/to/crawlmark-mcp/dist/index.js
```

**Claude Desktop, Cursor and other clients** (`mcpServers` config; Cursor's global file is `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "crawlmark": {
      "command": "npx",
      "args": ["-y", "crawlmark-mcp"]
    }
  }
}
```

**Codex** (`~/.codex/config.toml`, or run `codex mcp add crawlmark -- npx -y crawlmark-mcp`):

```toml
[mcp_servers.crawlmark]
command = "npx"
args = ["-y", "crawlmark-mcp"]
```

For a source checkout, use `"command": "node"` and `"args": ["--disable-warning=ExperimentalWarning", "/absolute/path/to/crawlmark-mcp/dist/index.js"]`. Claude Desktop, Cursor and Codex may not load your shell's `PATH`, so if one can't find `node` or `npx`, use the absolute path (`which node`). Credentials come from `.env` in the config home, so no `env` block is needed unless your settings live somewhere other than the default; then add `"env": { "CRAWLMARK_HOME": "/path/to/home" }`.

Once connected, run the **`getting-started`** prompt. It checks what's set up, explains what crawlmark can do with it, and offers a first report for your busiest client.

Tools
-----

Tools that take a `client` accept its domain (`example.com`), any URL or `www.` form of it, or its key in `clients.yaml`. Report tools return structured JSON; the agent writes the prose, so tone and formatting live in your prompts.

### Setup and clients

| Tool | Description |
|---|---|
| `setup_status` | Each integration's state (`working`, `configured`, `missing` or `error`) and the exact next step. Free |
| `list_clients` | Every client with its Search Console and GA4 properties, Tag Manager container and what's missing. `refresh: true` re-lists from Google |
| `set_client_profile` | Sets a client's area (for local searches), niche, display name and brand terms |

### Reports

| Tool | Description |
|---|---|
| `monthly_report` | Search Console and GA4 for the month vs the previous month and last year: top and moving queries and pages, landing pages, tracked keyword positions, top opportunities, the branded vs non-branded split, and what changed since the last audit. Free by default |
| `run_audit` | Lighthouse, axe, rendered-vs-raw HTML, index status, on-page checks and site hygiene for each key page, with optional full crawl and backlinks. Saved, so it can be compared later |
| `list_audits` | A client's saved audits, newest first |
| `get_audit` | One saved audit's full result and findings |
| `compare_audits` | What's new, resolved, still open or unverified between two audits, plus score changes |
| `crawl_status` | Progress of a full crawl started by `run_audit` |
| `crawl_issue_pages` | URLs failing one crawl check |

### Opportunities (free, Search Console only)

| Tool | Description |
|---|---|
| `striking_distance` | Queries at positions 5-20, with estimated extra clicks at position 3 |
| `quick_wins` | Pages at positions 11-20 with their top queries |
| `low_ctr` | Queries in the top 5 with unusually low CTR: title and meta rewrite candidates |
| `cannibalization` | Queries where several pages split the impressions |
| `declining_pages` | Pages losing clicks, with the queries that lost the most |

Branded queries are excluded by default. See [docs/audits.md](docs/audits.md#opportunities) for thresholds.

### Site checks

| Tool | Description |
|---|---|
| `site_hygiene` | robots.txt, sitemaps, structured data, hreflang and orphan pages. Free |
| `render_check` | Compares a page's raw HTML with what Chrome renders and flags SEO elements that only appear after JavaScript. Free |
| `gtm_audit` | Audits the live Tag Manager container: paused, unfired and legacy tags, duplicate GA4 tags, unused variables, custom HTML, consent gaps and unpublished changes. Free |
| `lighthouse` | Lighthouse scores and lab Core Web Vitals, plus field data with a PageSpeed key |
| `accessibility_check` | axe-core WCAG checks on one page |

### Competitors, keywords and brand terms

| Tool | Description |
|---|---|
| `list_competitors`, `add_competitors`, `remove_competitors` | A client's competitors. Free |
| `suggest_competitors` | **Paid.** Ranked competitor candidates from keyword overlap and local Google results, with evidence. Never saves; you pick which to add |
| `list_keywords`, `add_keywords`, `remove_keywords` | Tracked keywords; `monthly_report` reports their positions. Free |
| `add_brand_terms`, `remove_brand_terms` | Terms that mark a query as branded, per client. Free |
| `suggest_brand_terms` | Infers how people search for the client by name from its Search Console queries (free), or DataForSEO when it has no Search Console data (about $0.02) |

### Raw data

| Tool | Description |
|---|---|
| `gsc_query` | Search Console search analytics |
| `gsc_inspect_url` | Search Console URL inspection |
| `ga4_report` | GA4 Data API report |
| `keyword_volume` | **Paid.** Search volume for keywords |
| `serp_check` | **Paid.** Live Google results for a keyword |
| `ranked_keywords` | **Paid.** Keywords a domain ranks for |
| `competitor_domains` | **Paid.** Domains ranking for the same keywords |
| `backlinks_summary` | **Paid.** Backlink totals for a domain |
| `dataforseo_status` | Credentials check, sandbox or live mode, and balance. Free |

### Spend and housekeeping

| Tool | Description |
|---|---|
| `spend_summary` | Paid API spend this month, by client |
| `usage_summary` | Calls, errors and durations per tool |
| `purge_cache` | Drops expired cache entries and old usage rows |

Prompts
-------

| Prompt | Arguments | Does |
|---|---|---|
| `getting-started` | none | Checks setup, gives the command for anything missing, and offers a first report |
| `monthly-report-writeup` | `client`, `month` (optional, `YYYY-MM`) | Writes a client-facing monthly report: summary, what moved and why, branded vs non-branded, fixes since the last audit, top opportunities, next month's priorities |
| `audit-findings` | `client` | Uses a recent audit or runs one, compares it with the last, and writes findings by severity with a prioritized fix list |
| `opportunity-review` | `client` | Runs the five opportunity tools and writes a prioritized action list with estimated click upside |
| `client-health-check` | `client` | One cheap check per source, then a status table and fix list. Useful when onboarding a client |
| `find-competitors` | `client` | Confirms the client's area and niche, suggests competitors with evidence, and adds the ones you pick |
| `review-brand-terms` | `client` (optional; empty means every client) | Suggests brand terms and adds the ones you confirm |

Prompts prefer free tools, offer paid checks with their cost instead of running them, and name any section that was unavailable instead of guessing. Their text lives in `src/prompts/templates/*.md`.

Clients
-------

The client list is `config/clients.yaml` in the config home. You don't have to write it:

- **From Google.** Every Search Console site and GA4 property your account can see is joined by domain and added automatically, on first use and then once a day.
- **By hand.** `crawlmark-cli clients add example.com`. Only the domain is required, and a hand-added client works for DataForSEO, Lighthouse and axe without Google.

crawlmark never changes or removes what you write; discovery only adds new domains and fills missing properties. To hide a client for good, run `crawlmark-cli clients remove example.com --ignore`.

Add competitors, tracked keywords, an area and a niche at any time with the tools, the CLI or by editing the file. Set `area` (a DataForSEO location name such as `Austin,Texas,United States`) and `niche` before asking for competitor suggestions; local results are much better than national ones.

**Branded vs non-branded.** `monthly_report` splits queries into branded (people searching for the client by name) and non-branded (people searching for what the client sells), because non-branded is the number that shows SEO growth. Matching uses the domain, the client and GA4 names, and each client's brand terms. crawlmark infers brand terms from each new client's Search Console queries and saves only confident ones that match the client's name. A term never applies to another client.

[docs/clients.md](docs/clients.md) covers matching rules, defaults, competitor scoring and brand-term inference in full.

Scheduled audits and alerts
---------------------------

Two CLI commands are built for cron, launchd or CI:

```bash
crawlmark-cli check-traffic --all   # last 7 days vs the 7 before, branded vs non-branded (free)
crawlmark-cli audit --all           # a fresh audit per client, diffed against the previous one
```

Both print JSON. They alert on any new critical or high finding, or a non-branded click drop of at least `ALERT_TRAFFIC_DROP_PCT` (default 25%) and `ALERT_MIN_CLICKS_LOST` (default 50) clicks. Set `ALERT_WEBHOOK_URL` to an `https` Slack-style incoming webhook to get a text summary. Exit codes: `0` no alerts, `1` error, `2` alerts.

[docs/scheduling.md](docs/scheduling.md) has cron, launchd and GitHub Actions examples.

Cost controls
-------------

- Every paid call checks the client's monthly budget (`monthlyBudgetUsd`, default `DEFAULT_CLIENT_MONTHLY_BUDGET_USD`, 5) and the global `GLOBAL_MONTHLY_BUDGET_USD` (default 50) first, and refuses once a cap would be crossed.
- The cost DataForSEO reports is written to a ledger; `spend_summary` reads it.
- Responses are cached (keyword volume 30 days; ranked keywords and backlinks 7 days; SERPs, Google data and client discovery 1 day), so re-running a report mostly costs nothing.
- `monthly_report` and the opportunity tools are free. Live rank checks, full crawls and backlinks are opt-in.
- Use the DataForSEO sandbox while trying things out.

Configuration
-------------

Settings come from environment variables, with `.env` in the **config home** loaded automatically. Variables set by your shell or the MCP client win over `.env`. [`.env.example`](.env.example) lists every variable with comments.

The config home holds `.env`, `config/clients.yaml`, `data/` (cache, saved audits, spend ledger, OAuth token) and `secrets/`. It is:

1. `CRAWLMARK_HOME`, when set (an absolute path or one starting with `~`);
2. otherwise the project folder, for a source checkout;
3. otherwise `~/.crawlmark`.

`crawlmark-cli setup status` shows which one is in use. To move a setup, `crawlmark-cli setup migrate --to ~/.crawlmark` copies it (never moves), then set `CRAWLMARK_HOME` and re-run `crawlmark-cli setup --step register`.

| Variable | Default | Purpose |
|---|---|---|
| `CRAWLMARK_HOME` | see above | Where settings and data live. Set it in your shell or the MCP client config, not in `.env` |
| `GOOGLE_AUTH_MODE` | auto | `oauth` or `service_account`. Unset, a key file means service account, an OAuth client means OAuth |
| `GOOGLE_APPLICATION_CREDENTIALS` | | Service-account JSON key path |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | | Desktop-app OAuth client |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | | DataForSEO API credentials |
| `DATAFORSEO_BASE_URL` | sandbox | `https://api.dataforseo.com/v3` for live data |
| `DATAFORSEO_LIVE` | `false` | `true` selects the live API when no base URL is set |
| `PSI_API_KEY` | | PageSpeed Insights key |
| `CLIENTS_FILE` | `./config/clients.yaml` | The client list |
| `DATA_DIR` | `./data` | SQLite cache, saved audits, spend ledger and OAuth token |
| `DEFAULT_LOCATION_CODE`, `DEFAULT_LANGUAGE_CODE` | `2840`, `en` | DataForSEO market for clients that don't set one |
| `DEFAULT_CLIENT_MONTHLY_BUDGET_USD` | `5` | Per-client monthly cap |
| `GLOBAL_MONTHLY_BUDGET_USD` | `50` | Monthly cap across all clients |
| `COMPETITOR_DENYLIST_FILE`, `COMPETITOR_DENYLIST` | | Extra domains to leave out of competitor suggestions |
| `CHROME_PATH` | | Chrome or Chromium binary for Lighthouse, axe and rendering |
| `CHROME_NO_SANDBOX` | | `true` only where Chrome's sandbox can't start |
| `ALLOW_PRIVATE_URLS` | | `true` lets browser checks reach local and private addresses (local development) |
| `RESTRICT_TO_CLIENT_DOMAINS` | | `true` only accepts URLs on your clients' domains |
| `ALERT_TRAFFIC_DROP_PCT`, `ALERT_MIN_CLICKS_LOST` | `25`, `50` | Traffic-drop alert thresholds |
| `ALERT_WEBHOOK_URL` | | Incoming webhook for alerts |

Relative paths resolve against the config home, so the server works whichever directory a client launches it from.

CLI
---

`crawlmark-cli` (or `npx crawlmark-mcp <command>`, or `npm run cli -- <command>` from source) handles local admin tasks. Run `crawlmark-cli --help` for an overview and `crawlmark-cli help <command>` for a command's options.

| Command | Does |
|---|---|
| `init` (same as `setup`), `setup status`, `setup migrate --to <dir>` | Guided setup and app registration, status report, copy settings to a new home |
| `auth login`, `auth status`, `auth logout` | Google OAuth sign-in, check and sign-out |
| `clients list [--refresh]` | Discover and list clients |
| `clients add <domain>...`, `clients remove <domain>... [--ignore]` | Add or remove clients by hand |
| `clients set <client> [--area …] [--niche …] [--name …] [--brand-terms "a,b"]` | Set a client's profile |
| `competitors list\|add\|remove <client> [domain...]` | Manage competitors |
| `keywords list\|add\|remove <client> [keyword...]` | Manage tracked keywords (quote ones with spaces) |
| `brand list\|add\|remove <client> [term...]` | Manage brand terms |
| `brand suggest <client>\|--all [--apply] [--paid]` | Infer brand terms. `--all` makes no paid calls unless `--paid` |
| `audit --client <domain>\|--all [--dry-run]` | Scheduled audits |
| `check-traffic --client <domain>\|--all [--dry-run]` | Scheduled traffic check |

Results and errors
------------------

- **Partial reports.** Each report section runs on its own. If one source fails or isn't set up, that section says why and the rest of the report still comes back.
- **Timeouts.** Browser checks stop after 90 seconds, `run_audit` after 10 minutes, and each API request after 30 seconds. A DataForSEO call that times out may still be billed, so its estimate is recorded in the spend ledger.
- **URL limits.** Browser checks only load public `http` and `https` URLs. Set `ALLOW_PRIVATE_URLS=true` to audit a local or staging site on a private network, or `RESTRICT_TO_CLIENT_DOMAINS=true` to only accept your clients' domains.
- **Usage log.** Each tool call records the tool name, client, duration and whether it failed (no other arguments). `usage_summary` reads it.
- **Common errors.** "Google isn't set up" or a missing property: run `crawlmark-cli setup status`. A 403 from Google: add your account or service account to that client's property. A budget error: raise the cap or wait for next month.

Development
-----------

```bash
npm install
npm run build
npm test
npm run typecheck
npm run inspect      # MCP Inspector
```

[docs/development.md](docs/development.md) covers the code layout, adding a data source and releasing. [docs/audits.md](docs/audits.md) lists every audit and site-hygiene check.

**Known limits:** Windows is untested, OAuth with a Workspace (Internal) app hasn't been tried (personal Gmail in Testing mode has), and Tag Manager findings aren't part of `run_audit` yet.

License
-------

No license has been chosen yet, so all rights are reserved.

Links
-----

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [DataForSEO API access](https://app.dataforseo.com/api-access) and [pricing](https://dataforseo.com/pricing)
- [Google Cloud console](https://console.cloud.google.com/)
- [Search Console API](https://developers.google.com/webmaster-tools), [GA4 Data API](https://developers.google.com/analytics/devguides/reporting/data/v1), [Tag Manager API](https://developers.google.com/tag-platform/tag-manager/api/v2)
- [MCPB bundle spec](https://github.com/modelcontextprotocol/mcpb)
