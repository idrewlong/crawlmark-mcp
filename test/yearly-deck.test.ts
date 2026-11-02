/**
 * 0.5.0 Y3.3: the deck plan for the yearly report. The new sections use only existing blocks, ordered so the
 * block-generic deck (first chart, first table, first KPI row; six columns) shows the right thing. Two deck rules were
 * added for them (deck.ts): a share chart with a table of more than three rows puts the table on a continuation slide
 * (under a share chart the drawn table kept only two or three rows), and a table's bold "Total" row is kept when rows
 * are cut. Fixture data only (example.com).
 */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildDeck, DECK, type DeckSlide } from "../src/reports/render/deck.js";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toPptx } from "../src/reports/render/pptx/index.js";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import { yearlyReport } from "./fixtures/reports/yearly-data.js";

type SectionSlide = Extract<DeckSlide, { kind: "section" }>;
const narrative = { summary: "Clicks grew a third. Sessions followed.", sections: { channels: "Search led the growth. Direct traffic followed.\n\n- Paid search held its share" } };

function deck(withNarrative = false) {
  return buildDeck(buildReportDoc(yearlyReport(), { version: "0.5.0", ...(withNarrative ? { narrative } : {}) }));
}
const slidesOf = (slides: DeckSlide[], id: string) => slides.filter((s): s is SectionSlide => s.kind === "section" && s.sectionId === id);

describe("yearly deck", () => {
  const d = deck();

  it("one section slide per new section, in report order, within the slide cap", () => {
    for (const id of ["channels", "page-types", "content-years", "wins"]) expect(slidesOf(d.slides, id).filter((s) => !s.continued)).toHaveLength(1);
    expect(d.slides.length).toBeLessThanOrEqual(DECK.maxSlides);
    expect(d.warnings).toEqual([]);
    const order = d.slides.flatMap((s) => (s.kind === "section" && !s.continued ? [s.sectionId] : []));
    expect(order).toEqual(["search", "channels", "page-types", "pages", "page-movers", "content-years", "wins"]);
  });

  it("channels: the share chart alone, then the table on a continuation slide that keeps Change and the Total row", () => {
    const [s, c] = slidesOf(d.slides, "channels");
    expect(s!.chart?.type).toBe("share");
    expect(s!.chart?.title).toBe("Sessions by channel");
    expect(s!.table).toBeUndefined();
    expect(s!.takeaway).toBe("Organic Search brought 40.4% of sessions in 2025 (39.6% in 2024).");
    expect(c!.continued).toBe(true);
    expect(c!.table?.header).toEqual(["Channel", "Sessions", "2024", "Change", "Users", "Key events"]);
    expect(c!.table!.header.length).toBeLessThanOrEqual(DECK.maxTableCols);
    expect(c!.table!.tones?.[0]?.[3]).toBe("good");
    // 8 channels and the Total: the 7 biggest channels and the Total fit; the Total is never the row that's cut.
    expect(c!.table!.rows.map((r) => r[0])).toEqual(["Organic Search", "Direct", "Paid Search", "Referral", "Organic Social", "Email", "Unassigned", "Total"]);
    expect(c!.footnotes).toEqual(["Top 7 of 8 rows and the total; the full table is in the report."]);
  });

  it("channels with commentary: the chart beside the bullets, the table (with its Total) on a continuation slide", () => {
    const c = slidesOf(deck(true).slides, "channels");
    expect(c).toHaveLength(2);
    expect(c[0]!.chart?.type).toBe("share");
    expect(c[0]!.takeaway).toBe("Search led the growth.");
    expect(c[1]!.continued).toBe(true);
    expect(c[1]!.table?.header).toContain("Change");
    expect(c[1]!.table?.shown).toBe(DECK.maxTableRows);
    expect(c[1]!.table?.rows.at(-1)?.[0]).toBe("Total");
  });

  it("page types: the share chart, then every page type on a continuation slide with Change in the first six columns", () => {
    const [s, c] = slidesOf(d.slides, "page-types");
    expect(s!.chart?.type).toBe("share");
    expect(s!.table).toBeUndefined();
    expect(c!.continued).toBe(true);
    expect(c!.table?.header).toEqual(["Page type", "Clicks", "2024", "Change", "Share of clicks", "Impressions"]);
    expect(c!.table?.shown).toBe(5);
    expect(c!.footnotes).toEqual([]);
  });

  it("the drawn deck shows every page type and the channels Total (the writer doesn't have to cut the tables)", async () => {
    const zip = await JSZip.loadAsync((await toPptx(buildReportDoc(yearlyReport(), { version: "0.5.0" }))).data);
    const names = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    const slides = await Promise.all(names.map((f) => zip.file(f)!.async("string")));
    const tableOn = (title: string) => slides.find((x) => x.includes(`>${title}<`) && x.includes("<a:tbl>"));
    const pages = tableOn("Search clicks by page type")!;
    expect(pages.match(/<a:tr /g)).toHaveLength(1 + 5);
    expect(pages).not.toMatch(/Top \d+ of \d+ rows/);
    const channels = tableOn("Traffic by channel, year over year")!;
    expect(channels.match(/<a:tr /g)).toHaveLength(1 + 8);
    expect(channels).toContain(">Total<");
  });

  it("content by publish year: a table slide with every year", () => {
    const [s] = slidesOf(d.slides, "content-years");
    expect(s!.chart).toBeUndefined();
    expect(s!.table?.header).toEqual(["Published", "Pages", "Clicks", "Share of clicks", "Clicks per page", "Impressions"]);
    expect(s!.table?.rows.map((r) => r[0])).toEqual(["2025", "2024", "2023", "2022 and earlier", "Unknown"]);
    expect(s!.table?.bar?.col).toBe(2);
  });

  it("wins and misses: the table with Win/Miss tones and the goal tiles beside it", () => {
    const [s] = slidesOf(d.slides, "wins");
    expect(s!.table?.header).toEqual(["Result", "What changed", "Now", "Before"]);
    expect(s!.table?.tones?.map((r) => r[0])).toEqual(["good", "good", "good", "good", "bad"]);
    expect(s!.tiles?.map((k) => [k.label, k.tone])).toEqual([
      ["Search clicks", "good"],
      ["Sessions", "bad"],
    ]);
    expect(s!.footnotes).toEqual(["Top 5 of 7 rows; the full table is in the report."]);
  });

  it("builds in every theme", () => {
    for (const theme of THEME_IDS) {
      const t = buildDeck(buildReportDoc(yearlyReport(), { version: "0.5.0", theme }));
      expect(t.slides.length).toBe(d.slides.length);
    }
  });
});
