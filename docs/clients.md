# Clients, competitors and brand terms

Reference for how crawlmark builds and uses the client list. The [README](../README.md#clients) has the short version.

## The client list

The client list is `config/clients.yaml` in the config home (path set by `CLIENTS_FILE`, gitignored). You don't have to write it:

- **From Google.** When Google is set up, crawlmark lists every Search Console site and GA4 property (with its web streams) the account can access, joins them by domain, and adds any new domain to `clients.yaml` with its name, `gscProperty` and `ga4PropertyId`. This happens on first use and then at most once a day (cached in SQLite); `list_clients` with `refresh: true` or `crawlmark-cli clients list --refresh` re-lists now. The file is created if it's missing.
- **By hand.** `crawlmark-cli clients add example.com` (or edit the file). Only `domain` is required. A hand-added client works for DataForSEO, Lighthouse and axe with no Google setup at all.

**crawlmark never changes or removes what you write.** Discovery only appends domains that have no entry and fills a missing `gscProperty`, `ga4PropertyId` or Tag Manager container (`gtmAccountId` plus `gtmContainerId`, only when the entry has neither). It keeps your comments, order and values (indentation is normalised), writes atomically (following a symlinked file and keeping its permissions), and leaves entries for domains it no longer sees (`list_clients` notes them). If you pin a property that differs from what discovery would pick, your value wins and `list_clients` notes the difference. To drop a client for good, set `ignore: true` on its entry (or `clients remove <domain> --ignore`): it's hidden and never re-added. Deleting an entry outright only lasts until the next discovery if Google still lists the domain.

Every field is in `config/clients.example.yaml`. The file is re-read on every call, so edits apply without a restart.

### How matching works

- Every site is reduced to a host: lowercased, with the scheme, path, port and a leading `www.` dropped. `sc-domain:example.com`, `https://www.example.com/` and an `https://example.com` GA4 stream all become `example.com`. Internationalised domains are compared in punycode, so `bücher.example` and `xn--bcher-kva.example` match. Subdomains stay separate (`shop.example.com` is its own client).
- Search Console: if a host has both a domain property (`sc-domain:`) and URL-prefix properties, the domain property is used and the others are listed as `alternates`. Among URL-prefix properties, a root-path property (`https://example.com/`) wins over a path-scoped one (`https://example.com/blog/`), then `https` over `http`, then the shorter URL. Sites where the account is an unverified user are skipped.
- GA4: a property maps to the host of each of its web streams. If several properties share a host, the lowest property ID is used and the rest are listed as `alternates`. Properties with no web stream (app-only) are skipped with a note.
- Tag Manager: crawlmark lists the accounts and web containers the identity can read and matches each container's **domain list** (container settings) to a client's domain. Containers with no domain list are listed in the `list_clients` notes; pin one by setting `gtmAccountId` and `gtmContainerId` (the numeric IDs in the Tag Manager URL, not `GTM-XXXX`). If several containers list one domain, the lowest `GTM-` ID is used and the others are noted.
- A client can have only one side, or neither. Tools that need a missing one return an error such as "No GA4 property found for example.com"; reports mark just that section as failed.
- Entries are keyed by domain. Tools accept the domain, any URL or `www.` form of it, or the entry's key if you used a different one (e.g. `example-co:`). A key that names a different client's domain is a config error, since it would hide that client. Spend recorded under such a key counts toward the client's budget.

### Defaults

| Field | Default when the entry leaves it out |
|---|---|
| `name` | GA4 property name, else the domain |
| `locationCode`, `languageCode` | `DEFAULT_LOCATION_CODE` (2840, United States) and `DEFAULT_LANGUAGE_CODE` (`en`) |
| `keyPages` | The homepage: the GA4 stream URL, else `https://<domain>/` |
| `competitors`, `trackedKeywords` | Empty |
| `area`, `niche` | Unset: suggestions search the `locationCode` market and use tracked keywords and Search Console queries as seeds, falling back to the client's ranked keywords from its data provider (paid) when there are none |
| `monthlyBudgetUsd` | `DEFAULT_CLIENT_MONTHLY_BUDGET_USD` (5) |
| `dataProvider` | `SEO_DATA_PROVIDER` (blank means `dataforseo`) |
| `country` | The country of a country-level `locationCode` (2840 gives `US`, 2826 gives `GB`); none for a city or region code |
| `bingSite` | The verified Bing Webmaster Tools site whose host is the client's domain (https first, then the root path) |
| `gbpPlaceId` | None: `local_profile` searches by the client's name until you confirm a listing |
| `ahrefsSiteAuditProject` | None: `technical_issues` matches the client's existing Ahrefs Site Audit project by domain (exactly one must match); set it with `clients set example.com --ahrefs-site-audit-project <id>` (the ID in `app.ahrefs.com/site-audit/<id>`) or by editing clients.yaml; not through Claude. The project's site must be the client's domain or a subdomain of it, or the source is refused |
| `semrushProject` | None: matched by domain among your Semrush projects that have Site Audit; set it with `clients set example.com --semrush-project <id>` or in clients.yaml, not through Claude (saves the project-list call, 100 units). An audit whose site isn't the client's domain or a subdomain is refused |
| `monthlyUnits.ahrefs`, `monthlyUnits.semrush` | `DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS` (10,000) and `DEFAULT_CLIENT_MONTHLY_SEMRUSH_UNITS` (5,000) |

Arrays you set (`competitors`, `trackedKeywords`, `keyPages`) replace the defaults rather than append.

### Data provider, country and unit caps

Three optional fields choose where a client's paid keyword, ranking, competitor and backlink data comes from, and what it may spend:

```yaml
clients:
  example:
    domain: example.com
    dataProvider: ahrefs          # dataforseo, ahrefs or semrush; overrides SEO_DATA_PROVIDER for this client
    country: US                   # ISO alpha-2 market for Ahrefs and Semrush; else from a country-level locationCode
    monthlyUnits:                 # per-client API unit caps; else the DEFAULT_CLIENT_MONTHLY_* values
      ahrefs: 20000
      semrush: 5000
```

- `dataProvider` picks whose data is used, not credentials: the key itself is in `.env` (or the Claude Desktop extension settings). With no key for the chosen provider, the client's paid calls fail with the command to fix it; crawlmark never falls back to another provider's account. Live SERPs, on-page checks and crawls always use DataForSEO.
- `country` is stored uppercase. Semrush uses its database for that country (`GB` is Semrush's `uk`); a country Semrush has no database for makes Semrush unavailable for the client. A client with a city-level `locationCode` and no `country` can't use Ahrefs or Semrush until `country` is set.
- `languageCode` and `area` stay DataForSEO-only.
- An invalid `dataProvider` or `country` is a config error naming the allowed values.

Set or clear them with the CLI or the `set_client_profile` tool (`""` clears a value there):

```bash
crawlmark-cli clients set example.com --provider ahrefs --country GB
crawlmark-cli clients set example.com --provider none --country none   # back to the default; country from the location code
```

### Bing site

`bing_report` and the `bing_overview` report section find the client's site among the sites your Bing Webmaster Tools key can read (`GetUserSites`, cached a day), using the same domain matching as Search Console discovery: `https://www.example.com/` and `http://example.com/` both match `example.com`, verified sites only. To pick a different one, set `bingSite` to the URL exactly as Bing lists it:

```bash
crawlmark-cli clients set example.com --bing-site https://www.example.com/
crawlmark-cli clients set example.com --bing-site none   # back to matching by domain
```

`bingSite` must be on the client's own domain or a subdomain of it (`https://www.example.com/` or `https://blog.example.com/` for `example.com`); a site on another host is refused, so one client's report can never show another site's Bing data. A `bingSite` that the key can't read, or that isn't verified yet, is an error naming `bingSite`. Bing sites are never written to clients.yaml automatically, and the Bing lookup never runs during client discovery, so a Bing problem can't affect `list_clients`.

`list_clients` shows each client's resolved `dataProvider` (marked `(default)` when it comes from `SEO_DATA_PROVIDER`) and `country`.

### Google Business Profile

`local_profile`, `local_pack`, `local_reviews` and the `local_profile` report section read a client's Google Business Profile through DataForSEO (paid; not the Google Business Profile API). Set `area` first (`crawlmark-cli clients set example.com --area "Austin,Texas,United States"`) so searches run in the client's town; without it they use the client's whole `locationCode` market.

1. Run `local_profile` for the client (with `estimateOnly: true` first: about $0.0054). It searches Google by the client's name (or the `query` you pass) and returns the best match plus up to 4 other listings, and says whether the listing's website is the client's domain.
2. Check the match: title, address and website. crawlmark never saves it on its own.
3. Only when it's the right business, save its place ID:

```bash
crawlmark-cli clients set example.com --place-id ChIJexamplePlaceId000001
crawlmark-cli clients set example.com --place-id none   # forget it
```

or `set_client_profile` with `gbpPlaceId`. Through `set_client_profile` (Claude), the place ID must be one `local_profile` returned for that client in the last day; the CLI flag takes whatever you type. From then on `local_profile` looks the listing up by place ID, `local_pack` recognises the client's own listing by it (otherwise by website domain), and `local_reviews` and the report section run (both refuse without it, so they can never show another business's reviews).

Reviews come back without reviewer names, profile links, photos or review IDs, and the owner's reply only as yes or no. Review and listing text is stripped of control and invisible characters and escaped in report files.

### When discovery doesn't run or fails

- Google not set up: discovery is skipped, `list_clients` says so in one `discovery.info` line, and the clients come from `clients.yaml` only.
- Google set up but failing (missing key file, expired sign-in): `clients.yaml` entries are still available, and `list_clients` reports why in `discovery.error`.
- Google Analytics Admin API disabled: Search Console clients are still listed (and added), with a warning to enable the "Google Analytics Admin API".
- Tag Manager unavailable or no access: clients are still discovered and `list_clients` adds a note.
- A new property doesn't show up: discovery is cached for a day. Use `list_clients` with `refresh: true` or `crawlmark-cli clients list --refresh`.

## Competitors, tracked keywords, area and niche

Add them whenever you like, with the tools, the CLI (`crawlmark-cli competitors add example.com rival.example`) or by editing the file. Each competitor is a domain string or an object with a note, source and date; tracked keywords work the same way. The tools and CLI write the object form:

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
    brandTerms:                       # usually filled automatically
      - example plumbing
      - term: ex plumbing
        source: auto-gsc              # manual, suggested, auto-gsc or auto-dataforseo
        addedAt: 2026-10-12
```

Competitors are stored as bare domains (`https://www.rival.example/page` becomes `rival.example`), keywords lowercase with single spaces, and duplicates are skipped. The client's own domain can't be a competitor.

## Rank history

Tracked keywords get a stored rank history (local, in crawlmark's database). `crawlmark-cli check-ranks` (or the `check_ranks` tool) saves each one's Search Console average position over the last 7 complete days, free; with `--live` (or `live: true`) it also saves the live Google rank from DataForSEO, paid and checked against the caps first. Live ranks from `serp_check`, `monthly_report` with `liveRanks` and report templates with `liveRanks` are saved too. Only tracked keywords are stored, and a second check on the same day replaces the first. `rank_history` returns the series with the latest, best and worst rank and the change over 30 and 90 days; the `rank_trend` report section shows it in report files. Keep everything; a year of daily checks for 50 keywords is about 18,000 small rows.

## Keyword ideas and competitor gap

`keyword_ideas` (from 1-20 seed keywords) and `keyword_gap` (keywords the client's competitors rank for and it doesn't) use the client's data provider: DataForSEO, Ahrefs or Semrush, never another account. Both are paid and take `estimateOnly: true`, which returns the estimate, the provider and what's left of the cap without a request; the `keyword-research` prompt always asks you before the real call. A call that wouldn't fit the cap is refused before any request, and the message names a smaller `limit` that fits (for example a Semrush gap at 80 units a line: 2 competitors × 50 lines is 8,000 units, more than the default 5,000 a client, so it suggests limit 25). `keyword_gap` compares the client's saved competitors (the first 3) unless you name up to 5. With Ahrefs, "the client already ranks" comes from the client's own Search Console queries (free) when it has a property, otherwise from one extra Ahrefs call for the client's top 1,000 keywords (13,000 units, included in the estimate). Difficulty is each provider's own 0-100 score (`dataforseo_kd`, `ahrefs_kd`, `semrush_kd`) and isn't comparable across providers.

## Competitor suggestions

`suggest_competitors` (or the `find-competitors` prompt) proposes competitors from two sources:

1. **Organic overlap:** the client's data provider's list of domains ranking for the same keywords as the client (DataForSEO, Ahrefs or Semrush).
2. **Local search presence** (DataForSEO only; skipped with a note when DataForSEO isn't set up): live Google results for up to 5 seed keywords, searched in the client's `area` (or its `locationCode` market when no area is set). Seeds are, in order: `seeds` the AI passes (3-5 non-branded service keywords, confirmed with you), the `niche`, tracked keywords, then the top non-branded Search Console queries of the last 28 days (free; needs Google). When seeds or a niche are given, a Search Console query is used only if it shares a meaningful word with them. Only if none of those exist does it fall back to the client's ranked keywords from its data provider.

**Pass service-keyword `seeds`.** A small site's own ranked keywords are mostly branded, so organic overlap returns companies that share its name. `find-competitors` has the AI propose 3-5 non-branded service keywords, confirm them with you, and pass them as `seeds`. Candidates whose domain starts or ends with the client's brand initialism (`abbuild.example`, `buildingwithab.example`) or contains a longer brand name are excluded with reason `brand-lookalike` (still listed under `excluded`); common-word brand names are never used for this.

**Set `area` and `niche` first.** Without them, seeds fall back to Search Console queries and the search is national, which gives weaker candidates. The `find-competitors` prompt makes the AI set or confirm both before suggesting; if they're unset it proposes values inferred from the client's homepage title and description. Seeds that look like the client's own brand (including initialisms and suffix variants such as "ab building inc") are dropped, and sample URLs have tracking parameters stripped.

It drops the client's own site, current competitors, `ignore: true` domains, and a built-in denylist of platforms that rank for everything (social networks, review, listing and contractor-directory sites, business-data directories, home-improvement lead marketplaces, marketplaces, encyclopedias, video sites, big-box retailers, search engines, `.gov`/`.edu` and similar). Add your own rules in `config/competitor-denylist.txt` (optional, gitignored; one per line) or `COMPETITOR_DENYLIST` (comma-separated): `directory.example` (that domain and its subdomains), `*.example-tld`, `portal.*` (any short suffix), and `!domain` to exempt one.

Each candidate has a score from 0 to 100: half from keyword overlap (relative to the strongest candidate) and half from local search presence (the average over seeds of `(21 − position) ÷ 20`, so position 1 counts 1.0 and position 20 counts 0.05). When a local `area` is in effect and the SERPs returned candidates, the weights are 30% overlap and 70% local presence, and candidates with local search evidence are listed before overlap-only ones, which keep their score but carry `weakEvidence: true`. If one source contributes nothing, the other counts fully. The response includes the evidence (shared keywords, average position, appearances, positions per seed, a sample URL), excluded domains with reasons, `costUsd` and `fromCache`. A run costs one overlap call plus one SERP call per seed (cached 30 days and 1 day). It never saves anything; add the ones you want with `add_competitors` (`source: "suggested"`).

## Branded queries

`monthly_report` splits Search Console queries into branded (people looking for the client by name) and non-branded (people looking for what the client sells). Non-branded is the number that shows SEO growth; branded mostly tracks existing awareness. The report gives clicks, impressions, CTR and average position for each group (position weighted by impressions) for the report month and the one before, with the change, and marks every query row, mover and tracked keyword with `branded: true | false`.

A query counts as branded when, ignoring case, spacing, punctuation and accents, it:

- contains one of the client's `brandTerms` (4+ characters anywhere in the query; shorter terms such as initials only as a whole word);
- matches the domain stem, the client name or the GA4 property name (`exampleplumbing.com` matches "example plumbing", "Example-Plumbing hours" and "exampleplumbing");
- uses spaced initials or a generic suffix ("a b building", "ab building inc"), or the short brand token alone ("ab construction").

`brandTerms` add to this built-in matching; they never replace it, and each client's terms apply only to that client. To set them by hand, use `add_brand_terms` / `remove_brand_terms`, `crawlmark-cli brand add|remove <client> <term>...`, `set_client_profile` (`brandTerms: [...]` replaces the list, `[]` clears it), or edit `clients.yaml`. Add misspellings, old names and product names the client is known by. Terms of 4+ characters match across word boundaries, so prefer distinctive terms.

The split sums query-level rows (up to 5,000 per month), which leave out anonymized queries, so branded + non-branded will be lower than the site totals in the same report; the report says so in `search.note`. Matching is heuristic: a client whose name is a common word can have a few non-brand queries marked branded, so spot-check `topQueries` and add terms where it misses.

## Automatic brand terms

A domain often isn't how people search for a business: `casaluna.example` gets searched as "casa luna pizza" and "casa luna menu", which the domain-stem matching misses. `suggest_brand_terms` finds those names in the client's own queries:

1. **Data.** Search Console query rows for the last 90 days (up to 1,000; free). Only when Search Console isn't usable at all (Google isn't set up, or the client has no property) does it use ranked keywords for the client's own domain from its data provider (top 100, paid: about $0.02 on DataForSEO, or Ahrefs/Semrush units; cached 7 days, through the budget or unit cap). If Search Console returns fewer than 20 rows, the paid fallback runs only with `allowPaid: true` (the `review-brand-terms` prompt asks you first); `allowPaid: false` turns it off. A Search Console error is reported and never falls back to the paid source.
2. **Candidates.** 1-3 word phrases from queries the client's current matching doesn't already cover. Generic words never start or end a candidate: stop words, intent words ("near", "best", "how"), navigational modifiers ("menu", "hours", "reviews"), the niche, the area, US state names, and trade words seen in the queries. So "pizza near me" never becomes a brand term, however well the site does for it.
3. **Signals.** (a) Name similarity to the *distinctive part* of the domain stem, client name or GA4 name: the name minus trade words, places and company suffixes. (b) Navigational behaviour, Search Console only: the phrase's queries average position 2 or better with CTR well above the expected curve. (c) Concentration: the phrase recurs across several queries that carry a real share of the site's clicks, on page one.
4. **Confidence.** `high` needs strong name similarity plus navigational behaviour or concentration, at an average position of 3 or better. Behaviour without name similarity is at most `medium`. A similar name the site ranks poorly for is usually another business, so it stays `low`. The response's `method` string has every threshold.
5. **Other clients.** A phrase that matches any other client's domain, name or brand terms (including close misspellings and fragments) is never proposed; it's listed under `excluded` with reason `other-client-brand`. So an agency site whose queries mention its clients' names doesn't adopt them, and each client's terms stay its own.

**Strict auto-add.** A candidate is only ever saved automatically (by discovery, `apply: true` or `--apply`) when one of its words (4+ letters, not the niche, area, a place, a company suffix or a filler word) matches the distinctive part of the client's name (`autoQualified: true`). Everything else comes back as a suggestion with a `reviewReason`: `needs-review: generic-name-match`, `needs-review: no-distinctive-name`, or `needs-review: confidence`.

The response also lists the top 20 non-branded queries no candidate covers, so the AI can spot misspellings or old names. The `review-brand-terms` prompt walks through confirming medium and low candidates, and `crawlmark-cli brand suggest --all` does it in bulk.

**Automatically for new clients.** When discovery adds a new client that has a Search Console property, crawlmark runs the free Search Console inference for it and saves the `high` candidates that pass the strict auto-add check (`source: auto-gsc`). It never calls DataForSEO here, and a failure never affects the sync; `list_clients` notes what was added.
