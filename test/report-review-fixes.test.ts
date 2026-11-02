/**
 * Report redesign review fixes (round 4): each block is one finding. Fixture data only (example.com); no network.
 */
import { describe, expect, it } from "vitest";
import { fillDays } from "../src/lib/dates.js";
import JSZip from "jszip";
import { buildReportDoc, type Chart, type LineChart } from "../src/reports/render/doc.js";
import { toDocx, wholeInterval } from "../src/reports/render/docx.js";
import { lineChartSvg, tickLabel } from "../src/reports/render/svg.js";

describe("R-3: days with no rows are filled with 0", () => {
  it("fillDays fills gaps between reported days, never days before the first or after the last report", () => {
    const rows = [{ date: "2026-09-02", n: 2 }, { date: "2026-09-04", n: 4 }];
    expect(fillDays({ startDate: "2026-09-01", endDate: "2026-09-06" }, rows, (date) => ({ date, n: 0 }))).toEqual([
      { date: "2026-09-02", n: 2 },
      { date: "2026-09-03", n: 0 },
      { date: "2026-09-04", n: 4 },
    ]);
    expect(fillDays({ startDate: "2026-09-01", endDate: "2026-09-06" }, [], (date) => ({ date, n: 0 }))).toEqual([]);
  });

  it("a report run before Search Console has the last days: the series stops at the last reported day (no drop to 0)", async () => {
    const lag = (d: string) => d >= "2026-09-28";
    const deps = fakeDeps({
      gscQuery: async (c, o) => data.gscQuery(c, o).filter((r) => !(o.dimensions?.join() === "date" && lag(r.keys[0]!))),
      ga4OrganicDaily: async (c, r) => data.ga4OrganicDaily(c, r).filter((x) => !lag(x.date)),
    });
    const report = await fixtureReport({}, deps);
    const search = report.sections.find((s) => s.id === "search") as { data: { daily: { current: { date: string; clicks: number }[] } } };
    expect(search.data.daily.current).toHaveLength(27);
    expect(search.data.daily.current.at(-1)!.date).toBe("2026-09-27");
    expect(search.data.daily.current.every((d) => d.clicks > 0)).toBe(true);
    const traffic = report.sections.find((s) => s.id === "traffic") as { data: { daily: { current: { date: string; sessions: number }[] } } };
    expect(traffic.data.daily.current.at(-1)!.date).toBe("2026-09-27");
  });

  it("search and sessions series cover every day; the previous period lines up; weeks are 7 days", async () => {
    const gap = (d: string) => ["2026-09-06", "2026-09-07", "2026-08-03"].includes(d);
    const deps = fakeDeps({
      gscQuery: async (c, o) => data.gscQuery(c, o).filter((r) => !(o.dimensions?.join() === "date" && gap(r.keys[0]!))),
      ga4OrganicDaily: async (c, r) => data.ga4OrganicDaily(c, r).filter((x) => !gap(x.date)),
    });
    const report = await fixtureReport({}, deps);
    const search = report.sections.find((s) => s.id === "search") as { data: { daily: { current: { date: string; clicks: number }[]; previous: { date: string; clicks: number }[] } } };
    expect(search.data.daily.current).toHaveLength(30);
    expect(search.data.daily.current[5]).toEqual({ date: "2026-09-06", clicks: 0, impressions: 0 });
    expect(search.data.daily.previous).toHaveLength(31);
    expect(search.data.daily.previous[2]).toMatchObject({ date: "2026-08-03", clicks: 0 });
    const traffic = report.sections.find((s) => s.id === "traffic") as { data: { daily: { current: { date: string; sessions: number }[] } } };
    expect(traffic.data.daily.current).toHaveLength(30);
    expect(traffic.data.daily.current[6]).toEqual({ date: "2026-09-07", sessions: 0 });
    const md = toMarkdown(buildReportDoc(report, v));
    expect(md).toMatch(/\| 1–7 Sep \| \d/);
    expect(md).toMatch(/\| 8–14 Sep \| \d/);
  });
});

/** A fixture doc with one extra section holding `chart`, rendered to DOCX; returns the chart parts' XML. */
async function docxCharts(chart: Chart): Promise<string> {
  const doc = buildReportDoc(await fixtureReport({ include: [] }), v);
  doc.sections = [{ id: "x", anchor: "s-x", title: "X", blocks: [{ kind: "chart", chart }] }];
  const zip = await JSZip.loadAsync(await toDocx(doc));
  const parts = Object.keys(zip.files).filter((f) => /^word\/charts\/chart\d+\.xml$/.test(f));
  return (await Promise.all(parts.map((p) => zip.file(p)!.async("string")))).join("\n");
}

describe("SEC-2: non-date chart categories go through docxText", () => {
  it("control and XML-invalid characters are removed from Word chart categories", async () => {
    const xml = await docxCharts({ ...line([1, 2, 3], "count"), x: ["a\u0007b", "c\u202ed", "e\u0000f"] });
    expect(xml).toContain("ab");
    expect(xml).not.toMatch(/[\u0000-\u0008\u202e]/);
  });
});

describe("SEC-3: NaN and Infinity never reach the Word chart", () => {
  it("non-finite line values become gaps and share values 0; the file still builds", async () => {
    const xml = await docxCharts(line([1, Number.NaN, Number.POSITIVE_INFINITY, 4], "count"));
    expect(xml).not.toMatch(/NaN|Infinity/);
    const share = await docxCharts({ type: "share", title: "Share", parts: ["A", "B"], rows: [{ label: "Sep", values: [Number.NaN, 5] }, { label: "Aug", values: [Number.NEGATIVE_INFINITY, 3] }], summary: "s" });
    expect(share).not.toMatch(/NaN|Infinity/);
  });
});

describe("DOCX footer without footer text", () => {
  it("white label with no footer: just 'Page n of m', no stray separator", async () => {
    const doc = buildReportDoc(await fixtureReport({ include: [] }), { ...v, branding: { hideCrawlmark: true } });
    expect(doc.footer).toBe("");
    const zip = await JSZip.loadAsync(await toDocx(doc));
    const footer = (await Promise.all(Object.keys(zip.files).filter((f) => /^word\/footer\d*\.xml$/.test(f)).map((f) => zip.file(f)!.async("string")))).join("");
    expect(footer).toContain(">Page <");
    expect(footer).not.toContain("·");
  });
});

describe("local intent ignores the country part of the area", () => {
  it("any country, not only the US and UK", () => {
    expect(isLocalIntent("plumber canada", "Toronto,Ontario,Canada")).toBe(false);
    expect(isLocalIntent("plumber germany", "Berlin,Berlin,Germany")).toBe(false);
    expect(isLocalIntent("plumber toronto", "Toronto,Ontario,Canada")).toBe(true);
    expect(isLocalIntent("emergency plumber ontario", "Toronto,Ontario,Canada")).toBe(true);
    // A single-part area is the place itself.
    expect(isLocalIntent("plumber smallville", "Smallville")).toBe(true);
  });
});

describe("axis labels for big counts", () => {
  it("thousands as k, millions as M", () => {
    expect(tickLabel(750, "count")).toBe("750");
    expect(tickLabel(2500, "count")).toBe("2.5k");
    expect(tickLabel(250_000, "count")).toBe("250k");
    expect(tickLabel(1_000_000, "count")).toBe("1M");
    expect(tickLabel(2_500_000, "count")).toBe("2.5M");
  });
});
import { toMarkdown } from "../src/reports/render/markdown.js";
import { isLocalIntent } from "../src/reports/templates/run.js";
import { fakeDeps } from "./fixtures/reports/deps.js";
import * as data from "./fixtures/reports/data.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const v = { version: "0.1.0" };

describe("R-1: the one-page layout never calls a section with data 'no data'", () => {
  it("search without daily rows (daily fetch failed) shows a one-line note, not 'Not included'", async () => {
    const deps = fakeDeps({
      gscQuery: async (c, o) => {
        if (o.dimensions?.join() === "date") throw new Error("invalid_grant: /Users/someone/token.json");
        return data.gscQuery(c, o);
      },
    });
    const md = toMarkdown(buildReportDoc(await fixtureReport({ template: "executive", include: [] }, deps), v));
    expect(md).toContain("## Clicks this period");
    expect(md).toContain("*Clicks per day weren't available for this report.*");
    expect(md).not.toContain("Not included this time");
    expect(md).not.toMatch(/invalid_grant|\/Users\/someone/);
  });

  it("no gainers but some losers: 'No query gained clicks this period', not 'Not included'", async () => {
    // Every query did better in the previous month, so there are only losers.
    const deps = fakeDeps({ gscQuery: async (c, o) => data.gscQuery(c, o).map((r) => (o.startDate === "2026-08-01" && o.dimensions?.join() === "query" ? { ...r, clicks: r.clicks * 10 } : r)) });
    const report = await fixtureReport({ template: "executive", include: [] }, deps);
    const movers = report.sections.find((s) => s.id === "wins") as { data: { gainers: unknown[]; losers: unknown[] } };
    expect(movers.data.gainers).toEqual([]);
    expect(movers.data.losers.length).toBeGreaterThan(0);
    const md = toMarkdown(buildReportDoc(report, v));
    expect(md).toContain("## Top wins");
    expect(md).toContain("*No query gained clicks this period.*");
    expect(md).not.toContain("Not included this time");
  });
});

/** The y-axis labels of an SVG line chart (text at x = 34) with their y positions. */
function yTicks(svg: string): { label: string; y: number }[] {
  return [...svg.matchAll(/<text x="34" y="([\d.]+)" text-anchor="end" class="tick">([^<]*)<\/text>/g)].map((m) => ({ label: m[2]!, y: Number(m[1]) }));
}
const line = (values: number[], format: LineChart["format"], invert = false): LineChart => ({
  type: "line",
  title: "t",
  x: values.map((_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`),
  series: [{ name: "s", values, role: invert ? "series" : "current", index: 0 }],
  format,
  ...(invert ? { invert: true, connectGaps: true } : {}),
  summary: "s",
});

describe("R-2: whole-number axes", () => {
  it("positions 1 → 2.2 → 3: distinct whole labels, all inside the plot", () => {
    const ticks = yTicks(lineChartSvg(line([1, 2.2, 3], "position", true), { width: 600, height: 160 }, "#1f5ea8"));
    expect(ticks.map((t) => t.label)).toEqual(["1", "2", "3"]);
    for (const t of ticks) expect(t.y).toBeGreaterThanOrEqual(10);
  });

  it("counts peaking at 2: 0, 1, 2 (no repeated labels)", () => {
    const labels = yTicks(lineChartSvg(line([0, 1, 2, 1], "count"), { width: 600, height: 160 }, "#1f5ea8")).map((t) => t.label);
    expect(labels).toEqual(["0", "1", "2"]);
  });

  it("the Word chart's major unit for counts and positions is a whole number", () => {
    expect(wholeInterval(line([0, 1, 2, 1], "count"))).toBe(1);
    expect(wholeInterval(line([1, 2.2, 3], "position", true))).toBe(1);
    expect(wholeInterval(line([0, 400, 1200], "count"))).toBe(500);
  });
});

describe("round 6 R-1: no 2.5 steps on whole-number axes", () => {
  it("counts up to 10 tick at 0, 5, 10; positions 4 to 10 at whole numbers", () => {
    expect(yTicks(lineChartSvg(line([0, 4, 10, 7], "count"), { width: 600, height: 160 }, "#1f5ea8")).map((t) => t.label)).toEqual(["0", "5", "10"]);
    const pos = yTicks(lineChartSvg(line([4, 7, 10], "position", true), { width: 600, height: 160 }, "#1f5ea8")).map((t) => t.label);
    expect(pos.every((l) => /^\d+$/.test(l))).toBe(true);
    expect(new Set(pos).size).toBe(pos.length);
    expect(wholeInterval(line([0, 4, 10, 7], "count"))).toBe(5);
    expect(Number.isInteger(wholeInterval(line([4, 7, 10], "position", true)))).toBe(true);
  });
});

describe("round 6 SEC-2: tiny values can't make the tick loop run away", () => {
  it("maxima of 1e-15 and 1e-300 (score format, no bands) finish quickly with a few ticks", () => {
    const t0 = Date.now();
    for (const top of [1e-15, 1e-300]) {
      const svg = lineChartSvg(line([0, top / 2, top], "score"), { width: 600, height: 160 }, "#1f5ea8");
      expect(yTicks(svg).length).toBeLessThanOrEqual(8);
    }
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("SEC-1: huge values can't make the tick loop run away", () => {
  it("a value near Number.MAX_VALUE gives no SVG (the table is shown instead), quickly", () => {
    const t0 = Date.now();
    // The axis maximum overflows to Infinity: no chart.
    expect(lineChartSvg(line([0, 1.7e308, 1], "count"), { width: 600, height: 160 }, "#1f5ea8")).toBe("");
    expect(lineChartSvg(line([0, Number.MAX_VALUE], "ms"), { width: 600, height: 160 }, "#1f5ea8")).toBe("");
    // Huge but finite: a handful of ticks, never a runaway loop.
    expect(yTicks(lineChartSvg(line([0, Number.MAX_VALUE / 4, 1], "count"), { width: 600, height: 160 }, "#1f5ea8")).length).toBeLessThanOrEqual(8);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
