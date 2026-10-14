/** Phase 13 A-7: computed highlights 11 (new critical/high technical issues) and 12 (indexed share moved ≥ 5 points). Pure. */
import { describe, expect, it } from "vitest";
import { computeHighlights } from "../src/reports/highlights.js";
import { INDEXING, p13Report, TECH_ISSUES } from "./fixtures/reports/p13-data.js";

describe("Phase 13 highlights", () => {
  it("(11) counts new critical and high issues, with resolved ones beside them; unverified never count as resolved", () => {
    const h = computeHighlights(p13Report());
    expect(h.find((x) => x.kind === "technical-issues-new")).toEqual({ kind: "technical-issues-new", sectionId: "issues", text: "1 new critical or high-severity technical issue since the last report (1 resolved).", value: 1 });
    // First run (no changes) or no new severe issue: no highlight.
    expect(computeHighlights(p13Report({ issues: { ...TECH_ISSUES, changes: null } })).some((x) => x.kind === "technical-issues-new")).toBe(false);
    expect(computeHighlights(p13Report({ issues: { ...TECH_ISSUES, issues: TECH_ISSUES.issues.filter((i) => i.change !== "new") } })).some((x) => x.kind === "technical-issues-new")).toBe(false);
  });

  it("(12) the indexed share between the last two months with data, only when it moved at least 5 points", () => {
    expect(computeHighlights(p13Report()).some((x) => x.kind === "indexed-share")).toBe(false);
    const moved = { ...INDEXING, trend: [...INDEXING.trend.slice(0, 3), { month: "2026-10", inspected: 40, indexedShare: 68 }] };
    expect(computeHighlights(p13Report({ indexing: moved })).find((x) => x.kind === "indexed-share")).toEqual({
      kind: "indexed-share",
      sectionId: "indexing",
      text: "The share of checked URLs Google has indexed fell 7.0 points (from 75.0% in September 2026 to 68.0% in October 2026).",
      value: -7,
    });
  });
});
