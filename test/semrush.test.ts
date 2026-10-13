/**
 * Semrush (Phase 9 task 6). Fixtures copy the documented examples in
 * docs/research/semrush-api.md; fetch is stubbed and test/setup.ts points the Semrush
 * base and balance URLs at a closed local port, so nothing leaves the process.
 */
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

const KEY = "semrush-SENTINEL-v3-91ab";
const V4KEY = "semrush-SENTINEL-v4-55cd";
process.env.SEMRUSH_API_KEY = KEY;
process.env.SEO_DATA_PROVIDER = "semrush";

const shape = await import("../src/providers/semrush-shape.js");
const semrush = await import("../src/providers/semrush.js");
const routed = await import("../src/providers/seo-data.js");
const { env, SEMRUSH_DEFAULT_BALANCE_URL } = await import("../src/config.js");
const { db } = await import("../src/lib/store.js");
const { TTL } = await import("../src/lib/cache.js");
const { handler } = await import("../src/tools/util.js");

const FIXDIR = new URL("./fixtures/semrush/", import.meta.url);
const fx = (name: string) => readFileSync(new URL(name, FIXDIR), "utf8");
const NOTE = readFileSync(new URL("../docs/research/semrush-api.md", import.meta.url), "utf8");

interface Call {
  url: URL;
  auth: string | null;
}

function fakeSemrush(respond: (c: Call, n: number) => Response | undefined = () => undefined) {
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
      const type = url.searchParams.get("type");
      if (url.pathname === "/apis/v4/backlinks/v1/overview") return new Response(fx("v4-backlinks-overview.json"), { status: 200 });
      if (type === "backlinks_overview") return new Response(fx("backlinks_overview.doc.csv"), { status: 200 });
      if (type === "phrase_these") return new Response(fx("phrase_these.csv"), { status: 200 });
      if (type === "domain_organic") return new Response(fx("domain_organic.csv"), { status: 200 });
      if (type === "domain_organic_organic") return new Response(fx("domain_organic_organic.csv"), { status: 200 });
      if (url.pathname.endsWith("countapiunits.html")) return new Response(fx("balance.txt"), { status: 200 });
      return new Response("ERROR 40 :: MANDATORY PARAMETER action NOT SET OR EMPTY", { status: 200 });
    }),
  );
  return calls;
}

let n = 0;
function client(over: Partial<Client> = {}): Client {
  n++;
  return {
    slug: `s${n}.example.com`,
    domain: `s${n}.example.com`,
    aliases: [],
    monthlyBudgetUsd: 5,
    locationCode: 2826,
    languageCode: "en",
    country: "GB",
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
  env.SEMRUSH_V4_API_KEY = undefined;
});

// ------------------------------------------------------------------ shape (pure)

describe("Semrush CSV", () => {
  it("reads the documented domain_organic example by export_columns position, Trends commas included", () => {
    const cols = ["Ph", "Po", "Pp", "Pd", "Nq", "Cp", "Ur", "Tr", "Tc", "Co", "Nr", "Td"];
    const rows = shape.parseSemrushCsv(fx("domain_organic.doc.csv"), cols);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ Ph: "seo", Po: "9", Nq: "110000", Ur: "http://www.example.com/", Tr: "17.53" });
    expect(rows[0]!.Td).toBe("0.81,1.00,1.00,1.00,1.00,0.81,0.81,0.81,0.81,0.81,0.81,0.81");
  });

  it("a header that doesn't match the documented text is a SemrushFormatError, never a mis-map", () => {
    expect(() => shape.parseSemrushCsv(fx("domain_organic.doc.csv"), ["Ph", "Nq"])).toThrow(shape.SemrushFormatError);
    expect(() => shape.parseSemrushCsv("Keyword;Volume\na;1\n", ["Ph", "Nq"])).toThrow(/column 2 is "Volume", expected "Search Volume" for Nq/);
  });

  it("handles quoted fields (export_escape=1), CRLF and a trailing newline", () => {
    const rows = shape.parseSemrushCsv(fx("domain_organic.csv"), shape.SEMRUSH_COLUMNS.domain_organic);
    expect(rows).toHaveLength(4);
    expect(rows[2]!.Ph).toBe("example; quoted");
    expect(shape.parseSemrushCsv('"Keyword";"Search Volume"\r\n"a ""b""";"10"\r\n', ["Ph", "Nq"])).toEqual([{ Ph: 'a "b"', Nq: "10" }]);
  });

  it("every fixture's header cells equal the documented header text in docs/research/semrush-api.md", () => {
    // code -> header text, from the note's column tables (| `Ph` | Keyword | ...).
    const documented = new Map([...NOTE.matchAll(/^\s*\| `([A-Za-z]{2})` \| ([^|]+?) \|/gm)].map((m) => [m[1]!, m[2]!.trim()]));
    const headerOf = (code: string) => (["ascore", "total", "domains_num"].includes(code) ? code : documented.get(code));
    for (const [code, text] of Object.entries(shape.SEMRUSH_HEADER_TEXT)) {
      if (headerOf(code) !== undefined) expect(text, code).toBe(headerOf(code));
    }
    const csvs = readdirSync(FIXDIR).filter((f) => f.endsWith(".csv"));
    expect(csvs.length).toBeGreaterThanOrEqual(7);
    const byText = new Map([...Object.entries(shape.SEMRUSH_HEADER_TEXT)].map(([c, t]) => [t, c]));
    for (const f of csvs) {
      const header = fx(f).split(/\r?\n/)[0]!;
      for (const cell of header.split(";").map((c) => c.replace(/^"|"$/g, ""))) {
        const code = byText.get(cell);
        expect(code, `${f}: ${cell}`).toBeDefined();
        // Columns in the note's code tables must match them; the others appear in the documented example lines (checked below).
        if (headerOf(code!) !== undefined) expect(headerOf(code!), `${f}: ${cell}`).toBe(cell);
        else expect(f.endsWith(".doc.csv"), `${f}: ${cell} is only documented in an example`).toBe(true);
      }
      // The documented examples' header lines appear verbatim in the note.
      if (f.endsWith(".doc.csv")) expect(NOTE, f).toContain(header);
    }
  });
});

describe("Semrush errors and balance", () => {
  it("parses ERROR bodies and maps every documented code to the spec's message", () => {
    expect(shape.parseSemrushError(fx("error-50.txt"))).toEqual({ code: 50, text: "NOTHING FOUND" });
    const msg = (code: number, text = "x") => shape.classifySemrushError({ code, text }, "uk").message;
    for (const c of [110, 120]) expect(msg(c)).toBe("Semrush rejected the API key (SEMRUSH_API_KEY, or SEMRUSH_V4_API_KEY for v4 calls).");
    for (const c of [130, 135]) expect(msg(c)).toBe("Semrush API is not enabled for this account or report (needs an SEO Business plan plus an API unit package).");
    expect(msg(132)).toBe("Semrush API units balance is zero; buy units under Subscription info > API units.");
    for (const c of [131, 134]) expect(msg(c)).toBe("Semrush request limit hit (10 requests/s, 10 at once); try again shortly.");
    expect(msg(133)).toBe("Semrush denied access to database uk on this plan.");
    expect(msg(43, "MANDATORY PARAMETER phrase NOT SET OR EMPTY")).toMatch(/^Semrush rejected the request \(43: MANDATORY PARAMETER phrase NOT SET OR EMPTY\)/);
    expect(shape.classifySemrushError({ code: 10005, text: "Wrong parameter" }, null).kind).toBe("request");
  });

  it("maps the documented v4 error JSON by error.code", () => {
    const e = shape.parseSemrushV4Error(JSON.parse(fx("v4-error-403.json")));
    expect(e).toEqual({ code: 403, message: "Forbidden", retryable: false, status: 403 });
    expect(shape.classifySemrushV4Error(403, e).kind).toBe("disabled");
    expect(shape.classifySemrushV4Error(403, { code: 403, message: "Not enough API units" }).kind).toBe("balance");
    expect(shape.classifySemrushV4Error(200, { code: 132, message: "" }).kind).toBe("balance");
    expect(shape.classifySemrushV4Error(401, { code: 401, message: "" }).kind).toBe("auth");
    expect(shape.classifySemrushV4Error(429, null).kind).toBe("rate");
  });

  it("parses the balance body", () => {
    expect(shape.parseUnitsBalance(fx("balance.txt"))).toBe(1000);
    expect(shape.parseUnitsBalance(" 25,300 \r\n")).toBe(25300);
    expect(shape.parseUnitsBalance("ERROR 120 :: WRONG KEY - ID PAIR")).toBeNull();
  });

  it("maps Co to LOW/MEDIUM/HIGH at the boundaries and fills missing keywords", () => {
    expect([0, 0.33, 0.34, 0.66, 0.67, 1].map((c) => shape.competitionLevel(c))).toEqual(["LOW", "LOW", "MEDIUM", "MEDIUM", "HIGH", "HIGH"]);
    const out = shape.mapSemrushKeywordVolumes(shape.parseSemrushCsv(fx("phrase_these.csv"), shape.SEMRUSH_COLUMNS.phrase_these), ["example widgets", "missing one"]);
    expect(out).toEqual([
      { keyword: "example widgets", search_volume: 1900, competition: "LOW", cpc: 1.25 },
      { keyword: "missing one", search_volume: null, competition: null, cpc: null },
    ]);
  });

  it("prices: 10/line, 40/line, 45 or 40 per request, empty is free", () => {
    expect(shape.estimateSemrushUnits("domain_organic", 4)).toBe(40);
    expect(shape.estimateSemrushUnits("domain_organic_organic", 5)).toBe(200);
    expect(shape.estimateSemrushUnits("backlinks_overview_v4", 1)).toBe(45);
    expect(shape.estimateSemrushUnits("backlinks_overview_v3", 1)).toBe(40);
    expect(shape.estimateSemrushUnits("backlinks_overview_v3", 0)).toBe(0);
  });
});

// ------------------------------------------------------------------ client

describe("Semrush requests", () => {
  it("every report URL has display_limit (and the database); Tg is requested and Tr never is; GB is uk", async () => {
    const calls = fakeSemrush();
    const c = client();
    await routed.rankedKeywords(c, c.domain, 10);
    await routed.competitorDomains(c, 5);
    const [ranked, comps] = calls;
    expect(Object.fromEntries(ranked!.url.searchParams)).toEqual({
      type: "domain_organic",
      domain: c.domain,
      database: "uk",
      export_columns: "Ph,Po,Nq,Ur,Tg",
      display_sort: "nq_desc",
      display_limit: "10",
      key: KEY,
    });
    expect(ranked!.url.searchParams.get("export_columns")!.split(",")).not.toContain("Tr");
    expect(comps!.url.searchParams.get("display_limit")).toBe("5");
    expect(comps!.url.searchParams.get("export_columns")).toBe("Dn,Np,Ot");
  });

  it("partial lines: display_limit 10 and 4 lines back gives 4 rows, 40 units and the note; Tg is estimatedTraffic", async () => {
    fakeSemrush();
    const c = client();
    const r = await routed.rankedKeywords(c, c.domain, 10);
    expect(r).toMatchObject({ provider: "semrush", units: 40, costUsd: 0, fromCache: false, totalCount: 4 });
    expect(r.items[0]).toEqual({ keyword: "example widgets", position: 3, searchVolume: 1900, url: "https://example.com/widgets", estimatedTraffic: 240 });
    expect(r.items[3]!.position).toBeNull();
    expect(r.notes).toEqual(["Semrush returned 4 of 10 requested lines; if your unit balance is low, results may be cut short (semrush_status shows the balance)."]);
    expect(ledger(c)).toEqual([{ endpoint: "domain_organic", units: 40 }]);
    // Cached: no request, no ledger row, units 0.
    const again = await routed.rankedKeywords(c, c.domain, 10);
    expect(again).toMatchObject({ fromCache: true, units: 0 });
    expect(ledger(c)).toHaveLength(1);
  });

  it("ERROR 50 is an empty result costing nothing, with no partial-lines note", async () => {
    fakeSemrush(() => new Response(fx("error-50.txt"), { status: 200 }));
    const c = client();
    const r = await routed.competitorDomains(c, 10);
    expect(r).toMatchObject({ totalCount: 0, items: [], units: 0 });
    expect(r.notes).toBeUndefined();
  });

  it("keyword volume: phrase_these with keywords joined by ;, batches of 100", async () => {
    const calls = fakeSemrush();
    const kws = Array.from({ length: 101 }, (_, i) => (i === 0 ? "example widgets" : `example kw ${i}`));
    const r = await routed.searchVolume(client(), kws);
    expect(calls.map((c) => c.url.searchParams.get("phrase")!.split(";").length)).toEqual([100, 1]);
    expect(r.result[0]).toEqual({ keyword: "example widgets", search_volume: 1900, competition: "LOW", cpc: 1.25 });
    expect(r.units).toBe(60); // 3 lines per batch x 10
    expect(r.notes).toHaveLength(1); // the first batch returned 3 of 100
  });

  it("backlinks with only SEMRUSH_API_KEY use the v3 overview at /analytics/v1/ (40 units)", async () => {
    const calls = fakeSemrush();
    const c = client();
    const r = await routed.backlinksSummary(c);
    expect(calls[0]!.url.pathname).toBe("/analytics/v1/");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({ type: "backlinks_overview", target: c.domain, target_type: "root_domain", export_columns: "ascore,total,domains_num" });
    expect(r).toMatchObject({ units: 40, summary: { backlinks: 22063983, referringDomains: 49145, newBacklinks: null, authority: { metric: "semrush_score", value: 74 } } });
  });

  it("backlinks with SEMRUSH_V4_API_KEY use the v4 overview with Authorization: Apikey (45 units); the v4 key is never in a query string", async () => {
    env.SEMRUSH_V4_API_KEY = V4KEY;
    const calls = fakeSemrush();
    const c = client();
    const r = await routed.backlinksSummary(c);
    expect(calls[0]!.url.pathname).toBe("/apis/v4/backlinks/v1/overview");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ url: c.domain, scope: "ROOT_DOMAIN", fields: "backlinks_count,domains_count,new_count,lost_count,score" });
    expect(calls[0]!.auth).toBe(`Apikey ${V4KEY}`);
    expect(calls[0]!.url.href).not.toContain(V4KEY);
    expect(calls[0]!.url.href).not.toContain(KEY);
    expect(r).toMatchObject({ units: 45, summary: { backlinks: 2341, referringDomains: 156, newBacklinks: 23, lostBacklinks: 15, authority: { metric: "semrush_score", value: 78 } } });
  });

  it("v4 errors map by error.code; the v3 key-rejected and zero-balance bodies map to the spec's messages", async () => {
    env.SEMRUSH_V4_API_KEY = V4KEY;
    fakeSemrush(() => new Response(fx("v4-error-403.json"), { status: 403 }));
    await expect(routed.backlinksSummary(client())).rejects.toThrow("Semrush API is not enabled for this account or report");
    env.SEMRUSH_V4_API_KEY = undefined;
    fakeSemrush(() => new Response(fx("error-120.txt"), { status: 200 }));
    await expect(routed.rankedKeywords(client())).rejects.toThrow("Semrush rejected the API key (SEMRUSH_API_KEY, or SEMRUSH_V4_API_KEY for v4 calls).");
    fakeSemrush(() => new Response(fx("error-132.txt"), { status: 403 }));
    await expect(routed.rankedKeywords(client())).rejects.toThrow("Semrush API units balance is zero; buy units under Subscription info > API units.");
  });

  it("one 429 is retried; a second surfaces with the rate-limit message", async () => {
    const waits: number[] = [];
    semrush.semrushTiming.sleep = async (ms) => void waits.push(ms);
    fakeSemrush((_c, k) => (k === 1 ? new Response("ERROR 429 :: Too Many Requests", { status: 429 }) : undefined));
    expect((await routed.competitorDomains(client(), 3)).totalCount).toBe(2);
    expect(waits).toEqual([2000]);
    fakeSemrush(() => new Response("", { status: 429, headers: { "retry-after": "1" } }));
    await expect(routed.competitorDomains(client(), 3)).rejects.toThrow("Semrush request limit hit (10 requests/s, 10 at once); try again shortly.");
  });

  it("a timeout records the estimate; an estimate over the cap makes no request", async () => {
    fakeSemrush(() => {
      throw new DOMException("timeout", "TimeoutError");
    });
    const c = client();
    await expect(routed.competitorDomains(c, 10)).rejects.toThrow(/timed out after 30s; Semrush may still have billed it/);
    expect(ledger(c)).toEqual([{ endpoint: "domain_organic_organic (timeout, estimated)", units: 400 }]);
    const calls = fakeSemrush();
    await expect(routed.competitorDomains(client({ monthlyUnits: { ahrefs: 1, semrush: 399 } }), 10)).rejects.toThrow(/Semrush unit cap hit/);
    expect(calls).toHaveLength(0);
  });

  it("an undocumented database is unavailable before any request", async () => {
    const calls = fakeSemrush();
    await expect(routed.rankedKeywords(client({ country: "GL" }))).rejects.toThrow(/Semrush has no database for country GL/);
    expect(calls).toHaveLength(0);
  });

  it("every Semrush-backed cache entry expires within 30 days (Semrush's caching rule)", async () => {
    fakeSemrush();
    const c = client();
    await routed.searchVolume(c, ["example widgets"]);
    await routed.competitorDomains(c, 2);
    expect(TTL.month).toBeLessThanOrEqual(30 * 24 * 60 * 60);
    const now = Math.floor(Date.now() / 1000);
    const maxExpiry = (db.prepare("SELECT MAX(expires_at) AS m FROM cache").get() as { m: number }).m;
    expect(maxExpiry - now).toBeLessThanOrEqual(30 * 24 * 60 * 60);
  });
});

describe("checkSemrushKey (free balance)", () => {
  it("accepted with units left; the URL is https by default", async () => {
    expect(SEMRUSH_DEFAULT_BALANCE_URL.startsWith("https://")).toBe(true);
    const calls = fakeSemrush();
    const r = await semrush.checkSemrushKey(KEY);
    expect(r).toEqual({ configured: true, works: true, reachable: true, unitsLeft: 1000, error: null, costUsd: 0 });
    expect(calls[0]!.url.pathname).toBe("/users/countapiunits.html");
  });

  it("rejected (ERROR 120) vs unreachable; neither shows the key", async () => {
    fakeSemrush(() => new Response(fx("error-120.txt"), { status: 200 }));
    expect(await semrush.checkSemrushKey(KEY)).toMatchObject({ works: false, errorCode: 120 });
    vi.stubGlobal("fetch", vi.fn(async (u: string) => { throw new TypeError(`fetch failed for ${u}`); }));
    const r = await semrush.checkSemrushKey(KEY);
    expect(r).toMatchObject({ works: null, reachable: false });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});

describe("Semrush keys never leak", () => {
  it("not in thrown errors (even when the network error carries the URL), the ledger, the cache or the usage log", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => { throw new TypeError(`connect ECONNREFUSED ${u}`); }));
    const wrapped = handler("ranked_keywords", async ({ c }: { c: Client }) => routed.rankedKeywords(c, c.domain, 5));
    const res = await wrapped({ c: client() });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(JSON.stringify(res)).toContain("key=<redacted>");
    for (const table of ["spend", "cache", "tool_calls"]) {
      const rows = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
      expect(rows, table).not.toContain(KEY);
      expect(rows, table).not.toContain(V4KEY);
    }
  });
});

describe("SEC-1: a ';' inside a keyword can't bypass the unit cap", () => {
  it("normalizeKeywordList splits on ';' and line breaks, trims, drops empties and dedupes", () => {
    expect(shape.normalizeKeywordList([" a ;b", "b\r\nc", "", ";;", "a"])).toEqual(["a", "b", "c"]);
  });

  it("one entry holding 100 keywords is estimated as 100 (1,000 units): a 100-unit cap blocks before any request", async () => {
    const calls = fakeSemrush();
    const entry = Array.from({ length: 100 }, (_, i) => `example kw${i}`).join(";");
    await expect(routed.searchVolume(client({ monthlyUnits: { ahrefs: 1, semrush: 100 } }), [entry])).rejects.toThrow(/Semrush unit cap hit/);
    await expect(semrush.semrushKeywordVolume(client({ monthlyUnits: { ahrefs: 1, semrush: 100 } }), [entry])).rejects.toThrow(/Semrush unit cap hit/);
    expect(calls).toHaveLength(0);
  });

  it("recorded units never exceed the estimate for a ';' keyword", async () => {
    const calls = fakeSemrush();
    const c = client();
    const r = await routed.searchVolume(c, ["example widgets;example gadgets;example repair"]);
    expect(calls[0]!.url.searchParams.get("phrase")).toBe("example widgets;example gadgets;example repair");
    const recorded = ledger(c).reduce((s, row) => s + row.units, 0);
    expect(recorded).toBe(30);
    expect(recorded).toBeLessThanOrEqual(shape.estimateSemrushUnits("phrase_these", 3));
    expect(r.result.map((k) => k.keyword)).toEqual(["example widgets", "example gadgets", "example repair"]);
  });

  it("tool schemas reject ';', CR and LF in a keyword with a clear message", async () => {
    const { keywordInput } = await import("../src/lib/clients.js");
    for (const bad of ["a;b", "a\nb", "a\rb", ""]) expect(keywordInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(keywordInput.safeParse("a;b").error?.issues[0]?.message).toMatch(/can't contain ';' or a line break/);
    expect(keywordInput.safeParse("x".repeat(201)).success).toBe(false);
    expect(keywordInput.safeParse("example widgets").success).toBe(true);
  });
});
