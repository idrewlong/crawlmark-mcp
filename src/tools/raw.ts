import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cliHint } from "../lib/cli-hint.js";
import { z } from "zod";
import { resolveClient } from "../clients.js";
import { lastCompleteMonth, monthRange } from "../lib/dates.js";
import { runAxe } from "../providers/axe.js";
import { ahrefsStatus } from "../providers/ahrefs.js";
import { dataForSeoStatus } from "../providers/dataforseo.js";
import { semrushStatus } from "../providers/semrush.js";
import { backlinksSummary, competitorDomains, rankedKeywords, searchVolume, serp } from "../providers/seo-data.js";
import { effectiveHostnames, ga4HostnameBreakdown, ga4Report } from "../providers/ga4.js";
import { gscInspectUrl, gscQuery } from "../providers/gsc.js";
import { validateGa4Hostnames } from "../lib/ga4-hostnames.js";
import { fillGscMonths, gscHistoryView } from "../lib/gsc-monthly.js";
import { runLighthouse } from "../providers/lighthouse.js";
import { clientOrigin, cruxHistory } from "../providers/crux.js";
import { checkRender } from "../providers/render.js";
import { TIMEOUTS } from "../lib/timeout.js";
import { keywordInput } from "../lib/clients.js";
import { recordLiveRank } from "../lib/rank-history.js";
import { assertUserUrl } from "../user-url.js";
import { handler, READ_ONLY } from "./util.js";

/** Writes local history to the database and may make many Search Console calls. */
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/**
 * Lower-level tools for ad-hoc questions ("which pages lost clicks from the
 * blog?"). The report tools in reports.ts cover the routine workflows.
 */

const clientArg = z
  .string()
  .describe("Client domain (e.g. 'example.com'; URL and www. forms also work) or a clients.yaml slug. See list_clients.");
const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const BROWSER = { timeoutMs: TIMEOUTS.browserMs };
/** Routed paid tools: each result carries `provider` (whose data it is), `units` (Ahrefs/Semrush API units; null for DataForSEO), costUsd and fromCache. */
const PAID = "Paid (DataForSEO, Ahrefs or Semrush, per client; the result's `provider` and `units` say which and how many API units)";
const URL_RULES =
  "http/https only; hosts that resolve to a private, loopback or link-local address are refused unless ALLOW_PRIVATE_URLS=true, " +
  "and with RESTRICT_TO_CLIENT_DOMAINS=true only client domains and their subdomains are allowed.";
const URL_SAFETY = `${URL_RULES} Times out after 90s.`;
/** Lighthouse runs one at a time, so its whole-call limit covers the longest wait plus one run (a backstop; the run has its own timer). */
const LIGHTHOUSE = { timeoutMs: TIMEOUTS.lighthouseQueueMs + TIMEOUTS.lighthouseRunMs + 30_000 };

function rangeOrDefault(startDate?: string, endDate?: string) {
  if (startDate && endDate) return { startDate, endDate };
  return monthRange(lastCompleteMonth());
}

export function registerRawTools(server: McpServer) {
  // ------------------------------------------------------------- Google (free)

  server.registerTool(
    "gsc_query",
    {
      title: "Search Console query",
      description:
        "Query Google Search Console search analytics for a client. Group by query, page, country, device or date, " +
        "and filter by page or query substring. Free. Defaults to the last complete month. " +
        "The client's gscExcludeQueries are left out of the rows (set includeExcludedQueries to see raw Search Console numbers).",
      inputSchema: {
        client: clientArg,
        startDate: dateArg.optional(),
        endDate: dateArg.optional(),
        dimensions: z.array(z.enum(["query", "page", "country", "device", "date"])).optional(),
        pageContains: z.string().optional(),
        queryContains: z.string().optional(),
        rowLimit: z.number().int().min(1).max(25000).optional(),
        includeExcludedQueries: z.boolean().optional().describe("Don't leave out the client's gscExcludeQueries (raw numbers). Default false."),
      },
      annotations: READ_ONLY,
    },
    handler("gsc_query", async ({ client, startDate, endDate, ...rest }) =>
      gscQuery(await resolveClient(client), { ...rangeOrDefault(startDate, endDate), ...rest }),
    ),
  );

  server.registerTool(
    "gsc_history",
    {
      title: "Search Console history",
      description:
        "Saved monthly Search Console history for a client: clicks, impressions, CTR and position per month, and optionally one month's top pages, queries, devices and countries. " +
        "Free. Google keeps only 16 months of Search Console data, so run this once per client with backfill: true to save what Google still has (the oldest month may be partial, complete: false); " +
        "monthly_report and report runs then save the newest missing months. Saved numbers are raw: the client's gscExcludeQueries are applied to saved query rows when a report reads them, and to saved totals only for months saved under the same exclusions (otherwise totals are read raw, with a note). " +
        "A backfill paces its requests, backs off at quota limits and is safe to run again: it only fetches months not saved yet (refresh: false).",
      inputSchema: {
        client: clientArg,
        backfill: z.boolean().optional().describe("Fetch and save the months not saved yet (up to `months`). Default false: only show what is saved."),
        months: z.number().int().min(1).max(16).optional().describe("How many recent months a backfill covers. Default 16."),
        month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM: the month `detail` shows (default: the newest saved month)."),
        detail: z.array(z.enum(["pages", "queries", "devices", "countries"])).optional().describe("Also return that month's saved rows."),
        limit: z.number().int().min(1).max(250).optional().describe("Rows per detail list. Default 25."),
      },
      annotations: LOCAL_WRITE,
    },
    handler(
      "gsc_history",
      async ({ client, backfill, months, month, detail, limit }, { signal }) => {
        const c = await resolveClient(client);
        if (!c.gscProperty) throw new Error(`No Search Console property found for ${c.domain}, so there is no history to save. Give the Google account access to the site in Search Console (then call list_clients with refresh: true).`);
        const n = months ?? 16;
        const fill = backfill ? await fillGscMonths(c, { max: n, window: n, signal }, { gscQuery, now: Date.now }) : undefined;
        const view = gscHistoryView(c, { month, detail, limit: limit ?? 25 });
        if (fill?.failed.length) view.notes.unshift(`${fill.failed.length} month(s) weren't saved. Call gsc_history with backfill: true again to carry on where it stopped.`);
        return { client: c.domain, property: c.gscProperty, stored: view.stored, ...(fill ? { backfill: fill } : {}), ...(view.detail ? { detail: view.detail } : {}), notes: view.notes };
      },
      { timeoutMs: 5 * 60_000 },
    ),
  );

  server.registerTool(
    "crux_history",
    {
      title: "Core Web Vitals history (CrUX)",
      description:
        "Real-user Core Web Vitals over time from the Chrome UX Report History API: the 75th percentile of LCP, INP, CLS, FCP and TTFB per weekly period " +
        "(each a 28-day window; default 25 periods, up to 40, about 10 months), with a good / needs-improvement / poor rating per period and a trend " +
        "(the last 4 periods against the first 4; within 5% is flat). Give exactly one of client (its https origin), url or origin. " +
        `Free with CRUX_API_KEY, or a PSI_API_KEY whose Google Cloud project has the Chrome UX Report API enabled (${cliHint()} setup --step crux). ` +
        "`available: false` means Chrome has too little traffic data for that origin or URL. Cached for a day.",
      inputSchema: {
        client: clientArg.optional(),
        url: z.string().url().max(2000).optional().describe("One page, e.g. https://example.com/pricing."),
        origin: z.string().url().max(300).optional().describe("A whole origin, e.g. https://example.com."),
        formFactor: z.enum(["PHONE", "DESKTOP", "TABLET", "ALL"]).optional().describe("Default PHONE."),
        weeks: z.number().int().min(1).max(40).optional().describe("Weekly periods. Default 25."),
        metrics: z.array(z.enum(["lcp", "inp", "cls", "fcp", "ttfb"])).min(1).optional().describe("Default all five."),
      },
      annotations: READ_ONLY,
    },
    handler("crux_history", async ({ client, url, origin, formFactor, weeks, metrics }) => {
      if ([client, url, origin].filter((v) => v !== undefined).length !== 1) throw new Error("Give exactly one of client, url or origin.");
      if (origin !== undefined) {
        const u = new URL(origin);
        if (!/^https?:$/.test(u.protocol) || (u.pathname !== "/" && u.pathname !== "") || u.search) throw new Error("origin must be a scheme and host only, e.g. https://example.com.");
      }
      if (url !== undefined && !/^https?:/i.test(url)) throw new Error("url must be http or https.");
      const target = client ? { origin: clientOrigin(await resolveClient(client)) } : origin ? { origin: new URL(origin).origin } : { url };
      return cruxHistory({ ...target, formFactor, weeks, metrics });
    }),
  );

  server.registerTool(
    "gsc_inspect_url",
    {
      title: "Inspect URL in Search Console",
      description: "Index status, Google-selected canonical, last crawl, mobile usability and rich results for one URL. Free.",
      inputSchema: { client: clientArg, url: z.string().url() },
      annotations: READ_ONLY,
    },
    handler("gsc_inspect_url", async ({ client, url }) => gscInspectUrl(await resolveClient(client), url)),
  );

  server.registerTool(
    "ga4_report",
    {
      title: "GA4 report",
      description:
        "Run a GA4 Data API report for a client. Pass GA4 API metric and dimension names " +
        "(e.g. metrics: sessions, keyEvents, engagementRate; dimensions: landingPagePlusQueryString, sessionDefaultChannelGroup, date). Free. " +
        "Only the client's GA4 hostnames are counted (default: the domain and its www form; set ga4Hostnames with set_client_profile). " +
        "Returns { rows, hostnames } where hostnames lists the hostnames left out with their session counts; hostnames / allHostnames override the filter for this call.",
      inputSchema: {
        client: clientArg,
        metrics: z.array(z.string()).min(1),
        dimensions: z.array(z.string()).optional(),
        startDate: dateArg.optional(),
        endDate: dateArg.optional(),
        organicOnly: z.boolean().optional().describe("Restrict to Organic Search sessions."),
        limit: z.number().int().min(1).max(10000).optional(),
        hostnames: z.array(z.string().max(253)).min(1).max(20).optional().describe('Count only these hostnames for this call ("shop.example.com", "*.example.com" for any subdomain). Default: the client\'s ga4Hostnames.'),
        allHostnames: z.boolean().optional().describe("Count every hostname (no hostname filter) for this call."),
      },
      annotations: READ_ONLY,
    },
    handler("ga4_report", async ({ client, startDate, endDate, hostnames, allHostnames, ...rest }) => {
      if (hostnames && allHostnames) throw new Error("Give hostnames or allHostnames, not both.");
      if (hostnames) {
        const problem = validateGa4Hostnames(hostnames);
        if (problem) throw new Error(`hostnames: ${problem}`);
      }
      const c = await resolveClient(client);
      const range = rangeOrDefault(startDate, endDate);
      const override = allHostnames ? ["*"] : hostnames;
      const rows = await ga4Report(c, { ...range, ...rest, ...(override ? { hostnames: override } : {}) });
      const effective = effectiveHostnames(c, override);
      let breakdown: Awaited<ReturnType<typeof ga4HostnameBreakdown>> | undefined;
      let breakdownError: string | undefined;
      try {
        breakdown = await ga4HostnameBreakdown(c, range, { ...(rest.organicOnly !== undefined ? { organicOnly: rest.organicOnly } : {}), ...(override ? { hostnames: override } : {}) });
      } catch (err) {
        breakdownError = err instanceof Error ? err.message : String(err);
      }
      return {
        rows,
        hostnames: {
          applied: effective.includes("*") ? ("all" as const) : effective,
          excludedSessions: breakdown && breakdown.applied !== "all" ? breakdown.excludedSessions : null,
          excluded: breakdown?.excluded ?? [],
          ...(breakdownError ? { error: breakdownError } : {}),
        },
      };
    }),
  );

  // ------------------------------------- paid SEO data (DataForSEO, Ahrefs or Semrush, per client)

  server.registerTool(
    "keyword_volume",
    {
      title: "Keyword search volume",
      description: "Monthly Google search volume, CPC and competition for up to 1,000 keywords in the client's market. " + PAID + ", cached 30 days.",
      inputSchema: { client: clientArg, keywords: z.array(keywordInput).min(1).max(1000) },
      annotations: READ_ONLY,
    },
    handler("keyword_volume", async ({ client, keywords }) => searchVolume(await resolveClient(client), keywords)),
  );

  server.registerTool(
    "serp_check",
    {
      title: "Live SERP check",
      description:
        "Live Google organic results for one keyword in the client's market, with the client's rank and the top 10. Paid (DataForSEO only, whatever the client's data provider), cached 1 day. " +
        "When the keyword is one of the client's tracked keywords, its rank is also saved to rank history (see rank_history).",
      inputSchema: { client: clientArg, keyword: z.string(), depth: z.number().int().min(10).max(100).optional() },
      annotations: READ_ONLY,
    },
    handler("serp_check", async ({ client, keyword, depth }) => {
      const c = await resolveClient(client);
      const r = await serp(c, keyword, depth);
      // Phase 12 B: tracked keywords only (B-D1); an untracked keyword stores nothing. The result is unchanged.
      recordLiveRank(c, keyword, r, depth === undefined ? {} : { depth });
      return r;
    }),
  );

  server.registerTool(
    "ranked_keywords",
    {
      title: "Ranked keywords",
      description: "Keywords a domain ranks for (defaults to the client's domain; pass a competitor domain to compare). " + PAID + ", cached 7 days.",
      inputSchema: {
        client: clientArg,
        target: z.string().optional().describe("Domain to analyze. Defaults to the client's domain."),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      annotations: READ_ONLY,
    },
    handler("ranked_keywords", async ({ client, target, limit }) => rankedKeywords(await resolveClient(client), target, limit)),
  );

  server.registerTool(
    "competitor_domains",
    {
      title: "Organic competitors",
      description: "Domains that compete with the client for the same organic keywords. " + PAID + ", cached 30 days.",
      inputSchema: { client: clientArg, limit: z.number().int().min(1).max(100).optional() },
      annotations: READ_ONLY,
    },
    handler("competitor_domains", async ({ client, limit }) => competitorDomains(await resolveClient(client), limit)),
  );

  server.registerTool(
    "backlinks_summary",
    {
      title: "Backlinks summary",
      description: "Backlink and referring-domain counts, rank and spam score for a domain (rank and spam score are DataForSEO-only; `authority` labels each provider's own domain-strength metric). " + PAID + ", cached 7 days.",
      inputSchema: { client: clientArg, target: z.string().optional() },
      annotations: READ_ONLY,
    },
    handler("backlinks_summary", async ({ client, target }) => {
      const c = await resolveClient(client);
      const r = await backlinksSummary(c, target);
      // Phase 13 B (side effect only; the output is unchanged): a fresh summary of the client's own domain is stored as
      // a dated snapshot, so the backlinks report section can compare months without buying it again.
      const bare = (d: string) => d.toLowerCase().replace(/^www\./, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!r.fromCache && r.summary && bare(target ?? c.domain) === bare(c.domain)) {
        try {
          const { saveSnapshot } = await import("../lib/snapshots.js");
          const s = r.summary;
          saveSnapshot({
            client: c.slug,
            kind: "backlinks",
            target: bare(c.domain),
            provider: r.provider,
            market: "global",
            day: new Date().toISOString().slice(0, 10),
            source: "live",
            capturedAt: Date.now(),
            data: { backlinks: s.backlinks, referringDomains: s.referringDomains, authority: s.authority, newBacklinks: s.newBacklinks, lostBacklinks: s.lostBacklinks, newReferringDomains: null, lostReferringDomains: null },
          });
        } catch (err) {
          console.error(`crawlmark: couldn't store the backlinks snapshot: ${(err as Error).message}`);
        }
      }
      return r;
    }),
  );

  server.registerTool(
    "dataforseo_status",
    {
      title: "DataForSEO status",
      description:
        "Check the DataForSEO account: whether the credentials work, the mode (`sandbox` = canned free data, `live` = billed) from the configured base URL, and the account balance in USD. " +
        "Free, never cached, records no spend, and never shows the credentials. A missing or rejected login is reported in the result, not as a tool error.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler("dataforseo_status", () => dataForSeoStatus()),
  );

  server.registerTool(
    "ahrefs_status",
    {
      title: "Ahrefs status",
      description:
        "Check the Ahrefs API v3 key with Ahrefs' free limits-and-usage call: whether the key works, the plan, the key's and workspace's units used this billing month " +
        "and when they reset, plus the units crawlmark recorded this calendar month against its own cap (monthlyUnitCap). " +
        "Free (no API units), never cached, records no spend, and never shows the key. A missing or rejected key is reported in the result, not as a tool error; on a paid call a rejected key is an error that says how to fix the key or move that client to another configured provider (set_client_profile dataProvider), and crawlmark never switches providers by itself. " +
        `Change the key in a terminal (${cliHint()} setup --step ahrefs), never through chat.`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler("ahrefs_status", () => ahrefsStatus()),
  );

  server.registerTool(
    "semrush_status",
    {
      title: "Semrush status",
      description:
        "Whether a Semrush API key (v4, from the profile > API keys page) is set, what Semrush serves in crawlmark (keyword volume and backlinks; its v4 API has no rankings, " +
        "competitors, visibility or Site Audit), and the units crawlmark recorded this calendar month against its own cap. Semrush has no free key check, so a rejected key shows " +
        `on the first paid call, as an error that says how to fix the key or move that client to another configured provider (set_client_profile dataProvider); crawlmark never switches providers by itself. Free, never cached, records no spend, never shows a key. Change the key in a terminal (${cliHint()} setup --step semrush), never through chat.`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler("semrush_status", async () => semrushStatus()),
  );

  // ---------------------------------------------------- browser checks (free)

  server.registerTool(
    "lighthouse",
    {
      title: "Lighthouse",
      description:
        "Run Lighthouse on any URL: category scores, lab Core Web Vitals and top opportunities. " +
        "Adds real-user CrUX field data when PSI_API_KEY is set. " +
        "Free. Usually 30-60 s; Lighthouse runs one at a time, so parallel calls queue (each run times out after 150 s, not counting the wait). Call it for one URL at a time. " +
        URL_RULES,
      inputSchema: { url: z.string().url(), formFactor: z.enum(["mobile", "desktop"]).optional() },
      annotations: READ_ONLY,
    },
    handler(
      "lighthouse",
      async ({ url, formFactor }, { signal }) => {
        await assertUserUrl(url);
        return runLighthouse(url, formFactor, { signal });
      },
      LIGHTHOUSE,
    ),
  );

  server.registerTool(
    "accessibility_check",
    {
      title: "Accessibility check (axe)",
      description:
        "Run axe-core WCAG checks on any URL. Returns violations grouped by rule with impact, WCAG criteria and example selectors. " +
        "Automated checks catch a subset of issues; flag manual review in reports. Free. " + URL_SAFETY,
      inputSchema: { url: z.string().url(), level: z.enum(["A", "AA", "AAA"]).optional() },
      annotations: READ_ONLY,
    },
    handler(
      "accessibility_check",
      async ({ url, level }, { signal }) => {
        await assertUserUrl(url);
        return runAxe(url, level, { signal });
      },
      BROWSER,
    ),
  );

  server.registerTool(
    "render_check",
    {
      title: "Rendered vs raw HTML check",
      description:
        "Fetch a URL twice, as plain HTML (Googlebot-like user agent, no JavaScript) and as rendered by headless Chrome, then compare title, " +
        "meta description, canonical, robots meta, H1s, links, JSON-LD types, hreflang, Open Graph and visible word count. " +
        "Flags SEO elements that only appear after JavaScript runs (rules like title-js-only, canonical-mismatch, content-js-dependent). " +
        "Free, ~15s, cached 1 day. " + URL_SAFETY,
      inputSchema: { url: z.string().url(), refresh: z.boolean().optional().describe("Bypass the one-day cache.") },
      annotations: READ_ONLY,
    },
    handler(
      "render_check",
      async ({ url, refresh }, { signal }) => {
        await assertUserUrl(url);
        return checkRender(url, { refresh: refresh ?? false, signal });
      },
      BROWSER,
    ),
  );
}
