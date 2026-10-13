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

On top of the raw sources it adds per-client config, a SQLite response cache, a per-client and global monthly spend cap, and report-shaped tools.

## Tools

**Report tools** (start here)

| Tool | Does |
|---|---|
| `list_clients` | Configured clients and which sources are connected |
| `monthly_report` | GSC + GA4 month vs previous month and last year, top/moving queries and pages, landing pages, tracked keyword positions |
| `run_audit` | Lighthouse + axe + GSC index status + on-page check per key page, sitemap health; optional full crawl and backlinks |
| `crawl_status` | Progress and issue counts for a full crawl started by `run_audit` |
| `crawl_issue_pages` | URLs failing one crawl check (e.g. `no_description`) |
| `spend_summary` | Paid API spend this month by client |
| `purge_cache` | Drop expired cache entries |

**Lower-level tools** (for follow-up questions)

`gsc_query`, `gsc_inspect_url`, `ga4_report`, `keyword_volume`, `serp_check`, `ranked_keywords`, `competitor_domains`, `backlinks_summary`, `lighthouse`, `accessibility_check`

Report tools return structured JSON. The agent (or a skill) turns that into the written report, so formatting and tone live in your prompts, not in this server.

## Setup

Requires Node 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install            # also downloads a Chrome build for Lighthouse + axe
cp .env.example .env
cp config/clients.example.yaml config/clients.yaml
npm run build
```

Scripts: `npm run dev` (tsx), `npm run build`, `npm start` (runs `dist/` with the SQLite ExperimentalWarning silenced), `npm run cli -- <command>` (the `crawlmark-cli` admin CLI), `npm run typecheck` (source and tests), `npm test` (vitest), `npm run inspect`.

### Config and paths

Settings come from environment variables, with `.env` in the project root loaded automatically (a missing `.env` is fine). `.env.example` lists every variable. Relative `CLIENTS_FILE`, `DATA_DIR` (which also holds the Google OAuth token) and `GOOGLE_APPLICATION_CREDENTIALS` values resolve against the project root (the directory above `src/` or `dist/`), not the working directory, so the server works no matter where a client launches it. Absolute paths are used as-is.

### Google (GSC + GA4)

The server signs in to Google one of two ways, set by `GOOGLE_AUTH_MODE` in `.env`. Switching modes is only an `.env` change; the tools are the same.

#### Choose a setup

| Option | Mode | You need | Pros | Cons | Steps |
|---|---|---|---|---|---|
| **A. OAuth, Google Workspace** | `oauth` | A Workspace (business) account, with the Cloud project inside that organization | Sign in once; the server sees every property you can already open; sign-ins don't expire on a schedule | Requires Workspace | 1, 2 (Internal), CLI check |
| **B. OAuth, personal Gmail** | `oauth` | Any Google account | Same property access as A, no Workspace needed | Sign-in expires every 7 days while the app is in Testing; Google shows an "unverified app" screen | 1, 2 (External + Testing), CLI check |
| **C. Service account** | `service_account` | Any Google account that can create a Cloud project | Never expires, no sign-in, works for unattended jobs | You must add the service account's email to every client's Search Console and GA4 property | 1, 3, CLI check |

**Which one?** With Workspace, use A. Without it, use C for daily work and unattended jobs, and B if you'd rather not share each property with a service account. You can set up more than one and switch with `GOOGLE_AUTH_MODE`. The default is `oauth`.

All options request read-only scopes only: `webmasters.readonly` and `analytics.readonly`. OAuth also requests `openid email` so it can show which account is signed in.

#### 1. Google Cloud project and APIs

In the [Google Cloud console](https://console.cloud.google.com/), create (or pick) a project. Under **APIs & Services > Library**, enable:

- **Google Search Console API**
- **Google Analytics Data API**
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
   GOOGLE_AUTH_MODE=service_account
   GOOGLE_APPLICATION_CREDENTIALS=./secrets/google-service-account.json
   ```

One service account covers every client; you just add it to each property. Add it to the exact Search Console property named in `gscProperty` (a `sc-domain:` domain property and a `https://` URL-prefix property are separate). The GA4 property ID is under **Admin > Property details**.

#### Check it works

```bash
npm run build
npm run cli -- auth status
```

It prints the mode, the account in use, and `Token check: OK` (OAuth) or `Key check: OK` (service account). If something is missing, it says what to set or run. A tool that returns a 403 for one client usually means that account or service account hasn't been added to that client's property.

#### CLI

`crawlmark-cli` (`dist/cli.js`, or `npm run cli -- <command>`) handles local admin tasks. Unlike the MCP server, it prints to stdout.

| Command | Does |
|---|---|
| `crawlmark-cli auth login` | OAuth loopback sign-in (`127.0.0.1`, random port, PKCE, state check, 5-minute timeout). Stores the token at `DATA_DIR/google-token.json` with mode `0600`. |
| `crawlmark-cli auth status` | Shows the active mode and account (OAuth email or service-account email), then checks the token or key against Google and lists the granted scopes. Exits non-zero with setup guidance if something is missing. |
| `crawlmark-cli auth logout` | Revokes the stored token with Google and deletes the file. If revoking fails it still deletes the file and warns. |

The server reads the token on demand and picks up a new login without a restart. Refreshed access tokens are written back to the same file. Never commit or share `google-token.json`; it's gitignored.

### DataForSEO

1. Create an account and copy the API login and password from the dashboard into `.env`.
2. Leave `DATAFORSEO_BASE_URL` on the **sandbox** while building. It's free and returns fake data in the real response shape.
3. Switch to `https://api.dataforseo.com/v3` when you're ready, and fund the account.

### PageSpeed Insights (optional)

Create an API key in Google Cloud with the PageSpeed Insights API enabled and set `PSI_API_KEY`. Without it, Lighthouse still runs locally; you just don't get real-user field data.

### Clients

Edit `config/clients.yaml`. Each client has a slug, domain, GSC property, GA4 property ID, market (DataForSEO location + language), competitors, tracked keywords, key pages to audit, and a monthly budget.

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

- Every paid call checks the client's `monthlyBudgetUsd` and the global `GLOBAL_MONTHLY_BUDGET_USD` before running, and refuses with a clear error once a cap would be crossed.
- The actual cost DataForSEO reports is written to a ledger; `spend_summary` reads it.
- Responses are cached in `data/crawlmark.db` (volume 30 days, ranked keywords and backlinks 7 days, SERPs and Google data 1 day), so re-running a report mostly costs nothing.
- `monthly_report` is free by default. Live rank checks (`liveRanks: true`), full crawls and backlinks are opt-in.
- The pre-flight estimates in `src/providers/dataforseo.ts` are conservative placeholders. Tune them against DataForSEO's pricing page.

## Layout

```
src/
  index.ts              server entry (stdio)
  cli.ts                crawlmark-cli: auth login | status | logout
  config.ts             env + clients.yaml loading (paths resolved from project root)
  lib/
    store.ts            SQLite (cache + spend ledger)
    cache.ts            TTL cache wrapper
    budget.ts           per-client / global spend caps
    dates.ts            month ranges and comparisons
    paths.ts            project-root path resolution (pure)
    env.ts              empty env values count as unset (pure)
    google-auth.ts      Google auth mode selection, consent URL, callback check, token merge, error messages (pure)
    token-store.ts      OAuth token file: atomic 0600 write, read, delete
  providers/            one file per data source
    gsc.ts  ga4.ts  dataforseo.ts  lighthouse.ts  axe.ts  browser.ts
    google.ts           googleAuth(): OAuth client or service account, by GOOGLE_AUTH_MODE; googleAuthStatus()
    google-login.ts     OAuth loopback login flow
    google-oauth-client.ts  OAuth2Client that maps invalid_grant; token-file client loader (refresh persistence)
    dataforseo-shape.ts pure mappers: raw DataForSEO results -> typed compact objects
  reports/
    monthly.ts          monthly_report composer
    audit.ts            run_audit composer
    section.ts          per-section error isolation
  tools/
    reports.ts          report tool registrations
    raw.ts              lower-level tool registrations
scripts/
  record-fixtures.ts    records raw DataForSEO sandbox responses (refuses non-sandbox); scrub before committing
test/
  *.test.ts             vitest unit tests (pure functions)
  fixtures/dataforseo/  API payloads used by the mapping tests (see its README)
```

## Adding a source

1. Add `src/providers/<name>.ts`. Wrap calls in `cached()`, and for paid APIs call `assertBudget()` before and `recordSpend()` after.
2. Register any raw tools in `src/tools/raw.ts`.
3. Pull it into a report composer in `src/reports/` inside a `section()` so a failure doesn't break the report.

Candidates: Bing Webmaster Tools, Google Business Profile, a rank tracker, or the CMS (to check for drafts, missing alt text, etc).

## Status

Scaffold. It typechecks and the server starts and serves all tools. It has not yet been run against live Google, DataForSEO or Chrome. Google OAuth login is unit tested but not yet run end to end against a real account. DataForSEO ranked keywords, competitors, backlinks and instant page results are shaped into compact typed objects, but the mapping fixtures are scrubbed sandbox recordings (see `test/fixtures/dataforseo/README.md`).
