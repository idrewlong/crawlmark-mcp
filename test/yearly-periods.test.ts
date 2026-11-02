/** Release 0.5.0 Y0.2: year periods, the `year` run override and period names (C1). Today is always injected. */
import { describe, expect, it } from "vitest";
import { minusOneYear, PeriodError, periodName, periodSlug, resolvePeriod, type ResolvedPeriod } from "../src/reports/templates/period.js";
import type { Comparison, Period } from "../src/reports/templates/schema.js";

const BOTH: Comparison[] = ["previous_period", "previous_year"];
const on = (iso: string) => new Date(`${iso}T12:00:00Z`);
const resolve = (period: Period, today: string, compare: Comparison[] = BOTH, override = {}): ResolvedPeriod => resolvePeriod(period, compare, override, on(today));

describe("year ranges", () => {
  it("last_year on 2026-11-01 is 2025 against 2024", () => {
    expect(resolve({ range: "last_year" }, "2026-11-01")).toEqual({
      current: { startDate: "2025-01-01", endDate: "2025-12-31" },
      label: "2025",
      folderMonth: "2025-12",
      comparisons: { previous_year: { startDate: "2024-01-01", endDate: "2024-12-31" } },
    });
  });

  it("year_to_date on 2026-11-01 is Jan–Oct 2026 against Jan–Oct 2025", () => {
    expect(resolve({ range: "year_to_date" }, "2026-11-01")).toEqual({
      current: { startDate: "2026-01-01", endDate: "2026-10-31" },
      label: "Jan–Oct 2026 (year to date)",
      folderMonth: "2026-10",
      comparisons: { previous_year: { startDate: "2025-01-01", endDate: "2025-10-31" } },
    });
  });

  it("year_to_date in January is last year in full (C-D1)", () => {
    expect(resolve({ range: "year_to_date" }, "2027-01-15")).toEqual({
      current: { startDate: "2026-01-01", endDate: "2026-12-31" },
      label: "2026 (full year; no complete month of 2027 yet)",
      folderMonth: "2026-12",
      comparisons: { previous_year: { startDate: "2025-01-01", endDate: "2025-12-31" } },
    });
  });

  it("year_to_date after March is labelled as the quarter", () => {
    const p = resolve({ range: "year_to_date" }, "2026-04-10");
    expect(p.current).toEqual({ startDate: "2026-01-01", endDate: "2026-03-31" });
    expect(p.label).toBe("Q1 2026 (year to date)");
    expect(p.folderMonth).toBe("2026-03");
  });

  it("year_to_date in February and March uses the plain names", () => {
    expect(resolve({ range: "year_to_date" }, "2026-02-03").label).toBe("January 2026 (year to date)");
    expect(resolve({ range: "year_to_date" }, "2026-03-03").label).toBe("1 Jan – 28 Feb 2026 (year to date)");
  });

  it("last_12_months on 2026-11-01 is Nov 2025 – Oct 2026", () => {
    expect(resolve({ range: "last_12_months" }, "2026-11-01")).toEqual({
      current: { startDate: "2025-11-01", endDate: "2026-10-31" },
      label: "Nov 2025 – Oct 2026",
      folderMonth: "2026-10",
      comparisons: { previous_year: { startDate: "2024-11-01", endDate: "2025-10-31" } },
    });
  });

  it("a year range gives one previous_year whichever comparisons are asked for", () => {
    for (const compare of [["previous_period"], ["previous_year"], BOTH, ["previous_year", "previous_period"]] as Comparison[][]) {
      expect(Object.keys(resolve({ range: "last_year" }, "2026-11-01", compare).comparisons), compare.join()).toEqual(["previous_year"]);
    }
    expect(resolve({ range: "last_year" }, "2026-11-01", []).comparisons).toEqual({});
  });
});

describe("the year override", () => {
  it("a past year is that calendar year", () => {
    const p = resolve({ range: "last_month" }, "2026-11-01", BOTH, { year: "2025" });
    expect(p).toMatchObject({ current: { startDate: "2025-01-01", endDate: "2025-12-31" }, label: "2025", folderMonth: "2025-12", comparisons: { previous_year: { startDate: "2024-01-01", endDate: "2024-12-31" } } });
    expect(Object.keys(p.comparisons)).toEqual(["previous_year"]);
    expect(resolve({ range: "last_year" }, "2026-11-01", BOTH, { year: "2019" }).label).toBe("2019");
  });

  it("the current year is year to date (C-D1 in January)", () => {
    expect(resolve({ range: "last_month" }, "2026-11-01", BOTH, { year: "2026" })).toMatchObject({ current: { startDate: "2026-01-01", endDate: "2026-10-31" }, label: "Jan–Oct 2026 (year to date)", folderMonth: "2026-10" });
    expect(resolve({ range: "last_month" }, "2027-01-15", BOTH, { year: "2027" })).toMatchObject({ current: { startDate: "2026-01-01", endDate: "2026-12-31" }, label: "2026 (full year; no complete month of 2027 yet)" });
  });

  it("the template's compare still filters", () => {
    expect(resolve({ range: "last_month" }, "2026-11-01", [], { year: "2025" }).comparisons).toEqual({});
  });

  it.each([
    [{ year: "2027" }, "2027 hasn't started yet."],
    [{ year: "25" }, 'Year must be YYYY, got "25".'],
    [{ year: "2025-01" }, 'Year must be YYYY, got "2025-01".'],
    [{ year: "2025", month: "2025-05" }, "Give only one of year, month, quarter, or startDate and endDate."],
    [{ year: "2025", quarter: "2025-Q1" }, "Give only one of year, month, quarter, or startDate and endDate."],
    [{ year: "2025", startDate: "2025-01-01", endDate: "2025-02-01" }, "Give only one of year, month, quarter, or startDate and endDate."],
  ])("refuses %j", (override, message) => {
    expect(() => resolve({ range: "last_month" }, "2026-11-01", BOTH, override)).toThrow(PeriodError);
    expect(() => resolve({ range: "last_month" }, "2026-11-01", BOTH, override)).toThrow(message);
  });

  it("month and quarter together still name year in the message", () => {
    expect(() => resolve({ range: "last_month" }, "2026-11-01", BOTH, { month: "2026-09", quarter: "2026-Q3" })).toThrow("Give only one of year, month, quarter, or startDate and endDate.");
  });
});

describe("periodName and periodSlug", () => {
  it.each([
    [{ startDate: "2026-09-01", endDate: "2026-09-30" }, "September 2026"],
    [{ startDate: "2026-07-01", endDate: "2026-09-30" }, "Q3 2026"],
    [{ startDate: "2025-01-01", endDate: "2025-12-31" }, "2025"],
    [{ startDate: "2026-01-01", endDate: "2026-10-31" }, "Jan–Oct 2026"],
    [{ startDate: "2026-02-01", endDate: "2026-05-31" }, "Feb–May 2026"],
    [{ startDate: "2025-11-01", endDate: "2026-10-31" }, "Nov 2025 – Oct 2026"],
    [{ startDate: "2024-11-01", endDate: "2026-10-31" }, "Nov 2024 – Oct 2026"],
    // 25 whole months: past the 4-to-24 rule.
    [{ startDate: "2024-10-01", endDate: "2026-10-31" }, "1 Oct 2024 – 31 Oct 2026"],
    // 3 whole months that aren't a quarter, and 2 whole months: rangeLabel, unchanged.
    [{ startDate: "2026-02-01", endDate: "2026-04-30" }, "1 Feb – 30 Apr 2026"],
    [{ startDate: "2026-01-01", endDate: "2026-02-28" }, "1 Jan – 28 Feb 2026"],
    // Not whole months.
    [{ startDate: "2026-01-01", endDate: "2026-10-30" }, "1 Jan – 30 Oct 2026"],
    [{ startDate: "2026-09-12", endDate: "2026-10-09" }, "12 Sep – 9 Oct 2026"],
  ])("periodName(%j) is %s", (r, name) => {
    expect(periodName(r)).toBe(name);
  });

  it("periodSlug of a calendar year is the year; others are unchanged", () => {
    expect(periodSlug({ startDate: "2025-01-01", endDate: "2025-12-31" })).toBe("2025");
    expect(periodSlug({ startDate: "2026-01-01", endDate: "2026-10-31" })).toBe("2026-01-01-to-2026-10-31");
    expect(periodSlug({ startDate: "2026-09-01", endDate: "2026-09-30" })).toBe("2026-09");
    expect(periodSlug({ startDate: "2026-07-01", endDate: "2026-09-30" })).toBe("2026-q3");
  });

  it("minusOneYear turns 29 Feb into 28 Feb", () => {
    expect(minusOneYear({ startDate: "2024-01-01", endDate: "2024-02-29" })).toEqual({ startDate: "2023-01-01", endDate: "2023-02-28" });
    expect(resolve({ range: "year_to_date" }, "2024-03-05").comparisons.previous_year).toEqual({ startDate: "2023-01-01", endDate: "2023-02-28" });
  });
});
