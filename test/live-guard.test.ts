/**
 * The paid-endpoint guard behind `npm run test:live` (test/live/guard.ts). The live runner itself never runs in the
 * normal suite; this checks the guard that keeps it free. No network: the "real" fetch is a stub that records calls.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AHREFS_PATHS } from "../src/providers/ahrefs-shape.js";
import { assertFreeEndpoint, FREE_ENDPOINTS, guardedFetchFrom, PaidEndpointRefusedError } from "./live/guard.js";

const stub = () => {
  const sent: string[] = [];
  const real = (async (input: Parameters<typeof fetch>[0]) => {
    sent.push(String(input));
    return new Response("{}");
  }) as typeof fetch;
  return { sent, fetch: guardedFetchFrom(real) };
};

describe("live smoke guard", () => {
  it("lets the documented-free calls through", async () => {
    const { sent, fetch } = stub();
    await fetch("https://api.ahrefs.com/v3/subscription-info/limits-and-usage");
    await fetch("https://sandbox.dataforseo.com/v3/appendix/user_data");
    await fetch("https://api.dataforseo.com/v3/appendix/user_data", { method: "GET" });
    await fetch("https://api.semrush.com/users/countapiunits.html?key=k");
    await fetch("https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=k");
    await fetch("https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=k", { method: "POST" });
    expect(sent).toHaveLength(6);
  });

  it("refuses every paid path before sending, including each Ahrefs path except the status check", async () => {
    const { sent, fetch } = stub();
    const paid: [string, string][] = [
      ["POST", "https://api.dataforseo.com/v3/serp/google/organic/live/regular"],
      ["POST", "https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live"],
      ["POST", "https://api.dataforseo.com/v3/business_data/google/reviews/task_post"],
      ["POST", "https://api.dataforseo.com/v3/appendix/user_data"],
      ["GET", "https://api.semrush.com/?type=domain_organic&key=k"],
      ["GET", "https://api.semrush.com/analytics/v1/?type=backlinks_overview&key=k"],
      ["GET", "https://api.semrush.com/users/countapiunits.html.evil/"],
      ["GET", "https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=x"],
      ["GET", "https://evil.example/v3/subscription-info/limits-and-usage"],
      ["GET", "https://api.ahrefs.com.evil.example/v3/subscription-info/limits-and-usage"],
      ...Object.values(AHREFS_PATHS)
        .filter((p) => p !== AHREFS_PATHS.limitsAndUsage)
        .map((p): [string, string] => ["GET", `https://api.ahrefs.com/v3${p}`]),
    ];
    for (const [method, url] of paid) await expect(fetch(url, { method }), `${method} ${url}`).rejects.toBeInstanceOf(PaidEndpointRefusedError);
    expect(sent).toEqual([]);
  });

  it("refuses an unparseable URL and never puts the query string (a key) in the message", () => {
    expect(() => assertFreeEndpoint("GET", "not a url")).toThrow(PaidEndpointRefusedError);
    let message = "";
    try {
      assertFreeEndpoint("GET", "https://api.semrush.com/?type=domain_organic&key=SECRET-KEY-123");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Refusing GET api\.semrush\.com\//);
    expect(message).not.toContain("SECRET-KEY-123");
  });

  it("every allowlisted rule is a GET status/list call or a POST that is free (no write or paid verb snuck in)", () => {
    for (const r of FREE_ENDPOINTS) {
      if (r.method === "POST") expect(["CrUX", "Google auth"]).toContain(r.vendor);
      expect(r.path.source).not.toMatch(/\.\*/); // no wildcard paths
    }
  });

  it("the smoke runner calls vendors only through the guarded fetch", () => {
    const smoke = readFileSync(join(import.meta.dirname, "live", "smoke.live.ts"), "utf8");
    // Every production check function is handed `guarded`; none is called with the default fetch.
    for (const fn of ["checkDataForSeoCredentials", "checkAhrefsKey", "checkSemrushKey", "checkBingKey"]) {
      expect(smoke, fn).toMatch(new RegExp(`${fn}\\([^)]*guarded\\)`));
    }
    expect(smoke).toMatch(/cruxHistory\([^)]*fetchImpl: guarded/);
    expect(smoke).toMatch(/fetchImplementation: guarded/);
    // And the setup file installs the guard on the global fetch too.
    expect(readFileSync(join(import.meta.dirname, "live", "setup.ts"), "utf8")).toMatch(/globalThis\.fetch = guardedFetchFrom/);
  });
});
