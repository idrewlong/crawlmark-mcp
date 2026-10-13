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

`list_clients` shows each client's resolved `dataProvider` (marked `(default)` when it comes from `SEO_DATA_PROVIDER`) and `country`.

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

## Competitor suggestions

`suggest_competitors` (or the `find-competitors` prompt) proposes competitors from two sources:

1. **Organic overlap:** the client's data provider's list of domains ranking for the same keywords as the client (DataForSEO, Ahrefs or Semrush).
2. **Local search presence** (DataForSEO only; skipped with a note when DataForSEO isn't set up): live Google results for up to 5 seed keywords, searched in the client's `area` (or its `locationCode` market when no area is set). Seeds are, in order: `seeds` the AI passes (3-5 non-branded service keywords, confirmed with you), the `niche`, tracked keywords, then the top non-branded Search Console queries of the last 28 days (free; needs Google). When seeds or a niche are given, a Search Console query is used only if it shares a meaningful word with them. Only if none of those exist does it fall back to the client's ranked keywords from its data provider.

**Pass service-keyword `seeds`.** A small site's own ranked keywords are mostly branded, so organic overlap returns companies that share its name. `find-competitors` has the AI propose 3-5 non-branded service keywords, confirm them with you, and pass them as `seeds`. Candidates whose domain starts or ends with the client's brand initialism (`abbuild.com`, `buildingwithab.com`) or contains a longer brand name are excluded with reason `brand-lookalike` (still listed under `excluded`); common-word brand names are never used for this.

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
