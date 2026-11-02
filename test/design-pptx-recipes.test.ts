/**
 * 0.4.0 deck design pass 2 (docs/research/2026-11-02-deck-design-brief.md): the layout recipes. Content fills the
 * content area, the agenda is a grid or evenly spread columns, the summary is insight cards or rows, the side
 * column lines up with the chart, short tables get in-cell bars and one- or two-row tables become record cards,
 * and the chart caption carries the latest value. Fixture data only (example.com).
 */
import { describe, expect, it } from "vitest";
import type { DeckSlide } from "../src/reports/render/deck.js";
import type { LineChart } from "../src/reports/render/doc.js";
import { renderDeck } from "../src/reports/render/pptx/index.js";
import { SLIDE } from "../src/reports/render/pptx/master.js";
import { axisNumber, contentArea, latestLabel } from "../src/reports/render/pptx/slides.js";
import { deckTheme } from "../src/reports/render/themes/deck-themes.js";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import { fixtureDeck, styleFor, text, unzip } from "./fixtures/pptx/decks.js";

interface Shape {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  xml: string;
}

const EMU = 914_400;
/** Every shape, picture and frame on a slide with its name and box (inches). */
function shapes(xml: string): Shape[] {
  return [...xml.matchAll(/<p:(sp|graphicFrame|pic)>.*?<\/p:\1>/g)].flatMap((m) => {
    const name = /<p:cNvPr id="\d+" name="([^"]*)"/.exec(m[0])?.[1];
    const b = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(m[0]);
    if (!name || !b) return [];
    return [{ name, x: +b[1]! / EMU, y: +b[2]! / EMU, w: +b[3]! / EMU, h: +b[4]! / EMU, xml: m[0] }];
  });
}
const named = (all: Shape[], name: string | RegExp) => all.filter((s) => (typeof name === "string" ? s.name === name : name.test(s.name)));
const one = (all: Shape[], name: string) => {
  const s = named(all, name);
  expect(s, name).toHaveLength(1);
  return s[0]!;
};

/** Frame and furniture, not content: the title, takeaway, source line, footer and bold's edge block. */
const FURNITURE = /^(Title|Title pill|Takeaway|Source line|Footer|Slide Number|Edge block)$/;

async function slideXml(deck: { slides: DeckSlide[] }, theme: (typeof THEME_IDS)[number], index: number): Promise<string> {
  const zip = await unzip(await renderDeck(deck as ReturnType<typeof fixtureDeck>, styleFor(theme)));
  return text(zip, `ppt/slides/slide${index + 1}.xml`);
}

describe("fill: every body slide's content fills 60–100% of the content area and stays inside it", () => {
  for (const id of THEME_IDS) {
    it(id, async () => {
      const deck = fixtureDeck();
      const zip = await unzip(await renderDeck(deck, styleFor(id)));
      for (const [i, s] of deck.slides.entries()) {
        if (s.kind === "title" || s.kind === "closing") continue;
        const content = shapes(await text(zip, `ppt/slides/slide${i + 1}.xml`)).filter((sh) => !FURNITURE.test(sh.name));
        expect(content.length, `slide ${i + 1}`).toBeGreaterThan(0);
        const area = contentArea("takeaway" in s && !!s.takeaway);
        const top = Math.min(...content.map((c) => c.y));
        const bottom = Math.max(...content.map((c) => c.y + c.h));
        const left = Math.min(...content.map((c) => c.x));
        const right = Math.max(...content.map((c) => c.x + c.w));
        expect(top, `slide ${i + 1} (${s.kind}) top`).toBeGreaterThanOrEqual(area.y - 0.01);
        expect(bottom, `slide ${i + 1} (${s.kind}) bottom`).toBeLessThanOrEqual(area.y + area.h + 0.01);
        expect(left, `slide ${i + 1} left`).toBeGreaterThanOrEqual(SLIDE.margin - 0.01);
        expect(right, `slide ${i + 1} right`).toBeLessThanOrEqual(SLIDE.w - SLIDE.margin + 0.01);
        expect((bottom - top) / area.h, `slide ${i + 1} (${s.kind}) fill`).toBeGreaterThanOrEqual(0.6);
      }
    });
  }
});

describe("agenda", () => {
  const withItems = (n: number, details = false) => {
    const deck = fixtureDeck();
    const a = deck.slides[1]!;
    if (a.kind !== "agenda") throw new Error("fixture changed");
    a.items = Array.from({ length: n }, (_, i) => `Section ${i + 1}`);
    if (details) a.details = a.items.map((_, i) => (i % 2 ? "" : `What happened in section ${i + 1}.`));
    return deck;
  };

  it("up to six items: a grid of numbered blocks (3 × 2, 2 × 2 for four) with the one-line descriptions", async () => {
    for (const [n, cols] of [[6, 3], [4, 2], [3, 3]] as const) {
      const all = shapes(await slideXml(withItems(n, true), "cards", 1));
      const blocks = named(all, /^Agenda block \d+$/);
      expect(blocks).toHaveLength(n);
      expect(new Set(blocks.map((b) => b.x.toFixed(3))).size).toBe(cols);
      expect(new Set(blocks.map((b) => b.w.toFixed(3))).size).toBe(1);
      expect(named(all, /^Agenda number \d+$/).map((s) => /<a:t>(\d+)<\/a:t>/.exec(s.xml)![1])).toEqual(Array.from({ length: n }, (_, i) => String(i + 1).padStart(2, "0")));
      expect(named(all, /^Agenda detail \d+$/)).toHaveLength(Math.ceil(n / 2));
    }
    // Rule themes: a top rule per block instead of a card.
    const minimal = shapes(await slideXml(withItems(6), "minimal", 1));
    expect(named(minimal, /^Agenda block \d+ rule$/)).toHaveLength(6);
    expect(named(minimal, /^Agenda block \d+$/)).toHaveLength(0);
  });

  it("seven to twelve: two columns with the rows spread over the full height; more: three columns", async () => {
    for (const [n, cols] of [[7, 2], [12, 2], [13, 3]] as const) {
      const items = named(shapes(await slideXml(withItems(n), "editorial", 1)), /^Agenda \d+$/);
      expect(items).toHaveLength(n);
      expect(new Set(items.map((s) => s.x.toFixed(3))).size).toBe(cols);
      const area = contentArea(false);
      const per = Math.ceil(n / cols);
      const first = items[0]!;
      const last = items[per - 1]!;
      // Equal rows from the top of the content area to its bottom.
      expect(first.y).toBeCloseTo(area.y + 0.04, 2);
      expect(last.y + last.h).toBeCloseTo(area.y + area.h - 0.04, 2);
    }
  });
});

describe("summary", () => {
  const withBullets = (bullets: string[]) => {
    const deck = fixtureDeck();
    const s = deck.slides[3]!;
    if (s.kind !== "summary") throw new Error("fixture changed");
    s.bullets = bullets;
    return deck;
  };

  it("up to three points: insight cards across, equal and top-aligned, the number above the text; no full-height panel", async () => {
    for (const id of ["cards", "minimal", "bold", "friendly"] as const) {
      const all = shapes(await slideXml(withBullets(["Clicks grew 12%.", "Service pages drove the growth", "One post slipped"]), id, 3));
      const texts = named(all, /^Insight \d$/);
      expect(texts).toHaveLength(3);
      expect(new Set(texts.map((t) => t.y.toFixed(3))).size).toBe(1);
      expect(new Set(texts.map((t) => t.w.toFixed(3))).size).toBe(1);
      for (let i = 1; i <= 3; i++) expect(one(all, `Insight ${i} number`).y).toBeLessThan(one(all, `Insight ${i}`).y);
      expect(named(all, /Panel/)).toHaveLength(0);
      const area = contentArea(false);
      // Each card is about 70% of the content height.
      const card = deckTheme(id).surface.card ? one(all, "Insight card 1") : one(all, "Insight 1 rule");
      expect(card).toBeDefined();
      expect(texts[0]!.y + texts[0]!.h - (card.y)).toBeGreaterThan(area.h * 0.6);
    }
  });

  it("four or five points: numbered rows spread over the height with a rule between rows; consulting adds its label column", async () => {
    const five = ["One point.", "Two point.", "Three point.", "Four point.", "Five point."];
    const rows = named(shapes(await slideXml(withBullets(five), "cards", 3)), /^Item \d$/);
    expect(rows).toHaveLength(5);
    const gaps = rows.slice(1).map((r, i) => r.y - rows[i]!.y);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0]!, 3);
    const consulting = shapes(await slideXml(withBullets(five.slice(0, 3)), "consulting", 3));
    expect(one(consulting, "Label").xml).toContain("<a:t>Key points</a:t>");
    expect(one(consulting, "Item 1").x).toBeGreaterThanOrEqual(SLIDE.margin + 2.2);
  });

  it("editorial: the first point is a large serif lead, the rest numbered rows", async () => {
    const all = shapes(await slideXml(withBullets(["Clicks grew 12% month over month.", "Service pages", "One post"]), "editorial", 3));
    const lead = one(all, "Lead");
    expect(lead.xml).toMatch(/ sz="3[26]00"/);
    expect(lead.xml).toContain(`typeface="Georgia"`);
    expect(named(all, /^Item \d$/)).toHaveLength(2);
  });
});

describe("side column beside a chart", () => {
  for (const id of THEME_IDS) {
    it(`${id}: top-aligned with the chart block and as tall; text ≥ 0.3 in past any rule or edge`, async () => {
      const all = shapes(await slideXml(fixtureDeck(), id, 4));
      const t = deckTheme(id);
      const chartTop = t.surface.card ? one(all, "Chart card").y : one(all, "Chart caption").y;
      const frame = one(all, "Chart");
      const chartBottom = frame.y + frame.h + (t.surface.card ? 0.3 : 0);
      const panel = t.callout.fill ? one(all, "Side panel") : one(all, "Side panel rule");
      expect(panel.y).toBeCloseTo(chartTop, 3);
      expect(panel.x).toBeCloseTo(SLIDE.sideX, 3);
      if (t.callout.fill) expect(panel.y + panel.h).toBeCloseTo(chartBottom, 3);
      const label = one(all, "Side label");
      expect(label.xml).toContain("<a:t>Commentary</a:t>");
      const items = named(all, /^Side item \d$/);
      expect(items.length).toBeGreaterThan(0);
      const inset = items[0]!.x - SLIDE.sideX - (t.callout.left ? t.callout.left.weight / 72 : 0);
      if (t.callout.fill || t.callout.left) expect(inset).toBeGreaterThanOrEqual(0.3 - 1e-6);
      expect(Math.max(...items.map((i) => i.y + i.h))).toBeLessThanOrEqual(chartBottom + 0.01);
      for (const i of items) expect(i.xml).toMatch(/ sz="(1600|1800|2000)"/);
    });
  }
});

describe("KPI tiles + chart", () => {
  it("tiles go in a row on top (not a 2 × 2 side grid), the chart below at full width", async () => {
    const deck = fixtureDeck();
    const s = deck.slides[4]!;
    if (s.kind !== "section") throw new Error("fixture changed");
    s.tiles = [1, 2, 3, 4].map((n) => ({ label: `K${n}`, value: `${n}00` }));
    s.bullets = [];
    delete s.table;
    const all = shapes(await slideXml(deck, "cards", 4));
    const tiles = named(all, /^Tile \d$/);
    expect(tiles).toHaveLength(4);
    expect(new Set(tiles.map((t) => t.y.toFixed(3))).size).toBe(1);
    const card = one(all, "Chart card");
    expect(card.y).toBeGreaterThan(tiles[0]!.y + tiles[0]!.h);
    expect(card.w).toBeCloseTo(SLIDE.w - 2 * SLIDE.margin, 3);
  });
});

describe("key numbers", () => {
  it("a band of equal cards with one value size, and the verdict banner under it", async () => {
    const deck = fixtureDeck();
    const k = deck.slides[2]!;
    if (k.kind !== "kpis") throw new Error("fixture changed");
    k.takeaway = "Clicks grew 17.6% in September.";
    const all = shapes(await slideXml(deck, "bold", 2));
    const tiles = named(all, /^Tile \d rule$/);
    expect(tiles).toHaveLength(4);
    const sizes = new Set(named(all, /^Tile \d value$/).map((v) => / sz="(\d+)"/.exec(v.xml)![1]));
    expect(sizes.size).toBe(1);
    const banner = one(all, "Banner");
    expect(one(all, "Banner text").xml).toContain("<a:t>Clicks grew 17.6% in September.</a:t>");
    expect(banner.y).toBeGreaterThan(Math.max(...named(all, /^Tile \d value$/).map((v) => v.y + v.h)));
    // The comparison caption moves to the source line.
    expect(one(all, "Source line").xml).toContain("Change vs August 2026");
  });
});

describe("tables", () => {
  const withTable = (rows: number, bar: boolean) => {
    const deck = fixtureDeck();
    const s = deck.slides[5]!;
    if (s.kind !== "section" || !s.table) throw new Error("fixture changed");
    s.table.rows = s.table.rows.slice(0, rows).map((r) => r.slice(0, 4));
    s.table.header = s.table.header.slice(0, 4);
    s.table.numeric = s.table.numeric.slice(0, 4);
    if (bar) s.table.bar = { col: 1, values: s.table.rows.map((_, i) => (i + 1) * 10) };
    return deck;
  };

  it("short tables (2–4 rows) with bar data get in-cell bars, sized by value; longer tables don't", async () => {
    const all = shapes(await slideXml(withTable(4, true), "cards", 5));
    const bars = named(all, /^Bar \d$/);
    expect(bars).toHaveLength(4);
    expect(bars[3]!.w).toBeCloseTo(bars[0]!.w * 4, 2);
    expect(bars[0]!.xml).toContain("<p:txBody>");
    expect(named(shapes(await slideXml(withTable(8, true), "cards", 5)), /^Bar \d$/)).toHaveLength(0);
    expect(named(shapes(await slideXml(withTable(4, false), "cards", 5)), /^Bar \d$/)).toHaveLength(0);
  });

  it("a short table steps up the ladder (larger type, taller rows) and fills at least 60% of the area", async () => {
    const all = shapes(await slideXml(withTable(4, false), "minimal", 5));
    const table = one(all, "Table");
    expect(table.xml).toMatch(/ sz="(2000|2200)"/);
    expect(table.h / contentArea(false).h).toBeGreaterThanOrEqual(0.6);
    const long = one(shapes(await slideXml(withTable(8, false), "minimal", 5)), "Table");
    // Eight rows: a lower step of the ladder (14 or 16 pt), never below 14 pt.
    expect(long.xml).toMatch(/<a:tc><a:txBody>.*? sz="(1400|1600)"/);
    // Body rows (the header is 12 pt caps).
    expect(long.xml.slice(long.xml.indexOf("</a:tr>"))).not.toMatch(/ sz="1[0-3]00"/);
  });

  it("one or two rows become record cards (label over value per column)", async () => {
    const all = shapes(await slideXml(withTable(1, false), "friendly", 5));
    expect(named(all, "Table")).toHaveLength(0);
    expect(one(all, "Record 1")).toBeDefined();
    expect(named(all, /^Record 1 label \d$/)).toHaveLength(4);
    expect(one(all, "Record 1 label 1").xml).toContain("<a:t>Page</a:t>");
    expect(one(all, "Record 1 value 1").xml).toContain("<a:t>/page-1</a:t>");
  });

  it("a continuation slide shows the section title with a muted 'continued' tag", async () => {
    const title = one(shapes(await slideXml(fixtureDeck(), "editorial", 5)), "Title");
    expect(title.xml).toMatch(/<a:t>Search performance<\/a:t><\/a:r><a:r><a:rPr lang="en-US" sz="1400" b="0" i="1"[^>]*>.*?<a:t> {3}continued<\/a:t>/);
  });
});

describe("chart caption: the latest value", () => {
  const chart = (values: (number | null)[], o: Partial<LineChart> = {}): LineChart => ({
    type: "line",
    title: "Clicks per day",
    x: values.map((_, i) => `2026-09-${String(28 + i).padStart(2, "0")}`),
    series: [
      { name: "September 2026", values, role: "current" },
      { name: "August 2026", values: values.map(() => 1), role: "previous" },
    ],
    format: "count",
    summary: "s",
    ...o,
  });

  it("the last value of the current series and its day, formatted as the axis formats it", () => {
    expect(latestLabel(chart([40, 45, 48]))).toBe("Latest: 48 (30 Sep)");
    expect(latestLabel(chart([40, 45, null]))).toBe("Latest: 45 (29 Sep)");
    expect(latestLabel(chart([10_000, 12_345, 23_456]))).toBe("Latest: 23k (30 Sep)");
    expect(latestLabel(chart([1, 2, 2_345_678]))).toBe("Latest: 2M (30 Sep)");
    expect(latestLabel(chart([2900, 2600, 2300], { format: "ms" }))).toBe("Latest: 2,300 ms (30 Sep)");
    expect(latestLabel(chart([8.1, 7.44, 6.4], { format: "position" }))).toBe("Latest: 6.4 (30 Sep)");
    expect(latestLabel({ type: "share", title: "Share", parts: ["A", "B"], rows: [{ label: "x", values: [1, 2] }], summary: "s" })).toBeNull();
    expect(axisNumber(9_999, "count")).toBe("9,999");
    expect(axisNumber(0.05, "score")).toBe("0.05");
  });

  it("sits in the caption row, right-aligned with the legend", async () => {
    const all = shapes(await slideXml(fixtureDeck(), "cards", 4));
    const legend = one(all, "Chart legend");
    expect(legend.xml).toContain("<a:t>Latest: 30 (3 Sep)</a:t>");
    expect(legend.y).toBeCloseTo(one(all, "Chart caption").y, 3);
  });
});

describe("cover and closing", () => {
  for (const id of THEME_IDS) {
    it(`${id}: the cover's right region carries the theme element; the closing is a centred group`, async () => {
      const deck = fixtureDeck();
      const zip = await unzip(await renderDeck(deck, styleFor(id)));
      const cover = shapes(await text(zip, "ppt/slides/slide1.xml"));
      const right = cover.filter((s) => s.x >= 8.8 && !/^(Agency|Logo)/.test(s.name));
      expect(right.length, "right region").toBeGreaterThan(0);
      const title = one(cover, "Title");
      expect(title.x + title.w).toBeLessThanOrEqual(8.45);
      const closing = shapes(await text(zip, `ppt/slides/slide${deck.slides.length}.xml`));
      const t = one(closing, "Title");
      expect(t.xml).toContain(`algn="ctr"`);
      expect(t.y + t.h / 2).toBeGreaterThan(2.5);
      expect(t.y + t.h / 2).toBeLessThan(4.2);
    });
  }
});
