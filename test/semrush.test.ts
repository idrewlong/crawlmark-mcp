/**
 * Semrush through its v4 API only. keyword_volume uses v4 Get Keyword Metrics and backlinks_summary the v4 overview;
 * every other capability isn't in Semrush's v4 API, so it falls back to DataForSEO or says why not. No request ever
 * goes anywhere but /apis/v4/. fetch is stubbed; test/setup.ts points the Semrush base URL at a closed local port.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

const KEY = "semrush-SENTINEL-v4-77ef"; // gitleaks:allow (fake test key)
process.env.SEMRUSH_API_KEY = KEY;
process.env.SEO_DATA_PROVIDER = "semrush";

const routed = await import("../src/providers/seo-data.js");
const shape = await import("../src/providers/semrush-shape.js");
const semrush = await import("../src/providers/semrush.js");
const { env } = await import("../src/config.js");
const { db } = await import("../src/lib/store.js");
const { semrushRow } = await import("../src/setup/status.js");

const fx = (name: string) => readFileSync(new URL(`./fixtures/semrush/${name}`, import.meta.url), "utf8");

interface Call {
  url: URL;
  auth: string | null;
}

function fake(respond: (c: Call, n: number) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname !== "127.0.0.1") throw new Error("test tried to reach a real host");
      const call = { url, auth: new Headers(init?.headers).get("authorization") };
      calls.push(call);
      const custom = respond(call, calls.length);
      if (custom) return custom;
      if (url.pathname === "/apis/v4/keywords/v1/metrics") return new Response(fx("v4-keyword-metrics.json"), { status: 200 });
      if (url.pathname === "/apis/v4/backlinks/v1/overview") return new Response(fx("v4-backlinks-overview.json"), { status: 200 });
      return new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

let n = 0;
function client(over: Partial<Client> = {}): Client {
  n++;
  return {
    slug: `sem${n}.example.com`,
    domain: `sem${n}.example.com`,
    aliases: [],
    monthlyBudgetUsd: 5,
    locationCode: 2840,
    languageCode: "en",
    country: "US",
    monthlyUnits: { ahrefs: 10_000, semrush: 100_000 },
    ...over,
  } as unknown as Client;
}
const ledger = (c: Client) => db.prepare("SELECT endpoint, units FROM spend WHERE client = ? ORDER BY id").all(c.slug) as { endpoint: string; units: number }[];

beforeEach(() => {
  semrush.semrushTiming.sleep = async () => {};
  semrush.semrushTiming.spacing = async () => {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  env.SEMRUSH_API_KEY = KEY;
});

describe("keyword_volume (v4 Get Keyword Metrics)", () => {
  it("sends one request per keyword with the Authorization header and maps the string fields to numbers", async () => {
    const calls = fake();
    const c = client();
    const r = await routed.searchVolume(c, ["seo tools"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/apis/v4/keywords/v1/metrics");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ keyword: "seo tools", country: "US" });
    expect(calls[0]!.auth).toBe(`Apikey ${KEY}`);
    expect(calls[0]!.url.href).not.toContain(KEY);
    expect(r).toMatchObject({ provider: "semrush", units: 20, result: [{ keyword: "seo tools", search_volume: 60500, competition: "HIGH", cpc: 1245 }] });
    expect(r.notes?.join(" ")).toContain("Early Access");
    expect(r.notes?.join(" ")).toContain("cpc is passed through");
    expect(ledger(c)).toEqual([{ endpoint: "keywords/v1/metrics", units: 20 }]);
  });

  it("estimates 20 units per keyword and enforces the cap before any request", async () => {
    const calls = fake();
    await expect(routed.searchVolume(client({ monthlyUnits: { ahrefs: 1, semrush: 59 } }), ["a b", "c d", "e f"])).rejects.toThrow(/Semrush unit cap hit/);
    expect(calls).toHaveLength(0);
    const ok = client({ monthlyUnits: { ahrefs: 1, semrush: 60 } });
    const r = await routed.searchVolume(ok, ["g h", "i j", "k l"]);
    expect(calls).toHaveLength(3);
    expect(r.units).toBe(60);
    expect(ledger(ok).map((l) => l.units)).toEqual([20, 20, 20]);
  });

  it("splits keywords on ; and line breaks before pricing, so one entry can't smuggle in extra billed requests", async () => {
    const calls = fake();
    const r = await routed.searchVolume(client(), ["m n;o p", "q r"]);
    expect(calls).toHaveLength(3);
    expect(r.units).toBe(60);
  });

  it("a timeout records the estimate", async () => {
    fake(() => {
      throw new DOMException("timeout", "TimeoutError");
    });
    const c = client();
    await expect(routed.searchVolume(c, ["timeout kw"])).rejects.toThrow(/timed out after 30s; Semrush may still have billed it/);
    expect(ledger(c)).toEqual([{ endpoint: "keywords/v1/metrics (timeout, estimated)", units: 20 }]);
  });

  it("one 429 is retried; a second surfaces with the rate-limit message", async () => {
    const waits: number[] = [];
    semrush.semrushTiming.sleep = async (ms) => void waits.push(ms);
    fake((_c, k) => (k === 1 ? new Response("", { status: 429 }) : undefined));
    expect((await routed.searchVolume(client(), ["retry kw"])).units).toBe(20);
    expect(waits).toEqual([2000]);
    fake(() => new Response("", { status: 429, headers: { "retry-after": "1" } }));
    await expect(routed.searchVolume(client(), ["limit kw"])).rejects.toThrow("Semrush request limit hit (10 requests/s, 10 at once); try again shortly.");
  });

  it("a client with no country is unavailable before any request", async () => {
    const calls = fake();
    await expect(routed.searchVolume(client({ country: undefined as never }), ["no country kw"])).rejects.toThrow(/country/);
    expect(calls).toHaveLength(0);
  });
});

describe("backlinks_summary (v4 overview)", () => {
  it("calls the v4 overview with the header and 45 units", async () => {
    const calls = fake();
    const c = client();
    const r = await routed.backlinksSummary(c);
    expect(calls[0]!.url.pathname).toBe("/apis/v4/backlinks/v1/overview");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ url: c.domain, scope: "ROOT_DOMAIN", fields: "backlinks_count,domains_count,new_count,lost_count,score" });
    expect(calls[0]!.auth).toBe(`Apikey ${KEY}`);
    expect(calls[0]!.url.href).not.toContain(KEY);
    expect(r).toMatchObject({ units: 45, summary: { backlinks: 2341, referringDomains: 156, newBacklinks: 23, lostBacklinks: 15, authority: { metric: "semrush_score", value: 78 } } });
    expect(ledger(c)).toEqual([{ endpoint: "backlinks/v1/overview", units: 45 }]);
  });
});

describe("v4 errors", () => {
  it("401 and 403 are the rejected-key message that points at a v4 key", async () => {
    const MSG = /^Semrush rejected the API key for .+ \(HTTP 40[13]\)\. .*To fix the key: .* setup --step semrush\.$/;
    fake(() => new Response(fx("v4-error-403.json"), { status: 403 }));
    await expect(routed.searchVolume(client(), ["auth kw one"])).rejects.toThrow(MSG);
    fake(() => new Response("{}", { status: 401 }));
    await expect(routed.backlinksSummary(client())).rejects.toThrow(MSG);
    expect(shape.classifySemrushV4Error(403, { code: 403, message: "Not enough API units" }).kind).toBe("balance");
    expect(shape.classifySemrushV4Error(400, { code: 400, message: "bad" }).kind).toBe("request");
    expect(shape.classifySemrushV4Error(500, null).kind).toBe("server");
  });

  it("errors never carry the key", async () => {
    fake(() => new Response(JSON.stringify({ meta: { success: false, status_code: 500 }, error: { code: 500, message: `boom ${KEY}` } }), { status: 500 }));
    const err = await routed.backlinksSummary(client()).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(KEY);
  });
});

describe("capabilities Semrush's v4 API doesn't have", () => {
  const E = (dfs: boolean) => ({ defaultProvider: "semrush" as const, configured: { dataforseo: dfs, ahrefs: false, semrush: true } });
  const c = { slug: "x", dataProvider: undefined };
  const LACKING = ["rankedKeywords", "competitorDomains", "organicOverview", "competitorOverview", "keywordIdeas", "keywordGap"] as const;

  it("resolveProvider falls back to DataForSEO with fallbackFrom when it is set up", () => {
    for (const cap of LACKING) expect(routed.resolveProvider(c, cap, E(true)), cap).toEqual({ provider: "dataforseo", fallbackFrom: "semrush" });
    for (const cap of ["keywordVolume", "backlinksSummary"] as const) expect(routed.resolveProvider(c, cap, E(true)), cap).toEqual({ provider: "semrush" });
  });

  it("otherwise says Semrush's API (v4) doesn't include it and to use DataForSEO or Ahrefs", () => {
    const words: Record<string, string> = {
      rankedKeywords: "ranked keywords",
      competitorDomains: "competitor domains",
      organicOverview: "organic visibility",
      competitorOverview: "the competitor overview",
      keywordIdeas: "keyword ideas",
      keywordGap: "keyword gaps",
    };
    for (const cap of LACKING) expect(routed.resolveProvider(c, cap, E(false)), cap).toEqual({ unavailable: `Semrush's API (v4) doesn't include ${words[cap]}. Use DataForSEO or Ahrefs for it.` });
  });

  it("the routed calls give that message with no DataForSEO login, and make no request", async () => {
    const login = env.DATAFORSEO_LOGIN;
    env.DATAFORSEO_LOGIN = undefined;
    try {
      const calls = fake();
      await expect(routed.rankedKeywords(client(), "example.com", 5)).rejects.toThrow("Semrush's API (v4) doesn't include ranked keywords. Use DataForSEO or Ahrefs for it.");
      await expect(routed.competitorDomains(client(), 5)).rejects.toThrow("Semrush's API (v4) doesn't include competitor domains.");
      expect(calls).toHaveLength(0);
    } finally {
      env.DATAFORSEO_LOGIN = login;
    }
  });

  it("the Semrush provider only claims keyword volume and backlinks", () => {
    expect([...semrush.semrushProvider.capabilities].sort()).toEqual(["backlinksSummary", "keywordVolume"]);
    expect(semrush.semrushProvider.rankedKeywords).toBeUndefined();
    expect(semrush.semrushProvider.organicOverview).toBeUndefined();
    expect(semrush.semrushProvider.keywordGap).toBeUndefined();
  });

  it("a whole routed run only ever calls /apis/v4/ paths, with the header and no key in the URL", async () => {
    const calls = fake();
    await routed.searchVolume(client(), ["full run kw"]);
    await routed.backlinksSummary(client());
    const login = env.DATAFORSEO_LOGIN;
    env.DATAFORSEO_LOGIN = undefined;
    try {
      for (const f of [() => routed.rankedKeywords(client(), "example.com", 5), () => routed.competitorDomains(client(), 5)]) await f().catch(() => undefined);
    } finally {
      env.DATAFORSEO_LOGIN = login;
    }
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.url.pathname.startsWith("/apis/v4/")).toBe(true);
      expect(call.auth).toBe(`Apikey ${KEY}`);
      expect(call.url.searchParams.has("key")).toBe(false);
    }
  });
});

describe("the key", () => {
  it("SEMRUSH_V4_API_KEY, the 0.1.0 name for the v4 key, is read when SEMRUSH_API_KEY is unset and wins when both are set (there SEMRUSH_API_KEY was the old v3 key)", async () => {
    const saved = { main: process.env.SEMRUSH_API_KEY, alias: process.env.SEMRUSH_V4_API_KEY };
    try {
      vi.resetModules();
      delete process.env.SEMRUSH_API_KEY;
      process.env.SEMRUSH_V4_API_KEY = "alias-key-1234"; // gitleaks:allow (fake test key)
      expect((await import("../src/config.js")).env.SEMRUSH_API_KEY).toBe("alias-key-1234");
      vi.resetModules();
      process.env.SEMRUSH_API_KEY = "old-v3-key-5678"; // gitleaks:allow (fake test key)
      expect((await import("../src/config.js")).env.SEMRUSH_API_KEY).toBe("alias-key-1234");
      vi.resetModules();
      delete process.env.SEMRUSH_V4_API_KEY;
      expect((await import("../src/config.js")).env.SEMRUSH_API_KEY).toBe("old-v3-key-5678");
    } finally {
      vi.resetModules();
      if (saved.main === undefined) delete process.env.SEMRUSH_API_KEY;
      else process.env.SEMRUSH_API_KEY = saved.main;
      if (saved.alias === undefined) delete process.env.SEMRUSH_V4_API_KEY;
      else process.env.SEMRUSH_V4_API_KEY = saved.alias;
    }
  });

  it("status and requests use the v4 alias when both are set", async () => {
    const saved = { main: process.env.SEMRUSH_API_KEY, alias: process.env.SEMRUSH_V4_API_KEY };
    try {
      vi.resetModules();
      process.env.SEMRUSH_API_KEY = "old-v3-key-5678";
      process.env.SEMRUSH_V4_API_KEY = "v4-alias-key-9999";
      const mod = await import("../src/providers/semrush.js");
      const cfg = await import("../src/config.js");
      expect(mod.semrushStatus().keySet).toBe(true);
      expect(cfg.env.SEMRUSH_API_KEY).toBe("v4-alias-key-9999");
      const seen: (string | null)[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_u: string, init?: RequestInit) => {
          seen.push(new Headers(init?.headers).get("authorization"));
          return new Response(fx("v4-backlinks-overview.json"), { status: 200 });
        }),
      );
      const { backlinksSummary } = await import("../src/providers/seo-data.js");
      await backlinksSummary(client({ slug: "both-keys.example.com", domain: "both-keys.example.com" }));
      expect(seen).toEqual(["Apikey v4-alias-key-9999"]);
    } finally {
      vi.resetModules();
      if (saved.main === undefined) delete process.env.SEMRUSH_API_KEY;
      else process.env.SEMRUSH_API_KEY = saved.main;
      if (saved.alias === undefined) delete process.env.SEMRUSH_V4_API_KEY;
      else process.env.SEMRUSH_V4_API_KEY = saved.alias;
    }
  });
});

describe("status rows", () => {
  const input = (over: Record<string, unknown> = {}) => ({ keySet: true, chosen: { byDefault: false, clients: 0 }, unitsUsedThisMonth: 30, cap: 20_000, ...over });

  it("setup_status: key set is configured, with the capabilities, the units and 'no free key check'; no key is missing, or an error when used", () => {
    const row = semrushRow(input(), "next");
    expect(row).toMatchObject({ id: "semrush", state: "configured", next: null, data: { keySet: true, keyCheck: "none", capabilities: { keywordVolume: true, backlinksSummary: true }, unitsUsedThisMonth: 30, cap: 20_000 } });
    expect(row.detail).toContain("no free key check");
    expect(row.detail).toContain("keyword volume");
    expect(semrushRow(input({ keySet: false }), "next").state).toBe("missing");
    expect(semrushRow(input({ keySet: false, chosen: { byDefault: true, clients: 0 } }), "next").state).toBe("error");
    expect(JSON.stringify(row)).not.toContain(KEY);
  });

  it("semrush_status shows the key state, what it serves and the ledger, with no balance call and no key", async () => {
    const calls = fake();
    const s = semrush.semrushStatus();
    expect(s).toMatchObject({ keySet: true, keyCheck: "none", capabilities: { keywordVolume: true, backlinksSummary: true } });
    expect(JSON.stringify(s)).not.toContain(KEY);
    expect(calls).toHaveLength(0);
    env.SEMRUSH_API_KEY = undefined;
    expect(semrush.semrushStatus().capabilities).toEqual({ keywordVolume: false, backlinksSummary: false });
  });
});
