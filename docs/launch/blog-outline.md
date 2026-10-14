# Launch post outline: crawlmark

Working outline for the launch blog post (Phase 11). It's a living document: every phase that adds a feature, tool, prompt or command also adds it to [What it can do](#5-what-it-can-do) below, marked **Shipped** or **Coming**. Before publishing, check every item against the README and drop anything that didn't ship.

**Working title options**

- "Stop digging, start answering: an SEO data layer for AI"
- "We spent hours on every SEO report, so we built crawlmark"
- "Let AI read the SEO data, so you can do the work"

**Length:** 1,200–1,800 words. **Tone:** plain, practical, first person, no hype words. **Audience:** people who already do SEO, not people learning what it is.

---

## 1. Hook (2–3 short paragraphs)

- Open on a real moment: a client asks a simple question ("why did traffic drop last month?") and answering it means an hour of digging through GA4 data.
- Name the cost: Search Console in one tab, GA4 in another, SEMRush in a third, etc. Even doing a report takes hours; the insight takes minutes.
- The turn: AI is very good at reading data and explaining it. It just needs the data in front of it.

## 2. Why we built it

- **The problem is retrieval, not analysis.** Most of the time on an SEO report goes to pulling, cleaning and joining data, not thinking about it.
- **Complex client questions don't fit dashboards.** "Which pages lost non-branded clicks after the redesign, and is it a ranking or a CTR problem?" needs several sources at once.
- **The goal:** save time, get answers fast, and let AI do what it's best at, looking at data, while you decide what to do about it.
- **What we refused to compromise on:**
  - Your data stays yours: credentials live on your machine, nothing goes to us, no tracking.
  - Read-only access to Google.
  - Hard spend caps on paid APIs, so a curious question never runs up a bill.
  - Free sources first; paid calls are opt-in and say what they cost.

## 3. Who it's for

- **People monitoring their own site:** founders, freelancers, site owners who want answers without learning five tools.
- **In-house marketing teams:** recurring reporting for leadership, faster answers to "what happened?" questions, scheduled checks that flag drops.
- **Agencies and SEO consultants:** many clients, one setup; clients are discovered automatically from Google; monthly reports in minutes; audits that show what changed since last time.
- **The common thread:** less time collecting data, more time on the work clients actually pay for (strategy, content, fixes, conversations).

## 4. How it works (one short section, one diagram)

- crawlmark is an MCP server: a connector that gives Claude (and Cursor and Codex) tools to fetch and analyse SEO data.
- Diagram idea: data sources on the left (Search Console, GA4, Tag Manager, DataForSEO / Ahrefs / Semrush, Lighthouse, axe) → crawlmark (cache, budgets, client list) → your AI app → a report or an answer.
- The AI asks, crawlmark fetches and shapes the data, and the AI writes the answer. Formatting and tone stay in your hands.

## 5. What it can do

Grouped by job, each with one example question a reader could ask. Mark every line **Shipped** or **Coming** until launch.

**Reports** (Shipped)

- Monthly report: Search Console and GA4, month over month and year over year, top and moving queries and pages, tracked keyword positions. _"Write the October report for example.com."_
- Branded vs non-branded split, with brand terms learned automatically from how people search. _"How much of our growth is people searching our name?"_
- A ready-made prompt that writes the client-facing report in plain language.

**Opportunities** (Shipped, free)

- Striking-distance queries, quick-win pages, low-CTR titles, keyword cannibalization, declining pages, with estimated extra clicks. _"What are the five easiest wins this month?"_

**Audits** (Shipped)

- Lighthouse, accessibility (axe), rendered-vs-raw HTML (what Google sees before JavaScript), index status, on-page checks. _"Audit the homepage and pricing page."_
- Site hygiene: robots.txt, sitemaps, structured data, hreflang, orphan pages.
- hreflang read from page tags, sitemap entries and `Link` headers, with conflict detection.
- Saved audits with diffs: what's new, fixed or still open since last time. _"What did we fix since the last audit?"_
- Tag Manager audit: paused, unfired and legacy tags, duplicate GA4 tags, consent gaps, unpublished changes.

**Competitors and keywords** (Shipped)

- Competitor suggestions from keyword overlap and local search results, with evidence; you pick which to keep. _"Who are our real local competitors?"_
- Tracked keywords and competitor lists per client.

**Clients** (Shipped)

- Clients discovered automatically from Search Console, GA4 and Tag Manager; add others by hand. Works for one site or a hundred.

**Monitoring** (Shipped)

- Scheduled audits and traffic checks from cron or CI, with alerts for new critical issues or non-branded click drops, sent to Slack-style webhooks.

**Cost control** (Shipped)

- Per-client and global monthly caps, a spend ledger, response caching, sandbox mode for trying it free.

**Setup** (Shipped)

- One-command installer: `npx crawlmark-mcp@latest init`, with live credential checks.
- Registers with Claude Code, Claude Desktop, Cursor and Codex; Claude Desktop also has a one-click bundle.
- Google via your own account (OAuth) or a service account.
- `setup status` and an in-Claude `setup_status` tool that say exactly what to fix.

**Bring your own data provider** (Shipped; live API check pending a key)

- Use your own Ahrefs (API v3, Lite plan or higher) or Semrush (SEO Business plan plus an API unit package) key instead of, or alongside, DataForSEO. The provider is set once (a default, plus an optional per-client override), not per question: with example.com on Ahrefs, _"Which keywords does example.com rank for?"_ answers from Ahrefs.
- What each provider covers: keyword volume (`keyword_volume`), ranked keywords (`ranked_keywords`), organic competitors (`competitor_domains`, and the overlap half of `suggest_competitors`) and backlinks (`backlinks_summary`, with Ahrefs Domain Rating or the Semrush authority score, labelled, never mixed). Live SERPs, on-page checks and full crawls stay on DataForSEO.
- One default provider, overridable per client: `npx crawlmark-mcp clients set example.com --provider semrush --country GB` (or `set_client_profile`). A missing key never quietly falls back to another account.
- Budgets in each provider's own currency: DataForSEO keeps its dollar caps; Ahrefs and Semrush get monthly API-unit caps, globally and per client, checked before each call and shown in `spend_summary`.
- Provider choice at install, whichever way you install: the `init` wizard asks which providers you have and which is the default (`setup --step provider` to change it later, `--step ahrefs` / `--step semrush` for one key), and the Claude Desktop bundle has a "Default SEO data provider" field plus key and unit-cap fields.
- New free tools `ahrefs_status` and `semrush_status` check a key without spending units; `setup_status` shows the default provider and where it's set.

**Installer polish** (Shipped)

- A menu when you re-run `init` on a finished setup: add or change a data provider, change the Google sign-in, re-register AI apps, refresh clients, check status, run everything again, or exit. A one-line status (which sources work, how many clients) sits above it.
- Every live check shows how long it took (`[1.2s]`), and the run ends with `Done in 14s`.
- A short tip under results, with the exact command for your install, e.g. `To switch accounts later: npx crawlmark-mcp setup --step google`.
- Clickable links in terminals that support them, and "Press Enter to open" for the pages a step needs (DataForSEO API access, Ahrefs and Semrush keys, Google Cloud, PageSpeed).
- "Try asking Claude" in the final summary: three ready-made questions using up to three of your own clients, read from your local `clients.yaml` and shown only in your terminal (example.com when you have none; CI and piped runs don't show them at all).
- A daily "Update available" notice from `init`, `--help` and `--version`: one request for the latest version number, no data about you or your clients, never in CI, and off with `CRAWLMARK_NO_UPDATE_CHECK=1`. The MCP server itself never checks.

**Report files and templates** (Shipped)

- Branded report files in Markdown, HTML, PDF and Word from reusable YAML templates (global and per client), with your agency name, logo, colours and footer. _"Write the September report for example.com and save it as a PDF and a Word file."_
- From Claude, with written commentary next to the numbers it discusses; from cron, data only and labelled that way.
- Save it as a Google Doc with your own Google Drive connector, only after you say yes. crawlmark itself never writes to Google.
- New tools: `list_report_templates`, `get_report_template`, `validate_report_template`, `run_report_template`, `export_report`.
- New prompt: `template-report`; `monthly-report-writeup` now offers to save files and a Google Doc.
- New commands: `crawlmark-cli report --client example.com|--all [--format md,html,pdf,docx]` and `crawlmark-cli report templates list|validate|init`.
- Agency-dashboard layout: cover band, key-figure cards, charts, clean tables; builtin `quarterly`, `executive` (one page), `technical` and `local` templates; white label.
- One PDF by default; pick other formats from a list on the terminal, and Claude asks which format(s) you want.

**Core Web Vitals history** (Shipped)

- Real-user LCP, INP and CLS week by week for up to 40 weeks, with ratings and a trend, from the Chrome UX Report (free with a Google key). _"Has example.com's LCP improved since spring?"_
- New tool `crux_history`, setup step `setup --step crux`, an optional `cwv` report section, and `run_audit` with `cruxHistory`.

**Rank history** (Shipped)

- Tracked keywords' positions saved over time: Search Console's 7-day average for free, and live Google ranks when you ask (DataForSEO, paid, estimate first). _"How have our tracked keywords moved since July for example.com?"_
- An alert when a live rank leaves the top 10 or drops 5 places (Search Console averages never alert).
- New tools: `check_ranks`, `rank_history`. New command: `crawlmark-cli check-ranks --client example.com|--all [--live] [--dry-run]` (live ranks only with an explicit `--live`).
- New report section `rank_trend` (optional `ranks` in the builtin monthly).

**Keyword ideas and competitor gap** (Shipped)

- Keyword ideas from seed keywords and the keywords competitors rank for that you don't, from your own DataForSEO, Ahrefs or Semrush account, with each provider's difficulty labelled. _"What keywords do our competitors rank for that we don't?"_
- Always an estimate first, checked against your monthly caps; a call that wouldn't fit is refused before any spend, with a limit that would.
- New tools: `keyword_ideas`, `keyword_gap`. New prompt: `keyword-research`. New report section `keyword_gap` (paid, opt-in).

**Tag Manager findings in audits** (Shipped, opt-in)

- `run_audit` with `includeTagManager` and `crawlmark-cli audit --include-tag-manager` add Tag Manager findings to saved audits and diffs; an optional `gtm` report section. Never on by default, never an alert.

**Free local crawl** (Shipped)

- Crawl a client's own site from your machine, free: broken links, redirect chains, missing and duplicate titles and descriptions, canonicals, depth, noindex pages and orphans against the sitemaps. Polite (robots.txt, Crawl-delay, an honest user agent) and capped. _"Crawl example.com and tell me what's broken."_
- Orphan detection in `site_hygiene` no longer needs a paid DataForSEO crawl (that path still works).
- New tools: `local_crawl`, `local_crawl_pages`. New command: `crawlmark-cli crawl --client example.com [--max-pages 500]`. `run_audit` with `localCrawl`, and a `site_crawl` report section.

**Server-log analysis** (Shipped)

- See what Googlebot and AI crawlers (GPTBot, ClaudeBot, PerplexityBot and others) actually request from your site, from your own access logs: hits, 404s, 5xx, top paths, parameter URLs. Googlebot is checked against Google's published IP ranges. _"How often did Googlebot and the AI crawlers hit example.com in the last two weeks, and what 404'd?"_
- Logs never leave your machine; only counts come back, never IP addresses or user agents.
- New tool: `log_analysis` (reads only the folders you allow with `LOG_DIRS`). New command: `crawlmark-cli logs --client example.com /var/log/nginx/access.log`.

**Bing Webmaster Tools** (Shipped)

- Bing clicks, impressions and CTR against the previous period, top queries and pages, and Bing's crawl stats and crawl issues, free with your own Bing key. _"How is example.com doing on Bing this month, and does Bing have crawl problems with it?"_
- Read-only: crawlmark never submits URLs, sitemaps or IndexNow pings to Bing.
- New tool: `bing_report` (Shipped). New setup step: `crawlmark-cli setup --step bing` (Shipped). New option: `crawlmark-cli clients set example.com --bing-site <url>` and `bingSite` in `set_client_profile` (Shipped). New report section `bing_overview` (Shipped).

**Local SEO** (Shipped)

- A client's Google Business Profile (rating, reviews, categories, hours, claimed or not), where it ranks in the Google Maps pack for its keywords in its town, and a summary of its latest Google reviews, from your own DataForSEO account. _"How does example.com look on Google Maps for its main keywords, and what are recent reviews saying?"_
- crawlmark finds the listing and you confirm it before it's saved; reviews never include reviewer names. Estimate first, checked against your monthly caps.
- New tools: `local_profile`, `local_pack`, `local_reviews`. New option: `crawlmark-cli clients set example.com --place-id <id>` and `gbpPlaceId` in `set_client_profile`. New report section `local_profile` (paid).

**AI-search visibility** (Shipped, paid and off by default)

- Which questions in Google AI Overviews (and ChatGPT in the US) cite your client's site, with the cited page and how often people ask, or the total mentions, from your own DataForSEO account. _"Which AI Overview answers cite example.com, and for what questions?"_
- Off until you set `AI_VISIBILITY_ENABLED=true`, with its own $2 monthly cap on top of your other caps and an estimate first. At least $0.10 per request, and DataForSEO may require a $100 monthly top-up for this API, so check your account.
- New tool: `ai_visibility`. New report section `ai_visibility` (paid). New settings `AI_VISIBILITY_ENABLED`, `AI_VISIBILITY_MONTHLY_BUDGET_USD` and a `setup_status` row.

**Audits: AI search readiness** (Shipped)

- Which AI crawlers robots.txt lets in, split into AI search crawlers (blocking them hides the site in ChatGPT search, Claude and Perplexity answers) and training-only crawlers (blocking them is a fair choice). _"Can ChatGPT search and Perplexity see example.com, and which AI crawlers does it block?"_
- llms.txt check: present or not, format against the llmstxt.org proposal, and links that don't load. For information only, since Google says it doesn't use llms.txt.
- Part of `site_hygiene` and `run_audit`, with a new optional `ai_readiness` report section.

**Technical issues in one list** (Shipped)

- Every stored technical problem for a client in one deduplicated, severity-grouped list: the saved audit, its site checks, the local crawl, a stored DataForSEO crawl and Google URL Inspection results, with which source found each issue and what's new, resolved or not re-checked since the last report. Never starts a crawl. _"What's broken on example.com right now, and what did we fix since last month?"_
- New tool `technical_issues` and an optional `issues` section in the builtin monthly, quarterly and technical templates.

**Google indexing coverage** (Shipped)

- How Google indexes a client's key pages, top Search Console pages and a weekly-rotating sample of sitemap URLs, with Search Console's sitemap errors, from the free URL Inspection API within a daily budget, labelled as a sample in the report. _"Which of example.com's pages aren't indexed, and why?"_
- New tools `index_coverage` and `inspect_index_coverage`, new command `crawlmark-cli index-coverage --client example.com|--all` for a daily cron, and an optional `indexing` report section.

**Check every page's indexing, and import Search Console's Pages report** (Shipped)

- "Check all pages" for Google indexing: every key, top and sitemap page in one run when today's URL Inspection budget allows, otherwise spread over a few daily runs with progress ("120 of 4,000 sitemap URLs checked in the last 30 days"), and the report says "all 23 sitemap pages checked" once it's complete. _"Check every page on example.com for indexing problems."_
- `inspect_index_coverage { all: true }` and `crawlmark-cli index-coverage --client example.com --all-pages`.
- Import Search Console's own Pages report: export it (zip of CSVs, Excel or CSV), and crawlmark shows Google's complete counts per reason in `index_coverage` and the report, with example URLs from each reason's export, marked "indexed now" when a later URL Inspection found them indexed. Parsed on your machine. _"Import the Pages report I downloaded for example.com and tell me what changed."_
- New tool `import_index_report` and command `crawlmark-cli index-coverage import --client example.com <file>`.

**Backlinks, keyword visibility and competitors in the report** (Shipped)

- Referring domains, backlinks and the provider's own authority metric (labelled, never mixed), ranking keywords by position band with estimated traffic, and top organic competitors (saved ones first) with shared keywords, from the client's own DataForSEO, Ahrefs or Semrush account. Month-over-month comes from figures crawlmark stores locally each month, so re-running a report costs nothing and provider history is bought at most once, only for report templates, with the cost shown before anything is spent. _"Add backlinks and keyword visibility to example.com's September report."_
- New tools `organic_visibility`, `competitor_overview` and `seo_trends`; new command `crawlmark-cli seo-snapshot --all --paid` for a monthly cron; optional paid `backlinks`, `visibility` and `competitors` sections in the builtin monthly and quarterly templates. Every provider figure carries a "Source:" line, white label included.

**Ahrefs and Semrush Site Audit in the technical-issues list** (Shipped)

- The client's existing Ahrefs or Semrush Site Audit project as extra (paid, opt-in) sources for `technical_issues`, merged with crawlmark's own findings and mapped onto one severity scale. Read-only: crawlmark never starts a crawl or creates a project.

**Report cost up front** (Shipped)

- `estimateOnly` on `run_report_template` and `export_report` (and `report --dry-run`) prices a report's paid sections before anything is fetched, and the whole run's budget is reserved while it runs.

**Build report templates by picking sections** (Shipped)

- `crawlmark-cli report templates new`: pick sections from a grouped list marked free or paid (with the client's cost per run), the period, comparisons and layout, see a one-page preview with sample data and the change to your template file, then save, change or cancel. Comments in the file are kept. _"I want a quarterly board pack with search, backlinks and the technical issues."_
- In Claude: new tools `create_report_template` and `update_report_template` and a new prompt `build-report-template`. Claude drafts the template from a plain-language request and shows the YAML and diff; nothing is saved until you say yes (a single-use confirmation that expires after 15 minutes, a refusal if the file changed in the meantime, an explicit OK for any paid section, and a direct question from apps that support it).

## 6. How to use it (a 5-minute walkthrough)

1. Install: `npx crawlmark-mcp@latest init`.
2. Connect what you have: Google (free), a data provider (optional, paid per call), PageSpeed key (optional).
3. Pick your AI apps; crawlmark registers itself.
4. In Claude, run the `getting-started` prompt.
5. Three questions to try first (use screenshots or a short clip for each):
   - "Give me the monthly report for example.com."
   - "What are the quick wins for example.com?"
   - "Audit example.com and tell me what changed since last time."

- Link to the README for setup details and the full tool list.

## 7. What it isn't

- Not a replacement for your judgement or your SEO tools; it's a way to ask them questions faster.
- Estimates (like extra clicks) are signals for prioritising, not forecasts.
- Accessibility checks are automated and still need a manual review.

## 8. Open to feedback

- It's early. Say what we want to hear about: missing data sources (Bing, Google Business Profile, rank trackers), report formats, rough edges in setup.
- Where to send it: GitHub issues and discussions (link), plus a direct contact.
- Invite contributions: adding a data source is a documented, small change.

## 9. Call to action

- One line: install command plus a link to the repo.
- Embed the 15–30 second demo video near the top or right before this section.

---

## Assets checklist

- [ ] Demo video (15–30 s): tools and plan in [demo-video.md](demo-video.md), shot list below
- [ ] Hero image or GIF of the installer (banner, spinners, summary box)
- [ ] Architecture diagram for section 4
- [ ] Two or three screenshots of real answers in Claude, with client data replaced by example.com
- [ ] Before/after: time to produce a monthly report by hand vs with crawlmark (measure it, don't guess)

## Demo video shot list (about 25 seconds)

| Time    | Shot                                                                                            | On screen                                 |
| ------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 0–3 s   | Terminal: `npx crawlmark-mcp@latest init`, banner drops in                                      | "SEO data, for your AI."                  |
| 3–8 s   | Fast cuts of checks turning green: DataForSEO, Google, clients discovered, apps registered      | "One command. Every source."              |
| 8–18 s  | Claude: "Why did example.com lose traffic last month?" and the answer streaming in with a table | "Ask anything. Get answers, not exports." |
| 18–23 s | Quick montage: quick wins list, audit diff, competitor suggestions                              | "Reports in minutes, not hours."          |
| 23–27 s | Logo and install command                                                                        | `npx crawlmark-mcp@latest init`           |

Use only example.com data in every shot.
