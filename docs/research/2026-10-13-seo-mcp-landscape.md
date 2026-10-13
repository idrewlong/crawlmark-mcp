# SEO MCP landscape: how does crawlmark compare, and what is it missing?

Date: 2026-10-13 · Author: my-skills:researcher · Status: final (with a "Not confirmed" list). All sources accessed 2026-10-13.

## Answer (TL;DR)

- **Vendor MCPs are hosted data pipes.** Ahrefs, Semrush, SE Ranking, DataForSEO, Similarweb, Whatagraph and AgencyAnalytics run remote OAuth servers that pass through one vendor's data and leave reporting to the model. Google first-party data comes from local community servers (mcp-gsc, about 1.9k stars) and Google's own GA4 `analytics-mcp` (about 3.4k stars). There is no official Search Console MCP. Confidence: high.
- **Closest competitor: `iannuttall/seo`** (npm `seo` v0.2.41, about 570 stars): a local Node toolkit with Search Console, GA4, its own crawler, Lighthouse, optional DataForSEO/Ahrefs/Semrush with local spend limits, projects, an installer that registers AI apps, Bing, server logs, AI mentions and HTML client reports. **Most-starred SEO project:** `AgriciDaniel/claude-seo` (about 18.9k stars), a Claude Code skill pack (not an MCP server) that writes Markdown and PDF reports.
- **Biggest gaps, in order:** report output and reusable templates; a free local crawl; stored rank history; keyword ideas and keyword gap; AI-search visibility; Bing Webmaster; local (Google Business Profile, reviews, map pack); CrUX History trends; server-log analysis; backlink detail. Confidence: medium (value ratings are inference).
- **Differentiators no reviewed competitor documents:** Tag Manager audit; axe accessibility checks; audit diffs with an `unverified` state; branded split with per-client inferred, isolated brand terms; competitor suggestions with local SERP evidence; per-client caps in dollars and API units with no silent provider fallback; scheduled alerts with a webhook.
- **Recurring custom reports:** only hosted reporting SaaS offers templates (Whatagraph `list-templates` + `export-report` to PDF/Excel; Nightwatch saved reports). No open-source SEO MCP lets users define a report template.
- **Google Docs:** an agent can likely turn a crawlmark Markdown report into a Google Doc through Claude's Google Drive connector (`create_file` converts text content to a Google Doc; the Drive API imports Markdown and HTML), with crawlmark never writing to Drive. Untested end to end. Confidence: medium.

## crawlmark baseline (from this repo)

Sources: Search Console, GA4, Tag Manager, DataForSEO, Ahrefs/Semrush, Lighthouse, PageSpeed/CrUX field data, axe. 44 tools and 7 prompts. Clients discovered from Google plus manual. Saved audits with diffs, rendered-vs-raw HTML, site hygiene, GTM audit. Five free opportunity tools. USD and unit caps. Scheduled `audit`/`check-traffic` with webhooks. Installer for Claude Code, Claude Desktop, Cursor, Codex, plus an MCPB bundle. Tools carry `readOnlyHint`/`destructiveHint`. Report tools return JSON; there is no file export (no PDF/DOCX code). `npm view crawlmark-mcp` returns 404, so the name is free.

## Competitors

| Server | Maker | Distribution / auth | Cost | Notable |
|---|---|---|---|---|
| Ahrefs MCP | Ahrefs (official) | Remote only (local npm archived Feb 2026); API/MCP key, OAuth | Lite+; shared API units, ≥50 per call | Site Explorer, Keywords Explorer, Site Audit, Rank Tracker, Brand Radar (AI mentions), a `gsc` group; `tools=essentials` preset; in Claude's connector directory |
| Semrush MCP | Semrush (official) | `https://mcp.semrush.com/v2/mcp`, OAuth 2.1 or `Apikey` header | Pro/Guru/One include 50k units | `domain_overview`, `organic_research`, `keyword_research`, `competitors_research`, `backlinks_research`, `position_tracking`, `site_audit`, `get_report_schema`, `execute_report`; "monthly reports in Google Docs or Notion" via your own integrations |
| SE Ranking MCP | SE Ranking (official) | Hosted `api.seranking.com/mcp`, OAuth 2.1 | Core ($129/mo)+ | 160–195 tools incl. AI-search visibility and a Project API; open-source Claude skills (`seo-drift` baseline/compare) |
| DataForSEO MCP | DataForSEO (official) | npm `dataforseo-mcp-server` (stdio/HTTP) and hosted OAuth | Pay as you go | v3 exposes docs tools plus a generic `api_request`; about 253 stars, Apache-2.0 |
| analytics-mcp | Google (official) | Local `pipx run analytics-mcp`, ADC `analytics.readonly` | Free | `run_report`, `run_funnel_report`, `run_realtime_report`, custom dimensions; about 3.4k stars |
| mcp-gsc | AminForou (community) | Local `uvx mcp-search-console`; OAuth or service account | Free (hosted version from $15/mo) | `compare_search_periods`, `batch_url_inspection`, indexing checks; deletes gated off; about 1.9k stars |
| iannuttall/seo | community | npm `seo`, Node 22, local CLI + stdio MCP | Free + optional providers | Own crawl, GSC, GA4, Bing, server logs, SerpBase rank tracking, IndexNow, ~74 report IDs, HTML/MD/CSV output, installer for 4 apps; no templates, CI-only scheduling |
| claude-seo | AgriciDaniel (community) | Claude Code plugin (skills) | Free | 34 `/seo` commands, CrUX History, Indexing API, Keyword Planner, Markdown + PDF (WeasyPrint), `/seo drift`, `/seo maps` |
| Screaming Frog MCP | Screaming Frog (official, v24) | Local stdio/HTTP from the app, MCPB | Paid licence | ~29 `sf_*` tools: crawl control, exports, screenshots; not read-only |
| Nightwatch | Nightwatch | Hosted SSE or npx, scoped key | Paid | Ranks (Google, Bing, YouTube), AI visibility, saved reports, scheduling with write scope |
| InsightfulPipe | InsightfulPipe | Hosted | $29.99–$299.99/mo | GSC, Bing, DataForSEO, crawler, PSI, GBP/GA4/GTM connections |
| Whatagraph | Whatagraph | Hosted, OAuth | Paid | `list-templates`, `preview-report`, `export-report` (PDF/Excel) |
| AgencyAnalytics | AgencyAnalytics | Hosted, OAuth | Paid | Per-client data queries; templates and scheduling stay in the platform |
| Others | various | — | — | Similarweb (official connector), Bing Webmaster (community only), gbp-mcp (GBP API needs Google approval), PSI/CrUX MCPs, Google Trends (scrapers; official API alpha), Serpstat, Advanced Web Ranking, Peec AI, Sitebulb. No Moz MCP found |

## Feature matrix

Key: Y = yes, P = partial or via a paid provider, N = no or not documented, ? = unclear.

| Capability | crawlmark | iannuttall/seo | claude-seo | Ahrefs | Semrush | SE Ranking | DataForSEO | mcp-gsc | analytics-mcp | Screaming Frog | Nightwatch | InsightfulPipe |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Local, data stays on machine | Y | Y | Y | N | N | N | Y/hosted | Y | Y | Y | N | N |
| Search Console | Y | Y | Y | Y | N | N | N | Y | N | N | ? | Y |
| GA4 | Y | Y | Y | N | N | N | N | N | Y | N | N | Y |
| Tag Manager audit | **Y** | N | N | N | N | N | N | N | N | N | N | N |
| Bing Webmaster | N | Y | P | N | N | N | N | N | N | N | Bing ranks | Y |
| Keyword volume / ideas | Volume only | Y | Y | Y | Y | Y | Y | N | N | N | Y | P |
| Keyword gap | N | Y | ? | Y | Y | Y | raw | N | N | N | ? | ? |
| Stored rank history | N | Y | N | Y | Y | Y | raw | N | N | N | Y | ? |
| Backlinks | Summary | P | P | Y | Y | Y | Y | N | N | N | N | P |
| Own / full crawl | P (paid) | Y (free) | P | Site Audit | Site Audit | Audit | On-Page | N | N | Y | Audits | Y |
| Lighthouse / lab CWV | Y | Y | Y | N | N | N | Y | N | N | P | N | PSI |
| CrUX History trend | N | ? | Y | N | N | N | N | N | N | N | N | N |
| Accessibility (axe) | **Y** | N | N | N | N | N | N | N | N | N | N | N |
| Rendered vs raw HTML | Y | ? | Y | N | N | N | Y | N | N | Y | N | ? |
| Saved audits + diffs | **Y** | P | Y (drift) | N | N | P | N | N | N | Crawl compare | N | N |
| GSC opportunity tools | Y (5) | Y | P | P | N | N | N | P | N | N | N | ? |
| Branded split, inferred terms | **Y** | P | N | P | N | N | N | N | N | N | N | N |
| Competitor suggestions w/ evidence | **Y** | P | N | P | P | P | raw | N | N | N | Y | N |
| AI-search visibility | N | Y | Y | Y | ? | Y | Y | N | N | N | Y | N |
| Server log analysis | N | Y | N | N | N | N | N | N | N | N | N | N |
| Local / GBP | P (local SERP) | P | Y | N | N | N | Y | N | N | N | N | Y |
| Multi-client, auto-discovered | **Y** | P | N | N | Projects | Projects | N | N | N | N | Projects | Y |
| Per-client spend caps | **Y** | P | N | N | N | N | N | n/a | n/a | n/a | n/a | P |
| Report file export | N | Y | Y | N | N | MD | N | N | N | CSV | ? | N |
| Report templates | N | N | N | N | N | N | N | N | N | N | Saved | N |
| Scheduled checks + alerts | **Y** | CI only | N | N | N | Audits | N | N | N | N | Schedules | N |
| Installer for AI apps | Y (4) | Y (4) | plugin | n/a | n/a | n/a | n/a | manual | manual | MCPB | npx | hosted |
| Prompts / skills | 7 prompts | skill | 34 skills | n/a | n/a | 20+ skills | n/a | skills | N | N | N | 155 skills |

## Ranked gaps

Fit is scored against crawlmark's principles: local, read-only Google access, free-first, spend caps, no client data leaving the machine.

| # | Gap | Who has it | Value | Effort | Data / cost | Fit |
|---|---|---|---|---|---|---|
| 1 | Report output to Markdown, standalone HTML and PDF (Chrome `page.pdf()`); optional DOCX | iannuttall, claude-seo, Whatagraph, Screaming Frog | High | S–M | Free | Excellent; Google Docs via the user's own Drive connector |
| 2 | Report templates: sections, metrics, date ranges, comparison periods; recurring via the CLI scheduler | Whatagraph, Nightwatch, AgencyAnalytics (platform only) | High | M | Free | Excellent |
| 3 | Free bounded local crawl (e.g. 500 URLs): broken links, redirects, titles, canonicals, depth, internal links, orphans | iannuttall, Screaming Frog, Sitebulb | High | L | Free | Excellent; removes the paid dependency in orphan detection |
| 4 | Stored rank history and a scheduled `check-ranks` | Ahrefs, Semrush, SE Ranking, AWR, Nightwatch, iannuttall | High | M | DataForSEO SERP, capped | Good (paid, opt-in) |
| 5 | Keyword ideas and keyword gap vs competitors | Ahrefs, Semrush, SE Ranking, iannuttall | High | S–M | Existing providers, capped | Good |
| 6 | AI-search visibility (mentions/citations in AI answers) | Ahrefs Brand Radar, SE Ranking, Nightwatch, Peec, iannuttall, claude-seo | High | M | DataForSEO LLM Mentions ($100/mo minimum) | Medium (paid, opt-in) |
| 7 | Bing Webmaster Tools data | iannuttall, InsightfulPipe, AgencyAnalytics, community | Medium–High | M | Free API key | Excellent (read-only; keep IndexNow out) |
| 8 | Local SEO: GBP profile/reviews, map pack | InsightfulPipe, gbp-mcp, claude-seo, DataForSEO Business Data | Medium–High | M | DataForSEO Business Data; GBP API needs Google approval | Good via DataForSEO |
| 9 | CrUX History (25–40 weeks of p75 LCP/INP/CLS) | claude-seo, PSI/CrUX MCPs | Medium | S | Free with the existing key | Excellent |
| 10 | Server-log analysis (Googlebot and AI crawlers) | iannuttall | Medium | M | Free, local files | Excellent |
| 11 | Backlink detail (new/lost, referring domains, anchors) | Ahrefs, Semrush, SE Ranking, DataForSEO | Medium | S–M | Providers, capped | Good |
| 12 | GA4 funnels, realtime, custom dimensions | analytics-mcp | Low–Medium | S | Free | Excellent |
| 13 | Search Console beyond 5,000 rows | InsightfulPipe, BigQuery | Low–Medium | S–M | Free / BigQuery | Good |
| 14 | Google Trends seasonality | scrapers, DataForSEO Trends | Low | S | Paid or fragile | Medium |
| 15 | Tag Manager findings inside `run_audit` | internal | Medium | S | Free | Excellent |

**Deliberately not gaps** (write actions, against the principles): IndexNow/Indexing API submission, sitemap submission, GBP review replies, site or sitemap deletion.

## What crawlmark does that competitors don't (for the launch post)

1. Tag Manager container audit.
2. Automated accessibility (axe) next to SEO and Lighthouse.
3. Audit diffs that only mark a finding resolved when its check actually re-ran (`unverified` otherwise).
4. Branded vs non-branded split with inferred brand terms kept separate per client.
5. Competitor suggestions with keyword-overlap and local SERP evidence, never saved automatically.
6. One setup for many clients, discovered across Search Console, GA4 and Tag Manager.
7. Bring your own provider with hard per-client caps (dollars and units) and no silent fallback.
8. Scheduled audits and traffic-drop alerts built in.
9. Free-first by default; paid calls state their cost.
10. Local and read-only, unlike every hosted vendor MCP.

Word the post carefully: iannuttall/seo overlaps on local-first operation, provider spend limits, projects and installer registration. Claim the specifics (GTM, axe, diffs, branded inference, per-client caps, alerts), not "the only local SEO MCP".

## Distribution and discoverability

- **Claude directory no longer accepts MCPB bundles**; local servers go in as **plugin bundles** (public GitHub repo; `.mcp.json` plus skills). Remote connectors need OAuth 2.0 and `title` plus `readOnlyHint`/`destructiveHint` on every tool (crawlmark already has the annotations). Keep MCPB as a sideload.
- **Official MCP Registry** (preview): publish to npm, add `mcpName` (e.g. `io.github.idrewlong/crawlmark`), write `server.json`, run `mcp-publisher publish`. Aggregators read the registry; Glama indexes GitHub automatically.
- **Market trend:** hosted one-click OAuth connectors. crawlmark's local design keeps client data on the machine but excludes claude.ai web and ChatGPT users. A self-hosted HTTP mode could come later; a hosted crawlmark would break the "no client data leaves the machine" principle.
- **Cursor Marketplace** is a likely second channel.
- **Naming:** npm `seo` is taken; `crawlmark-mcp` is free.
- **Roundups** ("best SEO MCP" posts by Nightwatch, SE Ranking, InsightfulPipe and others) are outreach targets after publishing.

## The recurring custom report use case

- **Whatagraph:** `list-templates` and `export-report` (Excel/PDF, one-hour link), hosted, plan-gated writes.
- **Nightwatch:** runs saved reports into chat; templates defined in its UI.
- **AgencyAnalytics:** templates and scheduled delivery in the platform, not through the MCP.
- **Semrush:** "monthly reports in Google Docs or Notion" via your own integrations.
- **iannuttall/seo, claude-seo, SE Ranking skills:** fixed reports, Markdown/HTML/PDF/CSV, no templates.
- **Conclusion:** no open-source or local SEO MCP lets a user define sections, metrics and date ranges as a reusable template.

**Google Docs / Drive options:**
- Google's official Workspace MCPs (developer preview): Drive MCP can create files; Docs MCP reads and updates docs (no create tool as of July 2026). Both need a Cloud project and preview enrolment.
- Claude's built-in Google Drive connector: `create_file` (`title`, `textContent`, `contentMimeType`, `parentId`) converts supported content to Google Docs by default; `update_file` only changes title and parent, so each month would be a new file.
- Drive API imports Markdown and HTML into Google Docs.
- Community: `mcp-gdocs`, workspacemcp.com, `mcp-google-suite`, Composio's Google Docs toolkit.

**Pipeline:** Claude calls `monthly_report` → writes the Markdown (or crawlmark renders HTML) → Drive connector `create_file`. Untested; HTML is the safer input for tables.

## Recommendation

1. **Before launch:** report renderer to `~/.crawlmark/reports/<client>/<YYYY-MM>.*` (Markdown, HTML, PDF); CrUX History; GTM findings in `run_audit`; a "save to Google Docs if a Drive tool is available" step in `monthly-report-writeup`.
2. **Next:** report templates (YAML, used by the prompt, `monthly_report` and `crawlmark-cli report --all`); stored rank history; keyword ideas and gap.
3. **Later:** free local crawler; Bing; local via DataForSEO Business Data; AI visibility (paid, opt-in); server logs.
4. **Distribution:** npm → MCP Registry → Claude plugin bundle; keep MCPB as a sideload; no hosted version.

**What would change this:** demand from claude.ai web or ChatGPT users (self-hosted HTTP/OAuth mode moves up); poor Markdown conversion in Drive (switch the handoff to HTML); iannuttall/seo adding templates or GTM checks (reword the differentiation).

## Not confirmed

- Ahrefs MCP endpoint, tool count and per-plan units (help centre says Lite has 200k; third parties say 25k).
- Whether Semrush MCP is in Claude's connector directory.
- SE Ranking's exact tool count and auth method.
- Drive connector Markdown conversion quality (not exercised; it would create a file in the user's Drive).
- Whether Google's Docs MCP has added a create tool since July 2026.
- iannuttall/seo's full tool list, monthly-report date options and spend-limit configuration.
- Whether crawlmark persists tracked-keyword positions between `monthly_report` runs (check `src/reports/` before scoping rank history).
- Popularity of servers without public stats.
- Whether a Moz MCP exists (none found).
- CrUX History length (25 vs 40 weeks; docs disagree).
- DataForSEO LLM Mentions per-request pricing (only the $100/month minimum is consistent).
- AgencyAnalytics MCP's existence (vendor page treated as authoritative).

## Sources

- [Semrush MCP docs](https://developer.semrush.com/api/basics/semrush-mcp/)
- [Getting started with Ahrefs MCP](https://help.ahrefs.com/en/articles/13913559-getting-started-with-ahrefs-mcp)
- [SEO MCP servers roundup (mcpplaygroundonline)](https://mcpplaygroundonline.com/blog/seo-mcp-servers)
- [dataforseo/mcp-server-typescript](https://github.com/dataforseo/mcp-server-typescript), [DataForSEO MCP setup guide](https://dataforseo.com/help-center/setting-up-the-official-dataforseo-mcp-server-simple-guide/amp)
- [DataForSEO LLM Mentions pricing](https://dataforseo.com/pricing/ai-optimization/llm-mentions), [Google Reviews API pricing](https://dataforseo.com/pricing/business-data/google-reviews-api)
- [googleanalytics/google-analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp)
- [AminForou/mcp-gsc](https://github.com/AminForou/mcp-gsc), [Suganthan GSC MCP privacy](https://suganthan.com/gsc-mcp/privacy/)
- [iannuttall/seo](https://github.com/iannuttall/seo), [README](https://raw.githubusercontent.com/iannuttall/seo/main/README.md)
- [AgriciDaniel/claude-seo](https://github.com/AgriciDaniel/claude-seo)
- [seranking/seo-skills](https://github.com/seranking/seo-skills), [SE Ranking skills library](https://help.seranking.com/hc/en-us/articles/29485358470300-Skills-library), [SE Ranking: best SEO MCPs](https://seranking.com/blog/best-seo-mcps/)
- [Screaming Frog MCP guide](https://www.screamingfrog.co.uk/guides/mcp-server/), [SEO Spider 24](https://www.screamingfrog.co.uk/seo-spider-24/)
- [Nightwatch: best SEO MCP servers](https://nightwatch.io/blog/best-seo-mcp-servers/), [Nightwatch listing](https://mcpservers.org/servers/nightwatch-io-seo-mcp)
- [InsightfulPipe: best SEO MCP servers](https://insightfulpipe.com/blog/best-seo-mcp-servers)
- [Similarweb Claude MCP](https://developers.similarweb.com/docs/claude-mcp-integration)
- [AgencyAnalytics MCP](https://agencyanalytics.com/features/model-context-protocol), [1ClickReport on AgencyAnalytics](https://www.1clickreport.com/blog/does-agencyanalytics-have-an-mcp-server-2026)
- [Whatagraph MCP](https://mcp.whatagraph.com/)
- [Dev Leader Bing Webmaster MCP](https://www.devleader.ca/projects/bing-webmaster-mcp), [mcp-server-bwt](https://glama.ai/mcp/servers/@zizzfizzix/mcp-server-bwt/blob/413064a8bcfbaa53c8a6c2e5dd065bed5f2798f6/README.md)
- [gbp-mcp](https://glama.ai/mcp/servers/tbjanofr59), [GBP API access guide](https://unified.to/blog/how_to_set_up_google_business_profile_api_access_and_get_oauth_2_credentials), [GBP API access thread](https://discuss.google.dev/t/gbp-api-escalation-basic-access-pending-14-days-requests-per-minute-locked-at-0/393020)
- [pagespeed-insights-mcp](https://cdn.jsdelivr.net/npm/pagespeed-insights-mcp@2.1.0/README.md), [Dev Leader PSI MCP](https://www.devleader.ca/projects/google-psi-mcp), [CrUX History API](https://developer.chrome.com/docs/crux/history-api), [guide](https://developer.chrome.com/docs/crux/guides/history-api)
- [Google Trends MCP](https://glama.ai/mcp/servers/@ainightshift/google_trends_mcp), [Trends API alpha](https://ppc.land/google-opens-alpha-testing-for-new-trends-api-targeting-developers-and-journalists/)
- [Workspace release notes](https://developers.google.com/workspace/release-notes), [Google Docs MCP review](https://www.usecarly.com/blog/google-docs-mcp/)
- [Drive API uploads/import](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [export formats](https://developers.google.com/workspace/drive/api/guides/ref-export-formats), [Markdown in Google Docs](https://workspaceupdates.googleblog.com/2024/07/import-and-export-markdown-in-google-docs.html)
- [mcp-gdocs](https://pypi.org/project/mcp-gdocs/), [workspacemcp.com](https://workspacemcp.com/), [mcp-google-suite](https://mcpservers.org/servers/adexltd/mcp-google-suite)
- [Claude directory: publish](https://claude.com/docs/directory/publish), [connector submission](https://claude.com/docs/connectors/building/submission), [MCP directory FAQ](https://support.claude.com/en/articles/11596036-anthropic-mcp-directory-faq)
- [MCP Registry quickstart](https://modelcontextprotocol.io/registry/quickstart.md), [Glama alternatives](https://composio.dev/blog/glama-alternatives)
- [Search Console MCP listing](https://enterprisedna.co/directories/mcp/lionkiii-google-searchconsole-mcp)
- npm registry: `npm view seo` (v0.2.41) and `npm view crawlmark-mcp` (404)
