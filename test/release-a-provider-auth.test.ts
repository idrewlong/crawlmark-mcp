/**
 * D9b / C17: a Semrush or Ahrefs key the vendor rejects gives a clear error with the way out (fix the key, or move
 * the client to another configured provider). It never falls back to another provider (A7).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

process.env.SEMRUSH_API_KEY = "semrush-SENTINEL-auth-31aa"; // gitleaks:allow (fake test key)
process.env.SEO_DATA_PROVIDER = "semrush";

const routed = await import("../src/providers/seo-data.js");
const semrush = await import("../src/providers/semrush.js");
const { env } = await import("../src/config.js");
const { cliHint } = await import("../src/lib/cli-hint.js");
const { db } = await import("../src/lib/store.js");

const client: Client = {
  slug: "auth.example.com",
  domain: "auth.example.com",
  aliases: [],
  monthlyBudgetUsd: 5,
  locationCode: 2840,
  languageCode: "en",
  country: "US",
  dataProvider: "semrush",
  monthlyUnits: { ahrefs: 10_000, semrush: 100_000 },
} as unknown as Client;

const saved = { login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD };
let hosts: string[];

beforeEach(() => {
  semrush.semrushTiming.sleep = async () => {};
  semrush.semrushTiming.spacing = async () => {};
  hosts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      hosts.push(new URL(input).hostname);
      return new Response(JSON.stringify({ error: { code: 401, message: "Unauthorized" } }), { status: 401 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  env.DATAFORSEO_LOGIN = saved.login;
  env.DATAFORSEO_PASSWORD = saved.password;
});

const spendRows = () => (db.prepare("SELECT COUNT(*) AS n FROM spend WHERE client = ?").get(client.slug) as { n: number }).n;

describe("Semrush rejects the key", () => {
  it("says so, names the configured alternative and both fixes, and makes no second request", async () => {
    env.DATAFORSEO_LOGIN = "login@example.com";
    env.DATAFORSEO_PASSWORD = "fake-password"; // gitleaks:allow (fake test value)
    const cli = cliHint();
    const err = await routed.backlinksSummary(client).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(routed.ProviderKeyRejectedError);
    expect(err!.message).toBe(
      `Semrush rejected the API key for auth.example.com (HTTP 401). To use another provider for this client: set_client_profile with dataProvider "dataforseo" (or ${cli} clients set auth.example.com --provider dataforseo). To fix the key: ${cli} setup --step semrush.`,
    );
    expect((err!.cause as Error).name).toBe("SemrushApiError");
    expect(hosts).toHaveLength(1); // one Semrush request (the one retry rule is for 429 only); nothing went to DataForSEO
    expect(new Set(hosts)).toEqual(new Set(["127.0.0.1"]));
    expect(spendRows()).toBe(0);
  });

  it("says no other provider is set up when none is", async () => {
    env.DATAFORSEO_LOGIN = undefined;
    env.DATAFORSEO_PASSWORD = undefined;
    const cli = cliHint();
    await expect(routed.backlinksSummary(client)).rejects.toThrow(
      `Semrush rejected the API key for auth.example.com (HTTP 401). No other data provider is set up for this request; run ${cli} setup --step provider. To fix the key: ${cli} setup --step semrush.`,
    );
    expect(hosts).toHaveLength(1);
    expect(spendRows()).toBe(0);
  });

  it("applies to keyword_volume too", async () => {
    await expect(routed.searchVolume(client, ["blue widgets"])).rejects.toBeInstanceOf(routed.ProviderKeyRejectedError);
  });
});

describe("keyRejectedMessage", () => {
  it("lists every other configured provider and uses the provider's own label and setup step", () => {
    const m = routed.keyRejectedMessage("ahrefs", { domain: "x.example.com" }, 403, { dataforseo: true, ahrefs: true, semrush: true }, "CLI");
    expect(m).toBe(
      'Ahrefs rejected the API key for x.example.com (HTTP 403). To use another provider for this client: set_client_profile with dataProvider "dataforseo" or "semrush" (or CLI clients set x.example.com --provider dataforseo). To fix the key: CLI setup --step ahrefs.',
    );
  });

  it("lists only providers that can serve the capability that failed", () => {
    const all = { dataforseo: true, ahrefs: true, semrush: true } as const;
    // Ranked keywords: Semrush's v4 API can't serve them, so only DataForSEO is suggested.
    const ranked = routed.keyRejectedMessage("ahrefs", { domain: "x.example.com" }, 403, all, "CLI", "rankedKeywords");
    expect(ranked).toContain('dataProvider "dataforseo" (or');
    expect(ranked).not.toContain("semrush\"");
    // Backlinks: Semrush can.
    expect(routed.keyRejectedMessage("ahrefs", { domain: "x.example.com" }, 403, all, "CLI", "backlinksSummary")).toContain('"dataforseo" or "semrush"');
    // Only Semrush configured besides the rejected key, and it can't serve ranked keywords: nothing to suggest.
    expect(routed.keyRejectedMessage("ahrefs", { domain: "x.example.com" }, 403, { dataforseo: false, ahrefs: true, semrush: true }, "CLI", "rankedKeywords")).toContain(
      "No other data provider is set up for this request; run CLI setup --step provider.",
    );
  });
});
