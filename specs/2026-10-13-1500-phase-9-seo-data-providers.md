<!--
Status: approved (open questions decided by the user 2026-10-13; two requirements added the same day)
Created: 2026-10-13 09:46 CDT · Updated: 2026-10-13 10:13 CDT
Author: Claude Code / my-skills:planner / branch phase-9-plan
Owner: backend
Reasoning: the user wants to bring their own Ahrefs or Semrush API key instead of, or alongside, DataForSEO. Today every paid tool calls DataForSEO directly, so this phase adds a provider layer, budgets measured in units, new setup steps, and a provider choice at install, whichever way the user installs. Ahrefs comes first, then Semrush. Live verification comes last, because no key exists yet.
Research:
  - docs/research/ahrefs-api-v3.md: every Ahrefs endpoint, parameter, field cost and error used here, with sources, accessed 2026-10-13
  - docs/research/semrush-api.md: every Semrush endpoint, parameter, column code, error code and key type used here, accessed 2026-10-13
  - MCPB manifest spec (github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md, accessed 2026-10-13): user_config types are string/number/boolean/directory/file; the properties are title, description, required, default, multiple, sensitive and min/max. There is no enum or options property, so a string field can't restrict its choices.
  - There is no docs/decisions/DECISIONS.md. The recorded decisions are in 9.10.
Supersedes: none. This file was renamed from specs/2026-10-13-0946-phase-9-seo-data-providers.md so it sorts after Phase 8 (specs/2026-10-13-1400-phase-8-premium-installer.md on phase-8-plan). Same plan, revised.

Lives in specs/ (my-skills convention); implementation.md links to it. Builds after Phase 8 (branch phase-8-installer) merges to main.
-->

## Phase 9: Ahrefs and Semrush as data providers

**Status:** approved 2026-10-13. Owner: backend, for every file below. It starts after Phase 8 merges, because the wizard uses Phase 8's `Ui` layer (`src/setup/ui.ts`, `ui-clack.ts`), `Prompter.multiselect`, `commandPrefix` and `renderStatus`.

**Goal.** A user with an Ahrefs (API v3) or Semrush API key can use it for keyword volume, ranked keywords, organic competitors and backlink summaries.

- Users choose their providers when they install, whichever way they install: the CLI wizard (`init`/`setup`, fancy or plain) or the Claude Desktop bundle.
- One provider is the default. Each client can override it.
- DataForSEO fills in what the chosen provider can't do: live SERPs, on-page checks and crawls.
- Budgets work in each provider's own currency. DataForSEO keeps its USD caps; Ahrefs and Semrush get monthly unit caps.
- Every tool name and existing output field stays the same.

**Non-goals.**
- Ahrefs or Semrush rank tracking, site audit or project APIs, historical data, and keyword ideas.
- A SERP or crawl backend other than DataForSEO.
- Automatic failover after a provider *errors* (see 9.5).
- Converting units to dollars.
- Fixing or merging metrics across providers. Ahrefs DR, Semrush score and DataForSEO rank are reported side by side, never mixed.
- An MCP tool that changes the provider or any credential. Secrets never go through chat. The MCP side reports the provider and points to the CLI (9.6).
- Any paid call in tests.

### 9.0 What the user sees

**CLI, fancy mode** (Phase 8 clack UI, `npx crawlmark-mcp@latest init`, first run). Values are placeholders.

```
┌  crawlmark 0.1.0  SEO audits for Claude, Cursor and Codex
◇  Config home: ~/.crawlmark (new)
◇  Node v22.13.1  OK
│
◆  SEO data providers
│  Keyword volumes, rankings, competitors and backlinks come from a paid
│  provider. Pick the ones you have an API key for (none is required).
│  ◼ DataForSEO   pay per call; free sandbox; also live SERPs, on-page, crawls
│  ◻ Ahrefs       API v3, Lite plan or higher
│  ◻ Semrush      Business plan + API unit package
│  (space toggles, enter confirms)
◇  Selected: DataForSEO, Ahrefs
│
◆  DataForSEO  … (Phase 8 flow: Which API? → login → masked password → spinner)
◇  ✔ DataForSEO works  sandbox, balance $1.00
│
◆  Ahrefs  keyword, ranking, competitor and backlink data
│  Create a key under Account settings > API keys (workspace owner or admin).
◇  Ahrefs API key  ••••••••••••••••
◒  Checking with Ahrefs (free limits-and-usage call)…
◇  ✔ Ahrefs works  plan Standard, key 1,200 of 50,000 units used (resets 2026-11-01)
│
◆  Default provider for keyword, competitor and backlink data
│  ● Ahrefs
│  ○ DataForSEO
│  Each client can override this (dataProvider in clients.yaml).
◇  Default: Ahrefs. Live SERPs, on-page checks and crawls still use DataForSEO.
│
◆  Google … (unchanged)
…
╭─ crawlmark is ready ─────────────────────────────────────────────╮
│  ✔ Node   ✔ DataForSEO   ✔ Ahrefs (default)   ○ Semrush           │
│  ✔ Google   ✔ Clients 11   ✔ Claude Code   ✔ Claude Desktop       │
│  Next:                                                           │
│    1. Restart Claude Desktop                                     │
│    2. In Claude, run the getting-started prompt                  │
│    3. Change providers: npx crawlmark-mcp setup --step provider  │
╰──────────────────────────────────────────────────────────────────╯
```

**Re-running** (`setup` or `setup --step provider`) shows the current state first, as every step does. The multi-select is pre-ticked with the providers that already have a key.

```
◆  SEO data providers
│  ✔ DataForSEO  sandbox, balance $1.00
│  ✔ Ahrefs      plan Standard (default)
│  ○ Semrush     not set up
│  Which do you have?  ◼ DataForSEO  ◼ Ahrefs  ◻ Semrush
```

- **Ticked and already working.** No credential prompt runs. Use `--step ahrefs` to change the key.
- **Ticked and not working.** That provider's credential step runs.
- **Unticked.** Nothing is deleted. The provider is only left out of the default list, and the step prints `Ahrefs key kept in .env but not used as the default. Remove AHREFS_API_KEY from .env to forget it.`

**Plain mode** (piped input, `CI`, `TERM=dumb`, `NO_COLOR`). The same steps run, line by line, through `terminalPrompter`:

```
SEO data providers: DataForSEO (working), Ahrefs (not set up), Semrush (not set up)
Which do you have? Comma list of dataforseo, ahrefs, semrush, or "none" [dataforseo]: dataforseo,ahrefs
...
Default provider for keyword, competitor and backlink data:
  1. ahrefs
  2. dataforseo
Choose [1]:
```

**`--yes`** (plain, non-interactive):
- The provider selection keeps the providers that already have a key. On a fresh home, that means none.
- Credential steps that would need a key end as `skipped`, with the message `Ahrefs needs a key; run setup --step ahrefs`. They never prompt and never fail the run.
- The default select keeps the current `SEO_DATA_PROVIDER` when it is valid and configured. Otherwise it takes the first working provider in the order dataforseo, ahrefs, semrush, and writes it only when it differs from the effective value (unset counts as dataforseo). With no working provider, nothing is written.

**Claude Desktop bundle.** The extension settings form gains these fields, in order, after the DataForSEO ones:

| Field | Shape |
|---|---|
| "Default SEO data provider" | text; "dataforseo, ahrefs or semrush. Blank means the value in your crawlmark .env, else dataforseo." |
| "Ahrefs API key" | masked |
| "Semrush API key (v3)" | masked |
| "Semrush API key (v4, optional)" | masked |
| "Ahrefs monthly unit cap" | number |
| "Semrush monthly unit cap" | number |

An unknown value doesn't stop the server. The error appears in `setup_status` and on every routed paid call (see 9.3).

**In Claude.**
- `setup_status` shows a "Data provider" row: `✔ Data provider  Ahrefs (default, from .env). DataForSEO for live SERPs, on-page and crawls.`, plus the `ahrefs` and `semrush` rows.
- The `getting-started` prompt says which provider is the default and how to change it:
  - `npx crawlmark-mcp setup --step provider` in a terminal;
  - or, when the value comes from the bundle, the "Default SEO data provider" field in Claude Desktop > Settings > Extensions > Crawlmark.

### 9.1 Capability matrix

The vendor details live in the research notes; each cell below cites the section it relies on.

| Provider | Base URL | Auth | Source |
|---|---|---|---|
| Ahrefs | `https://api.ahrefs.com/v3` | header `Authorization: Bearer <AHREFS_API_KEY>` | ahrefs-api-v3.md "General" |
| Semrush v3 | `https://api.semrush.com/` | `key=<SEMRUSH_API_KEY>` in the query string | semrush-api.md "General" |
| Semrush v3 backlinks | `https://api.semrush.com/analytics/v1/` | as v3 | semrush-api.md "v3 Backlinks Overview" |
| Semrush v4 | `https://api.semrush.com/apis/v4/…` | header `Authorization: Apikey <SEMRUSH_V4_API_KEY>`; **v4 needs its own key type** | semrush-api.md "Two key types" |

| Capability (id) | Used by | DataForSEO (today, unchanged) | Ahrefs v3 | Semrush |
|---|---|---|---|---|
| `keywordVolume` | `keyword_volume` | `POST /keywords_data/google_ads/search_volume/live` | `GET /keywords-explorer/overview?country=<cc>&keywords=a,b&select=keyword,volume,cpc` in batches of 100 | `GET /?type=phrase_these&phrase=a;b&database=<db>&export_columns=Ph,Nq,Cp,Co` in batches of 100 (v3, deprecated; see 9.10 D8) |
| `rankedKeywords` | `ranked_keywords`, `suggest_competitors` seeds, brand inference | `POST /dataforseo_labs/google/ranked_keywords/live` | `GET /site-explorer/organic-keywords?target=&country=<cc>&date=<today>&mode=subdomains&volume_mode=average&select=keyword,best_position,best_position_url,volume,sum_traffic&order_by=volume:desc&limit=` | `GET /?type=domain_organic&domain=&database=<db>&export_columns=Ph,Po,Nq,Ur,Tg&display_sort=nq_desc&display_limit=<limit>` |
| `competitorDomains` | `competitor_domains`, `suggest_competitors` overlap | `POST /dataforseo_labs/google/competitors_domain/live` | `GET /site-explorer/organic-competitors?target=&country=<cc>&date=<today>&mode=subdomains&select=competitor_domain,keywords_common,traffic&order_by=keywords_common:desc&limit=` | `GET /?type=domain_organic_organic&domain=&database=<db>&export_columns=Dn,Np,Ot&display_sort=np_desc&display_limit=<limit>` |
| `backlinksSummary` | `backlinks_summary`, `run_audit` backlinks | `POST /backlinks/summary/live` | `GET /site-explorer/backlinks-stats?target=&date=<today>&mode=subdomains` (no `select`; it returns all 4 fields) plus `GET /site-explorer/domain-rating?target=&date=<today>` | With `SEMRUSH_V4_API_KEY`: `GET /apis/v4/backlinks/v1/overview?url=&scope=ROOT_DOMAIN&fields=backlinks_count,domains_count,new_count,lost_count,score`. Without it: `GET /analytics/v1/?type=backlinks_overview&target=&target_type=root_domain&export_columns=ascore,total,domains_num` |
| `serpLive` | `serp_check`, `suggest_competitors` SERP source, monthly `liveRanks` | `POST /serp/google/organic/live/regular` | none | none |
| `onPageInstant` | `run_audit` per-page on-page check | `POST /on_page/instant_pages` | none | none |
| `siteCrawl` (start, status, issue pages, URL list) | `run_audit fullCrawl`, `crawl_status`, `crawl_issue_pages`, `site_hygiene` crawl read | `/on_page/task_post`, `/on_page/summary`, `/on_page/pages` | none | none |
| `accountCheck` (free) | wizard, `setup_status`, `*_status` tools | `GET /appendix/user_data` | `GET /subscription-info/limits-and-usage` (documented as free) | `GET https://www.semrush.com/users/countapiunits.html?key=` (documented free; the docs show `http://`, and crawlmark uses https only, see 9.11 N8). The v4 key has no free check: it is saved untested and checked on first use |

**Rules the docs impose.** Each is cited in the research notes.

- **Ahrefs `country` is a lowercase alpha-2 enum** (`us`, `gb`). Its enum contains both `gb` and `uk`, and crawlmark sends `gb`.
  - `country` is required on organic-competitors and keywords-explorer overview, and optional on organic-keywords. crawlmark always sends it.
- **Ahrefs `date` is required** on organic-keywords, organic-competitors, backlinks-stats and domain-rating. crawlmark sends today's UTC date.
- **Ahrefs `limit` defaults to 1000**, so crawlmark always sends it.
- **Ahrefs `volume_mode=average` is sent on organic-keywords**, so `searchVolume` is a 12-month average, the same as keywords-explorer `volume`. The organic-keywords default, `monthly`, means the latest month.
- **Semrush `display_limit` is always sent.** Leaving it out returns 10,000 lines by default, which for `domain_organic` costs 100,000 units.
- **The Semrush v3 CSV header uses display names** (`Keyword;Search Volume;…`), not codes. The parser maps columns by the position of the `export_columns` crawlmark sent, and checks each header against `SEMRUSH_HEADER_TEXT` (code to documented header). A mismatch is a typed `SemrushFormatError`, never a silent mis-map.
- **Semrush databases** are lowercase, with the UK as `uk`. Mobile and `-ext` databases are never used.
- **Semrush prices are per line returned** (per request for backlinks). Empty responses cost nothing.

**Mapping to today's shapes.** Field names don't change. A value a provider doesn't supply is `null`.

- **`KeywordVolume`.**
  - Ahrefs: `volume` → `search_volume`, and `cpc` (USD cents) / 100 → `cpc`. `competition` is null.
  - Semrush v3: `Nq` → `search_volume`, and `Cp` (already USD) → `cpc`. `Co` (0–1) becomes `competition`: below 0.34 is `"LOW"`, below 0.67 is `"MEDIUM"`, anything higher is `"HIGH"`.
  - Neither provider fills `monthly_searches`.
- **`RankedKeyword`.**
  - Ahrefs: `best_position` → `position`, `best_position_url` → `url`, `volume` → `searchVolume`, `sum_traffic` → `estimatedTraffic`.
  - Semrush: `Po` → `position`, `Ur` → `url`, `Nq` → `searchVolume`, **`Tg` → `estimatedTraffic`**. The docs define `Tg` as estimated traffic and `Tr` as a percent share, so `Tr` is never requested.
- **`Competitor`.**
  - Ahrefs: `competitor_domain` (rows where it is null are dropped), `keywords_common` → `intersectingKeywords`, `traffic` → `estimatedTraffic`.
  - Semrush: `Dn`, `Np` → `intersectingKeywords`, `Ot` → `estimatedTraffic`.
  - `avgPosition` is null for both.
- **`BacklinksSummary`.**
  - Ahrefs: `metrics.live` → `backlinks`, and `metrics.live_refdomains` → `referringDomains`.
  - Semrush v4: `backlinks_count`, `domains_count`, `new_count` and `lost_count`.
  - Semrush v3: `total`, `domains_num`; new and lost are null.
  - `rank` and `spamScore` stay DataForSEO-only.
  - New, additive: `authority: { metric: "dataforseo_rank" | "domain_rating" | "semrush_score", value: number | null }`.
    - Ahrefs `domain_rating.domain_rating` gives `domain_rating`.
    - Semrush v4 `score` and v3 `ascore` both give `semrush_score`.
    - The docs call the v4 value "domain score (0–100)" and v3's column `ascore`. The two aren't documented as the same number, so the label is deliberately vendor-neutral.

**Market.**
- Ahrefs and Semrush both need a market. It comes from the new optional client field `country` (ISO alpha-2, stored uppercase).
- When `country` is unset, a country-level DataForSEO `locationCode` supplies it: 2000 + the ISO 3166 numeric code, e.g. 2840 → `US` and 2826 → `GB`. The table lives in `src/lib/country.ts`.
- `ahrefsCountry(cc)` returns lowercase (`gb`). `semrushDatabase(cc)` returns lowercase with `GB` → `uk`, and returns null outside the documented desktop list. That list is copied from semrush-api.md "Databases".
- A city-level code with no `country` makes Ahrefs and Semrush unavailable for that client, with this message: `Set country: XX for <client> in clients.yaml (or clients set <client> --country XX); Ahrefs/Semrush need a country, and locationCode <n> is not a country.`
- `languageCode` and `area` stay DataForSEO-only.

### 9.2 Provider interface

New file `src/providers/seo-data.ts`. Tools and reports import from here instead of from `dataforseo.ts`. The DataForSEO-only crawl, SERP and on-page functions are the exception and keep their direct imports.

```ts
export const PROVIDER_IDS = ["dataforseo", "ahrefs", "semrush"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type Capability = "keywordVolume" | "rankedKeywords" | "competitorDomains" | "backlinksSummary" | "serpLive" | "onPageInstant" | "siteCrawl";

/** Extra fields every routed result carries (additive to today's shapes). */
export interface ProviderMeta {
  provider: ProviderId;
  /** Set when the client's provider lacks the capability and DataForSEO served it. */
  fallbackFrom?: ProviderId;
  costUsd: number;            // as today; 0 for ahrefs/semrush
  units: number | null;       // null for dataforseo; 0 when served from cache
  fromCache: boolean;
}

export interface SeoDataProvider {
  id: ProviderId;
  capabilities: ReadonlySet<Capability>;
  /** Key/login present (no network). */
  configured(): boolean;
  keywordVolume?(client: Client, keywords: string[], opts?: CallOpts): Promise<{ result: KeywordVolume[] } & ProviderMeta>;
  rankedKeywords?(client: Client, target: string, limit: number, opts?: CallOpts): Promise<RankedKeywordsResult & ProviderMeta>;
  competitorDomains?(client: Client, limit: number, opts?: CallOpts): Promise<CompetitorsResult & ProviderMeta>;
  backlinksSummary?(client: Client, target: string, opts?: CallOpts): Promise<{ summary: BacklinksSummary | null } & ProviderMeta>;
}
interface CallOpts { refresh?: boolean; signal?: AbortSignal }

export class ProviderUnavailableError extends Error {
  constructor(readonly capability: Capability, readonly chosen: ProviderId, message: string) { super(message); }
}

/** The default provider and where it came from (9.3). Pure; tested on its own. */
export function resolveDefaultProvider(input: { raw: string | undefined; source: "env" | "envFile" | "default" }):
  { ok: true; provider: ProviderId; source: "env" | "envFile" | "default" } | { ok: false; invalidValue: string; message: string };

/** Pure: which provider serves `capability` for `client`, or why none can. */
export function resolveProvider(
  client: Pick<Client, "slug" | "dataProvider">,
  capability: Capability,
  env: { defaultProvider: ProviderId | { invalid: string }; configured: Record<ProviderId, boolean> },
): { provider: ProviderId; fallbackFrom?: ProviderId } | { unavailable: string };

// Routed entry points (same names and argument order as dataforseo.ts today):
export function searchVolume(client: Client, keywords: string[]): Promise<...>;
export function rankedKeywords(client: Client, target?: string, limit?: number): Promise<...>;
export function competitorDomains(client: Client, limit?: number): Promise<...>;
export function backlinksSummary(client: Client, target?: string): Promise<...>;
/** Throws ProviderUnavailableError unless DataForSEO is configured. Wraps dataforseo.ts serp/serpOrganic/instantPage/onPage*. */
export function requireDataForSeo(capability: Capability, client: Client): void;
```

**New files.** Each provider task cites its research note, and the fixtures copy the documented examples (9.7).

- **`src/providers/ahrefs.ts`.** The HTTP client: `request`, `paidUnits`, the four capability functions and `checkAhrefsKey`. It follows docs/research/ahrefs-api-v3.md "Endpoints".
- **`src/providers/ahrefs-shape.ts`** (pure).
  - The mappers.
  - `AHREFS_FIELD_UNITS`, copied from the documented field costs: `volume`, `sum_traffic`, `traffic`, `difficulty`, `keyword_difficulty` and `global_volume` cost 10; `live_refdomains` and `all_time_refdomains` cost 5; the rest cost 1.
  - `estimateAhrefsUnits(fields, rows) = max(50, sum(unique field units) × rows)`. The field list is the union of `select` and `order_by`, each field counted once, per the docs.
  - `unitsFromHeaders(h)`.
  - `classifyAhrefsError(status, body)`. The body is `{ error: string }`.
- **`src/providers/semrush.ts`.** The HTTP client: v3 reports, v3 or v4 backlinks, and `checkSemrushKey`. It follows docs/research/semrush-api.md "Endpoints".
- **`src/providers/semrush-shape.ts`** (pure).
  - `parseSemrushCsv(text, exportColumns)`: semicolon fields with a header row. It allows commas inside a field (the documented `Td` trends value), CRLF, a trailing newline and `export_escape` quotes, and it checks the header against `SEMRUSH_HEADER_TEXT`.
  - `parseSemrushError(text)`: a body matching `^ERROR (\d+) :: (.*)` becomes `SemrushApiError { code, text }`.
  - `parseSemrushV4Error(json)`: `{ meta, error: { code, message, retryable } }`.
  - `parseUnitsBalance(text)`: strips thousands separators and whitespace, so `1,000` gives 1000.
  - The mappers.
  - `SEMRUSH_UNITS`: `phrase_these` 10/line, `domain_organic` 10/line, `domain_organic_organic` 40/line, v4 backlinks overview 45/request, v3 `backlinks_overview` 40/request.
  - `estimateSemrushUnits(type, lines)`.
- **The DataForSEO adapter.** The functions in `dataforseo.ts` keep their signatures. A thin adapter in `seo-data.ts` adds `provider: "dataforseo"` and `units: null`.

**Errors the user sees.** These are never retried, because a retry could double-bill. 429 is the one exception, below.

| Condition (documented in the notes) | Message |
|---|---|
| Ahrefs 401 or 403 | `Ahrefs rejected the API key (AHREFS_API_KEY): <error>. Create one under Account settings > API keys.` The `{error}` text is included |
| Ahrefs 429 | `Ahrefs rate limit hit (60 requests/min by default); try again in a minute.` |
| Ahrefs 400 | `Ahrefs rejected the request: <error>.` This is a crawlmark bug; the message says so and names the endpoint |
| Semrush `ERROR 110`, `120`, `402` (v3) or 401 (v4) | `Semrush rejected the API key (SEMRUSH_API_KEY, or SEMRUSH_V4_API_KEY for v4 calls).` |
| Semrush `ERROR 130` or `135` | `Semrush API is not enabled for this account or report (needs an SEO Business plan plus an API unit package).` |
| Semrush `ERROR 132` | `Semrush API units balance is zero; buy units under Subscription info > API units.` |
| Semrush `ERROR 131`, `134` or v4 429 / `ERROR 429` | `Semrush request limit hit (10 requests/s, 10 at once); try again shortly.` |
| Semrush `ERROR 133` | `Semrush denied access to database <db> on this plan.` |
| Semrush `ERROR 40`–`46`, `10000`–`10040`, `605`, `613` | `Semrush rejected the request (<code>: <text>).` A crawlmark bug, as for Ahrefs 400 |

- **Semrush `ERROR 50 :: NOTHING FOUND` is not an error.** It becomes an empty result with `totalCount: 0` and `units: 0`, because the docs say empty responses cost no units.
- **Timeouts and aborts** record the pre-flight unit estimate, with endpoint `<path> (timeout, estimated)`, as `billedRequest` does today.
- **429.** One automatic retry after the `Retry-After` header, or after 2 s when there is none. Both docs describe 429 as throttling, so the request was not billed. A second 429 surfaces with the message above.

**Rate.** Each provider has its own in-process limiter:
- Ahrefs: at most 4 requests in flight and at least 1,000 ms between request starts, matching the documented 60/min.
- Semrush: at most 4 in flight and at least 100 ms between starts, matching the documented 10/s and 10 concurrent.

It reuses `mapLimit` from `src/lib/concurrency.ts`, plus a start-spacing helper. Batched keyword calls run one after another.

**Cache keys.**
- The new providers use `cacheKey("seo", provider, capability, { target, country, limit, keywords, semrushApi?: "v3" | "v4" })`.
- `date` is left out, so the weekly TTL holds.
- DataForSEO keeps its current `("dfs", baseUrl, path, body)` keys, so existing cache entries stay valid.
- The TTLs match today's: volume 30 days, ranked 7 days, competitors 30 days, backlinks 7 days.
- No TTL may exceed 30 days, because Semrush terms forbid caching API data for more than one month (semrush-api.md "Caching rule"). A test asserts this.

### 9.3 Config and clients.yaml

**Env** (`src/config.ts` EnvSchema, `.env.example`, manifest). An empty string, or a leftover `${user_config.x}` placeholder, counts as unset (`isUnsetValue` in `src/lib/env.ts`).

| Var | Type / default | Meaning |
|---|---|---|
| `SEO_DATA_PROVIDER` | `dataforseo \| ahrefs \| semrush`, matched after trimming and ignoring case; unset means `dataforseo` | Default provider for the four routed capabilities |
| `AHREFS_API_KEY` | string, optional | API v3 key (Account settings > API keys; workspace owner or admin) |
| `SEMRUSH_API_KEY` | string, optional | **v3** key (Subscription info > API units). Used for every v3 report and the balance check |
| `SEMRUSH_V4_API_KEY` | string, optional | **v4** key (profile > API keys). When set, backlinks use the v4 overview; when unset, they use the v3 overview |
| `AHREFS_MONTHLY_UNIT_CAP` | int > 0, default `50000` | Global Ahrefs units per calendar month (UTC) |
| `SEMRUSH_MONTHLY_UNIT_CAP` | int > 0, default `20000` | Global Semrush units per calendar month |
| `DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS` | int > 0, default `10000` | Per-client Ahrefs cap |
| `DEFAULT_CLIENT_MONTHLY_SEMRUSH_UNITS` | int > 0, default `5000` | Per-client Semrush cap |
| `AHREFS_BASE_URL`, `SEMRUSH_BASE_URL`, `SEMRUSH_BALANCE_URL` | url; test-only; read from the shell env only (Phase 8 `fromShell`) | Point tests at a fake server. Setup never writes them |

**`SEO_DATA_PROVIDER` validation and precedence** (decision D11).
- **Not part of EnvSchema's strict parse.** An invalid value would throw at import and kill the server, and Claude Desktop would only show "server disconnected". Instead, `config.ts` reads the raw value and calls `resolveDefaultProvider`.
- **Blank or unset** gives `dataforseo` (source `default`).
- **A known value**, matched ignoring case and spaces, gives that provider. The source is `env` (process env, e.g. the bundle or the shell) or `envFile` (`.env`).
- **Anything else** gives `{ ok: false }`. The server still starts and:
  1. writes one stderr line at startup: `crawlmark: SEO_DATA_PROVIDER is "moz", which isn't a provider crawlmark knows. Use dataforseo, ahrefs or semrush, or leave it blank for dataforseo.`;
  2. shows the "Data provider" row in `setup_status` with state `error`, that message as its detail, and `next` set to the change command (9.6);
  3. makes every routed call (9.2) throw `ProviderUnavailableError` with that message plus ` Change it with: <cli> setup --step provider, or in Claude Desktop's extension settings.`, before any request or budget check.

  DataForSEO-only tools (`serp_check`, crawls) are unaffected. Free tools are unaffected.
- **Blank bundle fields don't hide `.env`.** Before `process.loadEnvFile`, `config.ts` deletes from `process.env` the Phase 9 keys whose value is unset by `isUnsetValue`: `SEO_DATA_PROVIDER`, `AHREFS_API_KEY`, `SEMRUSH_API_KEY`, `SEMRUSH_V4_API_KEY` and the four cap vars.
  - Without this, a blank "Default SEO data provider" bundle field (passed as `""` or as the literal placeholder) would stop `.env` from supplying the value, because `loadEnvFile` never overrides a key that already exists.
  - Existing vars keep today's behaviour. Changing them is out of scope (9.11 follow-up).
- **Case is normalised for the default only.** The wizard writes lowercase values, and the CLI and `set_client_profile` reject unknown values. `clients.yaml` stays strict (below).

**clients.yaml** (`OverrideSchema` and `Client` in `src/lib/clients.ts`, documented in `docs/clients.md`):

```yaml
clients:
  example:
    domain: example.com
    dataProvider: ahrefs          # optional; overrides SEO_DATA_PROVIDER for this client
    country: US                   # optional ISO alpha-2; else derived from a country-level locationCode
    monthlyUnits:                 # optional per-client unit caps; else the DEFAULT_CLIENT_MONTHLY_* values
      ahrefs: 20000
      semrush: 5000
```

- `Client` gains three fields:
  - `dataProvider?: ProviderId`
  - `country: string | null`, resolved
  - `monthlyUnits: { ahrefs: number; semrush: number }`, resolved
- An invalid `dataProvider` or `country` fails `parseOverrides` with the existing `clients.<slug>.<field>` message style, which names the allowed values.
- `list_clients` shows `dataProvider` (the resolved value, marked `(default)` when inherited) and `country`.

**Setting the per-client fields.** Both go through the existing `setClientProfile` in `src/competitors.ts`, so YAML comments survive as they do today.
- **`set_client_profile`** (in `src/tools/competitors.ts`) gains two inputs:
  - `dataProvider: z.enum(["dataforseo","ahrefs","semrush",""]).optional()`, where `""` clears the override.
  - `country: z.string().regex(/^([A-Za-z]{2})?$/).optional()`, stored uppercase, where `""` clears it.

  Its description adds: `dataProvider overrides the default SEO data provider for this client; it chooses whose paid data is used, not credentials.`
- **`clients set <client>`** (in `src/cli.ts` and Phase 8's `src/cli-help.ts`) gains `--provider <dataforseo|ahrefs|semrush|none>` and `--country <XX|none>`.

### 9.4 Budgets and units

**Ledger migration** (`src/lib/store.ts`).
- After the `CREATE TABLE` block, run `ALTER TABLE spend ADD COLUMN units INTEGER NOT NULL DEFAULT 0`. It is guarded by `PRAGMA table_info(spend)`, so it runs once.
- Existing rows get 0. Older builds still work on a migrated file, because their `INSERT` names its columns.
- Rollback: none needed. The extra column is ignored and never dropped.

**Recording.**
- `recordSpend(client, provider, endpoint, costUsd)` keeps its signature.
- New `recordUnits(client, provider, endpoint, units)` writes `cost_usd = 0, units = n`.
- Actual units:
  - **Ahrefs:** the response header `x-api-units-cost-total-actual`, else `x-api-units-cost-total`, else the estimate. `x-api-cache: hit` gives 0. All of these are documented headers.
  - **Semrush:** the documented price × the lines returned, or the flat per-request price for backlinks. An empty result (ERROR 50, or zero lines) gives 0, as the docs say. Semrush documents no units header.
  - Each Ahrefs backlinks call (stats and DR) records its own row.

**Enforcement** (`src/lib/budget.ts`).
- New `assertUnits(client, provider, estimateUnits)` runs before every uncached Ahrefs or Semrush call.
- It throws `BudgetExceededError` when `unitsThisMonth(spendKeys(client), provider) + estimate > client.monthlyUnits[provider]`. The message is: `Ahrefs unit cap hit for example.com: 9,850 of 10,000 units this month. Raise monthlyUnits.ahrefs in clients.yaml (or DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS) to continue.`
- The global check is the same, against `<PROVIDER>_MONTHLY_UNIT_CAP`.
- Unit calls never touch the USD caps, and `assertBudget` is unchanged.
- Batched calls check the whole batch's estimate before the first request.

**Pre-flight estimates.** These are conservative ceilings, using `limit` as the row count. Field costs and prices come from the research notes.

| Call | Estimate | Basis |
|---|---|---|
| Ahrefs ranked keywords | max(50, (1+1+1+10+10) × limit) = 23 × limit | `volume`, `sum_traffic` cost 10; `order_by volume` counts once |
| Ahrefs competitors | max(50, (1+1+10) × limit) = 12 × limit | `traffic` costs 10 |
| Ahrefs volume | max(50, 12 × keywords) per batch | `volume` costs 10; `keyword`, `cpc` cost 1 |
| Ahrefs backlinks | 50 + 50 | backlinks-stats: 12/row × 1 row → 50 min; DR: the documented 50 min example |
| Semrush ranked keywords | 10 × limit | 10/line |
| Semrush competitors | 40 × limit | 40/line |
| Semrush volume | 10 × keywords | 10/line |
| Semrush backlinks | 45 (v4) or 40 (v3) | per request |

**Plan row caps.** Ahrefs caps rows per request by plan: Lite 100, Standard 250, Advanced 500, Enterprise unlimited (ahrefs-api-v3.md "Plans"). `limit` is sent as asked. When fewer rows come back, `totalCount` and the units recorded reflect what came back. Nothing is clamped silently.

**Semrush partial results.** When the balance runs low, the docs say per-line reports return "the number of lines for which you have enough API units". So when a Semrush per-line response has fewer lines than `display_limit` (or than the keywords sent), the result adds `notes: ["Semrush returned N of M requested lines; if your unit balance is low, results may be cut short (semrush_status shows the balance)."]`. This is additive. Telling truncation apart from "no more data" is in 9.11.

**`spend_summary` output.** All additions; the existing keys stay.

```jsonc
{
  "month": "2026-10", "totalUsd": 1.23, "globalCapUsd": 50,
  "byClient": [{ "client": "example.com", "provider": "ahrefs", "calls": 3, "cost_usd": 0, "units": 2350 }],
  "units": {
    "ahrefs":  { "used": 2350, "globalCap": 50000 },
    "semrush": { "used": 0,    "globalCap": 20000 }
  }
}
```

`SpendRow` gains `units`, and `mergeSpendRows` sums it. Rows are sorted by `cost_usd`, then `units`.

### 9.5 Fallback rules

`resolveProvider` is pure and tested as a truth table.

1. The chosen provider is `client.dataProvider ?? default`. When the default is invalid (9.3) and the client has no override, the call throws `ProviderUnavailableError` with the invalid-value message.
2. If the chosen provider has the capability and is configured, it serves the call.
3. If the chosen provider **lacks** the capability (`serpLive`, `onPageInstant` and `siteCrawl` for Ahrefs and Semrush), DataForSEO serves it when configured, and the result carries `fallbackFrom: <chosen>`.
   - When DataForSEO isn't configured, the call throws `ProviderUnavailableError`: `Live SERP checks need DataForSEO; ahrefs (the provider for example.com) doesn't offer them. Run setup --step dataforseo.`
4. If the chosen provider **has** the capability but its key isn't set, the call throws `ProviderUnavailableError`: `SEO_DATA_PROVIDER is ahrefs but AHREFS_API_KEY is not set. Run setup --step ahrefs, or setup --step provider to pick another default.`
   - Nothing falls back, so spend never moves to another account without the user knowing (D2).
5. When a configured provider fails (an error, units exhausted, a budget cap), the error goes up as-is. Nothing falls back.
6. DataForSEO chosen and not configured: the call throws `ProviderUnavailableError` with today's "not set" wording.

**Where unavailable shows up.**
- **Tools.** `ProviderUnavailableError` reaches the tool `handler` and becomes a normal tool error with that text. `usage_summary` records the error class `ProviderUnavailableError`.
- **Reports.**
  - `section()` in `src/reports/section.ts` returns `{ ok: false, error, unavailable: true }` for this error class. This is an additive field.
  - `run_audit`: `crawl`, `links` and each page's `onPage` become unavailable sections. Findings treat them like any other failed section: unverified, not "passed".
  - `monthly_report` with `liveRanks: true`: the SERP check runs once before the tracked-keyword loop. When it's unavailable, every row keeps its GSC values with `liveRank: null`, and the section adds `liveRanks: { available: false, reason }`. The whole section no longer fails.
  - `suggest_competitors`: when no SERP provider is available, the SERP source is skipped with a note in `notes`, the same way GSC failures are handled today. The overlap source uses the routed `competitorDomains`.
  - Each source's provider and units go into the response's spend object as `units: { ahrefs?: n, semrush?: n }`, next to `costUsd`.
- **Brand inference.** It uses the routed `rankedKeywords`. When that is unavailable, the existing note path applies.

### 9.6 Wizard, status, MCP side, manifest

**Wizard** (`src/setup/wizard.ts`, after Phase 8).

- **Step names.** The public `STEP_NAMES` becomes `node, provider, dataforseo, ahrefs, semrush, google, psi, discovery, register`. These are the values `--step` accepts, and `help setup` lists them.
- **Run plans.** `runWizard` builds its plan from the step names and two internal phases, `provider:pick` and `provider:default`, which are not `--step` values.

  | Invocation | Plan |
  |---|---|
  | full run (`init`, `setup`) | `node → provider:pick → dataforseo → ahrefs → semrush → provider:default → google → psi → discovery → register` |
  | `--step provider` | `provider:pick → <the credential steps for providers ticked but not working> → provider:default` |
  | `--step dataforseo`, `ahrefs` or `semrush` | that credential step, then `provider:default` |
  | any other `--step` | unchanged |

  - In a full run, a credential step for an unticked provider returns `{ outcome: "skipped", message: "Not selected." }` and prompts nothing.
  - `--step <provider>` always runs that provider's step, ticked or not, as today.
- **WizardContext** gains `providers?: { selected: ReadonlySet<ProviderId>; working: Set<ProviderId> }`.
  - `provider:pick` fills `selected`.
  - Each credential step adds to `working` when its check passes.
  - When `provider:default` starts, it also adds any provider whose status is already `working`.
- **`provider:pick`.**
  1. Show the status of the three providers and the current default, with its source: `.env`, `shell env` or default.
  2. Ask the multi-select through Phase 8's `ctx.prompt.multiselect`: "Which SEO data providers do you have?"
     - The options are DataForSEO, Ahrefs and Semrush, with the one-line hints from 9.0.
     - Pre-ticked: the providers with a key. On a fresh home, DataForSEO only, so Enter keeps today's flow.
     - An empty selection is allowed, and prints `No paid provider selected. Free tools (Search Console, GA4, audits) still work. Add one later with setup --step provider.`
     - If DataForSEO is unticked while Ahrefs or Semrush is ticked, it prints `Live SERPs, on-page checks and crawls need DataForSEO; without it those parts of run_audit and serp_check are skipped.`
  3. Never deletes a key.
- **`stepAhrefs` and `stepSemrush`** follow `stepDataForSeo` through `ctx.ui`:
  1. Show the status.
  2. Ask "Set it up now?"
  3. Read the masked key.
  4. Check it under a spinner (`Checking with Ahrefs (free limits-and-usage call)…`), up to `MAX_ATTEMPTS`.
  5. Save it to `.env` (0600).

  Semrush specifics:
  - After the v3 key works, it asks `Add a Semrush v4 key too? (backlinks use the v4 overview; without it they use the older v3 report)`, defaulting to no.
  - The v4 key is saved untested, with the line `Saved; Semrush has no free check for v4 keys, so it's checked the first time backlinks_summary runs.`
  - Under `--yes`, the v4 question is skipped.
- **Success lines.**
  - `✔ Ahrefs works  plan <subscription>, key <units_usage_api_key> of <units_limit_api_key> units used (resets <usage_reset_date>)`. A null `units_limit_api_key` shows the workspace numbers. These are all documented limits-and-usage fields.
  - `✔ Semrush key accepted  <n> API units left`. It says "accepted", not "works" (D4).
- **Failure lines.**
  - `✖ Ahrefs rejected that key. Create one under Account settings > API keys (workspace owner or admin).`
  - `✖ Semrush rejected that key (ERROR <n>). Find the v3 key under Subscription info > API units.`
  - A Semrush key with a zero balance is a `warn`, not a fail: `Key accepted but the balance is 0 units; Semrush API needs an SEO Business plan and a unit package.`
  - An unreachable API asks "Save it anyway?" (default no), as DataForSEO does today.
- **`provider:default`.**
  - Let `W` be the set of working providers.
  - **`|W| = 0`:** writes nothing, and prints `No working provider yet; paid tools stay unavailable.`
  - **`|W| = 1`:** no question. If that provider differs from the effective default, it writes `SEO_DATA_PROVIDER=<it>` and prints `Default: Ahrefs (the only provider set up).`
  - **`|W| ≥ 2`:** `ctx.prompt.choose("Default provider for keyword, competitor and backlink data", W)`.
    - The pre-selected choice is the current default if it is in `W`, otherwise the first of `W` in the order dataforseo, ahrefs, semrush.
    - It writes `SEO_DATA_PROVIDER` only when the choice differs from the effective value.
    - The note says: `Each client can override this (dataProvider in clients.yaml, or clients set <client> --provider).`
  - It then prints `Live SERPs, on-page checks and crawls still use DataForSEO.`, adding `(not set up)` when DataForSEO isn't working.
  - When `SEO_DATA_PROVIDER` is in `ctx.shellEnvKeys`, it gives the existing shell-override warning.
  - Under `--yes`, it applies the D9 rule from 9.0 without prompting.
- **Summary box.** Phase 8's box gains `Ahrefs` and `Semrush` rows. The default is marked `(default)`. The next-steps list ends with `Change providers: <prefix> setup --step provider`.
- **Account checks.** `checkAhrefsKey(key, fetchImpl)` and `checkSemrushKey(key, fetchImpl)` are exported from the provider files and shaped like `checkDataForSeoCredentials`. They return `{ configured, works: true|false|null, reachable, …facts, error, costUsd: 0 }` and never throw.

**Status** (`src/setup/status.ts`, `status-providers.ts`, Phase 8 `status-render.ts`).
- `INTEGRATIONS` gains `seoprovider` (label "Data provider"), then `ahrefs` and `semrush`, all after `dataforseo`.
- `StatusProviders` gains `ahrefs()`, `semrush()` and `seoDataProvider()`. The last returns `{ default: ProviderId | null, source, invalidValue?: string, perClientOverrides: number }`.
- **The `seoprovider` row.**

  | State | When | Detail / next |
  |---|---|---|
  | `working` | the default is valid and its provider is `working` | `Ahrefs (default, from .env). DataForSEO for live SERPs, on-page and crawls.` |
  | `configured` | the default's provider is `configured` (unreachable) | |
  | `missing` | `SEO_DATA_PROVIDER` is unset (DataForSEO by default) and DataForSEO has no login: a fresh or free-only install | `next` is `<cli> setup --step provider` |
  | `error` | the default is invalid, or an explicitly chosen provider has no key (or it was rejected) | `next` is `<cli> setup --step provider` |

  - When `source` is `env` and the home's `configuredByEnv` is true (a bundle), `next` instead says `Change "Default SEO data provider" in Claude Desktop > Settings > Extensions > Crawlmark`.
  - `data` holds `{ default, source, invalidValue?, configured: { dataforseo, ahrefs, semrush }, perClientOverrides, change }`, where `change` is always the CLI command.
- **The `ahrefs` and `semrush` rows.**
  - `missing`: no key, and the provider isn't chosen by default or by any client.
  - `error`: chosen (by default or by a client), but the key is missing or rejected.
  - `configured`: the API is unreachable, or (Semrush) the key was accepted but the v4 key is untested.
  - `working`: otherwise.
  - `data` holds `{ default: boolean, plan|unitsLeft, unitsUsedThisMonth, cap, v4KeySet? }` and never a key.
- **The DataForSEO row** adds ` Fallback for live SERPs, on-page and crawls.` to its detail when another provider is the default.
- **`setup status --only`** accepts `seoprovider,ahrefs,semrush`.

**MCP side** (no tool changes the provider; D12).
- **`setup_status`.**
  - Its description adds: `Also reports the default SEO data provider (seoprovider row: which of DataForSEO, Ahrefs, Semrush is the default, where the setting comes from, and which are configured). The provider is changed in a terminal with the command in its next field, never through chat.`
  - The report gains a top-level additive `seoDataProvider` object, equal to the `seoprovider` row's `data`, so prompts can read it without searching the rows.
- **`getting-started` prompt** (`src/prompts/templates/getting-started.md`):
  - **Step 1:** after the table, state the default provider and its source from `seoDataProvider`. Give the way to change it: the bundle field when `source` is `env` and `home.data.configuredByEnv` is true, otherwise the `change` command, run in a terminal.
  - **Step 2:** "With DataForSEO it adds…" becomes "With a data provider (DataForSEO, Ahrefs or Semrush; yours is <default>) it adds keyword volumes, rankings, competitors and backlinks. DataForSEO is also needed for live rankings, on-page checks and crawls." The cost wording reads "DataForSEO charges a little per call; Ahrefs and Semrush use your plan's API units; all are capped by monthly budgets".
  - The existing rule about never accepting secrets in chat stays, and now names the Ahrefs and Semrush keys.
- **`client-health-check` prompt.** It mentions `ahrefs_status`, `semrush_status`, the client's resolved `dataProvider`, and `units` in `spend_summary`.
- **Tools** (`src/tools/raw.ts`).
  - The routed tools import from `seo-data.ts`. Their descriptions change from "Paid" to "Paid (DataForSEO, Ahrefs or Semrush, per client)".
  - New free tools `ahrefs_status` and `semrush_status`, modelled on `dataforseo_status`. They are read-only, never cached, record no spend and never show a key.
  - `serp_check` is unchanged apart from adding `provider: "dataforseo"`.

**MCPB manifest** (`mcpb/manifest.json`, `manifest_version` stays `0.3`).
- **New `user_config` entries,** each `required: false` and each mapped in `server.mcp_config.env`. None has a `default`, so a blank field defers to `.env` (9.3):
  - `seo_data_provider`: string, title "Default SEO data provider", description `dataforseo, ahrefs or semrush. Leave blank to use the value from your crawlmark .env (set by npx crawlmark-mcp setup --step provider), or dataforseo if none. Any other value is reported as an error by setup_status.` Its env var is `SEO_DATA_PROVIDER`.
  - `ahrefs_api_key`: string, sensitive, title "Ahrefs API key", description `Optional. API v3 key from Account settings > API keys (Lite plan or higher; workspace owner or admin).`
  - `semrush_api_key`: string, sensitive, title "Semrush API key (v3)", description `Optional. From Subscription info > API units. Needs an SEO Business plan and an API unit package.`
  - `semrush_v4_api_key`: string, sensitive, title "Semrush API key (v4, optional)", description `Optional. From your profile > API keys. Used for the newer backlinks report; without it crawlmark uses the v3 report.`
  - `ahrefs_monthly_unit_cap` and `semrush_monthly_unit_cap`: number, `min: 1`, with descriptions giving the defaults (50,000 and 20,000).

  The schema has no enum, so the allowed values are given in the description and checked by the server (9.3).
- The new tools are added to `tools`.
- `description` and `long_description` mention Ahrefs, Semrush and choosing a default provider.
- `keywords` gains `ahrefs` and `semrush`.

**Docs.**
- **`.env.example`:** a block per new var, with where to get the key and the plan requirement (Ahrefs Lite or higher; Semrush SEO Business plus a unit package; v3 and v4 keys).
- **`README.md`:**
  - **Install sections.** "npx and the setup wizard" says the wizard asks which providers you have and which is the default. "Claude Desktop bundle (MCPB)" lists the new fields and the blank-field rule. "From source" points to `setup --step provider`.
  - **New sections** "Ahrefs" and "Semrush", after "DataForSEO", in the same shape as the DataForSEO one: what you need, then the `setup --step` command.
  - **A "Data providers" section** with the short capability table, the default and per-client override, the fallback rule, and units versus USD.
  - **The step table** lists `provider`, `ahrefs` and `semrush`. The env table lists the new vars.
- **`docs/clients.md`:** the three new fields, plus `clients set --provider/--country`.
- **`implementation.md`:** a Phase 9 link to this spec.

### 9.7 Files (all backend)

| File | Change |
|---|---|
| `src/providers/seo-data.ts` (new) | types, `PROVIDER_IDS`, `resolveDefaultProvider`, `resolveProvider`, `ProviderUnavailableError`, routed functions, DataForSEO adapter |
| `src/providers/ahrefs.ts`, `ahrefs-shape.ts` (new) | client, account check, pure mappers, estimates and error classifier (cites docs/research/ahrefs-api-v3.md) |
| `src/providers/semrush.ts`, `semrush-shape.ts` (new) | client (v3 reports, v3/v4 backlinks), account check, CSV/header parser, mappers, estimates and error classifiers (cites docs/research/semrush-api.md) |
| `src/lib/country.ts` (new) | locationCode → alpha-2 table, `ahrefsCountry`, `semrushDatabase` and the documented Semrush database list |
| `src/lib/rate.ts` (new) | start-spacing limiter used by both clients |
| `src/providers/dataforseo.ts` | no behaviour change; export `isDataForSeoConfigured()` |
| `src/config.ts`, `src/lib/env.ts` | new env vars; drop unset Phase 9 keys before `loadEnvFile`; lenient `SEO_DATA_PROVIDER` resolution and stderr line |
| `src/lib/clients.ts` | `dataProvider`, `country`, `monthlyUnits` |
| `src/competitors.ts`, `src/tools/competitors.ts` | `setClientProfile` and `set_client_profile` gain `dataProvider` and `country` |
| `src/cli.ts`, `src/cli-help.ts` | `clients set --provider/--country`; step list in help (`provider`, `ahrefs`, `semrush`) |
| `src/lib/store.ts`, `src/lib/budget.ts`, `src/lib/spend.ts` | `units` column, `recordUnits`, `assertUnits`, `unitsThisMonth`, summary |
| `src/tools/raw.ts`, `src/tools/reports.ts`, `src/tools/setup.ts` | routed imports, new status tools, `spend_summary` units, `setup_status` description |
| `src/brand-inference.ts` | routed imports, units in spend, SERP-unavailable note |
| `src/reports/section.ts`, `monthly.ts`, `audit.ts` | `unavailable` flag, `liveRanks` availability |
| `src/setup/wizard.ts`, `src/setup/cli-setup.ts` | `provider` step, `provider:pick`/`provider:default` phases, `stepAhrefs`, `stepSemrush`, run plans, summary rows, `--yes` rules |
| `src/setup/status.ts`, `status-providers.ts`, `status-render.ts` | `seoprovider`, `ahrefs`, `semrush` rows; `seoDataProvider` in the report; `--only` values |
| `src/prompts/templates/getting-started.md`, `client-health-check.md` | provider wording and how to change it; new status tools, units |
| `mcpb/manifest.json`, `.env.example`, `README.md`, `docs/clients.md`, `implementation.md` | as in 9.6 |
| `test/fixtures/ahrefs/*.json` (new) | built from the documented response schemas in ahrefs-api-v3.md, values invented, example.com/example.org only |
| `test/fixtures/semrush/*.csv`, `*.json`, `*.txt` (new) | the documented examples from semrush-api.md, copied verbatim for header text, column order, number formats and the commas inside `Td`, with domains replaced by example.com/example.org; plus `error-50.txt` (`ERROR 50 :: NOTHING FOUND`), `error-120.txt`, `error-132.txt`, `balance.txt` (`1,000`), and `v4-error-403.json` (the documented v4 error body) |
| `test/*.test.ts` | see 9.9 |

### 9.8 Tasks

One agent (backend) does all of these. Each task is its own commit.
- Tasks 1 and 2 can run in either order.
- Task 3 needs task 2.
- Ahrefs (4, 5) comes before Semrush (6, 7).
- Task 5b needs tasks 5 and 3.
- Live verification (10) comes last and waits for a key.

1. **Ledger units and budgets.** Blocks 4 and 6. The migration, `recordUnits`, `assertUnits`, `unitsThisMonth`, `SpendRow.units` and the `spend_summary` additions, plus tests.
2. **Config, clients and country.** Blocks 3, 4 and 6.
   - The env vars, the unset-key drop before `loadEnvFile`, and `resolveDefaultProvider` with the stderr line.
   - The clients.yaml fields, `country.ts` with the Semrush database list from semrush-api.md "Databases", and `list_clients` output.
   - `set_client_profile` and `clients set` with `dataProvider`/`--provider` and `country`/`--country`.
3. **Provider layer, DataForSEO only.** After 2.
   - `seo-data.ts`, `resolveProvider` (including the invalid-default case) and the DataForSEO adapter.
   - Switch `raw.ts`, `competitors.ts`, `brand-inference.ts`, `audit.ts` and `monthly.ts` to the routed functions and `requireDataForSeo`.
   - The `section` `unavailable` flag and monthly `liveRanks` availability.
   - With no other provider configured, every existing test passes unchanged apart from the additive `provider`/`units` fields.
4. **Ahrefs provider.** After 1 to 3. **Read docs/research/ahrefs-api-v3.md first**; every parameter name, enum, field cost and header comes from it.
   - The shape file, the client, the four capabilities with the documented required params (`select`, `date`, lowercase `country`, `limit`, `mode`, `volume_mode=average`), estimates, header-based units, the error classifier (`{ error }`), `checkAhrefsKey` and `ahrefs_status`.
   - Fixtures follow the documented schemas.
5. **Ahrefs setup and status.** After 4.
   - `stepAhrefs`, the `ahrefs` status row, and the manifest and `.env.example` entries for Ahrefs.
5b. **Provider choice at install.** After 5 and 3.
   - The `provider` step name, the `provider:pick` and `provider:default` phases, the run plans, and the `--yes` rules.
   - The `seoprovider` status row and the `seoDataProvider` report field.
   - The `setup_status` description, the `getting-started` prompt changes, and the summary box rows.
   - The manifest `seo_data_provider` field.
6. **Semrush provider.** After 4, reusing its patterns. **Read docs/research/semrush-api.md first.**
   - The CSV parser with header-text checking, the v3 report types with `display_limit` always set, v4 backlinks when `SEMRUSH_V4_API_KEY` is set and v3 `backlinks_overview` at `/analytics/v1/` when it isn't.
   - The v3 and v4 error classifiers, the partial-lines note, `checkSemrushKey` (https balance URL) and `semrush_status`.
   - Fixtures copy the documented examples.
7. **Semrush setup and status.** After 6 and 5b. `stepSemrush` with the optional v4 key, the `semrush` status row, and the manifest and `.env.example` entries for Semrush.
8. **Docs.** After 7. README (the install sections, the provider sections and the "Data providers" section), `docs/clients.md`, `.env.example`, the prompt templates and `implementation.md`.
9. **Manual check without keys.** After 8.
   - Run the **Done when** items that need no key: fake keys against a local fake server through `AHREFS_BASE_URL`, `SEMRUSH_BASE_URL` and `SEMRUSH_BALANCE_URL`, `init --dry-run`, `setup --step provider --dry-run`, `setup --yes --dry-run` with a temp `CRAWLMARK_HOME`, and the MCP `setup_status` call with `SEO_DATA_PROVIDER=moz`.
10. **Live verification.** Deferred until the user has a key. **The user must approve before any billable call.**
    1. Run each provider's free account check.
    2. **Ahrefs, at no unit cost:** run each Site Explorer endpoint against the documented free target `ahrefs.com`, and keywords-explorer overview with `keywords=ahrefs` (ahrefs-api-v3.md "Free test queries"). Compare the fields and the `x-api-units-cost-*` headers with the fixtures and estimates.
    3. **Semrush has no free report calls.** With approval, make one call per report with `display_limit=5` on a domain the user owns, about 10×5 + 40×5 + 10×5 + 45 = 345 units.
    4. Fix the mappers if anything differs.
    5. Answer each item in 9.11 and record the results there.

### 9.9 Test plan

No test reaches the network.
- `fetch` is stubbed (`vi.stubGlobal`) as in `test/dataforseo-timeout.test.ts`.
- `test/setup.ts` clears `AHREFS_API_KEY`, `SEMRUSH_API_KEY`, `SEMRUSH_V4_API_KEY` and `SEO_DATA_PROVIDER`, and points all three base URLs at `http://127.0.0.1:9`, so an unstubbed call fails at once.
- Fixtures use example.com and example.org only.

- **`resolveDefaultProvider`.**
  - Unset, `""`, `"  "` and `"${user_config.seo_data_provider}"` all give dataforseo/default.
  - `"Ahrefs "` gives ahrefs.
  - `"moz"` gives `{ ok: false }`, with a message naming all three values and saying blank means dataforseo.
  - The source is `env` versus `envFile`, using `ENV_FILE_KEYS`.
- **Config precedence.**
  - With the process env `SEO_DATA_PROVIDER=""` and `.env` `SEO_DATA_PROVIDER=semrush`, the effective default is semrush (source `envFile`).
  - With the process env `ahrefs` and `.env` `semrush`, it is ahrefs (source `env`).
  - An invalid value doesn't throw at import. The server module loads, and `setup_status` returns the `seoprovider` row as `error`.
- **`resolveProvider` truth table.** Every combination of chosen provider (default, client override or invalid default), capability and configured set gives the expected provider, `fallbackFrom` or unavailable message, following rules 1 to 6.
- **Ahrefs shape** (fixtures from ahrefs-api-v3.md).
  - Each mapper turns its fixture into today's types: cents become dollars, rows with a null `competitor_domain` are dropped, and `authority.metric` is `domain_rating`.
  - `estimateAhrefsUnits` gives 50 as a floor, 23 × 100 for ranked keywords, and 50 for backlinks-stats, where 12 per row × 1 row is under the floor. An `order_by` field already in `select` counts once.
  - `unitsFromHeaders` prefers `-actual`, then the total, and `x-api-cache: hit` gives 0.
  - The error classifier handles `{error}` bodies for 400, 401, 403, 429 and 500.
  - The request builder always sends `date`, `limit` and lowercase `country`, and sends `volume_mode=average` on organic-keywords (asserted on the stubbed URL).
- **Semrush shape** (fixtures from semrush-api.md).
  - The CSV parser reads the documented `domain_organic` example, including the `Td` value with commas, and maps by `export_columns` position.
  - A header that doesn't match `SEMRUSH_HEADER_TEXT` throws `SemrushFormatError`.
  - It handles quoted fields (`export_escape=1`), CRLF and a trailing newline.
  - `ERROR 50 :: NOTHING FOUND` gives an empty result with 0 units.
  - ERROR 110, 120, 130, 131, 132, 133, 134 and 135 map to the typed errors and messages in 9.2.
  - The documented v4 error JSON maps by `error.code`.
  - `parseUnitsBalance("1,000\n")` is 1000.
  - `Co` maps to LOW/MEDIUM/HIGH at the boundaries. `Tg` is the `estimatedTraffic` source, and `Tr` is never requested (asserted on the URL).
  - The GB database is `uk`. An undocumented database gives null.
  - Every request URL contains `display_limit`.
- **Semrush backlinks route.** With only `SEMRUSH_API_KEY`, the request goes to `/analytics/v1/?type=backlinks_overview` with `target_type=root_domain` (40 units). With `SEMRUSH_V4_API_KEY`, it goes to `/apis/v4/backlinks/v1/overview` with `Authorization: Apikey` (45 units). The v4 key never appears in a query string.
- **Budgets.**
  - `assertUnits` blocks at the client cap and at the global cap.
  - USD and unit caps are independent: an Ahrefs call still runs when the USD budget is spent, and the reverse also holds.
  - A timeout records the estimated units.
  - A cached call records nothing.
  - The migration adds `units` once and keeps old rows.
  - Every Semrush-backed cache TTL is 30 days or less.
- **Partial lines.** A Semrush ranked call with `display_limit=10` and a fixture of 4 lines returns 4 rows, records 40 units, and adds the partial-lines note.
- **Rate.** The limiter spaces request starts by at least 1,000 ms for Ahrefs and 100 ms for Semrush (fake timers). One 429 is retried once; a second 429 surfaces.
- **Routed calls.**
  - A stubbed Ahrefs or Semrush server returns the fixtures.
  - Each routed tool returns `provider`, `units` and `fromCache`, and the ledger row matches.
  - A second call is served from cache, keyed with the provider. Switching a client's provider does not return the other provider's cached data.
- **Reports.**
  - `run_audit` with Ahrefs chosen and no DataForSEO: backlinks are served by Ahrefs, and the onPage and crawl sections are `unavailable: true`.
  - `monthly_report` with `liveRanks` and no DataForSEO keeps the GSC values, with `liveRanks.available: false`.
  - `suggest_competitors` notes the skipped SERP source.
- **Per-client override.**
  - `set_client_profile` with `dataProvider: "semrush"`, `country: "gb"` stores `semrush` and `GB` and keeps comments in clients.yaml. `""` clears both.
  - `clients set example.com --provider none --country none` clears both.
  - `--provider moz` exits 2 with the allowed values.
- **Setup** (fake fetch, `recordingUi`, temp home).
  - **`provider:pick`.**
    - On a fresh home, the multi-select defaults to `[dataforseo]`.
    - With an Ahrefs key in `.env`, the defaults are `[ahrefs]` plus any other configured providers.
    - An empty selection prints the free-tools line.
    - Unticking a configured provider leaves `.env` unchanged.
  - **Full run, selecting `ahrefs` only:** the DataForSEO and Semrush steps return `skipped`/"Not selected." with no prompts recorded, and the Ahrefs step runs.
  - **`stepAhrefs` and `stepSemrush`.** Four cases: working; rejected (asks again, at most 3 attempts); unreachable (save untested only on yes); Semrush zero balance (warn). The Semrush v4 follow-up saves `SEMRUSH_V4_API_KEY` with no fetch.
  - **`provider:default`.**
    - With 0 working providers, nothing is written.
    - With 1 working provider (Ahrefs) and no `SEO_DATA_PROVIDER`, it writes `SEO_DATA_PROVIDER=ahrefs` with no prompt.
    - With 2 working providers, it prompts with the current default pre-selected, and writes only on change.
    - When `SEO_DATA_PROVIDER` is in `shellEnvKeys`, it gives the warning.
  - **`--step provider`** with both DataForSEO and Ahrefs already working: no credential prompts, only the multi-select and the default select.
  - **`--step semrush`** runs the Semrush step, then `provider:default`.
  - **`--yes` on a fresh home:** no prompt is consumed. Ahrefs and Semrush are `skipped` with the `needs a key` message. `SEO_DATA_PROVIDER` is not written, and the run's exit code is unchanged from Phase 8.
  - **`--yes` with an invalid `SEO_DATA_PROVIDER=moz` in `.env` and DataForSEO working:** it writes `dataforseo`.
  - **Rendering.** Plain-mode transcripts contain no ANSI codes. Fancy mode records `multiselect`, a spinner per check and `select` events.
- **Status.**
  - Each `seoprovider`, `ahrefs` and `semrush` state in 9.6 is covered.
  - A bundle-sourced default (`source: env`, `configuredByEnv: true`) gets the extension-settings `next`.
  - A sentinel key string never appears in the report JSON or the rendered text.
  - `setup status --only seoprovider,ahrefs,semrush --json` returns those three rows.
- **Prompt.** The rendered `getting-started` template contains `setup --step provider` and the extension-settings wording, and never asks for a key.
- **Manifest.**
  - Each new `user_config` maps to an env var that config accepts.
  - `seo_data_provider` has no `default` and its description names all three values.
  - The three key fields are `sensitive: true`.
  - The two cap fields are numbers with `min: 1`.
  - `test/mcpb-manifest.test.ts` passes.

**Done when**

- [ ] `npm run typecheck` and `npm test` pass on top of merged Phase 8.
- [ ] `grep -rn "api.ahrefs.com\|api.semrush.com\|semrush.com/users" test/` matches only fixture metadata or base-URL assertions. A test fails if any stubbed request goes to a real host.
- [ ] Each provider source file has a header comment citing its research note, and every Semrush fixture's header line equals the documented header text in docs/research/semrush-api.md (a test compares them).
- [ ] With only DataForSEO configured, `keyword_volume`, `ranked_keywords`, `competitor_domains`, `backlinks_summary` and `serp_check` return every field they return today, plus `provider: "dataforseo"` (the fixture tests diff the key sets).
- [ ] `resolveProvider` has a test case for each of rules 1 to 6 in 9.5, plus the invalid-default case.
- [ ] Starting the server with `SEO_DATA_PROVIDER=moz`:
  - it does not exit;
  - stderr shows the one-line message naming dataforseo, ahrefs and semrush;
  - `setup_status` returns `seoprovider.state: "error"`;
  - `keyword_volume` returns a tool error with that message and makes no request.
- [ ] With the process env `SEO_DATA_PROVIDER=""` and `.env` `SEO_DATA_PROVIDER=ahrefs`, `setup_status.seoDataProvider` is `{ default: "ahrefs", source: "envFile", … }`.
- [ ] Opening a ledger file created before Phase 9 adds the `units` column once. `spend_summary` returns `units.ahrefs.used` and `units.semrush.used`, and `totalUsd` is unchanged.
- [ ] An Ahrefs call whose estimate goes over `monthlyUnits.ahrefs` throws `BudgetExceededError` naming the cap and the clients.yaml field, and makes no request (the fetch stub records zero calls).
- [ ] `run_audit` for a client with `dataProvider: ahrefs` and no DataForSEO login returns `links.ok: true` (from the Ahrefs fixture) and `onPage.unavailable: true`, and the report still saves.
- [ ] `npm run cli -- init --dry-run` in a real terminal (temp `CRAWLMARK_HOME`, fake servers) shows, in this order:
  1. the provider multi-select with DataForSEO pre-ticked;
  2. only the ticked providers' credential steps;
  3. the "Default provider" select, which appears only when two or more providers work;
  4. the summary box with `(default)` on one provider.

  It writes nothing.
- [ ] `npm run cli -- setup --step provider --dry-run`, with DataForSEO and Ahrefs already working in a temp `.env`, shows the current state of all three providers first, asks no credential question, then shows the default select.
- [ ] `npm run cli -- setup --step ahrefs --dry-run` and `--step semrush --dry-run`, against the local fake server, show a masked key prompt, a spinner and a ✔ line with plan or units, and they write nothing.
- [ ] `npm run cli -- setup --yes` on a fresh temp home completes without reading stdin. Its output marks Ahrefs and Semrush `skipped` with `needs a key`, and `.env` has no `SEO_DATA_PROVIDER`.
- [ ] `printf 'dataforseo,ahrefs\n' | npm run cli -- setup --step provider --dry-run` runs in plain mode with no escape codes (`| cat -v` shows no `^[`).
- [ ] `npm run cli -- setup status --only seoprovider,ahrefs,semrush --json` shows the states from 9.6, with no key in the output.
- [ ] `npm run cli -- clients set example.com --provider ahrefs --country GB` writes `dataProvider: ahrefs` and `country: GB` to clients.yaml, and `list_clients` shows them.
- [ ] `mcpb/manifest.json` lists the six new `user_config` entries (`seo_data_provider`, `ahrefs_api_key`, `semrush_api_key`, `semrush_v4_api_key`, `ahrefs_monthly_unit_cap`, `semrush_monthly_unit_cap`) and the two new tools, and `test/mcpb-manifest.test.ts` passes.
- [ ] The `getting-started` template mentions `setup --step provider` and the extension-settings field. `README.md`'s three install sections each mention choosing a provider, and the README has "Ahrefs", "Semrush" and "Data providers" sections.
- [ ] `.env.example`, the README and `docs/clients.md` document every new var and field, using example.com only.
- [ ] Task 10 is recorded as done (live calls matched the fixtures, and 9.11 is answered) or still pending a key. The phase can merge with it pending.

### 9.10 Decisions

D1 to D7 were open questions in the first draft. The user approved every recommendation on 2026-10-13. D8 to D13 follow from the research notes and the two requirements the user added the same day.

- **D1. Default unit caps.** Ahrefs: 50k global and 10k per client. Semrush: 20k and 5k. These are low enough to protect a Lite plan (200k a month) and a small Semrush unit package. The user tunes them once they know their plan.
- **D2. A missing key for the chosen provider does not fall back to DataForSEO** (rule 4). An explicit choice fails loudly rather than quietly spending on another account.
- **D3. Semrush backlinks use the v4 overview, with an optional `SEMRUSH_V4_API_KEY`, and the v3 overview until that key is set.** This applies the approved rule ("if v4 needs a separate key, add the optional key and use v3 until it is set"), and the docs confirm v4 needs its own key type (semrush-api.md "Two key types").
- **D4. The Semrush key check proves only that the key exists, and shows the balance.** Plan access (ERROR 130) shows up only on a paid report call. The success line says "key accepted", not "works".
- **D5. Ahrefs `date` is today's UTC date,** and it is left out of cache keys so weekly caching holds. The docs confirm `date` is required on all four Site Explorer endpoints used.
- **D6. Units are counted by calendar month (UTC),** so the ledger matches DataForSEO. The status row shows Ahrefs' own `usage_reset_date`.
- **D7. Metrics differ across providers.** This is documented in the README, and every result keeps `provider` so reports can label it.
  - Ahrefs organic-keywords is sent `volume_mode=average`, so both Ahrefs volumes are 12-month averages, like Semrush `Nq`.
- **D8. Semrush keyword volume uses v3 `phrase_these`, which is deprecated.** The v4 replacement takes one keyword per request at 20 units, against 10 units per line for up to 100 keywords per request, so v4 would cost about twice as much and need 100 times as many requests. When Semrush announces a shutdown date, a follow-up switches to v4 metrics with the v4 key.
- **D9. The provider choice is part of every install path.**
  - **CLI:** the `provider` step with `provider:pick` and `provider:default` (9.6).
  - **Bundle:** a `seo_data_provider` text field. MCPB 0.3 has no enum, so the allowed values go in the description and the server validates them.
  - **MCP:** read-only reporting in `setup_status` and the `getting-started` prompt.
  - **`--yes`:** keeps the current or a valid default, never prompts for keys, and writes `SEO_DATA_PROVIDER` only to fix a missing or invalid one when a provider works.
- **D10. Unticking a provider never deletes its key.** It only drops the provider from the default list. Deleting secrets is a manual `.env` edit, and the wizard says so.
- **D11. An invalid `SEO_DATA_PROVIDER` doesn't crash the server.** It is reported in `setup_status` and in every routed call, while free and DataForSEO-only tools keep working. Blank means dataforseo. Matching trims and ignores case. Blank bundle fields no longer hide `.env` values for the Phase 9 vars.
- **D12. There is no MCP tool to change the default provider or any key.** Secrets and credentials stay in the terminal. The per-client `dataProvider` override is a non-secret routing choice, so it stays available in `set_client_profile`.
- **D13. Semrush per-line responses shorter than requested carry a note,** because the docs say a low balance returns partial lines silently.

### 9.11 Not confirmed

None of these block the build. The code takes the safe reading listed, and task 10 answers each one.

**Ahrefs** (docs/research/ahrefs-api-v3.md "Not confirmed"):
- **N1.** The `error` strings, and 401 versus 403 for a bad key. The code treats both as "key rejected" and shows the vendor text.
- **N2.** The response when units run out, and whether pay-as-you-go continues silently. The code surfaces any 4xx with the vendor text. The unit caps (D1) are the guard.
- **N3.** Whether a `limit` above the plan's row cap is silently truncated or rejected. The code records the rows it gets.
- **N4.** The maximum `keywords` per overview request. The code uses batches of 100.
- **N5.** Whether `x-api-units-cost-total-actual` is always present. The code falls back to the total, then the estimate.
- **N6.** What limits-and-usage returns for a plan below Lite. Anything other than 200 shows as "rejected", with the vendor text.

**Semrush** (docs/research/semrush-api.md "Not confirmed"):
- **N7.** Whether countapiunits accepts the v3 key, the v4 key, or both. The code uses `SEMRUSH_API_KEY` (v3).
- **N8.** Whether `https://www.semrush.com/users/countapiunits.html` works; only `http://` is documented. The code uses https only and never sends a key over http. If https fails in task 10, the check falls back to a zero-cost "saved, untested" state, and this spec gets amended.
- **N9.** The exact balance body format. The parser strips separators and whitespace.
- **N10.** The HTTP status that comes with a v3 `ERROR` body. The code classifies by body text whatever the status.
- **N11.** How ERROR 132 appears on v4 JSON endpoints. The code maps v4 `error.code` 132, or a 403 whose message mentions units, to the zero-balance message, and any other 403 to "not enabled".
- **N12.** Whether a partial result from a low balance can be told apart from a complete one. The code adds a note (D13).
- **N13.** Whether `phrase_these` omits lines for keywords with no data. The mapper fills missing keywords with nulls.
- **N14.** When deprecated v3 `phrase_these` and `backlinks_overview` will be switched off (D8).
- **N15.** Whether a v4 key can be checked for free. It is saved untested.

**MCPB.**
- **N16.** Whether Claude Desktop passes a blank optional field as `""`, as the literal placeholder, or not at all. All three count as unset (D11).

**Follow-up (not this phase).** Apply the "blank env doesn't hide `.env`" rule to the existing vars (DataForSEO, Google, PSI).
