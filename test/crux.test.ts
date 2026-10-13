import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cruxFindings, parseCruxHistory, rate, seriesOf, trendOf, type CruxHistoryResponse } from "../src/analysis/crux.js";
import { checkedPairs, checkKey, checkOf, extractFindings, findingId } from "../src/analysis/findings.js";
import { diffAudits, type StoredAudit } from "../src/analysis/diff.js";
import { db } from "../src/lib/store.js";
import { clientOrigin, cruxErrorMessage, cruxHistory, cruxKey, CruxUnavailableError } from "../src/providers/crux.js";
import { collectSetupStatus, type StatusProviders } from "../src/setup/status.js";
import { forHumans, renderStatus } from "../src/setup/status-render.js";
import type { AuditResult } from "../src/reports/audit.js";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "crux", "history-origin.json"), "utf8")) as CruxHistoryResponse;
const KEY = "AIzaSy-SENTINEL-crux-key-0123456789";
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("CrUX History parsing", () => {
  it("25 periods by default; CLS strings, null p75s and NaN densities; ratings and trends", () => {
    const r = parseCruxHistory(FIXTURE, { origin: "https://example.com", formFactor: "PHONE", metrics: ["lcp", "inp", "cls", "fcp", "ttfb"] }, "CRUX_API_KEY");
    expect(r.periods).toHaveLength(25);
    expect(r.periods[0]).toEqual({ start: "2026-02-22", end: "2026-03-21" });
    const lcp = r.metrics.lcp!;
    expect(lcp.p75[3]).toBeNull();
    expect(lcp.rating.slice(0, 3)).toEqual(["needs-improvement", "needs-improvement", "needs-improvement"]);
    expect(lcp.rating.at(-1)).toBe("good");
    expect(lcp).toMatchObject({ unit: "ms", first: 3100, latest: 2140, change: -960, trend: "improving" });
    const cls = r.metrics.cls!;
    expect(cls.p75[0]).toBeNull();
    expect(cls.p75[1]).toBe(0.08);
    expect(cls).toMatchObject({ unit: "score", latest: 0.18, trend: "worsening" });
    expect(cls.rating.at(-1)).toBe("needs-improvement");
    expect(r.metrics.inp!.trend).toBe("worsening");
    expect(r.metrics.fcp!.trend).toBe("flat");
    expect(r.metrics.ttfb).toMatchObject({ latest: null, first: null, change: null, trend: "insufficient-data" });
  });

  it("thresholds and the trend band", () => {
    expect([rate("lcp", 2500), rate("lcp", 2501), rate("lcp", 4001), rate("cls", 0.1), rate("cls", 0.26), rate("inp", null)]).toEqual(["good", "needs-improvement", "poor", "good", "poor", null]);
    expect(trendOf([100, 100, 100, 100, 104, 104, 104, 104])).toBe("flat");
    expect(trendOf([100, 100, 100, 100, 106, 106, 106, 106])).toBe("worsening");
    expect(trendOf([100, null, null])).toBe("insufficient-data");
    expect(seriesOf("cls", ["0.1", "NaN", null], 3).p75).toEqual([0.1, null, null]);
  });

  it("findings from the latest period: poor is high, needs improvement is medium; stable ids", () => {
    const r = parseCruxHistory(FIXTURE, { origin: "https://example.com", formFactor: "PHONE", metrics: ["lcp", "inp", "cls"] }, "CRUX_API_KEY");
    const f = cruxFindings(r);
    expect(f.map((x) => [x.rule, x.severity])).toEqual([["field-inp-needs-improvement", "medium"], ["field-cls-needs-improvement", "medium"]]);
    expect(f[0]).toMatchObject({ source: "crux", url: "https://example.com", evidence: "252 ms in the 28 days to 2026-09-05" });
    expect(findingId("crux", "field-inp-needs-improvement", "https://example.com/")).toBe(findingId("crux", "field-inp-needs-improvement", "https://example.com"));
    expect(cruxFindings({ ...r, available: false, reason: "x" } as never)).toEqual([]);
  });
});

describe("CrUX History provider", () => {
  it("prefers CRUX_API_KEY over PSI_API_KEY; no key is unavailable with the setup hint", async () => {
    expect(cruxKey({ CRUX_API_KEY: "a", PSI_API_KEY: "b" })).toEqual({ key: "a", source: "CRUX_API_KEY" });
    expect(cruxKey({ PSI_API_KEY: "b" })).toEqual({ key: "b", source: "PSI_API_KEY" });
    await expect(cruxHistory({ origin: "https://example.com" }, { e: {} })).rejects.toThrow(CruxUnavailableError);
    await expect(cruxHistory({ origin: "https://example.com" }, { e: {} })).rejects.toThrow(/setup --step crux/);
  });

  it("sends the request (default PHONE, 25 weeks) and never puts the key in the result, the error or the cache", async () => {
    const fetchImpl = vi.fn(async () => ok(FIXTURE));
    const r = await cruxHistory({ origin: "https://example.com/" }, { e: { CRUX_API_KEY: KEY }, fetchImpl: fetchImpl as never, refresh: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:9/records:queryHistoryRecord?key=${KEY}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ origin: "https://example.com", formFactor: "PHONE", collectionPeriodCount: 25 });
    expect(r).toMatchObject({ available: true, keySource: "CRUX_API_KEY", key: { origin: "https://example.com", formFactor: "PHONE" }, fromCache: false });
    expect(JSON.stringify(r)).not.toContain(KEY);
    const again = await cruxHistory({ origin: "https://example.com" }, { e: { CRUX_API_KEY: KEY }, fetchImpl: fetchImpl as never });
    expect(again).toMatchObject({ fromCache: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const rows = db.prepare("SELECT key, value FROM cache").all() as { key: string; value: string }[];
    expect(rows.some((row) => row.key.includes(KEY) || row.value.includes(KEY))).toBe(false);

    const failing = vi.fn(async () => new Response(`{"error":{"message":"bad key=${KEY}","status":"INTERNAL"}}`, { status: 500 }));
    const err = await cruxHistory({ origin: "https://example.org" }, { e: { CRUX_API_KEY: KEY }, fetchImpl: failing as never }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(KEY);
    const thrown = vi.fn(async () => {
      throw new TypeError(`fetch failed for ?key=${KEY}`);
    });
    const err2 = await cruxHistory({ origin: "https://example.net" }, { e: { CRUX_API_KEY: KEY }, fetchImpl: thrown as never }).catch((e: Error) => e);
    expect(String((err2 as Error).message)).not.toContain(KEY);
  });

  it("404 is available: false; a 403 for a disabled API is unavailable with the enable hint", async () => {
    const nf = vi.fn(async () => new Response('{"error":{"code":404,"status":"NOT_FOUND"}}', { status: 404 }));
    const r = await cruxHistory({ url: "https://example.com/rare-page" }, { e: { PSI_API_KEY: KEY }, fetchImpl: nf as never, refresh: true });
    expect(r).toMatchObject({ available: false, keySource: "PSI_API_KEY", reason: expect.stringContaining("no data for https://example.com/rare-page") });
    const disabled = vi.fn(async () => new Response('{"error":{"code":403,"message":"Chrome UX Report API has not been used in project 1 before or it is disabled.","status":"PERMISSION_DENIED","details":[{"reason":"SERVICE_DISABLED"}]}}', { status: 403 }));
    const e = await cruxHistory({ origin: "https://example.com" }, { e: { PSI_API_KEY: KEY }, fetchImpl: disabled as never, refresh: true }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(CruxUnavailableError);
    expect((e as Error).message).toMatch(/setup --step crux.*enable the Chrome UX Report API/);
    expect(cruxErrorMessage(400, "API key not valid. Please pass a valid API key.", "CRUX_API_KEY").message).toMatch(/isn't a valid key/);
  });

  it("the client origin uses www. when the key pages do", () => {
    expect(clientOrigin({ domain: "example.com", keyPages: ["https://www.example.com/"] })).toBe("https://www.example.com");
    expect(clientOrigin({ domain: "example.com", keyPages: ["https://example.com/a"] })).toBe("https://example.com");
  });
});

describe("CrUX in audit findings", () => {
  const r = parseCruxHistory(FIXTURE, { origin: "https://example.com", formFactor: "PHONE", metrics: ["lcp", "inp", "cls"] }, "CRUX_API_KEY");
  const audit = (withCrux: boolean) =>
    ({ pages: [], site: { sitemaps: { ok: false, error: "x" }, crawl: null, backlinks: null, hygiene: { ok: false, error: "x" }, ...(withCrux ? { cruxHistory: { ok: true, data: r } } : {}) } }) as unknown as AuditResult;

  it("maps findings and the checked pair; a later audit without CrUX shows them unverified, not resolved", () => {
    const f = extractFindings(audit(true));
    expect(f.map((x) => x.source)).toEqual(["crux", "crux"]);
    expect(checkedPairs(audit(true))).toEqual([{ url: "site:crux https://example.com", source: "crux" }]);
    expect(checkOf(f[0]!)).toEqual({ url: "site:crux https://example.com", source: "crux" });
    expect(checkKey(checkOf(f[0]!))).toBe(checkKey(checkedPairs(audit(true))[0]!));
    const stored = (id: string, ranAt: number, a: AuditResult): StoredAudit => ({ id, client: "example.com", ranAt, settings: {}, summary: {}, findings: extractFindings(a), checked: checkedPairs(a), result: {} });
    const d = diffAudits(stored("a", 1, audit(true)), stored("b", 2, audit(false)));
    expect(d.counts).toEqual({ new: 0, resolved: 0, persistent: 0, unverified: 2 });
    const same = diffAudits(stored("a", 1, audit(true)), stored("b", 2, audit(true)));
    expect(same.counts.persistent).toBe(2);
  });
});

describe("setup status crux row", () => {
  const base: StatusProviders = {
    home: () => ({ info: { dir: "/h", source: "env", reason: "test" }, exists: true, envFile: "/h/.env", envFileExists: true, configuredByEnv: false }),
    cli: () => "crawlmark-cli",
    googleStatus: () => ({ mode: "none", auto: true, problem: "Google isn't set up." }),
  } as unknown as StatusProviders;
  const row = async (crux?: StatusProviders["crux"]) => (await collectSetupStatus({ ...base, ...(crux ? { crux } : {}) }, { only: ["crux"] })).integrations[0]!;

  it("missing, working, configured; human output hides it only while missing", async () => {
    expect(await row()).toMatchObject({ id: "crux", state: "missing", next: "crawlmark-cli setup --step crux" });
    expect(await row(async () => ({ source: "CRUX_API_KEY", check: { ok: true } }))).toMatchObject({ state: "working", detail: "CRUX_API_KEY works with the Chrome UX Report API." });
    expect(await row(async () => ({ source: "PSI_API_KEY", check: { ok: false, problem: "not enabled" } }))).toMatchObject({ state: "configured", next: "crawlmark-cli setup --step crux" });
    const missing = await collectSetupStatus(base, { only: ["home", "crux"] });
    const human = forHumans({ ...missing, fromCache: false });
    expect(human.integrations.map((i) => i.id)).toEqual(["home"]);
    expect(human.summary).toEqual({ working: 1, configured: 0, missing: 0, error: 0 });
    expect(renderStatus(human, { width: 80, color: false, unicode: false }).join("\n")).not.toContain("CrUX");
    const set = await collectSetupStatus({ ...base, crux: async () => ({ source: "CRUX_API_KEY", check: { ok: true } }) }, { only: ["home", "crux"] });
    expect(forHumans({ ...set, fromCache: false }).integrations.map((i) => i.id)).toEqual(["home", "crux"]);
  });
});
