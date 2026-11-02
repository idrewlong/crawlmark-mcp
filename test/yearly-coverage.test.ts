/**
 * Release 0.5.0 Y0.3: the Search Console coverage guard (C2). A range older than Google's 16 months is served from
 * saved monthly history or left out with a note, never with Google's partial answer. The real Search Console
 * provider runs against a fake googleapis (it records every request) and the temp SQLite history table.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fake, row } from "./helpers/fake-analytics.js";

vi.mock("googleapis", async () => (await import("./helpers/fake-analytics.js")).googleapisMock);
vi.mock("../src/providers/google.js", async () => (await import("./helpers/fake-analytics.js")).googleProviderMock);

const { gscQuery, gscTotals } = await import("../src/providers/gsc.js");
const { saveMonth } = await import("../src/lib/gsc-monthly.js");
const { db } = await import("../src/lib/store.js");
const { coverageNote, gscRangeCoverage } = await import("../src/lib/gsc-coverage.js");
const { runTemplate } = await import("../src/reports/templates/run.js");
const { client, fakeDeps } = await import("./fixtures/reports/deps.js");
type RunDeps = import("../src/reports/templates/run.js").RunDeps;
type SectionResult = import("../src/reports/report-types.js").SectionResult;

const NOW = Date.parse("2026-11-01T12:00:00Z");
const today = new Date(NOW);
const PROPERTY = "sc-domain:example.com";
const months = (year: number) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
const store = (month: string, clicks: number) =>
  saveMonth({
    client: client.slug,
    property: PROPERTY,
    month,
    complete: true,
    capturedAt: NOW,
    totals: { keys: [], clicks, impressions: clicks * 20, ctr: 5, position: 6 },
    pages: [{ keys: ["https://example.com/"], clicks, impressions: clicks * 20, ctr: 5, position: 3 }],
    queries: [{ keys: ["plumber"], clicks, impressions: clicks * 20, ctr: 5, position: 4 }],
    devices: [],
    countries: [],
  });

/** fakeDeps, but Search Console through the real provider and the real coverage guard. */
function deps(): RunDeps {
  const d = fakeDeps({ gscQuery: (c, o) => gscQuery(c, o), gscTotals: (c, r) => gscTotals(c, r) });
  delete d.gscStoredCoverage;
  return d;
}

function home(period = "{ range: last_year }", compare = "[previous_year]") {
  const h = mkdtempSync(join(tmpdir(), "crawlmark-coverage-"));
  mkdirSync(join(h, "config"), { recursive: true });
  writeFileSync(
    join(h, "config", "report-templates.yaml"),
    `version: 1\ntemplates:\n  y:\n    title: Y\n    period: ${period}\n    compare: ${compare}\n    sections:\n      - { id: search, type: search_overview }\n      - { id: traffic, type: organic_traffic }\n      - { id: pages, type: top_pages }\n`,
  );
  return h;
}

const section = (sections: SectionResult[], id: string) => sections.find((s) => s.id === id)!;
const data = (sections: SectionResult[], id: string) => (section(sections, id) as Extract<SectionResult, { status: "ok" }>).data as Record<string, unknown>;
const askedFor = (year: string) => fake.gscCalls.filter((c) => c.startDate.startsWith(year) || c.endDate.startsWith(year));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  db.prepare("DELETE FROM gsc_monthly").run();
  db.prepare("DELETE FROM cache").run();
  fake.reset();
  fake.gsc = (b) => (b.dimensions?.length ? (b.dimensions[0] === "date" ? [] : [row(["https://example.com/live"], 50, 900, 4)]) : [row([], 999, 20000, 7)]);
});
afterEach(() => vi.useRealTimers());

describe("gscRangeCoverage", () => {
  const c = { slug: client.slug, gscProperty: PROPERTY };

  it("a range starting on Google's window start day is Google's; the day before is not", () => {
    // 2026-11-01 minus 16 months is 2025-07-01.
    expect(gscRangeCoverage(c, { startDate: "2025-07-01", endDate: "2025-07-31" }, NOW)).toEqual({ complete: true, source: "google" });
    expect(gscRangeCoverage(c, { startDate: "2025-06-30", endDate: "2025-07-31" }, NOW)).toEqual({ complete: false, missingMonths: ["2025-06"], reason: "not_whole_months" });
  });

  it("whole months before the window are complete only when every month is stored", () => {
    const r = { startDate: "2025-04-01", endDate: "2025-08-31" };
    expect(gscRangeCoverage(c, r, NOW)).toEqual({ complete: false, missingMonths: ["2025-04", "2025-05", "2025-06"], reason: "partial_window" });
    store("2025-05", 10);
    expect(gscRangeCoverage(c, r, NOW)).toEqual({ complete: false, missingMonths: ["2025-04", "2025-06"], reason: "partial_window" });
    for (const m of ["2025-04", "2025-06", "2025-07", "2025-08"]) store(m, 10);
    expect(gscRangeCoverage(c, r, NOW)).toEqual({ complete: true, source: "stored" });
  });

  it("a mid-month clock: the month the window starts in counts as before the window", () => {
    const mid = Date.parse("2026-11-15T12:00:00Z");
    expect(gscRangeCoverage(c, { startDate: "2025-07-15", endDate: "2025-08-10" }, mid)).toEqual({ complete: true, source: "google" });
    expect(gscRangeCoverage(c, { startDate: "2025-07-01", endDate: "2025-07-31" }, mid)).toEqual({ complete: false, missingMonths: ["2025-07"], reason: "partial_window" });
    expect(gscRangeCoverage(c, { startDate: "2025-05-03", endDate: "2025-08-10" }, mid)).toEqual({ complete: false, missingMonths: ["2025-05", "2025-06", "2025-07"], reason: "not_whole_months" });
  });

  it("no property means nothing is stored", () => {
    expect(gscRangeCoverage({ slug: client.slug }, { startDate: "2024-01-01", endDate: "2024-12-31" }, NOW)).toMatchObject({ complete: false, reason: "partial_window", missingMonths: months(2024) });
  });

  it("coverageNote names the period and the missing months (once for one month)", () => {
    expect(coverageNote({ startDate: "2024-01-01", endDate: "2024-12-31" }, { complete: false, missingMonths: months(2024), reason: "partial_window" })).toBe(
      "Search Console: 2024 is older than Google's 16 months and the saved history doesn't cover 2024-01…2024-12; that comparison is left out.",
    );
    expect(coverageNote({ startDate: "2025-06-01", endDate: "2025-06-30" }, { complete: false, missingMonths: ["2025-06"], reason: "partial_window" })).toBe(
      "Search Console: June 2025 is older than Google's 16 months and the saved history doesn't cover 2025-06; that comparison is left out.",
    );
  });
});

describe("runTemplate with a year older than Google's window", () => {
  it("2025 against 2024 with nothing stored for 2024: the comparison is left out with a note and Google is never asked for 2024", async () => {
    for (const m of months(2025)) store(m, 200);
    const r = await runTemplate(client, { homeDir: home(), today, template: "y", store: false }, deps());
    expect(r.period.label).toBe("2025");
    expect(section(r.sections, "search").status).toBe("ok");
    const search = data(r.sections, "search");
    expect(search.vsPreviousYear).toBeNull();
    expect((search.current as { clicks: number }).clicks).toBe(2400);
    expect(askedFor("2024")).toEqual([]);
    expect(r.notes).toContain("Search Console: 2024 is older than Google's 16 months and the saved history doesn't cover 2024-01…2024-12; that comparison is left out.");
    // GA4 keeps its comparison.
    expect(data(r.sections, "traffic").comparedWith).toBe("previous_year");
  });

  it("with every 2024 month stored, the stored figures are used, with the stored-history note and no daily previous series", async () => {
    for (const m of months(2025)) store(m, 200);
    for (const m of months(2024)) store(m, 100);
    const r = await runTemplate(client, { homeDir: home(), today, template: "y", store: false }, deps());
    const search = data(r.sections, "search");
    expect(search.vsPreviousYear).toMatchObject({ clicks: { value: 2400, change: 100 }, previous: { clicks: 1200 } });
    expect(fake.gscCalls.filter((c) => c.dimensions?.[0] !== "date")).toEqual([]);
    expect(askedFor("2024")).toEqual([]);
    expect(r.notes).toContain("Search Console: 2024 comes from saved monthly history, which keeps each month's top 250 pages and queries; page and query tables compared with it cover those only.");
    expect((search.daily as { previous: unknown } | undefined)?.previous ?? null).toBeNull();
  });

  it("a current year Google doesn't cover makes every Search Console section unavailable; GA4 keeps its comparison", async () => {
    const r = await runTemplate(client, { homeDir: home(), today, template: "y", year: "2023", store: false }, deps());
    for (const id of ["search", "pages"]) {
      expect(section(r.sections, id)).toMatchObject({
        status: "unavailable",
        reason: expect.stringMatching(/^Search Console doesn't cover 2023 \(older than Google's 16 months and not in the saved history; run .* gsc-history backfill\)$/),
      });
    }
    expect(section(r.sections, "traffic").status).toBe("ok");
    expect(data(r.sections, "traffic").comparedWith).toBe("previous_year");
    expect(fake.gscCalls).toEqual([]);
  });

  it("last_n_days 480: comparisons that cross the window are dropped with a note, the current range still runs", async () => {
    const r = await runTemplate(client, { homeDir: home("{ range: last_n_days, days: 480 }", "[previous_period, previous_year]"), today, template: "y", store: false }, deps());
    expect(r.period.current).toEqual({ startDate: "2025-07-07", endDate: "2026-10-29" });
    const search = data(r.sections, "search");
    expect(search.vsPreviousPeriod).toBeNull();
    expect(search.vsPreviousYear).toBeNull();
    expect((search.current as { clicks: number }).clicks).toBe(999);
    expect(r.notes).toContain("Search Console: 7 Jul 2024 – 29 Oct 2025 is older than Google's 16 months and the saved history doesn't cover 2024-07…2025-06; that comparison is left out.");
    expect(fake.gscCalls.every((c) => c.startDate >= "2025-07-01")).toBe(true);
    expect(data(r.sections, "traffic").comparedWith).toBe("previous_period");
  });
});
