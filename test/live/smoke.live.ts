/**
 * Opt-in live smoke checks (`npm run test:live`). Each check calls ONE free endpoint with the credentials crawlmark's
 * normal config loading finds (CRAWLMARK_HOME/.env or the shell), then asserts the response parses with the same
 * production code the tools use. A check whose credential is missing skips with a reason. Every request goes through
 * the allowlist in ./guard.ts, which throws on anything not documented as free.
 *
 * Never run by `npm test` or CI. Output is a summary table; no credential or response body is printed.
 */
import { google } from "googleapis";
import { afterAll, describe, expect, it, type TestContext } from "vitest";
import { env } from "../../src/config.js";
import { ga4PropertiesFromSummaries, gscSitesFromResponse } from "../../src/lib/clients.js";
import { checkAhrefsKey } from "../../src/providers/ahrefs.js";
import { checkBingKey } from "../../src/providers/bing.js";
import { cruxHistory, cruxKey } from "../../src/providers/crux.js";
import { checkDataForSeoCredentials } from "../../src/providers/dataforseo.js";
import { googleAuth, googleConfigured } from "../../src/providers/google.js";
import { assertFreeEndpoint, guardedFetchFrom, PaidEndpointRefusedError } from "./guard.js";

const guarded = guardedFetchFrom(globalThis.fetch);
/** googleapis per-call options. `fetchImplementation` is a gaxios option the generated types do not list. */
const callOpts = { fetchImplementation: guarded } as { timeout?: number };

interface Row {
  check: string;
  endpoint: string;
  status: "pass" | "skip" | "FAIL";
  detail: string;
}
const rows: Row[] = [];

/** Register a check: skipped with `missing` when it returns a reason, else `run` returns a one-line detail. */
function check(name: string, endpoint: string, missing: () => string | undefined, run: () => Promise<string>) {
  it(name, async (ctx: TestContext) => {
    const reason = missing();
    if (reason) {
      rows.push({ check: name, endpoint, status: "skip", detail: reason });
      ctx.skip(reason);
      return;
    }
    try {
      const detail = await run();
      rows.push({ check: name, endpoint, status: "pass", detail });
    } catch (err) {
      rows.push({ check: name, endpoint, status: "FAIL", detail: (err as Error).message.slice(0, 200) });
      throw err;
    }
  });
}

afterAll(() => {
  // Written straight to stdout: vitest's reporter can swallow console output from hooks.
  const cols = ["check", "endpoint", "status", "detail"] as const;
  const width = (c: (typeof cols)[number]) => Math.max(c.length, ...rows.map((r) => r[c].length));
  const line = (r: Record<(typeof cols)[number], string>) => cols.map((c) => r[c].padEnd(width(c))).join("  ");
  const out = [
    "",
    "Live smoke summary (free endpoints only)",
    line({ check: "check", endpoint: "endpoint", status: "status", detail: "detail" }),
    cols.map((c) => "-".repeat(width(c))).join("  "),
    ...rows.map(line),
    "",
  ];
  process.stdout.write(out.join("\n"));
});

describe("guard", () => {
  it("refuses a paid path before any request is sent", async () => {
    let sent = false;
    const g = guardedFetchFrom((async () => ((sent = true), new Response("{}"))) as typeof fetch);
    for (const [method, url] of [
      ["POST", "https://api.dataforseo.com/v3/serp/google/organic/live/regular"],
      ["GET", "https://api.ahrefs.com/v3/site-explorer/organic-keywords?target=example.com"],
      ["GET", "https://api.semrush.com/apis/v4/keywords/v1/metrics?keyword=x&country=US"],
    ] as const) {
      await expect(g(url, { method })).rejects.toBeInstanceOf(PaidEndpointRefusedError);
    }
    expect(sent).toBe(false);
    expect(() => assertFreeEndpoint("GET", "https://api.ahrefs.com/v3/subscription-info/limits-and-usage")).not.toThrow();
  });
});

describe("live smoke: free endpoints", () => {
  check(
    "Search Console sites list",
    "GET searchconsole /webmasters/v3/sites",
    () => (googleConfigured() ? undefined : "no Google credentials (run setup --step google)"),
    async () => {
      const res = await google.searchconsole({ version: "v1", auth: googleAuth() }).sites.list({}, callOpts);
      const sites = gscSitesFromResponse(res.data);
      expect(Array.isArray(sites)).toBe(true);
      for (const s of sites) expect(s.siteUrl).toMatch(/^(sc-domain:|https?:\/\/)/);
      return `${sites.length} site(s)`;
    },
  );

  check(
    "GA4 account summaries",
    "GET analyticsadmin /v1beta/accountSummaries",
    () => (googleConfigured() ? undefined : "no Google credentials (run setup --step google)"),
    async () => {
      const res = await google.analyticsadmin({ version: "v1beta", auth: googleAuth() }).accountSummaries.list({ pageSize: 50 }, callOpts);
      const props = ga4PropertiesFromSummaries(res.data);
      for (const p of props) expect(p.propertyId).toMatch(/^\d+$/);
      return `${props.length} propert(ies)`;
    },
  );

  check(
    "DataForSEO account (user_data)",
    "GET /v3/appendix/user_data",
    () => (env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD ? undefined : "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set"),
    async () => {
      const r = await checkDataForSeoCredentials({ login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD, baseUrl: env.DATAFORSEO_BASE_URL }, guarded);
      expect("error" in r ? r.error : "").toBe("");
      expect(r).toMatchObject({ credentialsConfigured: true, credentialsWork: true, reachable: true, costUsd: 0 });
      expect(["sandbox", "live"]).toContain(r.mode);
      return `credentials work, ${r.mode} mode`;
    },
  );

  check(
    "Ahrefs status (limits-and-usage)",
    "GET /v3/subscription-info/limits-and-usage",
    () => (env.AHREFS_API_KEY ? undefined : "AHREFS_API_KEY not set"),
    async () => {
      const r = await checkAhrefsKey(env.AHREFS_API_KEY, guarded);
      expect(r.error ?? "").toBe("");
      expect(r).toMatchObject({ configured: true, works: true, reachable: true, costUsd: 0 });
      return "key works";
    },
  );

  check(
    "Bing Webmaster site list",
    "GET GetUserSites",
    () => (env.BING_WEBMASTER_API_KEY ? undefined : "BING_WEBMASTER_API_KEY not set"),
    async () => {
      const r = await checkBingKey(env.BING_WEBMASTER_API_KEY!, guarded);
      expect(r.ok ? "" : r.problem).toBe("");
      if (r.ok) {
        expect(r.sites).toBeGreaterThanOrEqual(0);
        expect(r.verified).toBeLessThanOrEqual(r.sites);
        return `${r.sites} site(s), ${r.verified} verified`;
      }
      return "";
    },
  );

  check(
    "CrUX history for a public origin",
    "POST /v1/records:queryHistoryRecord",
    () => (cruxKey() ? undefined : "CRUX_API_KEY (or PSI_API_KEY) not set"),
    async () => {
      const r = await cruxHistory({ origin: "https://developer.chrome.com", weeks: 2 }, { fetchImpl: guarded, refresh: true });
      expect(r.available, "developer.chrome.com should have CrUX data").toBe(true);
      return "origin has field data";
    },
  );
});
