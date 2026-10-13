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

Scripts: `npm run dev` (tsx), `npm run build`, `npm start` (runs `dist/` with the SQLite ExperimentalWarning silenced), `npm run typecheck` (source and tests), `npm test` (vitest), `npm run inspect`.

### Config and paths

Settings come from environment variables, with `.env` in the project root loaded automatically (a missing `.env` is fine). `.env.example` lists every variable. Relative `CLIENTS_FILE`, `DATA_DIR` and `GOOGLE_APPLICATION_CREDENTIALS` values resolve against the project root (the directory above `src/` or `dist/`), not the working directory, so the server works no matter where a client launches it. Absolute paths are used as-is.

### Google service account (GSC + GA4)

1. In Google Cloud, create a project and enable the **Google Search Console API** and **Google Analytics Data API**.
2. Create a service account and download its JSON key to `secrets/google-service-account.json`.
3. Add the service account's email address:
   - in each **Search Console** property as a user (Restricted permission is enough)
   - in each **GA4** property as a Viewer
4. Set `GOOGLE_APPLICATION_CREDENTIALS` in `.env`.

One service account covers every client; you just add it to each property.

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
  config.ts             env + clients.yaml loading (paths resolved from project root)
  lib/
    store.ts            SQLite (cache + spend ledger)
    cache.ts            TTL cache wrapper
    budget.ts           per-client / global spend caps
    dates.ts            month ranges and comparisons
    paths.ts            project-root path resolution (pure)
    env.ts              empty env values count as unset (pure)
  providers/            one file per data source
    gsc.ts  ga4.ts  dataforseo.ts  lighthouse.ts  axe.ts  google.ts  browser.ts
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

Scaffold. It typechecks and the server starts and serves all tools. It has not yet been run against live Google, DataForSEO or Chrome. DataForSEO ranked keywords, competitors, backlinks and instant page results are shaped into compact typed objects, but the mapping fixtures are scrubbed sandbox recordings (see `test/fixtures/dataforseo/README.md`).
