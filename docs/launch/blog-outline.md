# Launch post outline: crawlmark

Working outline for the launch blog post (Phase 11). It's a living document: every phase that adds a feature, tool, prompt or command also adds it to [What it can do](#5-what-it-can-do) below, marked **Shipped** or **Coming**. Before publishing, check every item against the README and drop anything that didn't ship.

**Working title options**
- "Stop digging, start answering: an SEO data layer for AI"
- "We spent hours on every SEO report, so we built crawlmark"
- "Let AI read the SEO data, so you can do the work"

**Length:** 1,200–1,800 words. **Tone:** plain, practical, first person, no hype words. **Audience:** people who already do SEO, not people learning what it is.

---

## 1. Hook (2–3 short paragraphs)

- Open on a real moment: a client asks a simple question ("why did traffic drop last month?") and answering it means an afternoon of exports.
- Name the cost: Search Console in one tab, GA4 in another, a keyword tool in a third, Lighthouse runs, spreadsheets to stitch it together. The report takes hours; the insight takes minutes.
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
- Monthly report: Search Console and GA4, month over month and year over year, top and moving queries and pages, tracked keyword positions. *"Write the October report for example.com."*
- Branded vs non-branded split, with brand terms learned automatically from how people search. *"How much of our growth is people searching our name?"*
- A ready-made prompt that writes the client-facing report in plain language.

**Opportunities** (Shipped, free)
- Striking-distance queries, quick-win pages, low-CTR titles, keyword cannibalization, declining pages, with estimated extra clicks. *"What are the five easiest wins this month?"*

**Audits** (Shipped)
- Lighthouse, accessibility (axe), rendered-vs-raw HTML (what Google sees before JavaScript), index status, on-page checks. *"Audit the homepage and pricing page."*
- Site hygiene: robots.txt, sitemaps, structured data, hreflang, orphan pages.
- hreflang read from page tags, sitemap entries and `Link` headers, with conflict detection.
- Saved audits with diffs: what's new, fixed or still open since last time. *"What did we fix since the last audit?"*
- Tag Manager audit: paused, unfired and legacy tags, duplicate GA4 tags, consent gaps, unpublished changes.

**Competitors and keywords** (Shipped)
- Competitor suggestions from keyword overlap and local search results, with evidence; you pick which to keep. *"Who are our real local competitors?"*
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
- Use your own Ahrefs (API v3, Lite plan or higher) or Semrush (SEO Business plan plus an API unit package) key instead of, or alongside, DataForSEO. The provider is set once (a default, plus an optional per-client override), not per question: with example.com on Ahrefs, *"Which keywords does example.com rank for?"* answers from Ahrefs.
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
- Branded report files in Markdown, HTML, PDF and Word from reusable YAML templates (global and per client), with your agency name, logo, colours and footer. *"Write the September report for example.com and save it as a PDF and a Word file."*
- From Claude, with written commentary next to the numbers it discusses; from cron, data only and labelled that way.
- Save it as a Google Doc with your own Google Drive connector, only after you say yes. crawlmark itself never writes to Google.
- New tools: `list_report_templates`, `get_report_template`, `validate_report_template`, `run_report_template`, `export_report`.
- New prompt: `template-report`; `monthly-report-writeup` now offers to save files and a Google Doc.
- New commands: `crawlmark-cli report --client example.com|--all [--format md,html,pdf,docx]` and `crawlmark-cli report templates list|validate|init`.

**Core Web Vitals history** (Shipped)
- Real-user LCP, INP and CLS week by week for up to 40 weeks, with ratings and a trend, from the Chrome UX Report (free with a Google key). *"Has example.com's LCP improved since spring?"*
- New tool `crux_history`, setup step `setup --step crux`, an optional `cwv` report section, and `run_audit` with `cruxHistory`.

**Tag Manager findings in audits** (Shipped, opt-in)
- `run_audit` with `includeTagManager` and `crawlmark-cli audit --include-tag-manager` add Tag Manager findings to saved audits and diffs; an optional `gtm` report section. Never on by default, never an alert.

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

| Time | Shot | On screen |
|---|---|---|
| 0–3 s | Terminal: `npx crawlmark-mcp@latest init`, banner drops in | "SEO data, for your AI." |
| 3–8 s | Fast cuts of checks turning green: DataForSEO, Google, clients discovered, apps registered | "One command. Every source." |
| 8–18 s | Claude: "Why did example.com lose traffic last month?" and the answer streaming in with a table | "Ask anything. Get answers, not exports." |
| 18–23 s | Quick montage: quick wins list, audit diff, competitor suggestions | "Reports in minutes, not hours." |
| 23–27 s | Logo and install command | `npx crawlmark-mcp@latest init` |

Use only example.com data in every shot.
