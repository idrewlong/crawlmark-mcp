# I built crawlmark so Claude can read the SEO data and I can do the work

_Draft for the launch post. Built from [blog-outline.md](blog-outline.md). Claims are checked at the end of this file; remove that section before publishing._

A client asks a simple question: why did traffic drop last month? Answering it means an hour of digging. Search Console in one tab, GA4 in another, a keyword tool in a third, then a spreadsheet to line them up. The insight takes five minutes once the data is in front of me. Getting it there takes the rest of the hour.

AI models are good at reading data and explaining it. They just need the data. So I built crawlmark, an MCP server that gives Claude (and Cursor and Codex) tools to fetch, join and check SEO data for the sites I work on. I ask the question in plain language, crawlmark pulls the numbers, and Claude writes the answer.

## Why I built it

Most of the time on an SEO report goes to retrieval: pulling exports, cleaning them, matching pages across tools. The thinking part is short.

Client questions also rarely fit a dashboard. "Which pages lost non-branded clicks after the redesign, and is it a ranking problem or a click-through problem?" needs Search Console, a brand-term list and a before/after comparison at once. That's an easy question for a model with the right tools, and a slow one for me with five tabs.

A few things weren't up for negotiation:

- **Your data stays on your machine.** Credentials live in a local `.env`, the cache is a local SQLite file, and nothing is sent to me. There's no tracking.
- **Read-only on Google.** crawlmark asks for read-only scopes and never writes to Search Console, GA4 or Tag Manager.
- **Hard spend caps on paid APIs.** Every paid call is estimated first and checked against per-client and global monthly caps, so a curious question can't run up a bill.
- **Free sources first.** Search Console, GA4, Lighthouse, accessibility checks and a local crawler cost nothing. Paid data (DataForSEO, or your own Ahrefs or Semrush key) is opt-in and says what it costs.

## Who it's for

- **People looking after their own site** who want answers without learning five tools.
- **In-house marketing teams** who produce the same report every month and field "what happened?" questions in between.
- **Agencies and consultants** with many clients. crawlmark discovers clients from your Search Console and GA4 accounts, keeps one profile per client, and runs the same report or audit across all of them.

The common thread: less time collecting data, more time on the work people actually pay for.

## How it works

crawlmark is an MCP server, a small program that runs next to your AI app and gives it tools. When you ask Claude a question, Claude decides which tools to call. crawlmark fetches the data from Google, your data provider, Lighthouse or your own server logs, caches it, checks it against your budget, and hands back clean numbers. Claude writes the answer, so the tone and format stay in your hands.

Three decisions shaped most of the code:

**Estimates before spending.** Every paid tool can return an estimate without making the call, and a whole report reserves its budget before it starts. Parallel calls can't sneak past the cap, which turned out to matter: a model will happily fire ten requests at once.

**Untrusted text stays untrusted.** An SEO tool reads web pages, and web pages can contain text written to manipulate an AI. crawlmark treats crawled text as data, strips control characters before anything reaches a terminal or a report, and makes changes that matter, like saving a report template, go through an explicit confirmation step.

**One client list, everywhere.** Clients are discovered from Search Console and GA4 (Tag Manager containers are matched to them), stored in one file, and every tool takes the same `client` argument. "example.com" means the same site in a report, an audit and a crawl.

## What it can do

**Reports.** Monthly, quarterly, executive (one page), technical and local SEO templates, as PDF, Word, HTML or Markdown, with your agency name, logo and colours. Claude adds written commentary next to the numbers. You can build your own template by picking sections, from the terminal or by asking Claude.

**Opportunities.** Striking-distance queries, low-CTR titles, keyword cannibalization and declining pages, with an estimate of the extra clicks. Free, from Search Console.

**Audits.** Lighthouse, accessibility (axe), rendered vs raw HTML, structured data, sitemaps, hreflang, and a free local crawl for broken links, redirect chains, duplicate titles and orphan pages. Audits are saved, so the next one tells you what's new, fixed or still open.

**Indexing.** Which pages Google has indexed and why the others aren't, from the free URL Inspection API, plus an import of Search Console's own Pages report for the full counts.

**Rankings, keywords and competitors.** Rank history, keyword ideas and the keywords competitors rank for that you don't, with competitor suggestions you approve before they're saved.

**Monitoring.** Scheduled audits and traffic checks from cron, with alerts for new critical issues or drops in non-branded clicks.

It also reads your own server logs to show what Googlebot and AI crawlers actually request, checks whether AI search crawlers can reach the site, and pulls Core Web Vitals history from the Chrome UX Report.

## Getting started

```bash
npx crawlmark-mcp@latest init
```

The installer walks through Google (free), a data provider (optional, paid per call) and a PageSpeed key (optional), checks each one live, and registers crawlmark with Claude Code, Claude Desktop, Cursor and Codex. Claude Desktop users can also install a one-click bundle.

Then ask:

- "Give me the monthly report for example.com."
- "What are the quick wins for example.com?"
- "Audit example.com and tell me what changed since last time."

## What it isn't

It isn't a replacement for your judgement or your SEO tools. It's a faster way to ask them questions. Estimated extra clicks are signals for prioritising, not forecasts. Automated accessibility checks catch a lot but still need a manual review.

It's also early. The Ahrefs, Semrush and Bing integrations are built to the official docs but haven't been checked against a live account yet, so they're marked beta. It works with apps that run local MCP servers, which today means Claude, Cursor and Codex rather than ChatGPT.

## Tell me what's missing

I want to hear about missing data sources, report formats you need, and anything rough in setup. Open an issue or a discussion on GitHub. Adding a data source is a documented, small change if you'd like to contribute one.

**Install:** `npx crawlmark-mcp@latest init` · **Repo:** https://github.com/idrewlong/crawlmark-mcp

---

## Fact check (remove before publishing)

| Claim | Checked against |
|---|---|
| Works with Claude Code, Claude Desktop, Cursor and Codex; installer registers them | README install section; `src/setup/` |
| Not ChatGPT (local stdio server only) | `src/server.ts` uses `StdioServerTransport` only |
| Credentials in local `.env`, local SQLite cache, no tracking | README; `src/lib/store.ts`; no analytics code in `src/` |
| Read-only Google scopes, never writes to Google | Only `webmasters.readonly`, `analytics.readonly`, `tagmanager.readonly` in `src/` |
| Estimates first, per-client and global caps, whole-run reservations | `src/lib/budget.ts` (`withUsdReservation`, `withCallReservation`); `estimateOnly` in report tools |
| Parallel calls can't pass the cap | `test/dataforseo-reservation.test.ts` (10 parallel calls, 1 allowed) |
| Control characters stripped; template saves need confirmation | `src/lib/terminal-text.ts`; `src/tools/report-template-write.ts` |
| Clients discovered from Search Console and GA4, Tag Manager matched | `src/providers/discovery.ts`; `src/clients.ts` (Tag Manager best-effort) |
| Templates: monthly, quarterly, executive, technical, local; PDF/Word/HTML/Markdown | `src/reports/templates/builtin.ts`; `src/reports/render/` |
| Opportunities, audits, local crawl, indexing, Pages import, rank history, keyword gap, monitoring, logs, AI crawler checks, CrUX | blog outline section 5 (all Shipped); README tool tables |
| Ahrefs, Semrush, Bing are beta | README "Known limits" |
| `npx crawlmark-mcp@latest init` | Works only after the npm package is published |

Not stated on purpose: time saved per report (the outline asks to measure it, not guess), tool and test counts, and any client names.
