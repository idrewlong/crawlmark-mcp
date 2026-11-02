/**
 * 0.5.0 Y3: the four yearly sections (channel_yoy, page_groups, content_by_year, wins_misses) rendered from the Y0
 * fixture in every format and theme, plus the long-period "by month" fallback tables. Fixture data only (example.com).
 */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildReportDoc, type Block, type BuildOptions, type Chart, type ReportDoc, type TableBlock, type Text } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { toHtml } from "../src/reports/render/html.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import { toPptx } from "../src/reports/render/pptx/index.js";
import { fmtInt, MAX_SHARE_PARTS, PAGE_FILTER_NOTE, WINS_RULES_NOTE } from "../src/reports/render/sections.js";
import { latestLabel } from "../src/reports/render/pptx/slides.js";
import type { ChannelYoyData, ContentByYearData, PageGroupsData, SearchOverviewData, SectionResult, TemplateReport, WinsMissesData } from "../src/reports/report-types.js";
import { SECTION_TITLES, THEME_IDS } from "../src/reports/templates/schema.js";
import { XSS } from "./fixtures/reports/release-b-render.js";
import { fixtureReport } from "./fixtures/reports/report.js";
import { CHANNEL_YOY, channelRow, CONTENT_BY_YEAR, PAGE_GROUPS, WINS_MISSES, yearlyReport } from "./fixtures/reports/yearly-data.js";

const v: BuildOptions = { version: "0.5.0" };
const NEW_IDS = ["channels", "page-types", "content-years", "wins"] as const;
const NEW_TITLES = [SECTION_TITLES.channel_yoy, SECTION_TITLES.page_groups, SECTION_TITLES.content_by_year, SECTION_TITLES.wins_misses];

const plain = (t: Text) => t.map((r) => r.t).join("");
const section = (doc: ReportDoc, id: string) => {
  const s = doc.sections.find((x) => x.id === id);
  if (!s) throw new Error(`no section ${id}`);
  return s;
};
const charts = (blocks: Block[]): Chart[] => blocks.flatMap((b) => (b.kind === "chart" ? [b.chart] : b.kind === "columns" ? charts(b.columns.flat()) : []));
const tables = (blocks: Block[]): TableBlock[] => blocks.flatMap((b) => (b.kind === "table" ? [b] : b.kind === "columns" ? tables(b.columns.flat()) : []));
const notes = (blocks: Block[]) => blocks.flatMap((b) => (b.kind === "note" ? [plain(b.text)] : []));

/** The yearly report with one section's data replaced. */
function withData(id: string, data: unknown, over: Partial<TemplateReport> = {}): TemplateReport {
  const r = yearlyReport(over);
  r.sections = r.sections.map((s): SectionResult => (s.id === id && s.status === "ok" ? { ...s, data } : s));
  return r;
}
/** Only the four new sections (for checks over a whole rendered file). */
const onlyNew = (r: TemplateReport): TemplateReport => ({ ...r, sections: r.sections.filter((s) => (NEW_IDS as readonly string[]).includes(s.id)), highlights: [] });

async function docxXml(doc: ReportDoc) {
  const zip = await JSZip.loadAsync(await toDocx(doc));
  const document = await zip.file("word/document.xml")!.async("string");
  const chartParts = await Promise.all(Object.keys(zip.files).filter((f) => /^word\/charts\/chart\d+\.xml$/.test(f)).map((f) => zip.file(f)!.async("string")));
  return { document, chartParts };
}
async function pptxSlides(doc: ReportDoc) {
  const zip = await JSZip.loadAsync((await toPptx(doc)).data);
  const names = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  return Promise.all(names.map((f) => zip.file(f)!.async("string")));
}
/** XML text with runs joined (a title may be split across runs). */
const xmlText = (xml: string) => [...xml.matchAll(/<(?:w|a):t(?: [^>]*)?>([^<]*)<\/(?:w|a):t>/g)].map((m) => m[1]).join("");
const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe("yearly sections: block mapping (C6)", () => {
  const doc = buildReportDoc(yearlyReport(), v);

  it("channels: a share chart first (previous year, then this year), then the table, no deck-hostile extras", () => {
    const s = section(doc, "channels");
    expect(s.blocks.map((b) => b.kind)).toEqual(["chart", "table"]);
    const c = charts(s.blocks)[0]!;
    expect(c.type).toBe("share");
    if (c.type !== "share") return;
    expect(c.title).toBe("Sessions by channel");
    expect(c.rows.map((r) => r.label)).toEqual(["2024", "2025"]);
    // 8 channels: the top 6 by sessions, then the rest summed.
    expect(c.parts).toEqual(["Organic Search", "Direct", "Paid Search", "Referral", "Organic Social", "Email", "Other channels"]);
    expect(c.rows[1]!.values.at(-1)).toBe(40); // Unassigned 40 + Affiliates 0
    expect(c.rows[0]!.values.at(-1)).toBe(90); // Unassigned 30 + Affiliates 60
    expect(c.summary).toBe("Organic Search brought 40.4% of sessions in 2025 (39.6% in 2024).");
  });

  it("channels: table header, toned Change, a bold Total row", () => {
    const t = tables(section(doc, "channels").blocks)[0]!;
    expect(t.header).toEqual(["Channel", "Sessions", "2024", "Change", "Users", "Key events", "Engagement rate"]);
    expect(t.rows).toHaveLength(CHANNEL_YOY.rows.length + 1);
    expect(t.rows[0]![3]).toEqual([{ t: "+33.3%", tone: "good" }]);
    const affiliates = t.rows.find((r) => plain(r[0]!) === "Affiliates")!;
    expect(affiliates[3]).toEqual([{ t: "−100.0%", tone: "bad" }]);
    const total = t.rows.at(-1)!;
    expect(plain(total[0]!)).toBe("Total");
    expect(total.every((c) => c.every((r) => r.b === true))).toBe(true);
    expect(total[3]![0]!.tone).toBe("good");
  });

  it("channels: the users metric leads the table and the chart; previousEmpty drops last year with the note", () => {
    const users = buildReportDoc(withData("channels", { ...CHANNEL_YOY, metric: "users" } satisfies ChannelYoyData), v);
    const s = section(users, "channels");
    expect(charts(s.blocks)[0]!.title).toBe("Users by channel");
    expect(tables(s.blocks)[0]!.header).toEqual(["Channel", "Users", "2024", "Change", "Sessions", "Key events", "Engagement rate"]);

    const rows = CHANNEL_YOY.rows.map((r) => channelRow(r.channel, { sessions: r.sessions, users: r.users, keyEvents: r.keyEvents, engagedSessions: r.sessions / 2 }, { sessions: 0, users: 0, keyEvents: 0 }));
    const empty: ChannelYoyData = { ...CHANNEL_YOY, rows, totals: channelRow("Total", { sessions: 3710, users: 3148, keyEvents: 111, engagedSessions: 1855 }, { sessions: 0, users: 0, keyEvents: 0 }), previousEmpty: true };
    const e = section(buildReportDoc(withData("channels", empty), v), "channels");
    const c = charts(e.blocks)[0]!;
    expect(c.type === "share" && c.rows.map((r) => r.label)).toEqual(["2025"]);
    expect(tables(e.blocks)[0]!.header).toEqual(["Channel", "Sessions", "Users", "Key events", "Engagement rate"]);
    expect(notes(e.blocks)).toEqual(["Google Analytics has no data for 2024 (the property may be newer than that)."]);
  });

  it("channels: a channel new this year says new; no rows leaves the section out", () => {
    const fresh = channelRow("Video", { sessions: 50, users: 40, keyEvents: 1, engagedSessions: 25 }, null);
    const r = section(buildReportDoc(withData("channels", { ...CHANNEL_YOY, rows: [...CHANNEL_YOY.rows, fresh] }), v), "channels");
    const row = tables(r.blocks)[0]!.rows.find((x) => plain(x[0]!) === "Video")!;
    expect(plain(row[2]!)).toBe("0");
    expect(plain(row[3]!)).toBe("new");
    const none = buildReportDoc(withData("channels", { ...CHANNEL_YOY, rows: [], totals: channelRow("Total", { sessions: 0, users: 0, engagedSessions: 0, keyEvents: 0 }, null) }), v);
    expect(none.sections.some((x) => x.id === "channels")).toBe(false);
    expect(none.about.map(plain).join("\n")).toContain("Not included this time (no data for this period): Traffic by channel, year over year.");
  });

  it("page types: share chart (last year, then this year, as the channels), table with bar on Clicks, the page-filter note", () => {
    const s = section(doc, "page-types");
    expect(s.blocks.map((b) => b.kind)).toEqual(["chart", "table", "note"]);
    const c = charts(s.blocks)[0]!;
    expect(c.type === "share" && c.rows.map((r) => r.label)).toEqual(["2024", "2025"]);
    // Locations has no clicks either year: left out of the chart, kept in the table.
    expect(c.type === "share" && c.parts).toEqual(["Home", "Blog", "Services", "Other"]);
    const t = tables(s.blocks)[0]!;
    expect(t.header).toEqual(["Page type", "Clicks", "2024", "Change", "Share of clicks", "Impressions", "CTR", "Avg. position"]);
    expect(t.rows.map((r) => plain(r[0]!))).toEqual(["Home", "Blog", "Services", "Locations", "Other"]);
    expect(t.bar).toEqual({ col: 1, values: [420, 110, 200, 0, 40] });
    expect(t.rows[0]![3]).toEqual([{ t: "+33.3%", tone: "good" }]);
    expect(notes(s.blocks)).toEqual([PAGE_FILTER_NOTE]);
  });

  it("page types: more than 7 groups fold into 'Other page types' (with 'Other'); no comparison drops the columns; stored history adds its note", () => {
    const row = (name: string, clicks: number) => ({ ...PAGE_GROUPS.rows[0]!, name, clicks, impressions: clicks * 10, share: 0 });
    const many: PageGroupsData = { ...PAGE_GROUPS, rows: ["A", "B", "C", "D", "E", "F", "G", "H"].map((n, i) => row(n, 100 - i * 10)).concat(row("Other", 500)) };
    const c = charts(section(buildReportDoc(withData("page-types", many), v), "page-types").blocks)[0]!;
    expect(c.type === "share" && c.parts).toEqual(["A", "B", "C", "D", "E", "F", "Other page types"]);
    expect(c.type === "share" && c.rows[1]!.values.at(-1)).toBe(40 + 30 + 500); // G, H and the "Other" row, this year

    const solo: PageGroupsData = { ...PAGE_GROUPS, comparedWith: null, method: "stored_top_pages", rows: PAGE_GROUPS.rows.map((r) => ({ ...r, previous: null, change: null })), unattributed: { clicks: 230, impressions: 1000 } };
    const s = section(buildReportDoc(withData("page-types", solo), v), "page-types");
    expect(tables(s.blocks)[0]!.header).toEqual(["Page type", "Clicks", "Share of clicks", "Impressions", "CTR", "Avg. position"]);
    const sc = charts(s.blocks)[0]!;
    expect(sc.type === "share" && sc.rows.map((r) => r.label)).toEqual(["2025"]);
    expect(notes(s.blocks)).toEqual([PAGE_FILTER_NOTE, "From saved monthly history, which keeps each month's top 250 pages; 23.0% of clicks couldn't be assigned to a page type."]);
  });

  it("content by publish year: the table first (bar on Clicks), the sources note, the stale note", () => {
    const s = section(doc, "content-years");
    const t = tables(s.blocks)[0]!;
    expect(s.blocks[0]).toBe(t);
    expect(t.header).toEqual(["Published", "Pages", "Clicks", "Share of clicks", "Clicks per page", "Impressions"]);
    expect(t.rows.map((r) => plain(r[0]!))).toEqual(["2025", "2024", "2023", "2022 and earlier", "Unknown"]);
    expect(t.bar?.col).toBe(2);
    expect(notes(s.blocks)).toEqual(["From the newest saved crawl (11 Oct 2026): publish dates from structured data (9), page meta tags (3) and addresses (3); 5 pages have no date."]);
    const stale = section(buildReportDoc(withData("content-years", { ...CONTENT_BY_YEAR, staleDays: 120, sources: { ...CONTENT_BY_YEAR.sources, none: 1 } } satisfies ContentByYearData), v), "content-years");
    expect(notes(stale.blocks)).toContain("That crawl is 120 days old.");
    expect(notes(stale.blocks)[0]).toMatch(/; 1 page has no date\.$/);
    expect(buildReportDoc(withData("content-years", { ...CONTENT_BY_YEAR, rows: [] }), v).sections.some((x) => x.id === "content-years")).toBe(false);
  });

  it("wins and misses: goal tiles with tones, a Win/Miss table (wins first), the rules line", () => {
    const s = section(doc, "wins");
    expect(s.blocks.map((b) => b.kind)).toEqual(["kpiRow", "table", "note"]);
    const k = s.blocks[0]!;
    expect(k.kind === "kpiRow" && k.items).toEqual([
      { label: "Search clicks", value: "1,120", detail: "target 1,000 · met", tone: "good" },
      { label: "Sessions", value: "1,500", detail: "target 2,000 · 75% of target", tone: "bad" },
    ]);
    const t = tables(s.blocks)[0]!;
    expect(t.header).toEqual(["Result", "What changed", "Now", "Before"]);
    expect(t.rows.map((r) => r[0])).toEqual([...WINS_MISSES.wins.map(() => [{ t: "Win", tag: "good" }]), ...WINS_MISSES.misses.map(() => [{ t: "Miss", tag: "bad" }])]);
    // URLs in the rule text become page paths on the client's own site (data, never links).
    expect(t.rows[1]![1]).toEqual([{ t: "/" }, { t: " gained 105 clicks" }]);
    expect(t.rows[5]![1]).toEqual([{ t: "/old-offer" }, { t: " lost its 45 clicks" }]);
    expect(plain(t.rows[2]![3]!)).toBe("0");
    expect(plain(t.rows[3]![2]!)).toBe("2.4");
    expect(notes(s.blocks)).toEqual([WINS_RULES_NOTE]);
  });

  it("wins and misses: nothing passed, skipped goals, goals only, and nothing at all", () => {
    const quiet = section(buildReportDoc(withData("wins", { ...WINS_MISSES, goals: [], wins: [], misses: [], skippedGoals: ["Key events"] } satisfies WinsMissesData), v), "wins");
    expect(quiet.blocks.map((b) => b.kind)).toEqual(["paragraph", "note", "note"]);
    expect(quiet.blocks[0]!.kind === "paragraph" && plain(quiet.blocks[0]!.text)).toBe("No change passed the thresholds this time.");
    expect(notes(quiet.blocks)).toEqual(["Goals not checked (their data isn't in this report): Key events.", WINS_RULES_NOTE]);

    const goalsOnly = section(buildReportDoc(withData("wins", { ...WINS_MISSES, comparedWith: null, wins: [], misses: [] }), v), "wins");
    expect(goalsOnly.blocks.map((b) => b.kind)).toEqual(["kpiRow"]);

    const nothing = buildReportDoc(withData("wins", { comparedWith: null, goals: [], wins: [], misses: [], skippedGoals: [] } satisfies WinsMissesData), v);
    expect(nothing.sections.some((x) => x.id === "wins")).toBe(false);
  });

  it("every share chart in the report has at most 7 parts and one value per part in each row", () => {
    const all = doc.sections.flatMap((s) => charts(s.blocks)).filter((c) => c.type === "share");
    expect(all).toHaveLength(2);
    for (const c of all) {
      if (c.type !== "share") continue;
      expect(c.parts.length).toBeLessThanOrEqual(MAX_SHARE_PARTS);
      for (const r of c.rows) expect(r.values).toHaveLength(c.parts.length);
    }
  });

  it("About this report has one line per yearly section, and a run note a section already prints isn't repeated", () => {
    const about = doc.about.map(plain);
    expect(about).toContain("Traffic by channel: Google Analytics 4, all sessions on the site's own hostnames (not only search), in GA4's default channel groups, compared with the same dates a year earlier.");
    expect(about).toContain('Search clicks by page type: Search Console, filtered by page address; each page counts in the first matching type, and the rest is "Other".');
    expect(about).toContain("Content by publish year: publish dates from each page's structured data, article meta tags or a year in its address, read from the newest saved site crawl; modification dates are never used.");
    expect(about).toContain("Wins and misses: fixed thresholds, listed in that section.");
    const noted = buildReportDoc(yearlyReport({ notes: [PAGE_FILTER_NOTE, "Another run note."] }), v).about.map(plain);
    expect(noted).not.toContain(PAGE_FILTER_NOTE);
    expect(noted).toContain("Another run note.");
  });

  it("a report without the new sections gets none of their About lines", async () => {
    const about = buildReportDoc(await fixtureReport(), v).about.map(plain).join("\n");
    expect(about).not.toMatch(/^(Traffic by channel|Search clicks by page type|Content by publish year|Wins and misses):/m);
  });
});

describe("yearly sections: snapshots (cards)", () => {
  const doc = () => buildReportDoc(yearlyReport(), v);
  it("Markdown", async () => {
    await expect(toMarkdown(doc())).toMatchFileSnapshot("fixtures/reports/__snapshots__/yearly/yearly.md");
  });
  it("HTML", async () => {
    await expect(toHtml(doc())).toMatchFileSnapshot("fixtures/reports/__snapshots__/yearly/yearly.html");
  });
});

describe("yearly sections: every format in every theme", () => {
  for (const theme of THEME_IDS) {
    it(`${theme}: HTML, Markdown, DOCX and PPTX render, each new section's title is in each`, async () => {
      const doc = buildReportDoc(yearlyReport(), { ...v, theme });
      const html = toHtml(doc);
      const md = toMarkdown(doc);
      const { document, chartParts } = await docxXml(doc);
      const slides = await pptxSlides(doc);
      const docText = unxml(xmlText(document));
      const slideTexts = slides.map((x) => unxml(xmlText(x)));
      for (const title of NEW_TITLES) {
        expect(html).toContain(title);
        expect(md).toContain(title);
        expect(docText).toContain(title);
        expect(slideTexts.some((x) => x.includes(title))).toBe(true);
      }
      // The two share charts are native percent-stacked Word charts.
      expect(chartParts.filter((x) => x.includes('c:grouping val="percentStacked"')).length).toBeGreaterThanOrEqual(2);
    });
  }
});

describe("yearly sections: white label and escaping", () => {
  it("hideCrawlmark: no product, assistant, vendor or tool names in the new sections in any format", async () => {
    const doc = buildReportDoc(onlyNew(yearlyReport()), { ...v, branding: { hideCrawlmark: true } });
    const banned = /crawlmark|claude|dataforseo|ga4_report|gsc_query/i;
    expect(toMarkdown(doc)).not.toMatch(banned);
    expect(toHtml(doc)).not.toMatch(banned);
    expect(xmlText((await docxXml(doc)).document)).not.toMatch(banned);
    for (const s of await pptxSlides(doc)) expect(xmlText(s)).not.toMatch(banned);
  });

  it("an XSS string as a channel name, a page type and a page URL is inert in HTML and escaped in DOCX and PPTX", async () => {
    const r = yearlyReport();
    const ch = { ...CHANNEL_YOY, rows: CHANNEL_YOY.rows.map((x, i) => (i === 0 ? { ...x, channel: XSS } : x)) };
    const pg = { ...PAGE_GROUPS, rows: PAGE_GROUPS.rows.map((x, i) => (i === 0 ? { ...x, name: XSS } : x)) };
    const wm = { ...WINS_MISSES, wins: WINS_MISSES.wins.map((x, i) => (i === 1 ? { ...x, text: `https://example.com/${XSS} gained 105 clicks` } : x)) };
    r.sections = r.sections.map((s): SectionResult => (s.status !== "ok" ? s : s.id === "channels" ? { ...s, data: ch } : s.id === "page-types" ? { ...s, data: pg } : s.id === "wins" ? { ...s, data: wm } : s));
    const doc = buildReportDoc(r, v);
    const html = toHtml(doc);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(toMarkdown(doc)).not.toMatch(/(?<!\\)<img/);
    const { document } = await docxXml(doc);
    expect(document).not.toContain("<img");
    expect(unxml(xmlText(document))).toContain(XSS);
    const slides = await pptxSlides(doc);
    for (const s of slides) expect(s).not.toContain("<img");
    expect(slides.some((s) => unxml(xmlText(s)).includes(XSS))).toBe(true);
  });
});

describe("long periods: daily series become one point per month, with a table by month (C6, Y0b)", () => {
  const searchCharts = (doc: ReportDoc) => charts(section(doc, "search").blocks).filter((c) => c.type === "line");

  it("a 365-day series gives a monthly chart and 12 monthly rows matched to the same months a year earlier", () => {
    const doc = buildReportDoc(yearlyReport(), v);
    const [clicks, impressions] = searchCharts(doc);
    expect(clicks!.title).toBe("Clicks per month");
    expect(impressions!.title).toBe("Impressions per month");
    const MONTH_NAMES = ["Jan 2025", "Feb 2025", "Mar 2025", "Apr 2025", "May 2025", "Jun 2025", "Jul 2025", "Aug 2025", "Sep 2025", "Oct 2025", "Nov 2025", "Dec 2025"];
    for (const c of [clicks!, impressions!]) {
      if (c.type !== "line") throw new Error("line chart expected");
      // One point per month; the previous year's line is matched by month, the same figures as the table.
      expect(c.x).toEqual(MONTH_NAMES);
      expect(c.series.map((x) => [x.name, x.role])).toEqual([["2025", "current"], ["2024", "previous"]]);
      expect(c.series[0]!.values.map((x) => fmtInt(x))).toEqual(c.fallback!.rows.map((r) => plain(r[1]!)));
      expect(c.series[1]!.values.map((x) => fmtInt(x))).toEqual(c.fallback!.rows.map((r) => plain(r[2]!)));
      expect(c.summary).toMatch(/^(Clicks|Impressions) per month: [\d,]+ (clicks|impressions) in 2025 against [\d,]+ in 2024, from 1 Jan to 31 Dec\.$/);
      const f = c.fallback!;
      expect(f.header).toEqual(["Month", "2025", "2024", "Change"]);
      expect(f.rows).toHaveLength(12);
      expect(f.rows.map((r) => plain(r[0]!))).toEqual(["Jan 2025", "Feb 2025", "Mar 2025", "Apr 2025", "May 2025", "Jun 2025", "Jul 2025", "Aug 2025", "Sep 2025", "Oct 2025", "Nov 2025", "Dec 2025"]);
    }
    expect(clicks!.fallback!.title).toBe("Clicks by month");
    // The months add up to the whole of both years (2024's 29 February included).
    const sum = (col: number) => clicks!.fallback!.rows.reduce((s, r) => s + Number(plain(r[col]!).replace(/,/g, "")), 0);
    const data = yearlyReport().sections.find((s) => s.id === "search")!;
    const daily = (data.status === "ok" ? (data.data as SearchOverviewData) : null)!.daily!;
    expect(sum(1)).toBe(daily.current.reduce((s, p) => s + p.clicks, 0));
    expect(sum(2)).toBe(daily.previous!.reduce((s, p) => s + p.clicks, 0));
  });

  it("partial first and last months say so, and a leap February is compared whole", () => {
    const days = (from: string, to: string, v: number) => {
      const out: { date: string; clicks: number; impressions: number }[] = [];
      for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push({ date: new Date(t).toISOString().slice(0, 10), clicks: v, impressions: v * 10 });
      return out;
    };
    const cur = { startDate: "2025-01-15", endDate: "2025-06-20" };
    const prev = { startDate: "2024-01-15", endDate: "2024-06-20" };
    const r = yearlyReport({ period: { current: cur, label: "15 Jan – 20 Jun 2025", folderMonth: "2025-06", comparisons: { previous_year: prev } } });
    r.sections = r.sections.map((s): SectionResult => (s.id === "search" && s.status === "ok" ? { ...s, data: { ...(s.data as SearchOverviewData), daily: { current: days(cur.startDate, cur.endDate, 1), previous: days(prev.startDate, prev.endDate, 2), comparedWith: "previous_year" } } } : s));
    const chart = searchCharts(buildReportDoc(r, v))[0]!;
    expect(chart.type === "line" && chart.x).toEqual(["Jan 2025 (from 15 Jan)", "Feb 2025", "Mar 2025", "Apr 2025", "May 2025", "Jun 2025 (to 20 Jun)"]);
    expect(chart.type === "line" && chart.series[1]!.values).toEqual([34, 58, 62, 60, 62, 40]);
    const f = chart.fallback!;
    expect(f.rows.map((x) => x.map(plain))).toEqual([
      ["Jan 2025 (from 15 Jan)", "17", "34", "−50.0%"],
      ["Feb 2025", "28", "58", "−51.7%"],
      ["Mar 2025", "31", "62", "−50.0%"],
      ["Apr 2025", "30", "60", "−50.0%"],
      ["May 2025", "31", "62", "−50.0%"],
      ["Jun 2025 (to 20 Jun)", "20", "40", "−50.0%"],
    ]);
  });

  it("the deck caption's latest value is the last month, named by month", () => {
    const c = searchCharts(buildReportDoc(yearlyReport(), v))[0]!;
    expect(latestLabel(c)).toMatch(/^Latest: [\d,]+ \(Dec 2025\)$/);
    expect(latestLabel(c)).toBe(`Latest: ${c.type === "line" ? c.series[0]!.values.at(-1) : ""} (Dec 2025)`);
  });

  it("a 92-day quarter and a 30-day month keep the daily chart and the weekly table", async () => {
    const q = { startDate: "2025-07-01", endDate: "2025-09-30" };
    const days = (from: string, to: string) => {
      const out: { date: string; clicks: number; impressions: number }[] = [];
      for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push({ date: new Date(t).toISOString().slice(0, 10), clicks: 3, impressions: 30 });
      return out;
    };
    const r = yearlyReport({ period: { current: q, label: "Q3 2025", folderMonth: "2025-09", comparisons: {} } });
    r.sections = r.sections.map((s): SectionResult => (s.id === "search" && s.status === "ok" ? { ...s, data: { ...(s.data as SearchOverviewData), daily: { current: days(q.startDate, q.endDate), previous: null, comparedWith: null } } } : s));
    const qc = searchCharts(buildReportDoc(r, v))[0]!;
    expect(qc.title).toBe("Clicks per day");
    expect(qc.type === "line" && qc.x).toHaveLength(92);
    expect(qc.fallback!.title).toBe("Clicks by week");
    const doc = buildReportDoc(await fixtureReport(), v);
    const c = searchCharts(doc)[0]!;
    expect(c.title).toBe("Clicks per day");
    expect(c.fallback!.title).toBe("Clicks by week");
    expect(c.fallback!.header[0]).toBe("Days");
  });
});
