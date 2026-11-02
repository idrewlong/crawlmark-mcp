/**
 * Release 0.5.0 Y0.4: Search Console page filters (C3), the saved-history window (C2) and the GA4 channel report
 * (channel_yoy), against a fake googleapis that records every request body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fake, filtersOf, ga4Response, row } from "./helpers/fake-analytics.js";

vi.mock("googleapis", async () => (await import("./helpers/fake-analytics.js")).googleapisMock);
vi.mock("../src/providers/google.js", async () => (await import("./helpers/fake-analytics.js")).googleProviderMock);

const { gscQuery } = await import("../src/providers/gsc.js");
const { ga4ChannelReport } = await import("../src/providers/ga4.js");
const { historyCutoff, saveMonth, windowStart } = await import("../src/lib/gsc-monthly.js");
const { exclusionRegex } = await import("../src/lib/gsc-exclusions.js");
const { db } = await import("../src/lib/store.js");
const { groupRegex, groupsRegex } = await import("../src/lib/page-groups.js");

const ITEMS = ["example login"];
const mk = (extra: Record<string, unknown> = {}) =>
  ({ slug: "example", domain: "example.com", gscProperty: "sc-domain:example.com", ga4PropertyId: "99999999", name: "Example Co", aliases: [], gscExcludeQueries: [], trackedKeywords: [], brandTerms: [], ...extra }) as never;
const BLOG = { name: "Blog", prefix: ["/blog/"] };
const SERVICES = { name: "Services", prefix: ["/services/"] };
const RANGE = { startDate: "2026-09-01", endDate: "2026-09-30" };

beforeEach(() => {
  db.prepare("DELETE FROM cache").run();
  db.prepare("DELETE FROM gsc_monthly").run();
  fake.reset();
  fake.gsc = () => [row([], 100, 2000, 5)];
});
afterEach(() => vi.useRealTimers());

describe("Search Console page filters", () => {
  it("sends page includingRegex and excludingRegex in the one filter group, with the query exclusion on both subtraction requests", async () => {
    const pageRegex = groupRegex(SERVICES);
    const pageExcludeRegex = groupsRegex([BLOG]);
    await gscQuery(mk({ gscExcludeQueries: ITEMS }), { ...RANGE, dimensions: [], pageRegex, pageExcludeRegex });
    const page = [
      { dimension: "page", operator: "includingRegex", expression: "^https?://[^/]+(?:/services/)" },
      { dimension: "page", operator: "excludingRegex", expression: "^https?://[^/]+(?:/blog/)" },
    ];
    expect(fake.gscCalls.map((c) => c.dimensionFilterGroups)).toEqual([
      [{ filters: page }],
      [{ filters: [...page, { dimension: "query", operator: "includingRegex", expression: exclusionRegex(ITEMS) }] }],
    ]);
  });

  it("a query-level request filters pages and excludes queries in one request", async () => {
    await gscQuery(mk({ gscExcludeQueries: ITEMS }), { ...RANGE, dimensions: ["query"], pageRegex: groupRegex(BLOG) });
    expect(fake.gscCalls).toHaveLength(1);
    expect(filtersOf(fake.gscCalls[0]!)).toEqual([
      { dimension: "page", operator: "includingRegex", expression: "^https?://[^/]+(?:/blog/)" },
      { dimension: "query", operator: "excludingRegex", expression: exclusionRegex(ITEMS) },
    ]);
  });

  it("only the other-pages filter: excludingRegex alone", async () => {
    await gscQuery(mk(), { ...RANGE, dimensions: [], pageExcludeRegex: groupsRegex([BLOG, SERVICES]) });
    expect(filtersOf(fake.gscCalls[0]!)).toEqual([{ dimension: "page", operator: "excludingRegex", expression: "^https?://[^/]+(?:/blog/|/services/)" }]);
  });

  it("page filters are part of the cache key", async () => {
    await gscQuery(mk(), { ...RANGE, dimensions: [], pageRegex: groupRegex(BLOG) });
    await gscQuery(mk(), { ...RANGE, dimensions: [], pageRegex: groupRegex(BLOG) });
    expect(fake.gscCalls).toHaveLength(1);
    await gscQuery(mk(), { ...RANGE, dimensions: [], pageRegex: groupRegex(SERVICES) });
    await gscQuery(mk(), { ...RANGE, dimensions: [], pageRegex: groupRegex(BLOG), pageExcludeRegex: groupRegex(SERVICES) });
    await gscQuery(mk(), { ...RANGE, dimensions: [] });
    expect(fake.gscCalls).toHaveLength(4);
  });
});

describe("saved history and Google's window", () => {
  const store = (month: string, clicks: number) =>
    saveMonth({
      client: "example",
      property: "sc-domain:example.com",
      month,
      complete: true,
      capturedAt: Date.now(),
      totals: { keys: [], clicks, impressions: clicks * 10, ctr: 10, position: 4 },
      pages: [],
      queries: [],
      devices: [],
      countries: [],
    });

  it("a range starting the day before Google's window, with every month stored, is served from history (it went to Google before)", async () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now });
    expect(windowStart(now)).toBe("2025-07-02");
    // The old predicate: a range from historyCutoff on went to Google, partial for its first day.
    expect(historyCutoff(now)).toBe("2025-07-01");
    store("2025-07", 321);
    const rows = await gscQuery(mk(), { startDate: "2025-07-01", endDate: "2025-07-31", dimensions: [] });
    expect(rows[0]).toMatchObject({ clicks: 321 });
    expect(fake.gscCalls).toHaveLength(0);
  });

  it("a range starting on Google's window start goes to Google even when stored", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-01T12:00:00Z") });
    store("2025-07", 321);
    const rows = await gscQuery(mk(), { startDate: "2025-07-01", endDate: "2025-07-31", dimensions: [] });
    expect(rows[0]).toMatchObject({ clicks: 100 });
    expect(fake.gscCalls).toHaveLength(1);
  });

  it("a page filter never reads saved history", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-02T12:00:00Z") });
    store("2024-03", 50);
    await gscQuery(mk(), { startDate: "2024-03-01", endDate: "2024-03-31", dimensions: [], pageRegex: groupRegex(BLOG) });
    await gscQuery(mk(), { startDate: "2024-03-01", endDate: "2024-03-31", dimensions: [], pageExcludeRegex: groupRegex(BLOG) });
    expect(fake.gscCalls).toHaveLength(2);
  });
});

describe("ga4ChannelReport", () => {
  it("asks for the default channel group with four metrics, limit 50, the hostname filter and no organic filter", async () => {
    fake.ga4 = () =>
      ga4Response(["sessionDefaultChannelGroup"], ["sessions", "totalUsers", "engagedSessions", "keyEvents"], [
        [["Organic Search"], [1200, 900, 700, 40]],
        [["Direct"], [800, 650, 300, 12]],
        [["Bad\u0007Name"], [1, 1, 0, 0]],
      ]);
    const rows = await ga4ChannelReport(mk(), RANGE);
    expect(fake.ga4Calls).toHaveLength(1);
    const body = fake.ga4Calls[0];
    expect(body.dateRanges).toEqual([{ startDate: "2026-09-01", endDate: "2026-09-30" }]);
    expect(body.dimensions).toEqual([{ name: "sessionDefaultChannelGroup" }]);
    expect(body.metrics).toEqual([{ name: "sessions" }, { name: "totalUsers" }, { name: "engagedSessions" }, { name: "keyEvents" }]);
    expect(body.limit).toBe("50");
    // Hostname-scoped only: a single hostName filter, never sessionDefaultChannelGroup = Organic Search.
    expect(body.dimensionFilter.filter.fieldName).toBe("hostName");
    expect(JSON.stringify(body.dimensionFilter)).not.toContain("Organic Search");
    expect(rows).toEqual([
      { channel: "Organic Search", sessions: 1200, users: 900, engagedSessions: 700, keyEvents: 40 },
      { channel: "Direct", sessions: 800, users: 650, engagedSessions: 300, keyEvents: 12 },
      { channel: "BadName", sessions: 1, users: 1, engagedSessions: 0, keyEvents: 0 },
    ]);
  });
});
