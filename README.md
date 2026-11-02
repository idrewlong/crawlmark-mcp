# crawlmark: an MCP server for SEO audits and client reports

crawlmark gives Claude (or any MCP client) the data an SEO consultant or agency needs for monthly client work, and turns it into report-shaped tools. Ask for a monthly report, an audit with what changed since last time, or a list of quick wins, and the agent writes it from real data.

It combines:

| Source | What it provides | Cost |
|---|---|---|
| Google Search Console | Clicks, impressions, CTR, position, URL inspection, sitemaps | Free |
| GA4 Data API | Organic sessions, engagement, key events, landing pages | Free |
| Google Tag Manager | Live container contents for tag audits | Free |
| DataForSEO | Keyword volume, live SERPs, ranked keywords, competitors, backlinks, site crawls | Pay per call |
| Ahrefs (beta) | Keyword volume, ranked keywords, competitors and backlinks, with your own API key | Your plan's API units |
| Semrush (beta) | Keyword volume and backlinks, with your own v4 API key (its v4 API has nothing else) | Your plan's API units |
| Lighthouse | Performance, SEO and best-practice scores, lab Core Web Vitals | Free (runs locally) |
| PageSpeed Insights | Real-user field data (CrUX) | Free with an API key (optional) |
| Chrome UX Report History | Real-user Core Web Vitals week by week: 25 weeks by default, up to 40 | Free with an API key (optional) |
| Bing Webmaster Tools (beta) | Bing clicks, impressions, top queries and pages, crawl stats and crawl issues (read-only) | Free with an API key (optional) |
| axe-core | Automated WCAG checks at level A, AA (default) or AAA (axe has only a few AAA rules) | Free (runs locally) |

Every source is optional. Your client list fills itself from the Search Console sites and GA4 properties your Google account can see, and you can add clients by hand, so the paid data tools, Lighthouse and axe work without Google. Responses are cached in SQLite, and paid calls stop at a per-client and a global monthly cap (dollars for DataForSEO, API units for Ahrefs and Semrush). See [Data providers](#data-providers) for choosing between them.

Install crawlmark
-----------------

```bash
npx crawlmark-mcp@latest init
```

That one command sets up crawlmark and adds it to your AI apps: **Claude Code, Claude Desktop, Cursor and Codex**. `npm install crawlmark-mcp` on its own only downloads the package and doesn't start setup; run `init` with `npx` as above (or install globally with `npm i -g crawlmark-mcp` and run `crawlmark-mcp init`). It needs **Node 22.13 or later** (crawlmark uses the built-in `node:sqlite`). Other ways to install are below; whichever you pick, [set up your credentials](#set-up-credentials) next.

| System or use | Installation method |
|---|---|
| Claude Code, Claude Desktop, Cursor, Codex, or any MCP client | [npx and the setup wizard](#npx-and-the-setup-wizard) |
| Claude Desktop | [Claude Desktop bundle (MCPB)](#claude-desktop-bundle-mcpb) |
| Scheduled jobs from a checkout, or development | [From source](#from-source) |

### npx and the setup wizard

```bash
npx crawlmark-mcp@latest init
```

The wizard checks Node, asks which SEO data providers you have (DataForSEO, Ahrefs, Semrush, or none) and which one is the default, asks for each credential and checks it live, and discovers your clients. Then it asks which AI apps to add crawlmark to, with the ones it found on your machine already ticked:

| App | How crawlmark is added |
|---|---|
| Claude Code | `claude mcp add` (user scope, so every project sees it) |
| Claude Desktop | An entry in `claude_desktop_config.json` |
| Cursor | An entry in `~/.cursor/mcp.json` (global, not per project) |
| Codex | `codex mcp add`, or an entry in `~/.codex/config.toml` when the `codex` command isn't installed |

Every change is shown before it's made, other servers are listed by name only, and each config file keeps a `.bak` copy. An app that already has a different crawlmark entry is only changed if you say yes. Your settings live in `~/.crawlmark`.

In a terminal you get arrow-key choices, masked secrets, a spinner with the time taken for each live check, and a short tip under each result. Links are clickable in terminals that support it (iTerm2, WezTerm, VS Code, Ghostty, Windows Terminal, kitty and recent GNOME terminals; `FORCE_HYPERLINK=1` or `0` overrides), and the steps that need a web page (DataForSEO API access, Ahrefs and Semrush keys, Google Cloud, PageSpeed) offer to open it with Enter. The summary box ends with three things to try asking Claude, using up to three of your own clients from `clients.yaml` (read locally and only shown in your terminal; `example.com` when you have none). With piped input, `CI=true`, `TERM=dumb`, `NO_COLOR` or `--yes`, the same steps run as plain numbered prompts without any of that. `init` and `setup` are the same command.

Run `init` again once crawlmark is set up (a `.env` in its config home and at least one working data source) and it shows a menu instead of every step: add or change a data provider, change the Google sign-in, re-register your AI apps, add Semrush's or Ahrefs' own MCP server, refresh clients, set up report branding, check status, run the full setup again, or exit. `setup --step <name>` still goes straight to one step.

`init`, `setup`, `--help` and `--version` check npm for a newer crawlmark at most once a day (a plain request for the latest version number, with a 1.5 second timeout and nothing about you or your clients) and print `Update available` when there is one. It never runs in CI, when output isn't a terminal, or with `--json`. Set `CRAWLMARK_NO_UPDATE_CHECK=1` (or the common `NO_UPDATE_NOTIFIER=1`) to turn it off; the MCP server itself never checks.

`crawlmark-mcp` with no arguments is the MCP server, which is what clients launch. With a subcommand it runs the admin CLI instead, so `npx -y crawlmark-mcp@latest setup status` and `npx -y crawlmark-mcp@latest clients list` work too.

This README writes commands as `crawlmark-cli <command>`. If you haven't installed crawlmark globally, run the same command as `npx -y crawlmark-mcp@latest <command>` (from a source checkout, `npm run cli -- <command>`). Commands that crawlmark prints in its own messages and in `setup_status` already use the form that matches your install.

Installing the package downloads a Chrome build for Lighthouse and axe (about 570 MB in `~/.cache/puppeteer`). To skip it, set `PUPPETEER_SKIP_DOWNLOAD=true` before installing and either install Google Chrome or point `CHROME_PATH` at a Chrome or Chromium binary.

crawlmark prefers puppeteer's `chrome-headless-shell` (run `npx puppeteer browsers install chrome-headless-shell` if it's missing) for rendering, PDF export, axe and Lighthouse. On macOS the shell runs without a Dock icon, whereas full Google Chrome flashes one on every launch, even headless; there's no flag that avoids that. The order is `CHROME_PATH`, then the headless shell, then puppeteer's Chrome, then a system Chrome. `setup_status` shows which one is in use.

### Claude Desktop bundle (MCPB)

Download `crawlmark.mcpb` from the [latest release](https://github.com/idrewlong/crawlmark-mcp/releases/latest) and double-click it, or drag it onto Claude Desktop (**Settings > Extensions**). Claude Desktop shows a form. Every field is optional, so fill in only what you use:

| Field | What it is |
|---|---|
| DataForSEO API login / password | From [DataForSEO API access](https://app.dataforseo.com/api-access). The password is stored in your OS keychain. Leave empty to skip the paid tools |
| Use the live DataForSEO API | Off (default) uses the free sandbox with sample data. On uses real data, billed to your balance |
| Default SEO data provider | `dataforseo`, `ahrefs` or `semrush`. Blank uses the value in your crawlmark `.env` (from `setup --step provider`), else `dataforseo`. Any other value is reported by `setup_status` |
| Ahrefs API key | API v3 key ([Ahrefs](#ahrefs)) |
| Semrush API key (v4) | The [Semrush](#semrush) key, from your profile > API keys |
| Ahrefs / Semrush monthly unit cap | API units crawlmark may use per month across all clients. Defaults 50,000 and 20,000 |
| Google service-account key file | The JSON key from [option C](#option-c-service-account) |
| Google OAuth client ID / secret | Only for signing in with your own Google account ([options A and B](#options-a-and-b-oauth)). After installing, sign in once from a terminal: `CRAWLMARK_HOME=<data folder> npx crawlmark-mcp setup --step google` |
| PageSpeed Insights API key | Adds real-user field data |
| Chrome executable | Optional path to Chrome or Chromium |
| crawlmark data folder | Where the client list, cache and spend log live. Default `~/.crawlmark` |

A blank field never hides a value in your crawlmark `.env` for the provider fields, so you can choose the provider in a terminal (`CRAWLMARK_HOME=<data folder> npx crawlmark-mcp setup --step provider`) and leave the form empty. Keys typed into the form stay in Claude Desktop; the wizard's keys stay in `.env`.

The bundle doesn't include Chrome. Audits use the Chrome path from the form, or the Chrome installed on your machine. Then ask Claude to run `setup_status`, or use the `getting-started` prompt, to see what's working.

### From source

```bash
git clone https://github.com/idrewlong/crawlmark-mcp.git
cd crawlmark-mcp
npm install            # also downloads a Chrome build for Lighthouse and axe
npm run build
npm run cli -- setup
```

A source checkout keeps its settings in the project folder instead of `~/.crawlmark`. See [Configuration](#configuration). The wizard asks which SEO data providers you have; to change that later, run `npm run cli -- setup --step provider`, or run `npm run cli -- init` again and pick it from the menu. Set `CRAWLMARK_NO_UPDATE_CHECK=1` to turn off the daily update check.

Upgrading to 0.3.0
------------------

Update with `npx -y crawlmark-mcp@latest init` (or `npm i -g crawlmark-mcp@latest`) **on every computer that uses your report template files**, then check these:

- **Update every computer before you use the new template fields.** A template file that uses any new field (a cover, contents, page breaks, text blocks, fonts, `hideProviders`, `commentaryNote`, `allowTerms` or `blockTerms`) doesn't load in 0.2.0 or earlier: the older version marks the whole file invalid and falls back to the builtin templates and branding. Files that don't use the new fields load in both versions. Existing templates and stored reports render as before apart from the white-label change below, but `report` now stops (exit 1) when a template's own text, titles, cover or footer names an internal term: run `crawlmark-cli report templates validate` after upgrading to see any hits.
- **White-label reports now hide DataForSEO and the Claude commentary line.** With `hideCrawlmark: true`, files say "a third-party SEO data provider" instead of DataForSEO and "Written commentary; all figures come from the data below." instead of "Commentary written with Claude...". Set `hideProviders: false` to keep the DataForSEO name, and `commentaryNote` to word the line yourself or remove it. "Source: Ahrefs" and "Source: Semrush" lines always stay. Details in [docs/reports.md](docs/reports.md#white-label).
- **Exports can now be refused.** If the commentary Claude writes for a client names crawlmark, Claude, DataForSEO, a tool name or a similar internal term, `export_report` writes nothing and lists every hit, so Claude can rewrite it. `allowTerms` lets a term through; with white label on, crawlmark, Claude, Anthropic and DataForSEO can only be let through by the `allowTerms` in your branding, not by Claude on an export ([The term check](docs/reports.md#the-term-check)).
- **Command hints match how you installed crawlmark.** The commands that setup and `clients` messages tell you to run now start with the right prefix (`crawlmark-cli`, `npm run cli --` or `npx -y crawlmark-mcp@latest`).

Upgrading to 0.2.0
------------------

Update with `npx -y crawlmark-mcp@latest init` (or `npm i -g crawlmark-mcp@latest`), then check these:

- **GA4 numbers now count only the client's own hostnames.** By default that is the domain and its `www.` form. Sessions on subdomains, staging sites and `localhost` that the GA4 property also collects are left out, so organic sessions can drop against earlier reports. `monthly_report` and template runs say how many sessions were left out and which hostnames they came from (`GA4: 120 organic sessions from other hostnames were left out (staging.example.com 120). If a hostname belongs to this site, add it with set_client_profile ga4Hostnames.`). To count a subdomain, set `ga4Hostnames` for the client ([Client settings](#client-settings)); `"*.example.com"` covers every subdomain and `["*"]` turns the filter off.
- **`ga4_report` returns a different shape.** It was a list of rows; it is now `{ rows, hostnames }`. Anything that reads its output needs `.rows`. See [Raw data](#raw-data).
- **Save your Search Console history once.** Google keeps only 16 months of Search Console data. Run `crawlmark-cli gsc-history backfill --all` now (free) to save the months Google still has; from then on monthly reports and template runs save new months themselves. Details under [Search Console history](#search-console-history).
- **`gtm_audit` picks the container the live homepage loads.** If a client's Tag Manager container choice was ambiguous before, you may now be asked to pin one. See [Tag Manager container](#tag-manager-container).
- **Indexing checks send URLs exactly as listed.** "URL is unknown to Google" results saved by earlier versions (made with the trailing slash removed) are left out of `index_coverage` counts, with a note, and re-checked first on the next inspection run when the URL is still a key page or in the sitemap (results for URLs that are no longer listed stay hidden, with their own note). `gsc_inspect_url` results are never affected: they always sent the URL as given.

Set up credentials
------------------

The setup wizard covers everything here. Each step shows its current status first and can be skipped, so it's safe to re-run, and anything you don't need can be left out.

| Command | Does |
|---|---|
| `crawlmark-cli init` (or `setup`) | The whole wizard |
| `crawlmark-cli setup --step <node\|provider\|dataforseo\|ahrefs\|semrush\|google\|psi\|discovery\|register\|vendor-mcp>` | One step. `provider` picks your SEO data providers and the default one; `vendor-mcp` adds Semrush's or Ahrefs' own MCP server to your AI apps (see [below](#semrushs-and-ahrefs-own-mcp-servers-optional)) |
| `crawlmark-cli setup --step crux` | A key for Core Web Vitals history (CrUX). Only run this way; it isn't part of the default wizard |
| `crawlmark-cli setup --step bing` | A Bing Webmaster Tools API key. Only run this way; it isn't part of the default wizard |
| `crawlmark-cli setup --step branding [--client <domain>]` | Report branding: agency name, logo, colours, fonts, footer, white label, provider names, commentary note, paper size and default formats, with a one-page preview before saving. Only run this way (or from the setup menu) |
| `crawlmark-cli setup --dry-run` | Runs the free checks and shows what each step would do, without writing, signing in or registering anything |
| `crawlmark-cli setup --yes` | Accepts every default. Steps that need input (a password, an API key, a key file) are skipped; the default provider is only written to fix a missing or invalid one when a provider works |
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

Secrets are typed into the terminal without echo and saved to `.env` with mode `0600` (Windows has no file modes, so there the file relies on your user profile's permissions). Never paste them into a chat.

### DataForSEO

DataForSEO is optional and paid per call. It powers keyword volume, live SERPs, ranked keywords, competitor suggestions, backlinks, crawls and the on-page audit check.

1. Create an account at [dataforseo.com](https://dataforseo.com/) and open [API access](https://app.dataforseo.com/api-access). Copy the **API login** and **API password**. The API password is generated there and is not your account password.
2. Run `crawlmark-cli setup --step dataforseo`. It checks the credentials with DataForSEO's free account call and shows your balance.
3. Start with the **sandbox** (the default). It's free and returns sample data in the real response shape. Switch to live when you're ready and the account is funded.

By hand, set `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`, and set `DATAFORSEO_BASE_URL=https://api.dataforseo.com/v3` (or `DATAFORSEO_LIVE=true`) for live data.

Whatever your default provider, live SERPs (`serp_check`, live ranks in `monthly_report`, the SERP half of `suggest_competitors`), the per-page on-page check in `run_audit`, full crawls and local SEO (`local_profile`, `local_pack`, `local_reviews`) use DataForSEO.

### Ahrefs

> **Beta.** The Ahrefs integration is built to the official API documentation and tested against the documented example responses, but it hasn't been verified against a live account yet. Cost caps and key handling are fully tested. If anything looks wrong (an error you don't expect, a missing field, units that don't match your dashboard), please [open an issue](https://github.com/idrewlong/crawlmark-mcp/issues).

Ahrefs is optional. With an API v3 key it can supply keyword volume, ranked keywords, organic competitors and backlinks (with Ahrefs' Domain Rating).

1. You need the **Lite plan or higher**; other plans can't use the API. Each plan has a monthly unit allowance and a cap on rows per request (Lite 100).
2. Create a key under **Account settings > API keys** at [app.ahrefs.com/account/api-keys](https://app.ahrefs.com/account/api-keys). Only workspace owners and admins can open that page.
3. Run `crawlmark-cli setup --step ahrefs`. It checks the key with Ahrefs' free limits-and-usage call (no units used) and shows your plan and units, then asks which provider should be the default.

By hand, set `AHREFS_API_KEY` (and `SEO_DATA_PROVIDER=ahrefs` to make it the default). The `ahrefs_status` tool shows the plan, units used and the reset date.

**Ahrefs data in client reports.** crawlmark calls Ahrefs only through its REST API v3 (never Ahrefs' hosted MCP server) and keeps only counts long-term (per site, metric and month, for up to 25 months; never link or keyword lists). Ahrefs row lists (keywords, competitors, keyword ideas) are cached for at most a day so a repeat question is free, and are purged with the rest; Site Audit example URLs are shown in that run's result and its report (kept 24 hours for export) and never stored beyond that. Each report section with Ahrefs figures says "Source: Ahrefs", white label included. Before sending Ahrefs figures to clients, confirm that your Ahrefs plan allows sharing Ahrefs-derived metrics with them. `crawlmark-cli data purge --provider ahrefs` deletes what's stored; removing a client or the Ahrefs key does too.

### Semrush

> **Beta.** The Semrush integration is built to the official API documentation and tested against the documented example responses, but it hasn't been verified against a live account yet. Cost caps and key handling are fully tested. If anything looks wrong (an error you don't expect, a missing field, units that don't match your dashboard), please [open an issue](https://github.com/idrewlong/crawlmark-mcp/issues).

Semrush is optional. crawlmark uses Semrush's **v4 API** with a v4 key; Semrush's older v3 keys aren't supported. Semrush's v4 SEO API has only two things crawlmark uses:

| What crawlmark does | From Semrush |
|---|---|
| `keyword_volume` | v4 Get Keyword Metrics, 20 units per keyword (Early Access per Semrush, so it may change) |
| `backlinks_summary` and the `backlinks` report section | v4 backlinks overview, 45 units; no history (stored figures only) |
| Everything else: `ranked_keywords`, `competitor_domains`, `organic_visibility`, `competitor_overview`, `keyword_ideas`, `keyword_gap`, Site Audit in `technical_issues` | Not in Semrush's v4 API. DataForSEO serves them when it is set up (the result says `fallbackFrom: semrush`); otherwise the call says to use DataForSEO or Ahrefs |

API units come with the plan: Semrush says 50,000 units are included with SEO Classic Pro and Guru and with Semrush One Starter and Pro+, and SEO Classic Business or Semrush One Advanced can add unit packages.

1. Create a **v4 key** in your Semrush profile under **API keys** (up to 100, revocable, with an expiry).
2. Run `crawlmark-cli setup --step semrush` and paste it. Semrush has no free key check, so the key is saved as it is and checked by the first paid call (keyword volume or backlinks). A Semrush rejection on that call says to create a v4 key and re-run the step.

By hand, set `SEMRUSH_API_KEY` (and `SEO_DATA_PROVIDER=semrush` to make it the default). If you used 0.1.0, a key saved as `SEMRUSH_V4_API_KEY` is still read, and if both are set the `SEMRUSH_V4_API_KEY` one wins, because in 0.1.0 `SEMRUSH_API_KEY` held the old v3 key. Re-running the step saves the key as `SEMRUSH_API_KEY` and removes `SEMRUSH_V4_API_KEY` from `.env`. The `semrush_status` tool and `setup status` show whether the key is set and what it serves.

In v4 keyword metrics the CPC unit and the competition scale aren't documented, so CPC is passed through as Semrush returns it and the result carries a note saying so.

Semrush's API terms don't allow keeping its data longer than a month, so crawlmark deletes stored Semrush figures 31 days after fetching them.

### Data providers

Keyword volume and backlinks can come from any of the three providers; rankings, competitors, visibility, keyword ideas and the competitor keyword gap from DataForSEO or Ahrefs (Semrush's v4 API doesn't have them, so a Semrush client is served by DataForSEO for those when it is set up). DataForSEO is the default and is verified against its live API; Ahrefs and Semrush are in beta (see above). Live SERPs, on-page checks and crawls come from DataForSEO only.

| Capability | DataForSEO | Ahrefs | Semrush |
|---|---|---|---|
| `keyword_volume` | Google Ads volume | Keywords Explorer (12-month average) | Get Keyword Metrics (v4, 20 units per keyword) |
| `ranked_keywords` | Labs ranked keywords | Site Explorer organic keywords | Not available (DataForSEO or Ahrefs) |
| `competitor_domains` | Labs competitors | Site Explorer organic competitors | Not available (DataForSEO or Ahrefs) |
| `backlinks_summary` | Backlinks summary (rank, spam score) | Backlinks stats plus Domain Rating | Backlinks overview (v4) plus authority score |
| `organic_visibility`, `organic_visibility` report section | Labs domain rank overview (position bands, estimated traffic); history: historical rank overview | Metrics plus keywords history (position bands, organic traffic); history: keywords and metrics history | Not available (DataForSEO or Ahrefs) |
| `backlinks` report section | Backlinks summary; history: backlinks history (monthly, with new and lost referring domains) | Backlinks stats plus Domain Rating; history: referring domains and Domain Rating history | Backlinks overview (v4); no history (stored figures only) |
| `competitor_overview`, `competitor_overview` report section | Labs competitors with each competitor's whole footprint | Organic competitors | Not available (DataForSEO or Ahrefs) |
| `technical_issues` sources (paid, opt-in) | A stored full crawl's summary (free) | Site Audit issues of your existing project | Not available |
| `keyword_ideas` | Labs keyword ideas (`related`) or keyword suggestions (`matching`) | Keywords Explorer related terms or matching terms | Not available (DataForSEO or Ahrefs) |
| `keyword_gap` | Labs domain intersection | Each competitor's organic keywords, minus what the client already gets Search Console impressions for | Not available (DataForSEO or Ahrefs) |
| `serp_check`, `check_ranks` with `live`, on-page checks, crawls | Yes | No (DataForSEO is used) | No (DataForSEO is used) |
| Account check | `dataforseo_status` | `ahrefs_status` | `semrush_status` |

- **The default.** `SEO_DATA_PROVIDER` (`dataforseo`, `ahrefs` or `semrush`; blank means `dataforseo`) picks the default. `crawlmark-cli setup --step provider` sets it, and so does the bundle's "Default SEO data provider" field. An unknown value doesn't stop the server: `setup_status` and every paid call say what's wrong, and free tools keep working.
- **Per client.** A client's `dataProvider` in clients.yaml overrides the default: `crawlmark-cli clients set example.com --provider ahrefs` (or `none` to go back to the default), or `set_client_profile`. Ahrefs and Semrush need the client's market as a country: set `country` (`--country GB`), or it comes from a country-level `locationCode`.
- **No silent fallback.** If a client's provider has no key, its paid calls fail with the command to fix it; crawlmark never spends on another account instead. If the provider lacks a capability (live SERPs, on-page checks, crawls, or for Semrush anything but keyword volume and backlinks), DataForSEO serves it when it's set up, and the result says `fallbackFrom`.
- **Units, not dollars.** DataForSEO is capped in USD. Ahrefs and Semrush are capped in their own API units, per month (UTC): `AHREFS_MONTHLY_UNIT_CAP` (default 50,000) and `SEMRUSH_MONTHLY_UNIT_CAP` (20,000) across all clients, and `DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS` (10,000) and `DEFAULT_CLIENT_MONTHLY_SEMRUSH_UNITS` (5,000) per client, or a client's `monthlyUnits`. Each call checks its estimate first; units are never converted to dollars.
- **Metrics differ.** Every result carries `provider`, and `backlinks_summary` labels the domain-strength number in `authority.metric` (`dataforseo_rank`, `domain_rating` or `semrush_score`). They aren't comparable across providers.

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
- **Tag Manager API** (only for the Tag Manager checks: `gtm_audit`, `run_audit` with `includeTagManager` and the `gtm` report section)
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

### CrUX History (optional)

Core Web Vitals history (`crux_history`, the `cwv` report section and `run_audit` with `cruxHistory`) needs a Google Cloud API key with the [Chrome UX Report API](https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com) enabled. Run `crawlmark-cli setup --step crux` and paste the key (or leave it blank to use `PSI_API_KEY`, which works when its project has the Chrome UX Report API enabled and the key isn't restricted to PageSpeed only). The check is one free query for a public site. The key is saved as `CRUX_API_KEY`.

### Bing Webmaster Tools (optional)

> **Beta.** The Bing Webmaster Tools integration is built to the official API documentation and tested against the documented example responses, but it hasn't been verified against a live account yet. Key handling and the read-only method list are fully tested. If anything looks wrong (an error you don't expect, a missing field, numbers that don't match Bing's dashboard), please [open an issue](https://github.com/idrewlong/crawlmark-mcp/issues).

`bing_report` and the `bing_overview` report section read Bing search data with your own Bing Webmaster Tools API key. It's free:

1. Sign in at [Bing Webmaster Tools](https://www.bing.com/webmasters) (a Microsoft, Google or Facebook account works) and add and verify your sites. You can import them from Search Console.
2. Open **Settings** (top right) > **API Access**, accept the terms the first time, then **API Key** > **Generate API Key**. There is one key per user, and it covers every site you've verified.
3. Run `crawlmark-cli setup --step bing` and paste it. The check is one free request for your own site list; nothing about your clients is sent. The key is saved as `BING_WEBMASTER_API_KEY` (or set it in the Claude Desktop extension settings).

crawlmark only reads with this key. It calls a fixed list of read methods and never submits URLs, sitemaps or IndexNow pings, or changes anything in your Bing account. Bing requires the key in the request URL, so crawlmark never logs, caches or shows that URL. Each client is matched to the verified Bing site with the same domain; to use a different one on the same domain or a subdomain, set `bingSite` (`crawlmark-cli clients set example.com --bing-site https://www.example.com/`); a site on another host is refused. If the key is ever exposed, delete it and generate a new one on the same page.

### AI-search visibility (optional, paid)

> **Beta.** AI-search visibility is built to DataForSEO's official API documentation and tested against the documented example responses, but it hasn't been verified against a live account yet. Cost caps are fully tested. If anything looks wrong, please [open an issue](https://github.com/idrewlong/crawlmark-mcp/issues).

`ai_visibility` and the `ai_visibility` report section show which questions in Google AI Overviews (or ChatGPT, United States English only) cite a client's site, from DataForSEO's LLM Mentions API. It is **off by default** and **paid**:

- **Cost:** $0.10 per request plus $0.001 per row returned (about $0.12 for 20 answers). There is no request under $0.10.
- **Possible $100 monthly minimum:** DataForSEO launched LLM Mentions with a $100 monthly top-up required for access. Its 2026-07-07 update says that minimum was removed and it's pay as you go, but older help pages still mention it. Check your DataForSEO account before turning this on.
- **Its own cap:** `AI_VISIBILITY_MONTHLY_BUDGET_USD` (default $2) limits what it may spend each month across all clients, on top of each client's `monthlyBudgetUsd` and `GLOBAL_MONTHLY_BUDGET_USD`. Every call checks all three before its request, and `estimateOnly: true` shows the cost first without a request.
- **Try it free:** DataForSEO's sandbox (the default until you set `DATAFORSEO_LIVE=true`) serves LLM Mentions with sample data at no charge.

To turn it on, add `AI_VISIBILITY_ENABLED=true` to the `.env` in your config home (or switch on "AI-search visibility" in the Claude Desktop extension settings) and restart the server. `setup_status` shows its state, this month's AI spend and the cap. It never runs from a default report or a scheduled job: a report template section needs `paid: true`, the run needs `allowPaid: true` (or `--paid`), and the switch must be on.

Configure your MCP client
-------------------------

`crawlmark-cli setup --step register` does this for you. To do it by hand:

**Claude Code** (from npm):

```bash
claude mcp add crawlmark -s user -- npx -y crawlmark-mcp@latest
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
      "args": ["-y", "crawlmark-mcp@latest"]
    }
  }
}
```

**Codex** (`~/.codex/config.toml`, or run `codex mcp add crawlmark -- npx -y crawlmark-mcp@latest`):

```toml
[mcp_servers.crawlmark]
command = "npx"
args = ["-y", "crawlmark-mcp@latest"]
```

For a source checkout, use `"command": "node"` and `"args": ["--disable-warning=ExperimentalWarning", "/absolute/path/to/crawlmark-mcp/dist/index.js"]`. Claude Desktop, Cursor and Codex may not load your shell's `PATH`, so if one can't find `node` or `npx`, use the absolute path (`which node`). Credentials come from `.env` in the config home, so no `env` block is needed unless your settings live somewhere other than the default; then add `"env": { "CRAWLMARK_HOME": "/path/to/home" }`.

### Semrush's and Ahrefs' own MCP servers (optional)

Semrush and Ahrefs each host their own MCP server. You can add either to your AI app next to crawlmark, to ask the vendor's tools ad-hoc questions. This is separate from crawlmark's own Semrush and Ahrefs support:

| | crawlmark's Semrush / Ahrefs | The vendor's own MCP server |
|---|---|---|
| Sign-in | An API key in your crawlmark `.env` | OAuth, in your AI app |
| Good for | Reports, cost caps, caching and history | Ad-hoc questions in chat |
| Units | Counted against crawlmark's monthly caps | Spent directly from your account; crawlmark's caps, cache and reports don't cover them |

crawlmark itself never calls these servers; it only adds them to your AI apps. For Ahrefs, that is what its terms ask for: per [Ahrefs' docs](https://docs.ahrefs.com/docs/mcp/introduction), its MCP endpoint is for interactive use in MCP-compatible clients, and scripts or other programmatic access must use the public API, which is what crawlmark's own Ahrefs features use (REST API v3). Ahrefs' MCP is available on paid plans from Lite and draws from the same monthly API unit pool as the REST API; connecting through OAuth creates an MCP-tagged key with a default limit of 200,000 units a month, which workspace admins can change in the API keys report. Semrush says its MCP calls use the same API units as its API, with no extra fee ([Semrush MCP docs](https://developer.semrush.com/api/basics/semrush-mcp/)).

```bash
crawlmark-cli setup --step vendor-mcp
```

The step asks which servers to add (Semrush and Ahrefs, pre-ticked if you picked them as data providers), then which of your detected apps. Each change is previewed and asked about first, the config file is kept as a `.bak`, other servers are never touched, and an entry that is already there is left alone. If an entry named `semrush` or `ahrefs` already exists with a different setting, it is replaced only if you say yes (the default is no). No API key is ever written to an app's config. In a normal `init`, if you picked Semrush or Ahrefs as a provider, it asks once after the register step whether to also add them (default no; never asked under `--yes` or in plain mode).

To add them by hand (replace the name and URL for Ahrefs: `ahrefs`, `https://api.ahrefs.com/mcp/mcp`):

**Claude Code:**

```bash
claude mcp add --transport http -s user semrush https://mcp.semrush.com/v2/mcp
```

Then run `/mcp` in Claude Code and sign in.

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "semrush": { "url": "https://mcp.semrush.com/v2/mcp" }
  }
}
```

**Codex:**

```bash
codex mcp add semrush --url https://mcp.semrush.com/v2/mcp
codex mcp login semrush
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.semrush]
url = "https://mcp.semrush.com/v2/mcp"
```

**Claude Desktop** takes remote servers in its settings, not in `claude_desktop_config.json`: open **Settings > Connectors > Add custom connector**, enter a name (Semrush) and the URL, save, and sign in when asked.

If a client can't do OAuth, Semrush also accepts the header `Authorization: Apikey <key>`; the wizard never writes that for you, so add it yourself if you need it.

### Other MCP servers alongside crawlmark

An AI app can run several MCP servers in one chat, and the agent combines their tools. crawlmark covers search: Search Console, GA4, crawls, ranks and organic competitors. It doesn't cover competitors' paid ads, social, or other channels. To ask about those in the same conversation, add an MCP server for that data (an ad-library or analytics server, for example) to your AI app next to crawlmark, the same way as the Semrush and Ahrefs servers above. Their costs, limits and data handling are their own; crawlmark's caps, cache and reports only cover crawlmark's tools.

Once connected, run the **`getting-started`** prompt. It checks what's set up, explains what crawlmark can do with it, and offers a first report for your busiest client.

Tools
-----

Tools that take a `client` accept its domain (`example.com`), any URL or `www.` form of it, or its key in `clients.yaml`. Report tools return structured JSON; the agent writes the prose, so tone and formatting live in your prompts.

### Setup and clients

| Tool | Description |
|---|---|
| `setup_status` | Each integration's state (`working`, `configured`, `missing` or `error`) and the exact next step, plus the default SEO data provider (`seoDataProvider`). Free |
| `list_clients` | Every client with its Search Console and GA4 properties, Tag Manager container and what's missing. `refresh: true` re-lists from Google |
| `set_client_profile` | Sets a client's area (for local searches), niche, display name, brand terms, data provider override, country, Bing site, confirmed Google Business Profile place ID (`gbpPlaceId`), GA4 hostnames (`ga4Hostnames`), Search Console query exclusions (`gscExcludeQueries`) and pinned Tag Manager container (`gtmContainerId`) ([Client settings](#client-settings)) |

### Reports

| Tool | Description |
|---|---|
| `monthly_report` | Search Console and GA4 for the month vs the previous month and last year: top and moving queries and pages, landing pages, tracked keyword positions, top opportunities, the branded vs non-branded split, and what changed since the last audit. Also returns `notes` (GA4 sessions left out, excluded queries, history saved) and `search.querySpikes` (days when impressions jumped on a few zero-click queries). Free by default |
| `run_audit` | Lighthouse, axe, rendered-vs-raw HTML, index status, on-page checks and site hygiene for each key page, with optional full crawl and backlinks, Core Web Vitals history (`cruxHistory`), Tag Manager findings (`includeTagManager`) and the free local crawl (`localCrawl`). Saved, so it can be compared later |
| `list_audits` | A client's saved audits, newest first |
| `get_audit` | One saved audit's full result and findings |
| `compare_audits` | What's new, resolved, still open or unverified between two audits, plus score changes. Findings on a page or source the earlier audit didn't check are `firstChecked` (not new), and findings of an old Tag Manager container after a container change are `retired` (not resolved) ([details](docs/audits.md#saved-audits-and-diffs)) |
| `crawl_status` | Progress of a full crawl started by `run_audit` |
| `crawl_issue_pages` | URLs failing one crawl check |
| `list_report_templates` | Report templates for a client: the builtin `monthly`, `quarterly`, `executive` (one page), `technical` and `local`, your global file and the client's own file, with optional and paid sections. Free |
| `get_report_template` | One template with its defaults filled in and the resolved branding. Free |
| `validate_report_template` | Checks template YAML (or a saved file) and names each problem's YAML path. Free |
| `create_report_template` | Drafts a new template in the global or a client's template file. The first call only proposes (YAML, diff, paid sections with estimates, a 15-minute single-use token); the second, after you say yes, saves it. Paid sections need your explicit OK; apps with elicitation also ask you directly. Free |
| `update_report_template` | Changes a saved template (the whole template, or sections added or removed and settings changed) with the same propose-then-confirm steps. Free |
| `run_report_template` | Runs a template for a client: per-section data and status, computed highlights, and a `reportId` kept for 24 hours. Free unless you allow a paid section; `estimateOnly: true` prices the paid sections without fetching or spending anything |
| `export_report` | Saves a report as Markdown, HTML, PDF or Word files under the reports folder, data-only or with the agent's commentary, and can return a docs-friendly HTML copy for Google Docs |

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
| `site_hygiene` | robots.txt, sitemaps, structured data, hreflang (page tags, sitemap entries and `Link` headers), orphan pages (from the newest complete local or DataForSEO crawl), AI crawler access in robots.txt (AI search vs training-only crawlers) and llms.txt (informational: Google says it doesn't use it). Free |
| `local_crawl` | Crawls the client's own site from your machine (free): status codes, redirects and chains, titles, meta descriptions, canonicals, H1s, internal links, depth, broken links, noindex pages and orphans against the sitemaps. After following links it also fetches sitemap URLs the links didn't reach (`includeSitemapUrls`, on by default; `--no-sitemap-urls` on the CLI). Obeys robots.txt and Crawl-delay; same host only by default; up to 2,000 pages. Saved for `local_crawl_pages`, `site_hygiene` and audits |
| `local_crawl_pages` | Pages from a saved local crawl, filtered by issue or status code. Free, local |
| `technical_issues` | One deduplicated, severity-grouped list of technical problems from the saved audit, its site checks, the newest local crawl, a stored DataForSEO crawl and stored URL Inspection results, with the sources per issue and what's new, resolved or not re-checked since the last snapshot. Never starts a crawl. Free; your existing Ahrefs Site Audit project can be added as a paid source with `allowPaid` (read-only) ([details](docs/audits.md#technical-issues)) |
| `index_coverage` | Google's indexing of a sample of the client's URLs from stored URL Inspection results: indexed share, coverage states, the worst URLs, canonical mismatches, sitemap errors, the monthly trend and how many sitemap URLs were checked recently (or that all were). Free, local ([details](docs/audits.md#indexing-coverage)) |
| `import_index_report` | Imports an export of Search Console's Pages report (Indexing > Pages > Export: the zip of CSVs, an Excel workbook or one CSV) so `index_coverage` and the indexing report section show Google's complete counts per reason, with example URLs from a reason's own export. Reads only `IMPORT_DIRS` or `<home>/imports`; parsed on your machine. Free ([details](docs/audits.md#importing-search-consoles-pages-report)) |
| `inspect_index_coverage` | Inspects key pages, top Search Console pages and a weekly-rotating sample of sitemap URLs with URL Inspection (free, read-only) within a daily per-property budget, and stores the results. `all: true` checks every page when today's budget allows, else says how many daily runs a full pass needs |
| `render_check` | Compares a page's raw HTML with what Chrome renders and flags SEO elements that only appear after JavaScript. Free |
| `gtm_audit` | Audits the live Tag Manager container the client's homepage loads (or the one you pinned): paused, unfired and legacy tags, duplicate GA4 tags, unused variables, custom HTML, consent gaps and unpublished changes. Free ([Tag Manager container](#tag-manager-container)) |
| `lighthouse` | Lighthouse scores and lab Core Web Vitals, plus field data with a PageSpeed key. Runs one at a time per process: a second call waits its turn (up to 10 minutes), and each run gets 150 seconds once it starts. Cached results return at once |
| `accessibility_check` | axe-core WCAG checks on one page, at level A, AA (default) or AAA. Free |
| `crux_history` | Real-user Core Web Vitals (LCP, INP, CLS, FCP, TTFB) per week for up to 40 weeks, with ratings and a trend, for a client, an origin or a URL. Free with a key ([CrUX History](#crux-history-optional)) |
| `bing_report` | Bing Webmaster Tools for a client: clicks, impressions and CTR for the last 28 days (7 to 180) vs the period before, by day, the top 25 queries and pages, crawl stats for the latest 30 days and up to 50 URLs with crawl issues. Read-only; free with a key ([Bing Webmaster Tools](#bing-webmaster-tools-optional)) |
| `log_analysis` | Crawler hits from your server's access logs (Apache/Nginx, `.gz` too): Googlebot (checked against Google's published IP ranges), Bingbot and AI crawlers such as GPTBot, ClaudeBot and PerplexityBot, with statuses, top paths, 404s and 5xx, hits per day and parameter URLs. Reads only `LOG_DIRS` or `<home>/logs`; logs never leave your machine and no IP addresses or user agents are returned. Free |

### Rank history

| Tool | Description |
|---|---|
| `check_ranks` | Checks the client's tracked keywords now and saves them: Search Console's average position, clicks, impressions and top page over the last 7 complete days (free). `live: true` adds a **paid** live Google rank per keyword (DataForSEO, about $0.002 each); `estimateOnly: true` returns the estimate and what's left of the caps without any request |
| `rank_history` | The saved positions per tracked keyword and source, with the latest, first, best and worst rank and the change over the range, 30 and 90 days (lower is better). Free, local |

Live ranks from `serp_check`, `monthly_report` with `liveRanks` and report templates with `liveRanks` are saved too when the keyword is tracked. Only tracked keywords are stored.

### Local SEO (paid, DataForSEO)

> **Beta.** Local SEO is built to DataForSEO's official API documentation and tested against the documented example responses. `local_pack` has been run against the live API; `local_profile` and `local_reviews` haven't returned a real listing in a live check yet. Cost caps and reviewer-data stripping are fully tested. If anything looks wrong (an error you don't expect, a missing field, a cost that doesn't match your dashboard), please [open an issue](https://github.com/idrewlong/crawlmark-mcp/issues).

| Tool | Description |
|---|---|
| `local_profile` | **Paid** (about $0.0054). The client's Google Business Profile from DataForSEO Business Data: name, address, website, categories, rating and review count, star distribution, claimed or not, photos and opening hours, plus other listings the lookup returned. Searches by the client's name in its `area`. It never saves anything: check the match, then save its place ID with `set_client_profile` `gbpPlaceId` (or `crawlmark-cli clients set example.com --place-id <id>`) |
| `local_pack` | **Paid** (about $0.002 per keyword). The client's Google Maps position for its first 5 tracked keywords (or up to 10 you name) in its `area`, with the top 3 businesses |
| `local_reviews` | **Paid** ($0.0015 per 10 reviews). The rating, the star distribution of the reviews fetched and the latest 10 to 100 reviews (rating, date, text, whether the owner replied). Never reviewer names, profiles or photos. Needs the confirmed `gbpPlaceId`. Reviews are a queued DataForSEO task: if it isn't done within 75 seconds you get a `taskId` to read it with later, at no extra cost |

All three take `estimateOnly: true` (the estimate and what's left of the caps, with no request), check the whole call against the client's and the global monthly caps before the first request, and use DataForSEO whatever the client's data provider (there's no Ahrefs or Semrush equivalent). They don't use the Google Business Profile API, which needs Google's approval. See [docs/clients.md](docs/clients.md#google-business-profile).

### AI-search visibility (paid, off by default)

| Tool | Description |
|---|---|
| `ai_visibility` | **Paid** (at least $0.10 per request) and **off unless `AI_VISIBILITY_ENABLED=true`** ([AI-search visibility](#ai-search-visibility-optional-paid)). `mode: "mentions"`: questions in Google AI Overviews (or ChatGPT, US English only) whose answer cites the client, with the cited URL, its position among the sources, AI search volume and an answer excerpt. `mode: "metrics"`: mention counts and AI search volume by platform, location and language, and the domains cited alongside. Its own monthly cap; `estimateOnly: true` first |

### Competitors, keywords and brand terms

| Tool | Description |
|---|---|
| `list_competitors`, `add_competitors`, `remove_competitors` | A client's competitors. Free |
| `suggest_competitors` | **Paid.** Ranked competitor candidates from keyword overlap (the client's data provider) and local Google results (DataForSEO), with evidence. Never saves; you pick which to add |
| `list_keywords`, `add_keywords`, `remove_keywords` | Tracked keywords; `monthly_report` reports their positions. Free |
| `add_brand_terms`, `remove_brand_terms` | Terms that mark a query as branded, per client. Free |
| `keyword_ideas` | **Paid** (the client's data provider). Keyword ideas from 1-20 seeds, `related` or `matching`, with volume, CPC and the provider's own difficulty score (labelled; scales differ). `estimateOnly: true` first |
| `organic_visibility` | **Paid** (the client's data provider). Ranking keywords, keywords by position band and estimated traffic, stored for month-over-month; the provider's history only with `history: true`. `estimateOnly: true` first |
| `competitor_overview` | **Paid** (the client's data provider). Top organic competitors, saved ones first, with shared keywords and their keywords and traffic. `estimateOnly: true` first |
| `seo_trends` | Stored backlinks and visibility figures over time, one series per provider. Free, local |
| `keyword_gap` | **Paid** (the client's data provider). Keywords the client's competitors (its saved ones, or up to 5 you name) rank for and it doesn't, sorted by volume. `estimateOnly: true` first; a call that wouldn't fit the cap is refused with a limit that does |
| `suggest_brand_terms` | Infers how people search for the client by name from its Search Console queries (free), or the client's data provider's ranked keywords when it has no Search Console data (about $0.02 on DataForSEO) |

### Raw data

| Tool | Description |
|---|---|
| `gsc_query` | Search Console search analytics. Leaves out the client's `gscExcludeQueries` unless `includeExcludedQueries: true` |
| `gsc_history` | Saved monthly Search Console history (clicks, impressions, CTR, position, and a month's top pages, queries, devices and countries). `backfill: true` saves the months Google still has. Free ([details](#search-console-history)) |
| `gsc_inspect_url` | Search Console URL inspection |
| `ga4_report` | GA4 Data API report. Returns `{ rows, hostnames }`; counts only the client's GA4 hostnames unless you pass `hostnames` (up to 20) or `allHostnames: true` |
| `keyword_volume` | **Paid** (the client's data provider). Search volume for keywords |
| `serp_check` | **Paid** (DataForSEO). Live Google results for a keyword |
| `ranked_keywords` | **Paid** (the client's data provider). Keywords a domain ranks for |
| `competitor_domains` | **Paid** (the client's data provider). Domains ranking for the same keywords |
| `backlinks_summary` | **Paid** (the client's data provider). Backlink totals for a domain |
| `dataforseo_status` | Credentials check, sandbox or live mode, and balance. Free |
| `ahrefs_status` | Ahrefs key check, plan, units used and reset date. Free |
| `semrush_status` | Whether the Semrush v4 key is set, what Semrush serves in crawlmark, and units used this month (no free key check exists). Free |

Paid results carry `provider` (whose data it is) and `units` (Ahrefs or Semrush API units used; `null` for DataForSEO, which reports `costUsd`).

If Semrush or Ahrefs rejects a client's key on a paid call, the tool returns an error that names the provider and client and gives two ways out: fix the key (`crawlmark-cli setup --step semrush` or `ahrefs`), or switch that client to another provider you have set up (`set_client_profile` with `dataProvider`, or `crawlmark-cli clients set <client> --provider <name>`). crawlmark never switches providers by itself.

#### Client settings

Three per-client settings, in `clients.yaml` or set from Claude with `set_client_profile` or from a terminal with `clients set`:

| Setting | Does | Terminal |
|---|---|---|
| `ga4Hostnames` | Hostnames counted in GA4 numbers. Default: the domain and its `www.` form. Exact hosts, `*.example.com` for any subdomain, or `*` for no filter. Up to 20 | `crawlmark-cli clients set example.com --ga4-hostname shop.example.com --ga4-hostname "*.example.com"` (`none` goes back to the default) |
| `gscExcludeQueries` | Search Console queries to leave out of totals and query lists, as exact text or `/regex/` (RE2). Applies to every Search Console read; `gsc_query` can show the raw numbers with `includeExcludedQueries`. Totals say how many clicks and impressions were left out; average position is not adjusted | `crawlmark-cli clients set example.com --gsc-exclude-query "/^example( co)?$/"` (`none` clears) |
| `gtmContainerId` | Pins the Tag Manager container `gtm_audit` uses (`GTM-XXXX` or the numeric ID) | `crawlmark-cli clients set example.com --gtm-container GTM-ABC123` (`none` unpins) |

Examples and details are in [docs/clients.md](docs/clients.md#per-client-settings-for-ga4-search-console-and-tag-manager).

#### Search Console history

Google keeps 16 months of Search Console data. `gsc_history` and the `gsc-history` command save it month by month so older figures survive:

```bash
crawlmark-cli gsc-history backfill --all      # run this once after upgrading, then it keeps itself up to date
crawlmark-cli gsc-history backfill example.com --months 12
crawlmark-cli gsc-history show example.com    # the saved months
```

From chat, call `gsc_history` with `backfill: true`. It is free, paces its requests, backs off at quota limits and is safe to run again: it only fetches months not saved yet. The oldest month Google still has can be partial (`complete: false`). Saved numbers are raw. Query exclusions are applied to saved query rows when a report reads them. Saved totals are adjusted only for months saved under the same exclusions as the client has now: if you set or change `gscExcludeQueries` after saving, those months are read raw and the report says so (run the backfill again with `refresh` to re-save them). Stored page rows can't have exclusions subtracted. After that, each `monthly_report` and template run saves up to two missing months and says so in its notes. A report range older than 16 months uses saved history only when every month in it is saved.

#### Tag Manager container

`gtm_audit` reads the client's live homepage and audits the container whose `GTM-` ID it loads, so it audits what visitors actually get. The result has a `containerCheck` showing the page URL, the IDs found, and how the container was chosen (`pinned`, `live-page` or `only-candidate`). When several containers could match and none is on the page, it refuses and lists them with the command to pin one. A container injected only by JavaScript or a consent loader isn't visible in the page source: pin it.

```bash
crawlmark-cli clients set example.com --gtm-container GTM-ABC123   # pin
crawlmark-cli clients set example.com --gtm-container none          # unpin: go back to matching the live page
```

From Claude: `set_client_profile` with `gtmContainerId: "GTM-ABC123"`, or `""` to unpin. A pinned container that isn't on the live page still runs, with a warning. Client discovery (`clients list`, `list_clients`) only writes a container into `clients.yaml` when exactly one matches; entries it wrote earlier count as pinned, so unpin them to go back to matching the live page. Tag Manager API calls run two at a time and retry rate-limit errors for up to a minute before giving up.

### Spend and housekeeping

| Tool | Description |
|---|---|
| `spend_summary` | Paid API spend this month, by client and provider: dollars for DataForSEO, units for Ahrefs and Semrush |
| `usage_summary` | Calls, errors and durations per tool |
| `purge_cache` | Drops expired cache entries and old usage rows |

`crawlmark-cli data purge --provider <ahrefs|semrush|dataforseo> [--client example.com]` deletes what crawlmark stored from one provider (trend figures, its Site Audit items in saved technical-issue lists, and cached responses). `--client` also accepts the domain of a client you already removed from `clients.yaml`; the result says it purged a removed client's data.

Prompts
-------

| Prompt | Arguments | Does |
|---|---|---|
| `getting-started` | none | Checks setup, gives the command for anything missing, and offers a first report |
| `monthly-report-writeup` | `client`, `month` (optional, `YYYY-MM`) | Writes a client-facing monthly report: summary, what moved and why, branded vs non-branded, fixes since the last audit, top opportunities, next month's priorities. Offers to save it as files, and as a Google Doc when you have a Google Drive connector |
| `template-report` | `client`, `template` (optional), `period` (optional: `YYYY-MM`, `YYYY-Qn` or `YYYY-MM-DD..YYYY-MM-DD`) | Runs a report template, writes commentary per section and saves Markdown, HTML, PDF or Word files. Offers a Google Doc only when a Drive connector is available and you say yes |
| `build-report-template` | `request` (what you want in your words), `client` (optional) | Turns the request into a report template: shows you the YAML and diff, asks about each paid section by name and cost, and saves only after your yes |
| `audit-findings` | `client` | Uses a recent audit or runs one, compares it with the last, and writes findings by severity with a prioritized fix list |
| `opportunity-review` | `client` | Runs the five opportunity tools and writes a prioritized action list with estimated click upside |
| `client-health-check` | `client` | One cheap check per source, then a status table and fix list. Useful when onboarding a client |
| `keyword-research` | `client`, `seeds` (optional, comma-separated) | Finds keyword ideas from seed keywords, or the keywords competitors rank for that the client doesn't, from the client's data provider. Shows the estimate and remaining cap first, runs the paid call only after you agree, then groups the results by intent and suggests a page for each |
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

Report files
------------

`export_report` (in Claude) and `crawlmark-cli report` (from cron) turn a client's data into Markdown, HTML, PDF or Word files from a YAML template. The files are laid out like an agency dashboard: your logo and colours, four key-figure cards with their changes, a summary, charts (clicks and impressions per day, branded share, organic sessions, Core Web Vitals and rank history), clean tables, and a short "About this report". In Claude the files carry the commentary Claude writes; from cron they are data only and say so. Files go to `<home>/reports/<client>/<YYYY-MM>/`, readable only by you.

Your branding (agency name, logo, colours, fonts, footer, white label, paper size and default formats) is set up with `crawlmark-cli setup --step branding`, which shows a one-page preview with sample data before saving; `crawlmark-cli report preview-branding` shows it again later.

In Claude the commentary can use sub-headings, bullets, numbered lists, tables and `{{chart search}}` lines that repeat a chart from the section. Text meant for you only goes in an internal part, which is saved to a separate `<template>-<period>.internal.md` file and never into a client file. Texts are limited to 20,000 characters each (100,000 for the client's whole report). Before writing anything, `export_report` checks the client text for internal terms (crawlmark, Claude, DataForSEO, tool and setting names) and refuses the export, listing the hits, if it finds one; Ahrefs, Semrush and Google are not terms, and `allowTerms` (on the export, or in your branding) lets a term through; with white label on, only your branding's `allowTerms` can let crawlmark, Claude, Anthropic or DataForSEO through. [Commentary in docs/reports.md](docs/reports.md#commentary) has the format and the rules.

Templates can also set a cover (subtitle, "Prepared for", "Prepared by", which fields show), a linked contents list (`contents: true`), a page break before a section (`pageBreakBefore: true`, Word and PDF), and reusable text blocks (a glossary or methodology note) that a `block` section shows:

```yaml
templates:
  board:
    title: Quarterly board pack
    contents: true
    cover: { subtitle: Search performance for the board, preparedFor: Example Co }
    sections:
      - { id: search, type: search_overview }
      - { id: terms, type: block, block: glossary, pageBreakBefore: true }
blocks:
  glossary:
    title: Glossary
    text: "CTR is clicks divided by impressions."
```

Fonts come from `branding` (`bodyFont`, `headingFont`, `fontFallback`; setup asks for them). They show only where the font is installed: HTML and PDF fall back to a sans-serif or serif family, and Word and Google Docs substitute another font. A file that uses any of these fields doesn't load in crawlmark 0.2.0 ([Upgrading to 0.3.0](#upgrading-to-030)).

Builtin templates: `monthly` (the same data as `monthly_report`), `quarterly` (the quarter against the one before and the same quarter last year), `executive` (one page: key figures, the clicks trend, top wins and next steps), `technical` (site crawl, Core Web Vitals, audit changes and AI readiness, for web teams) and `local` (Local SEO: the Google Business Profile and map-pack positions, paid, plus local-intent searches).

```bash
crawlmark-cli report templates init                         # writes config/report-templates.yaml (monthly + quarterly to edit)
crawlmark-cli report --client example.com --format md,pdf,docx
crawlmark-cli report --all --template quarterly --quarter 2026-Q3 --format pdf
crawlmark-cli report --client example.com --template executive --format pdf
crawlmark-cli report templates new --client example.com    # build your own: pick sections, preview, save
```

To build your own template without writing YAML, run `crawlmark-cli report templates new` on a terminal, or ask Claude ("draft me a one-page monthly summary with search, traffic and technical issues"): it shows you the template and the change to your file, and saves only after you say yes. Paid sections are always named with their cost and never added without your OK.

Optional sections are added with `--include` (`include` in Claude). Free: `cwv` (Core Web Vitals history), `gtm` (Tag Manager findings), `ranks` (tracked keyword rank trends from the stored history), `ai` (llms.txt and AI crawler access from the newest saved audit), `issues` (the technical-issues list), `indexing` (Google indexing coverage) and `spend` (paid data used this month; the tool and CLI results always report it, the files only with this section). Paid, through the client's data provider: `backlinks` and `visibility` in `monthly` and `quarterly`, and `competitors` in `quarterly`. Paid sections (also `keyword_gap`, `local_profile` and `ai_visibility` in your own templates) run only with `--paid` (`allowPaid`) after their estimate fits the caps.

PDF uses the Chrome crawlmark already uses for Lighthouse, offline. To get a Google Doc, ask Claude: with your own Google Drive connector it can save the report there after you agree. crawlmark itself never writes to Google. [docs/reports.md](docs/reports.md) covers templates, layout, fonts, commentary, branding, paths and the Docs handoff.

Scheduled audits and alerts
---------------------------

These CLI commands are built for cron, launchd or CI:

```bash
crawlmark-cli check-traffic --all   # last 7 days vs the 7 before, branded vs non-branded (free)
crawlmark-cli audit --all           # a fresh audit per client, diffed against the previous one
crawlmark-cli check-ranks --all     # saves every tracked keyword's Search Console position (free)
crawlmark-cli index-coverage --all  # Google indexing of key pages and a rotating sitemap sample (free, daily budget)
crawlmark-cli seo-snapshot --all --paid  # monthly: store backlinks, visibility and competitor figures (paid; try --dry-run)
```

`check-ranks --live` adds a paid live Google rank per keyword (DataForSEO). It only runs when you pass `--live`, each client's total is checked against its cap first (a client over its cap is skipped, the others run), and `--dry-run` shows the keywords and the estimate without calling anything. Only live ranks alert: a keyword that leaves the top 10 or drops at least `ALERT_RANK_DROP` places (default 5). Search Console averages never alert.

`audit --include-tag-manager` adds each client's Tag Manager findings (medium or low, so they never alert); without it they're left out. `crawlmark-cli report --all` writes report files on a schedule ([Report files](#report-files)).

They print JSON. They alert on any new critical or high finding, a live rank drop (`check-ranks --live`), or a non-branded click drop of at least `ALERT_TRAFFIC_DROP_PCT` (default 25%) and `ALERT_MIN_CLICKS_LOST` (default 50) clicks. Set `ALERT_WEBHOOK_URL` to an `https` Slack-style incoming webhook to get a text summary. Exit codes: `0` no alerts, `1` error, `2` alerts.

[docs/scheduling.md](docs/scheduling.md) has cron, launchd and GitHub Actions examples.

Cost controls
-------------

- Every paid DataForSEO call checks the client's monthly budget (`monthlyBudgetUsd`, default `DEFAULT_CLIENT_MONTHLY_BUDGET_USD`, 5) and the global `GLOBAL_MONTHLY_BUDGET_USD` (default 50) first, and refuses once a cap would be crossed.
- Ahrefs and Semrush calls check unit caps instead (see [Data providers](#data-providers)). Units are never converted to dollars.
- Calls that run at the same time reserve their whole estimate until they finish, so together they can't pass a cap that their sum would cross. Reservations are per process: a cron run and the MCP server running at the same moment each see only the other's recorded spend, not its calls in progress.
- The cost DataForSEO reports, and the units Ahrefs and Semrush calls use, are written to a ledger; `spend_summary` reads it.
- Responses are cached (keyword volume 30 days; ranked keywords and backlinks 7 days; SERPs, Google data and client discovery 1 day; Ahrefs keyword and competitor lists at most 1 day), so re-running a report mostly costs nothing.
- `monthly_report` and the opportunity tools are free. Live rank checks, full crawls and backlinks are opt-in.
- Use the DataForSEO sandbox while trying things out. Ahrefs offers free test queries against its own domains; Semrush has none.

Configuration
-------------

Settings come from environment variables, with `.env` in the **config home** loaded automatically. Variables set by your shell or the MCP client win over `.env`. [`.env.example`](.env.example) lists every variable with comments.

The config home holds `.env`, `config/clients.yaml`, `config/report-templates.yaml`, `data/` (cache, saved audits, spend ledger, OAuth token), `reports/` (report files) and `secrets/`. It is:

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
| `SEO_DATA_PROVIDER` | `dataforseo` | Default provider for keyword, ranking, competitor and backlink data: `dataforseo`, `ahrefs` or `semrush` |
| `AHREFS_API_KEY` | | Ahrefs API v3 key |
| `SEMRUSH_API_KEY` | | Semrush v4 key (profile > API keys). `SEMRUSH_V4_API_KEY`, the 0.1.0 name for the v4 key, is still read and wins if both are set (in 0.1.0 this variable held the old v3 key) |
| `AHREFS_MONTHLY_UNIT_CAP`, `SEMRUSH_MONTHLY_UNIT_CAP` | `50000`, `20000` | Monthly API units across all clients |
| `DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS`, `DEFAULT_CLIENT_MONTHLY_SEMRUSH_UNITS` | `10000`, `5000` | Monthly API units per client (clients.yaml `monthlyUnits` overrides) |
| `PSI_API_KEY` | | PageSpeed Insights key |
| `CRUX_API_KEY` | | Chrome UX Report API key for Core Web Vitals history. Unset, `PSI_API_KEY` is tried |
| `BING_WEBMASTER_API_KEY` | | Bing Webmaster Tools API key for `bing_report` (read-only) |
| `CLIENTS_FILE` | `./config/clients.yaml` | The client list |
| `DATA_DIR` | `./data` | SQLite cache, saved audits, spend ledger and OAuth token |
| `REPORTS_DIR` | `./reports` | Report files from `export_report` and `crawlmark-cli report` |
| `LOG_DIRS` | | Directories `log_analysis` may read (comma-separated absolute paths); `<home>/logs` is always allowed |
| `IMPORT_DIRS` | | Directories `import_index_report` may read Search Console exports from (comma-separated absolute paths); `<home>/imports` is always allowed |
| `DEFAULT_LOCATION_CODE`, `DEFAULT_LANGUAGE_CODE` | `2840`, `en` | DataForSEO market for clients that don't set one |
| `DEFAULT_CLIENT_MONTHLY_BUDGET_USD` | `5` | Per-client monthly cap |
| `GLOBAL_MONTHLY_BUDGET_USD` | `50` | Monthly cap across all clients |
| `COMPETITOR_DENYLIST_FILE`, `COMPETITOR_DENYLIST` | | Extra domains to leave out of competitor suggestions |
| `CHROME_PATH` | | Chrome, Chromium or chrome-headless-shell binary for Lighthouse, axe and rendering. Overrides the headless shell |
| `CHROME_NO_SANDBOX` | | `true` only where Chrome's sandbox can't start |
| `ALLOW_PRIVATE_URLS` | | `true` lets browser checks reach local and private addresses (local development) |
| `RESTRICT_TO_CLIENT_DOMAINS` | | `true` only accepts URLs on your clients' domains |
| `ALERT_TRAFFIC_DROP_PCT`, `ALERT_MIN_CLICKS_LOST` | `25`, `50` | Traffic-drop alert thresholds |
| `ALERT_RANK_DROP` | `5` | Places a live rank must fall to alert (`check-ranks --live`) |
| `GSC_INSPECTION_DAILY_BUDGET` | `1000` | URL Inspection requests per Search Console property per Pacific-time day (Google allows 2,000; max 2000) |
| `GSC_INSPECTION_PER_MINUTE` | `60` | URL Inspection requests per minute (Google allows 600; max 600) |
| `SNAPSHOT_REUSE_DAYS` | `7` | A stored provider snapshot this recent is reused instead of a new paid call (the backlinks, organic visibility and competitor report sections, `seo-snapshot` and the matching tools) |
| `ALERT_WEBHOOK_URL` | | Incoming webhook for alerts |
| `CRAWLMARK_NO_UPDATE_CHECK` | | `1` turns off the daily "Update available" check in `init`, `setup`, `--help` and `--version` (`NO_UPDATE_NOTIFIER=1` works too) |

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
| `clients set <client> [--area …] [--niche …] [--name …] [--brand-terms "a,b"] [--provider <id\|none>] [--country <XX\|none>] [--bing-site <url\|none>] [--place-id <id\|none>]` | Set a client's profile, data provider override, country, Bing site and Google Business Profile place ID |
| `competitors list\|add\|remove <client> [domain...]` | Manage competitors |
| `keywords list\|add\|remove <client> [keyword...]` | Manage tracked keywords (quote ones with spaces) |
| `brand list\|add\|remove <client> [term...]` | Manage brand terms |
| `brand suggest <client>\|--all [--apply] [--paid]` | Infer brand terms. `--all` makes no paid calls unless `--paid` |
| `audit --client <domain>\|--all [--dry-run] [--include-tag-manager]` | Scheduled audits |
| `check-traffic --client <domain>\|--all [--dry-run]` | Scheduled traffic check |
| `check-ranks --client <domain>\|--all [--live] [--dry-run]` | Save tracked keyword positions (free); `--live` adds paid live ranks |
| `index-coverage --client <domain>\|--all [--max <n> \| --all-pages] [--stale-days <n>] [--dry-run]` | Inspect key pages, top pages and a rotating sitemap sample with URL Inspection (free, read-only) within the daily budget; `--all-pages` checks every page when the budget allows, else continues the rotation and says how many daily runs a full pass needs. Exit 0 done, 2 a client failed or Google's quota ran out, 1 error |
| `index-coverage import --client <domain> <file> [--reason <text>] [--confirm-property]` | Import an export of Search Console's Pages report (zip of CSVs, .xlsx or CSV) for `index_coverage` and the indexing report section. Local. Exit 0 imported, 1 error |
| `seo-snapshot --client <domain>\|--all --paid [--kinds backlinks,visibility,competitors] [--dry-run]` | Store today's backlinks, visibility and competitor figures through each client's SEO data provider (paid; each client's estimate is checked against its caps first; never buys history). Exit 0 done, 2 a client failed or was over its cap, 1 error or no `--paid` |
| `data purge --provider <ahrefs\|semrush\|dataforseo> [--client <domain>]` | Delete one provider's stored data (local only) |
| `report --client <domain>\|--all [--template <id>] [--month\|--quarter\|--start --end] [--format pdf,docx,html,md] [--include <id,id>] [--paid] [--dry-run]` | Report files from a template (data only; one PDF unless you pick other formats). Exit 0 written, 2 written with a failed section or format, 1 error |
| `report templates list\|validate [file]\|init` | List, check or create report templates |
| `report templates new [--client <domain>] [--file global\|client] [--replace] [--dry-run]` | Build a template on a terminal: pick sections (marked free or paid, with the client's cost per run), period, comparisons and layout, see a sample-data preview and the file diff, then save, change or cancel. Exit 0 saved or cancelled, 1 error or no terminal, 130 Ctrl-C |
| `crawl --client <domain> [--max-pages <n>] [--max-depth <n>] [--concurrency <n>] [--user-agent crawlmark\|googlebot] [--include-subdomains] [--start-url <url,url>]` | Free local crawl of a client's site, saved like `local_crawl`. Exit 0 saved, 1 error |
| `logs --client <domain> <file>... [--since <date>] [--until <date>] [--bots <name,name>] [--no-verify]` | Crawler hits in access logs you name (local only, aggregates only). Exit 0 done, 1 error |

Results and errors
------------------

- **Partial reports.** Each report section runs on its own. If one source fails or isn't set up, that section says why and the rest of the report still comes back.
- **Timeouts.** Browser checks stop after 90 seconds, `run_audit` after 10 minutes, and each API request after 30 seconds. A DataForSEO, Ahrefs or Semrush call that times out may still be billed, so its estimate is recorded in the spend ledger.
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

**Known limits:** the Ahrefs, Semrush and Bing Webmaster Tools integrations and AI-search visibility are in beta (built to the official docs, not yet verified against a live account), and so is local SEO apart from `local_pack`. CI runs the test suite and a packaged-install check on Linux, macOS and Windows, but the AI apps haven't been tried by hand on Windows. OAuth with a Workspace (Internal) app hasn't been tried (personal Gmail in Testing mode has). Tag Manager findings are in `run_audit` only when asked for (`includeTagManager`).

Security
--------

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

License
-------

[MIT](LICENSE)

Links
-----

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [DataForSEO API access](https://app.dataforseo.com/api-access) and [pricing](https://dataforseo.com/pricing)
- [Ahrefs API v3 docs](https://docs.ahrefs.com/) and [API keys](https://app.ahrefs.com/account/api-keys)
- [Semrush API docs](https://developer.semrush.com/api/)
- [Google Cloud console](https://console.cloud.google.com/)
- [Search Console API](https://developers.google.com/webmaster-tools), [GA4 Data API](https://developers.google.com/analytics/devguides/reporting/data/v1), [Tag Manager API](https://developers.google.com/tag-platform/tag-manager/api/v2)
- [MCPB bundle spec](https://github.com/modelcontextprotocol/mcpb)
