/**
 * Release 0.5.0 Y0b: the labelled partial Search Console range (C2a, user decision C-D6). When the current range is
 * partly older than Google's 16 months and those months aren't saved, Search Console sections show the available
 * whole months, labelled, with no comparison. Fake run deps record every Search Console and GA4 request; saved history
 * is the temp SQLite table. example.com only, no network.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { beforeEach, describe, expect, it } from "vitest";
import type { CrawlPage } from "../src/analysis/crawl.js";
import type { StoredCrawl } from "../src/lib/crawls.js";
import type { DateRange } from "../src/lib/dates.js";
import { gscPartialRange, partialNote } from "../src/lib/gsc-coverage.js";
import { saveMonth } from "../src/lib/gsc-monthly.js";
import { db } from "../src/lib/store.js";
import { computeHighlights } from "../src/reports/highlights.js";
import { buildDeck } from "../src/reports/render/deck.js";
import { buildReportDoc, type Block, type BuildOptions, type Chart, type ReportDoc, type Text } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { toHtml } from "../src/reports/render/html.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import { toPptx } from "../src/reports/render/pptx/index.js";
import { partialGoalsNote, partialSourceNote } from "../src/reports/render/sections.js";
import type { SectionResult, TemplateReport, WinsMissesData } from "../src/reports/report-types.js";
import { monthSpanLabel } from "../src/reports/templates/period.js";
import { runTemplate, type RunDeps } from "../src/reports/templates/run.js";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import { client, fakeDeps } from "./fixtures/reports/deps.js";
import * as fx from "./fixtures/reports/data.js";
import { CONTENT_BY_YEAR, H2_2025, PARTIAL_LABEL, PARTIAL_NOTE, partialYearReport, YEAR_2024, YEAR_2025 } from "./fixtures/reports/yearly-data.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const MID = Date.parse("2026-11-15T12:00:00Z");
const today = new Date(NOW);
const PROPERTY = "sc-domain:example.com";
const C = { slug: client.slug, gscProperty: PROPERTY };
const months = (from: number, to: number, year = 2025) => Array.from({ length: to - from + 1 }, (_, i) => `${year}-${String(from + i).padStart(2, "0")}`);
const SOURCE = partialSourceNote(PARTIAL_LABEL);
const MOVERS_REASON = "Search Console covers only Jul–Dec 2025 of this period, so there's nothing to compare with (Google keeps 16 months)";

const store = (month: string, clicks = 100) =>
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

/** Every Search Console request (queries and totals) and every GA4 request the run made, as ranges. */
let gscCalls: (DateRange & { dimensions?: string[] })[] = [];
let ga4Calls: DateRange[] = [];

const E = "https://example.com";
const crawlPage = (path: string, date: string): CrawlPage =>
  ({
    url: `${E}${path}`, depth: 1, status: 200, finalUrl: `${E}${path}`, finalStatus: 200, redirectChain: [], contentType: "text/html", title: "T", description: null, canonical: null,
    robots: null, noindex: false, h1Count: 1, inlinks: 1, outlinks: 1, firstLinkedFrom: null, parsed: true, issues: [], published: { date, source: "jsonld" },
  }) as CrawlPage;
const CRAWL: StoredCrawl = { id: "crawl_y0b", client: "example.com", ranAt: Date.UTC(2026, 9, 20), settings: {}, summary: {}, exhaustive: true, pages: [crawlPage("/", "2024-02-01"), crawlPage("/blog/water-heaters", "2025-03-01")] };

/** fakeDeps with the real coverage guard (saved history from the temp table) and recorded requests. */
function deps(over: Partial<RunDeps> = {}): RunDeps {
  const d = fakeDeps({
    gscQuery: async (c, o) => {
      gscCalls.push({ startDate: o.startDate, endDate: o.endDate, ...(o.dimensions ? { dimensions: o.dimensions } : {}) });
      return fx.gscQuery(c, o);
    },
    gscTotals: async (c, r) => {
      gscCalls.push({ startDate: r.startDate, endDate: r.endDate });
      return fx.gscTotals(c, r);
    },
    ga4OrganicSummary: async (c, r) => {
      ga4Calls.push(r);
      return fx.ga4OrganicSummary(c, r);
    },
    ga4ChannelReport: async (c, r) => {
      ga4Calls.push(r);
      return fx.ga4ChannelReport(c, r);
    },
    querySpikes: async (_c, r) => {
      gscCalls.push({ startDate: r.startDate, endDate: r.endDate });
      return [];
    },
    latestLocalCrawl: () => CRAWL,
    indexingSection: async () => (await import("./fixtures/reports/p13-data.js")).INDEXING,
    ...over,
  });
  delete d.gscStoredCoverage;
  return d;
}

/** A template with every Search Console section type, two GA4 sections and URL Inspection. */
function home(goals = "[{ metric: clicks, target: 1000, label: Search clicks }, { metric: sessions, target: 2000 }]") {
  const h = mkdtempSync(join(tmpdir(), "crawlmark-partial-"));
  mkdirSync(join(h, "config"), { recursive: true });
  writeFileSync(
    join(h, "config", "report-templates.yaml"),
    [
      "version: 1",
      "templates:",
      "  y:",
      "    title: Y",
      "    period: { range: last_year }",
      "    compare: [previous_year]",
      "    sections:",
      "      - { id: search, type: search_overview }",
      "      - { id: branded, type: branded_split }",
      "      - { id: queries, type: top_queries }",
      "      - { id: query-movers, type: query_movers }",
      "      - { id: pages, type: top_pages }",
      "      - { id: page-movers, type: page_movers }",
      "      - { id: tracked, type: tracked_keywords }",
      "      - { id: opps, type: opportunities }",
      "      - { id: page-types, type: page_groups }",
      "      - { id: content-years, type: content_by_year }",
      `      - { id: wins, type: wins_misses, goals: ${goals} }`,
      "      - { id: indexing, type: indexing_issues }",
      "      - { id: traffic, type: organic_traffic }",
      "      - { id: channels, type: channel_yoy }",
      "",
    ].join("\n"),
  );
  return h;
}

const AFFECTED_OK = ["search", "branded", "queries", "pages", "tracked", "opps", "page-types", "content-years", "wins"];
const section = (sections: SectionResult[], id: string) => sections.find((s) => s.id === id)!;
const data = <T = Record<string, unknown>>(sections: SectionResult[], id: string) => (section(sections, id) as Extract<SectionResult, { status: "ok" }>).data as T;

beforeEach(() => {
  db.prepare("DELETE FROM gsc_monthly").run();
  db.prepare("DELETE FROM cache").run();
  gscCalls = [];
  ga4Calls = [];
});

// ------------------------------------------------------------------------------------------------ Y0b.2

describe("gscPartialRange (Y0b.2)", () => {
  it("nothing saved: Google's whole months, Jul–Dec 2025, with Jan–Jun missing", () => {
    expect(gscPartialRange(C, YEAR_2025, NOW)).toEqual({ requested: YEAR_2025, range: H2_2025, source: "google", months: months(7, 12), missing: months(1, 6), label: "Jul–Dec 2025" });
  });

  it("a window starting mid-month starts at the next whole month", () => {
    // 2026-11-15 minus 16 months is 2025-07-15: July isn't whole in Google's window.
    expect(gscPartialRange(C, YEAR_2025, MID)).toMatchObject({ range: { startDate: "2025-08-01", endDate: "2025-12-31" }, source: "google", months: months(8, 12), missing: months(1, 7), label: "Aug–Dec 2025" });
  });

  it("a longer saved run beats Google's (Mar–Dec saved against Jul–Dec)", () => {
    for (const m of months(3, 12)) store(m);
    expect(gscPartialRange(C, YEAR_2025, NOW)).toEqual({ requested: YEAR_2025, range: { startDate: "2025-03-01", endDate: "2025-12-31" }, source: "stored", months: months(3, 12), missing: months(1, 2), label: "Mar–Dec 2025" });
  });

  it("a gap is never bridged: Feb saved, Mar not, Apr–Dec saved gives Apr–Dec", () => {
    store("2025-02");
    for (const m of months(4, 12)) store(m);
    const p = gscPartialRange(C, YEAR_2025, NOW)!;
    expect(p).toMatchObject({ range: { startDate: "2025-04-01", endDate: "2025-12-31" }, source: "stored", label: "Apr–Dec 2025" });
    expect(p.months).not.toContain("2025-02");
    expect(p.missing).toEqual(months(1, 3));
  });

  it("a tie goes to Google (it has daily rows)", () => {
    for (const m of months(7, 12)) store(m);
    expect(gscPartialRange(C, YEAR_2025, NOW)).toMatchObject({ range: H2_2025, source: "google" });
  });

  it("no whole month available (2023, nothing saved) gives null; a range Search Console covers gives null", () => {
    expect(gscPartialRange(C, { startDate: "2023-01-01", endDate: "2023-12-31" }, NOW)).toBeNull();
    expect(gscPartialRange(C, { startDate: "2025-07-01", endDate: "2026-10-31" }, NOW)).toBeNull();
    for (const m of months(1, 12)) store(m);
    expect(gscPartialRange(C, YEAR_2025, NOW)).toBeNull();
  });

  it("a last_n_days range crossing the window: Google's candidate ends on the range's own end day, labelled with rangeLabel", () => {
    const r = { startDate: "2025-06-20", endDate: "2026-11-12" };
    const p = gscPartialRange(C, r, MID)!;
    expect(p).toMatchObject({ range: { startDate: "2025-08-01", endDate: "2026-11-12" }, source: "google", label: "1 Aug 2025 – 12 Nov 2026" });
    expect(p.missing).toEqual(["2025-06", "2025-07"]);
    // Not whole months: saved history can't answer it, so no stored candidate even with every month saved.
    for (const m of [...months(6, 12), ...months(1, 11, 2026)]) store(m);
    expect(gscPartialRange(C, r, MID)).toMatchObject({ source: "google", range: { startDate: "2025-08-01" } });
  });

  it("monthSpanLabel: one month, one year, across years, a mid-month end", () => {
    expect(monthSpanLabel({ startDate: "2025-12-01", endDate: "2025-12-31" })).toBe("Dec 2025");
    expect(monthSpanLabel(H2_2025)).toBe("Jul–Dec 2025");
    expect(monthSpanLabel({ startDate: "2025-11-01", endDate: "2026-10-31" })).toBe("Nov 2025 – Oct 2026");
    expect(monthSpanLabel({ startDate: "2026-07-01", endDate: "2026-10-28" })).toBe("1 Jul – 28 Oct 2026");
    // Never a quarter or a year name.
    expect(monthSpanLabel({ startDate: "2025-07-01", endDate: "2025-09-30" })).toBe("Jul–Sep 2025");
    expect(monthSpanLabel(YEAR_2025)).toBe("Jan–Dec 2025");
  });

  it("partialNote reads exactly as C2a", () => {
    expect(partialNote(gscPartialRange(C, YEAR_2025, NOW)!)).toBe(PARTIAL_NOTE);
  });
});

// ------------------------------------------------------------------------------------------------ Y0b.1, Y0b.3

describe("runTemplate on a 2026-11-01 clock with nothing saved before 2025-07 (Y0b.1, Y0b.3)", () => {
  it("the builtin yearly template: Search Console sections are ok on Jul–Dec 2025 and nothing earlier is asked for", async () => {
    const h = mkdtempSync(join(tmpdir(), "crawlmark-partial-"));
    const r = await runTemplate(client, { homeDir: h, today, template: "yearly", store: false }, deps());
    expect(r.sections.map((s) => [s.id, s.status])).toEqual([
      ["search", "ok"],
      ["channels", "ok"],
      ["page-types", "ok"],
      ["pages", "ok"],
      ["page-movers", "unavailable"],
      // No goals and no comparison: nothing to show (C4).
      ["wins", "unavailable"],
    ]);
    expect(r.gscPartial).toEqual({ range: H2_2025, requested: YEAR_2025, label: "Jul–Dec 2025", source: "google", missing: months(1, 6) });
    expect(gscCalls.length).toBeGreaterThan(0);
    for (const c of gscCalls) expect({ startDate: c.startDate, endDate: c.endDate }).toEqual(H2_2025);
  });

  it("every Search Console section on Jul–Dec 2025, labelled, no comparison; movers unavailable; URL Inspection and GA4 untouched", async () => {
    const r = await runTemplate(client, { homeDir: home(), today, template: "y", store: false }, deps());
    for (const id of AFFECTED_OK) {
      expect(section(r.sections, id).status, id).toBe("ok");
      expect(section(r.sections, id).gscRange, id).toEqual({ range: H2_2025, label: "Jul–Dec 2025" });
    }
    for (const id of ["query-movers", "page-movers"]) expect(section(r.sections, id)).toMatchObject({ status: "unavailable", reason: MOVERS_REASON, gscRange: { label: "Jul–Dec 2025" } });

    // No Search Console request touches January to June 2025 or 2024.
    expect(gscCalls.length).toBeGreaterThan(0);
    for (const c of gscCalls) expect({ startDate: c.startDate, endDate: c.endDate }).toEqual(H2_2025);

    const search = data(r.sections, "search");
    expect(search.vsPreviousPeriod).toBeNull();
    expect(search.vsPreviousYear).toBeNull();
    expect(search.current).toEqual(fx.gscTotals(null, H2_2025));
    const daily = search.daily as { current: { date: string }[]; previous: unknown; comparedWith: unknown };
    expect(daily.current[0]!.date).toBe("2025-07-01");
    expect(daily.previous).toBeNull();
    expect(daily.comparedWith).toBeNull();
    expect(data(r.sections, "branded").comparedWith).toBeNull();
    expect(data(r.sections, "tracked").comparedWith).toBeNull();
    expect(data(r.sections, "page-types").comparedWith).toBeNull();
    expect((data(r.sections, "opps").window as DateRange)).toEqual(H2_2025);

    // URL Inspection isn't period-based: unaffected and unlabelled.
    expect(section(r.sections, "indexing").status).toBe("ok");
    expect(section(r.sections, "indexing").gscRange).toBeUndefined();

    // GA4 keeps all of 2025 against 2024.
    expect(data(r.sections, "traffic").comparedWith).toBe("previous_year");
    expect(section(r.sections, "traffic").gscRange).toBeUndefined();
    expect(data(r.sections, "channels")).toMatchObject({ current: YEAR_2025, previous: YEAR_2024 });
    expect(ga4Calls.length).toBeGreaterThan(0);
    for (const c of ga4Calls) expect([YEAR_2025, YEAR_2024]).toContainEqual(c);

    expect(r.period.comparisons).toEqual({ previous_year: YEAR_2024 });
    expect(r.gscPartial).toMatchObject({ label: "Jul–Dec 2025", source: "google" });
    expect(r.notes).toContain(PARTIAL_NOTE);
    // No C2 comparison note: there is no Search Console comparison to drop.
    expect(r.notes.some((n) => n.includes("that comparison is left out"))).toBe(false);
    expect(r.notes.some((n) => n.includes("comes from saved monthly history"))).toBe(false);
  });

  it("wins and misses: the Search Console goal is skipped with its name, the GA4 goal runs on all of 2025 (Y0b.4)", async () => {
    const r = await runTemplate(client, { homeDir: home(), today, template: "y", store: false }, deps());
    const w = data<WinsMissesData>(r.sections, "wins");
    expect(w.comparedWith).toBeNull();
    expect(w.wins).toEqual([]);
    expect(w.misses).toEqual([]);
    expect(w.skippedGoals).toEqual(["Search clicks"]);
    expect(w.gscSkippedGoals).toEqual(["Search clicks"]);
    // sessions for 2025 (the fixture's full-year figure), never Jul–Dec.
    expect(w.goals).toEqual([{ kind: "miss", rule: "goal", text: "Goal missed: sessions 1,500 of 2,000 (75%)", metric: "sessions", current: 1500, previous: null, target: 2000 }]);
  });

  it("wins and misses with only Search Console goals is unavailable (Y0b.4)", async () => {
    const r = await runTemplate(client, { homeDir: home("[{ metric: clicks, target: 1000 }, { metric: impressions, target: 20000 }]"), today, template: "y", store: false }, deps());
    expect(section(r.sections, "wins")).toMatchObject({ status: "unavailable", reason: "needs a comparison period or goals" });
  });

  it("a stored candidate (Mar–Dec saved): Search Console reads Mar–Dec, adds the stored-history note and has no daily series", async () => {
    for (const m of months(3, 12)) store(m);
    const r = await runTemplate(client, { homeDir: home(), today, template: "y", store: false }, deps());
    const mar = { startDate: "2025-03-01", endDate: "2025-12-31" };
    expect(r.gscPartial).toEqual({ range: mar, requested: YEAR_2025, label: "Mar–Dec 2025", source: "stored", missing: months(1, 2) });
    for (const c of gscCalls) expect({ startDate: c.startDate, endDate: c.endDate }).toEqual(mar);
    expect(gscCalls.some((c) => c.dimensions?.[0] === "date")).toBe(false);
    expect(data(r.sections, "search").daily).toBeUndefined();
    expect(r.notes).toContain(
      "Search Console: Mar–Dec 2025 only. Google keeps 16 months of data and the saved history doesn't cover 2025-01…2025-02, so Search Console figures cover Mar–Dec 2025 and aren't compared with an earlier period.",
    );
    expect(r.notes).toContain("Search Console: Mar–Dec 2025 comes from saved monthly history, which keeps each month's top 250 pages and queries; page and query tables compared with it cover those only.");
  });

  it("zero available months keeps the C2 unavailable reason (2023)", async () => {
    const r = await runTemplate(client, { homeDir: home(), today, year: "2023", template: "y", store: false }, deps());
    expect(r.gscPartial).toBeUndefined();
    for (const id of [...AFFECTED_OK, "query-movers", "page-movers", "indexing"]) {
      expect(section(r.sections, id)).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/^Search Console doesn't cover 2023 \(older than Google's 16 months/) });
      expect(section(r.sections, id).gscRange).toBeUndefined();
    }
    expect(gscCalls).toEqual([]);
  });

  it("an injected gscPartialRange dep is used instead of the real one", async () => {
    const q4 = { startDate: "2025-10-01", endDate: "2025-12-31" };
    const r = await runTemplate(client, { homeDir: home(), today, template: "y", store: false }, deps({ gscPartialRange: (_c, range) => ({ requested: range, range: q4, source: "google", months: months(10, 12), missing: months(1, 9), label: "Oct–Dec 2025" }) }));
    expect(r.gscPartial?.label).toBe("Oct–Dec 2025");
    for (const c of gscCalls) expect({ startDate: c.startDate, endDate: c.endDate }).toEqual(q4);
  });

  it("a period Search Console covers has no gscPartial and no gscRange (unchanged reports)", async () => {
    const r = await runTemplate(client, { homeDir: home(), today, year: "2026", template: "y", store: false }, deps());
    expect(r.gscPartial).toBeUndefined();
    expect("gscPartial" in r).toBe(false);
    for (const s of r.sections) expect("gscRange" in s).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ Y0b.5

const v: BuildOptions = { version: "0.5.0" };
const plain = (t: Text) => t.map((r) => r.t).join("");
const charts = (blocks: Block[]): Chart[] => blocks.flatMap((b) => (b.kind === "chart" ? [b.chart] : b.kind === "columns" ? charts(b.columns.flat()) : []));
const xmlText = (xml: string) => [...xml.matchAll(/<(?:w|a):t(?: [^>]*)?>([^<]*)<\/(?:w|a):t>/g)].map((m) => m[1]).join("");
const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
async function docxParts(doc: ReportDoc) {
  const zip = await JSZip.loadAsync(await toDocx(doc));
  const document = unxml(xmlText(await zip.file("word/document.xml")!.async("string")));
  const chartParts = await Promise.all(Object.keys(zip.files).filter((f) => /^word\/charts\/chart\d+\.xml$/.test(f)).map((f) => zip.file(f)!.async("string")));
  return { document, charts: chartParts.map((x) => unxml(xmlText(x))) };
}
async function pptxSlides(doc: ReportDoc) {
  const zip = await JSZip.loadAsync((await toPptx(doc)).data);
  const names = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  return Promise.all(names.map(async (f) => unxml(xmlText(await zip.file(f)!.async("string")))));
}

/** The rendered Search Console sections of the partial report (channels is GA4). */
const RENDERED = ["search", "page-types", "pages", "content-years", "wins"];
/** Text that may say 2025: the label itself, and month rows of the by-month tables ("Jul 2025"). */
const allowed2025 = (s: string) => s.replace(/Jul–Dec 2025/g, "").replace(/\b(?:Jul|Aug|Sep|Oct|Nov|Dec) 2025\b/g, "");
/** The partial report with only Search Console sections, and no "2025" publish-year row (a row value, not a period). */
const scOnly = (r: TemplateReport): TemplateReport => {
  const sections = r.sections
    .filter((s) => s.gscRange)
    .map((s): SectionResult => (s.id === "content-years" && s.status === "ok" ? { ...s, data: { ...CONTENT_BY_YEAR, rows: CONTENT_BY_YEAR.rows.filter((x) => x.year !== "2025") } } : s));
  return { ...r, sections, highlights: computeHighlights({ sections, period: r.period }) };
};

describe("rendering the partial year (Y0b.5)", () => {
  const doc = buildReportDoc(partialYearReport(), v);

  it("every affected section opens with the exact Source note; GA4 doesn't", () => {
    expect(SOURCE).toBe("Source: Search Console, Jul–Dec 2025 only (Google keeps 16 months, and earlier months weren't saved). Not compared with an earlier period.");
    for (const id of RENDERED) {
      const s = doc.sections.find((x) => x.id === id)!;
      expect(s.blocks[0], id).toEqual({ kind: "note", text: [{ t: SOURCE }] });
      // Said once per section.
      expect(s.blocks.filter((b) => b.kind === "note" && plain(b.text) === SOURCE)).toHaveLength(1);
    }
    expect(doc.sections.find((x) => x.id === "channels")!.blocks.some((b) => b.kind === "note" && plain(b.text).startsWith("Source: Search Console"))).toBe(false);
  });

  it("key figures: no delta, the label as detail; the KPI caption is exact", () => {
    expect(doc.kpis).toEqual([
      { label: "Clicks", value: "560", detail: "Jul–Dec 2025 only" },
      { label: "Impressions", value: "10,000", detail: "Jul–Dec 2025 only" },
      { label: "CTR", value: "5.60%", detail: "Jul–Dec 2025 only" },
      { label: "Average position", value: "8.2", detail: "Jul–Dec 2025 only · lower is better" },
    ]);
    expect(doc.kpiCaption).toBe("Search Console figures: Jul–Dec 2025 only (Google keeps 16 months); no comparison.");
  });

  it("search charts (monthly, the range is over 100 days): titles end with the label, one series, the summary names the label; no comparison note", () => {
    const search = doc.sections.find((x) => x.id === "search")!;
    const lines = charts(search.blocks).filter((c) => c.type === "line");
    expect(lines.map((c) => c.title)).toEqual(["Clicks per month, Jul–Dec 2025", "Impressions per month, Jul–Dec 2025"]);
    for (const c of lines) {
      expect(c.type === "line" && c.series.map((x) => x.name)).toEqual(["Jul–Dec 2025"]);
      expect(c.type === "line" && c.x).toEqual(["Jul 2025", "Aug 2025", "Sep 2025", "Oct 2025", "Nov 2025", "Dec 2025"]);
      expect(c.summary).toMatch(/^[\d,]+ (clicks|impressions) in Jul–Dec 2025\.$/);
      expect(c.fallback?.header).toEqual(["Month", "Jul–Dec 2025"]);
    }
    const table = search.blocks.find((b) => b.kind === "table");
    expect(table?.kind === "table" && table.header).toEqual(["Metric", "Jul–Dec 2025"]);
    expect(doc.about.map(plain).some((a) => a.includes("so that comparison is left out"))).toBe(false);
  });

  it("page types: one share row named by the label; wins: the Search Console goals note, the GA4 goal tile", () => {
    const pt = charts(doc.sections.find((x) => x.id === "page-types")!.blocks)[0]!;
    expect(pt.type === "share" && pt.rows.map((r) => r.label)).toEqual(["Jul–Dec 2025"]);
    const wins = doc.sections.find((x) => x.id === "wins")!;
    expect(wins.blocks.map((b) => b.kind)).toEqual(["note", "kpiRow", "note"]);
    expect(plain((wins.blocks[2] as Extract<Block, { kind: "note" }>).text)).toBe(partialGoalsNote("Jul–Dec 2025"));
    expect(partialGoalsNote("Jul–Dec 2025")).toBe("Search Console goals are left out: Search Console covers only Jul–Dec 2025 of this period.");
    const k = wins.blocks[1]!;
    expect(k.kind === "kpiRow" && k.items).toEqual([{ label: "Sessions", value: "1,500", detail: "target 2,000 · 75% of target", tone: "bad" }]);
    // A GA4 goal skipped for another reason is still named in the generic line, not mixed into the Search Console note.
    const both = partialYearReport();
    both.sections = both.sections.map((s): SectionResult => (s.id === "wins" && s.status === "ok" ? { ...s, data: { ...(s.data as WinsMissesData), skippedGoals: ["Search clicks", "keyEvents"] } } : s));
    const notes = buildReportDoc(both, v).sections.find((x) => x.id === "wins")!.blocks.flatMap((b) => (b.kind === "note" ? [plain(b.text)] : []));
    expect(notes).toEqual([SOURCE, "Goals not checked (their data isn't in this report): keyEvents.", partialGoalsNote("Jul–Dec 2025")]);
  });

  it("About has the report note once, page movers among the sections left out, and the period line unchanged", () => {
    const about = doc.about.map(plain);
    expect(about.filter((a) => a === PARTIAL_NOTE)).toHaveLength(1);
    expect(about).toContain("Not included this time (no data for this period): Page movers.");
    expect(about[0]).toBe("Period: 2025 (1 Jan – 31 Dec 2025), compared with 2024 (1 Jan – 31 Dec 2024, the same period a year earlier).");
    expect(doc.meta.periodLabel).toBe("2025");
  });

  it("Markdown and HTML snapshots", async () => {
    await expect(toMarkdown(doc)).toMatchFileSnapshot("fixtures/reports/__snapshots__/yearly/partial.md");
    await expect(toHtml(doc)).toMatchFileSnapshot("fixtures/reports/__snapshots__/yearly/partial.html");
  });

  it("no Search Console header, title, tile, note or highlight says 2025 alone (doc level)", () => {
    const d = buildReportDoc(scOnly(partialYearReport()), v);
    const texts: string[] = [d.kpiCaption ?? "", ...d.kpis.flatMap((k) => [k.label, k.detail ?? ""]), ...(d.summary?.items ?? []).map(plain)];
    const walk = (blocks: Block[]) => {
      for (const b of blocks) {
        if (b.kind === "note" || b.kind === "paragraph") texts.push(plain(b.text));
        if (b.kind === "table") texts.push(b.title ?? "", ...b.header);
        if (b.kind === "kpiRow") for (const k of b.items) texts.push(k.label, k.detail ?? "");
        if (b.kind === "columns") b.columns.forEach(walk);
        if (b.kind === "chart") {
          const c = b.chart;
          texts.push(c.title, c.summary, ...(c.type === "share" ? [...c.parts, ...c.rows.map((r) => r.label)] : c.type === "line" ? c.series.map((s) => s.name) : []), ...(c.fallback ? [c.fallback.title ?? "", ...c.fallback.header] : []));
        }
      }
    };
    for (const s of d.sections) walk(s.blocks);
    for (const t of texts) expect(allowed2025(t), t).not.toMatch(/\b2025\b/);
  });

  for (const theme of THEME_IDS) {
    it(`${theme}: the Source note, tiles, caption and chart titles in Markdown, HTML, DOCX and PPTX; no 2025 alone`, async () => {
      const d = buildReportDoc(scOnly(partialYearReport()), { ...v, theme });
      const md = toMarkdown(d);
      const html = toHtml(d);
      const docx = await docxParts(d);
      const slides = await pptxSlides(d);
      const deck = buildDeck(d);

      // The Source note: once per rendered section in each file, and a footnote on each section's first slide.
      const count = (s: string) => s.split(SOURCE).length - 1;
      expect(count(md)).toBe(RENDERED.length);
      expect(count(html.replace(/&#39;|&#x27;|&apos;/g, "'"))).toBe(RENDERED.length);
      expect(count(docx.document)).toBe(RENDERED.length);
      for (const id of RENDERED) {
        const first = deck.slides.find((s) => s.kind === "section" && s.sectionId === id && !s.continued);
        expect(first && first.kind === "section" && first.footnotes, id).toContain(SOURCE);
      }
      expect(slides.filter((s) => s.includes(SOURCE))).toHaveLength(RENDERED.length);

      // Tiles and caption.
      const kpis = deck.slides.find((s) => s.kind === "kpis");
      expect(kpis && kpis.kind === "kpis" && kpis.kpis.map((k) => [k.detail, k.delta])).toEqual([
        ["Jul–Dec 2025 only", undefined],
        ["Jul–Dec 2025 only", undefined],
        ["Jul–Dec 2025 only", undefined],
        ["Jul–Dec 2025 only · lower is better", undefined],
      ]);
      const caption = "Search Console figures: Jul–Dec 2025 only (Google keeps 16 months); no comparison.";
      for (const text of [md, html, docx.document, slides.join("\n")]) {
        expect(text).toContain("Jul–Dec 2025 only");
        expect(text).toContain(caption);
      }

      // Chart titles: HTML (title / aria-label), the Word chart part, the deck's chart caption.
      expect(html).toContain("Clicks per month, Jul–Dec 2025");
      expect(docx.charts.join("\n") + docx.document).toContain("Clicks per month, Jul–Dec 2025");
      expect(slides.join("\n")).toContain("Clicks per month, Jul–Dec 2025");

      // No Search Console figure is labelled 2025 alone: every 2025 left is the label or a month row.
      const sectionText = (text: string, from: string) => text.slice(text.indexOf(from));
      for (const text of [sectionText(md, "Search performance"), sectionText(html, "Search performance"), sectionText(docx.document, "Search performance"), ...slides.slice(1)]) {
        const rest = allowed2025(text.replace(/About this report[\s\S]*$/, ""));
        expect(rest.match(/.{0,40}\b2025\b.{0,40}/g) ?? []).toEqual([]);
      }
    });
  }
});
