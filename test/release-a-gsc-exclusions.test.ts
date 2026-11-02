/** Release A / D4: a client's gscExcludeQueries leave bot and noise queries out of Search Console totals and query lists. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fake, filtersOf, row, type GscBody } from "./helpers/fake-analytics.js";

vi.mock("googleapis", async () => (await import("./helpers/fake-analytics.js")).googleapisMock);
vi.mock("../src/providers/google.js", async () => (await import("./helpers/fake-analytics.js")).googleProviderMock);

const { gscQuery, gscTotals, subtractRows } = await import("../src/providers/gsc.js");
const { exclusionRegex } = await import("../src/lib/gsc-exclusions.js");
const { db } = await import("../src/lib/store.js");

const RANGE = { startDate: "2026-09-01", endDate: "2026-09-30" };
const ITEMS = ["example login", "/^site:example\\.com/"];
const EXPRESSION = "(?i)^(?:example login)$|(?:^site:example\\.com)";
const client = (gscExcludeQueries: string[] = ITEMS) => ({ slug: "example", domain: "example.com", gscProperty: "sc-domain:example.com", gscExcludeQueries }) as never;

const including = (b: GscBody) => filtersOf(b).some((f) => f.operator === "includingRegex" && f.expression === EXPRESSION);

beforeEach(() => {
  fake.reset();
  db.exec("DELETE FROM cache");
});

describe("exclusionRegex (the expression the tests below expect)", () => {
  it("is the C5 example", () => expect(exclusionRegex(ITEMS)).toBe(EXPRESSION));
});

describe("query-level requests", () => {
  it("carry an excludingRegex in the same filter group as an existing includingRegex", async () => {
    fake.gsc = () => [row(["good query"], 5, 100)];
    const rows = await gscQuery(client(), { ...RANGE, dimensions: ["query"], queryRegex: "^plumber", pageContains: "/blog/" });
    expect(rows).toEqual([{ keys: ["good query"], clicks: 5, impressions: 100, ctr: 5, position: 5 }]);
    expect(fake.gscCalls).toHaveLength(1);
    expect(fake.gscCalls[0]!.dimensionFilterGroups).toHaveLength(1);
    expect(filtersOf(fake.gscCalls[0]!)).toEqual([
      { dimension: "page", operator: "contains", expression: "/blog/" },
      { dimension: "query", operator: "includingRegex", expression: "^plumber" },
      { dimension: "query", operator: "excludingRegex", expression: EXPRESSION },
    ]);
  });

  it("a request with query among several dimensions is filtered too", async () => {
    fake.gsc = () => [];
    await gscQuery(client(), { ...RANGE, dimensions: ["page", "query"] });
    expect(filtersOf(fake.gscCalls[0]!)).toEqual([{ dimension: "query", operator: "excludingRegex", expression: EXPRESSION }]);
  });
});

describe("requests without a query dimension subtract the excluded share (A5)", () => {
  it("totals: raw 1,000 clicks / 50,000 impressions minus 0 / 30,000 gives 1,000 / 20,000, CTR 5.00, position kept", async () => {
    fake.gsc = (b) => (including(b) ? [row([], 0, 30_000, 9.9)] : [row([], 1000, 50_000, 7.3)]);
    const t = await gscTotals(client(), RANGE);
    expect(t).toEqual({ keys: [], clicks: 1000, impressions: 20_000, ctr: 5, position: 7.3, excluded: { clicks: 0, impressions: 30_000 } });
    expect(fake.gscCalls).toHaveLength(2);
    expect(fake.gscCalls.every((c) => (c.dimensions ?? []).length === 0)).toBe(true);
    expect(filtersOf(fake.gscCalls[0]!)).toEqual([]);
  });

  it("date: subtracts per day by key, and drops a day left with no impressions", async () => {
    fake.gsc = (b) =>
      including(b)
        ? [row(["2026-09-01"], 0, 400), row(["2026-09-02"], 1, 100)]
        : [row(["2026-09-01"], 10, 1000, 4), row(["2026-09-02"], 1, 100, 6), row(["2026-09-03"], 3, 300, 5)];
    const rows = await gscQuery(client(), { ...RANGE, dimensions: ["date"] });
    expect(rows).toEqual([
      { keys: ["2026-09-01"], clicks: 10, impressions: 600, ctr: 1.67, position: 4 },
      { keys: ["2026-09-03"], clicks: 3, impressions: 300, ctr: 1, position: 5 },
    ]);
  });

  it("page: subtracts per page", async () => {
    fake.gsc = (b) => (including(b) ? [row(["https://example.com/a"], 0, 50)] : [row(["https://example.com/a"], 20, 200), row(["https://example.com/b"], 5, 100)]);
    const rows = await gscQuery(client(), { ...RANGE, dimensions: ["page"] });
    expect(rows.map((r) => [r.keys[0], r.clicks, r.impressions, r.ctr])).toEqual([
      ["https://example.com/a", 20, 150, 13.33],
      ["https://example.com/b", 5, 100, 5],
    ]);
  });

  it("subtractRows leaves rows with no excluded share unchanged", () => {
    const raw = [{ keys: ["x"], clicks: 1, impressions: 10, ctr: 10, position: 3 }];
    expect(subtractRows(raw, [])).toEqual(raw);
  });
});

describe("bypass and no-op", () => {
  it("includeExcludedQueries: true sends one unfiltered request", async () => {
    fake.gsc = () => [row(["example login"], 0, 900)];
    const rows = await gscQuery(client(), { ...RANGE, dimensions: ["query"], includeExcludedQueries: true });
    expect(rows).toHaveLength(1);
    expect(fake.gscCalls).toHaveLength(1);
    expect(filtersOf(fake.gscCalls[0]!)).toEqual([]);
    const totals = await gscTotals(client(), { startDate: "2026-08-01", endDate: "2026-08-31" });
    expect(totals.excluded).toBeDefined();
  });

  it("a client without exclusions makes the same single request as before, with no excluded field", async () => {
    fake.gsc = () => [row([], 10, 100)];
    const t = await gscTotals(client([]), RANGE);
    expect(fake.gscCalls).toHaveLength(1);
    expect(fake.gscCalls[0]!.dimensionFilterGroups).toBeUndefined();
    expect(t).not.toHaveProperty("excluded");
    await gscQuery(client([]), { ...RANGE, dimensions: ["query"] });
    expect(fake.gscCalls).toHaveLength(2);
    expect(fake.gscCalls[1]!.dimensionFilterGroups).toBeUndefined();
  });

  it("caches per exclusion list", async () => {
    fake.gsc = () => [row([], 10, 100)];
    await gscTotals(client(), RANGE);
    await gscTotals(client(), RANGE);
    expect(fake.gscCalls).toHaveLength(2); // two requests once (raw + excluded share), none the second time
    await gscTotals(client(["another query"]), RANGE);
    expect(fake.gscCalls).toHaveLength(4);
  });
});

describe("a pattern Google rejects", () => {
  it("is named as the gscExcludeQueries problem", async () => {
    fake.gsc = () => {
      throw Object.assign(new Error("Invalid regular expression"), { response: { status: 400, data: { error: { message: "Invalid filter expression: bad escape" } } } });
    };
    await expect(gscQuery(client(), { ...RANGE, dimensions: ["query"] })).rejects.toThrow(/Search Console rejected the gscExcludeQueries pattern: Invalid filter expression: bad escape/);
  });

  it("a 400 without exclusions is left as it was", async () => {
    fake.gsc = () => {
      throw Object.assign(new Error("Bad request"), { response: { status: 400 } });
    };
    await expect(gscQuery(client([]), { ...RANGE, dimensions: ["query"] })).rejects.toThrow("Bad request");
  });
});
