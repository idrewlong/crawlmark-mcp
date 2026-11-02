/** Release A / D3: GA4 numbers are scoped to the client's hostnames, and the hosts left out are named with their sessions. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fake } from "./helpers/fake-analytics.js";

vi.mock("googleapis", async () => (await import("./helpers/fake-analytics.js")).googleapisMock);
vi.mock("../src/providers/google.js", async () => (await import("./helpers/fake-analytics.js")).googleProviderMock);

const state = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("../src/clients.js", () => ({ resolveClient: async () => state.client }));

const { ga4Report, ga4HostnameBreakdown, ga4OrganicSummary } = await import("../src/providers/ga4.js");
const { registerRawTools } = await import("../src/tools/raw.js");
const { db } = await import("../src/lib/store.js");

const RANGE = { startDate: "2026-09-01", endDate: "2026-09-30" };
const ORGANIC = { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search", matchType: "EXACT" } } };
const client = (extra: Record<string, unknown> = {}) => ({ slug: "example", domain: "example.com", ga4PropertyId: "99999999", ...extra }) as never;

const hostFilter = (call: { dimensionFilter?: any }, which = call.dimensionFilter) => (which?.filter ?? which?.andGroup?.expressions?.find((e: any) => e.filter.fieldName === "hostName"))?.filter ?? which?.filter;

/** Whether GA4's FULL_REGEXP (anchored, case-insensitive) matches a host. */
const matches = (value: string, host: string) => new RegExp(`^(?:${value})$`, "i").test(host);

beforeEach(() => {
  fake.reset();
  db.exec("DELETE FROM cache");
});

describe("ga4Report hostName filter", () => {
  it("by default sends a FULL_REGEXP that matches exactly the domain and www, and nothing else", async () => {
    await ga4Report(client(), { ...RANGE, metrics: ["sessions"] });
    const f = fake.ga4Calls[0].dimensionFilter.filter;
    expect(f.fieldName).toBe("hostName");
    expect(f.stringFilter).toMatchObject({ matchType: "FULL_REGEXP", caseSensitive: false });
    for (const ok of ["example.com", "www.example.com", "WWW.Example.com"]) expect(matches(f.stringFilter.value, ok), ok).toBe(true);
    for (const no of ["staging.example.com", "old-example.com", "example.com.evil.net", "localhost", "exampleXcom"]) expect(matches(f.stringFilter.value, no), no).toBe(false);
  });

  it("with organicOnly combines both filters in an andGroup (organic first)", async () => {
    await ga4Report(client(), { ...RANGE, metrics: ["sessions"], organicOnly: true });
    const { dimensionFilter } = fake.ga4Calls[0];
    expect(dimensionFilter.andGroup.expressions).toHaveLength(2);
    expect(dimensionFilter.andGroup.expressions[0]).toEqual(ORGANIC);
    expect(dimensionFilter.andGroup.expressions[1].filter.fieldName).toBe("hostName");
  });

  it('["*"] sends no host filter (just the organic one when asked, not wrapped in an andGroup)', async () => {
    await ga4Report(client({ ga4Hostnames: ["*"] }), { ...RANGE, metrics: ["sessions"] });
    expect(fake.ga4Calls[0].dimensionFilter).toBeUndefined();
    await ga4Report(client({ ga4Hostnames: ["*"] }), { ...RANGE, metrics: ["sessions"], organicOnly: true });
    expect(fake.ga4Calls[1].dimensionFilter).toEqual(ORGANIC);
  });

  it('uses the client\'s list, and "*.example.com" matches a subdomain but not the apex', async () => {
    await ga4Report(client({ ga4Hostnames: ["*.example.com"] }), { ...RANGE, metrics: ["sessions"] });
    const v = fake.ga4Calls[0].dimensionFilter.filter.stringFilter.value;
    expect(matches(v, "shop.example.com")).toBe(true);
    expect(matches(v, "a.b.example.com")).toBe(true);
    expect(matches(v, "example.com")).toBe(false);
  });

  it("a per-call hostnames list overrides the client's", async () => {
    await ga4Report(client({ ga4Hostnames: ["example.com"] }), { ...RANGE, metrics: ["sessions"], hostnames: ["shop.example.com"] });
    const v = fake.ga4Calls[0].dimensionFilter.filter.stringFilter.value;
    expect(matches(v, "shop.example.com")).toBe(true);
    expect(matches(v, "example.com")).toBe(false);
    await ga4Report(client({ ga4Hostnames: ["example.com"] }), { ...RANGE, metrics: ["sessions"], hostnames: ["*"] });
    expect(fake.ga4Calls[1].dimensionFilter).toBeUndefined();
  });

  it("caches per hostname list: another list asks Google again, the same list doesn't", async () => {
    const o = { ...RANGE, metrics: ["sessions"] };
    await ga4Report(client(), o);
    await ga4Report(client(), o);
    expect(fake.ga4Calls).toHaveLength(1);
    await ga4Report(client({ ga4Hostnames: ["example.com", "www.example.com", "shop.example.com"] }), o);
    expect(fake.ga4Calls).toHaveLength(2);
    await ga4Report(client(), { ...o, hostnames: ["*"] });
    expect(fake.ga4Calls).toHaveLength(3);
  });

  it("the headline summary carries the host filter too", async () => {
    fake.ga4 = () => ({ rows: [{ metricValues: [{ value: "10" }, { value: "8" }, { value: "6" }, { value: "0.6" }, { value: "1" }] }], metricHeaders: ["sessions", "totalUsers", "engagedSessions", "engagementRate", "keyEvents"].map((name) => ({ name })) });
    expect((await ga4OrganicSummary(client(), RANGE)).sessions).toBe(10);
    expect(hostFilter(fake.ga4Calls[0], fake.ga4Calls[0].dimensionFilter.andGroup.expressions[1]).fieldName).toBe("hostName");
  });
});

describe("ga4HostnameBreakdown", () => {
  const hosts = [
    ["example.com", 500],
    ["www.example.com", 300],
    ["staging.example.com", 120],
    ["localhost", 5],
    ["old-example.com", 40],
  ] as const;
  const answer = () => ({
    dimensionHeaders: [{ name: "hostName" }],
    metricHeaders: [{ name: "sessions" }],
    rows: hosts.map(([h, n]) => ({ dimensionValues: [{ value: h }], metricValues: [{ value: String(n) }] })),
  });

  it("names the hostnames the filter leaves out, with sessions, and asks without a host filter", async () => {
    fake.ga4 = answer;
    const b = await ga4HostnameBreakdown(client(), RANGE, { organicOnly: true });
    expect(b.applied).toEqual(["example.com", "www.example.com"]);
    expect(b.excludedSessions).toBe(165);
    expect(b.excluded).toEqual([
      { hostName: "staging.example.com", sessions: 120 },
      { hostName: "old-example.com", sessions: 40 },
      { hostName: "localhost", sessions: 5 },
    ]);
    const sent = fake.ga4Calls[0];
    expect(sent.dimensions).toEqual([{ name: "hostName" }]);
    expect(sent.metrics).toEqual([{ name: "sessions" }]);
    expect(sent.limit).toBe("50");
    expect(sent.dimensionFilter).toEqual(ORGANIC);
  });

  it('["*"] is "all", leaves nothing out and makes no request', async () => {
    const b = await ga4HostnameBreakdown(client({ ga4Hostnames: ["*"] }), RANGE);
    expect(b).toEqual({ applied: "all", excludedSessions: 0, excluded: [] });
    expect(fake.ga4Calls).toHaveLength(0);
  });

  it("a subdomain wildcard counts shop.example.com as in scope", async () => {
    fake.ga4 = answer;
    const b = await ga4HostnameBreakdown(client({ ga4Hostnames: ["example.com", "*.example.com"] }), RANGE);
    expect(b.excluded.map((e) => e.hostName)).toEqual(["old-example.com", "localhost"]);
  });
});

describe("ga4_report tool", () => {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>>();
  registerRawTools({ registerTool: (name: string, _def: unknown, cb: never) => void tools.set(name, cb) } as never);
  const call = async (args: Record<string, unknown>) => {
    const r = await tools.get("ga4_report")!({ client: "example.com", metrics: ["sessions"], startDate: RANGE.startDate, endDate: RANGE.endDate, ...args });
    return { error: r.isError, text: r.content[0]!.text };
  };

  beforeEach(() => {
    state.client = client();
    fake.ga4 = (body) =>
      body.dimensions?.[0]?.name === "hostName" && !body.dimensionFilter?.filter?.stringFilter?.value?.includes?.("example")
        ? { rows: [{ dimensionValues: [{ value: "example.com" }], metricValues: [{ value: "90" }] }, { dimensionValues: [{ value: "staging.example.com" }], metricValues: [{ value: "30" }] }] }
        : { dimensionHeaders: [{ name: "sessionDefaultChannelGroup" }], metricHeaders: [{ name: "sessions" }], rows: [{ dimensionValues: [{ value: "Organic Search" }], metricValues: [{ value: "90" }] }] };
  });

  it("returns { rows, hostnames } with the left-out hosts and their sessions", async () => {
    const r = await call({ dimensions: ["sessionDefaultChannelGroup"] });
    expect(r.error).toBeFalsy();
    expect(JSON.parse(r.text)).toEqual({
      rows: [{ sessionDefaultChannelGroup: "Organic Search", sessions: 90 }],
      hostnames: { applied: ["example.com", "www.example.com"], excludedSessions: 30, excluded: [{ hostName: "staging.example.com", sessions: 30 }] },
    });
  });

  it("allHostnames turns the filter off: applied is all and excludedSessions is null", async () => {
    const r = JSON.parse((await call({ allHostnames: true })).text);
    expect(r.hostnames).toEqual({ applied: "all", excludedSessions: null, excluded: [] });
    expect(fake.ga4Calls[0].dimensionFilter).toBeUndefined();
  });

  it("hostnames override the client's list; a bad list or both options is a clear error", async () => {
    const ok = JSON.parse((await call({ hostnames: ["shop.example.com"] })).text);
    expect(ok.hostnames.applied).toEqual(["shop.example.com"]);
    const bad = await call({ hostnames: ["not a host"] });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/isn't a usable GA4 hostname/);
    const both = await call({ hostnames: ["shop.example.com"], allHostnames: true });
    expect(both.error).toBe(true);
    expect(both.text).toMatch(/hostnames or allHostnames/);
  });
});
