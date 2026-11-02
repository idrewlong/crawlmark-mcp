/**
 * 0.4.0 deck layout fixes (checked against Keynote and Quick Look renders): round value-axis ticks, no chart title
 * to collide with the legend, transparent chart areas, content-sized table columns, the agenda's number tab stop,
 * bullets clear of a panel's rule, and font families every Mac and PC has.
 */
import { describe, expect, it } from "vitest";
import { contrast, DEFAULT_PRIMARY, NEUTRAL, TONE } from "../src/reports/render/color.js";
import type { LineChart, ShareChart } from "../src/reports/render/doc.js";
import { axisScale, deckChartXml, niceUnit } from "../src/reports/render/pptx/chart-style.js";
import { chartPart } from "../src/reports/render/pptx/charts.js";
import { renderDeck } from "../src/reports/render/pptx/index.js";
import { coverBackground, coverFill, makeCtx, SLIDE } from "../src/reports/render/pptx/master.js";
import { accentInk, agendaTab, bulletHang, columnWidths, textWidth } from "../src/reports/render/pptx/slides.js";
import type { RunStyle } from "../src/reports/render/pptx/xml.js";
import { deckTheme } from "../src/reports/render/themes/deck-themes.js";
import { themePalette } from "../src/reports/render/themes/palette.js";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import { fixtureDeck, lineChart, styleFor, text, unzip } from "./fixtures/pptx/decks.js";

const X = ["2026-09-01", "2026-09-02", "2026-09-03"];
const line = (values: number[], o: Partial<LineChart> = {}): LineChart => ({ type: "line", title: "Clicks per day", x: X, series: [{ name: "September 2026", values, role: "current" }], format: "count", summary: "s", ...o });
const ticks = (a: { min: number; max: number; unit: number }) => Array.from({ length: Math.round((a.max - a.min) / a.unit) + 1 }, (_, i) => Number((a.min + i * a.unit).toPrecision(12)));
const isNice = (u: number) => {
  const f = u / 10 ** Math.floor(Math.log10(u));
  return [1, 2, 2.5, 5].some((n) => Math.abs(f - n) < 1e-9);
};

describe("value axis on slides", () => {
  it("picks nice units: 1, 2, 2.5 or 5 × 10^n", () => {
    expect(niceUnit(50)).toBe(10);
    expect(niceUnit(48)).toBe(10);
    expect(niceUnit(70)).toBe(20);
    expect(niceUnit(2900)).toBe(1000);
    expect(niceUnit(0.06)).toBe(0.02);
    expect(niceUnit(110)).toBe(25);
    expect(niceUnit(11, 5, true)).toBe(5);
  });

  it("round ticks for the fixtures that drew 13/25/38/50 and 18/35/53/70", () => {
    const clicks = axisScale(line([37, 45, 48]));
    expect(ticks(clicks)).toEqual([0, 10, 20, 30, 40, 50]);
    const sessions = axisScale(line([50, 60, 64]));
    expect(ticks(sessions)).toEqual([0, 20, 40, 60, 80]);
    const lcp = axisScale(line([2900, 2600, 2300], { format: "ms" }));
    expect(ticks(lcp)).toEqual([0, 1000, 2000, 3000]);
  });

  it("every tick is a multiple of a nice unit, the max covers the data, at most 5 steps", () => {
    for (const top of [1, 3, 7, 9.5, 13, 48, 99, 101, 640, 1234, 87_000]) {
      for (const format of ["count", "score", "ms"] as const) {
        const a = axisScale(line([top / 2, top], { format }));
        expect(isNice(a.unit)).toBe(true);
        expect(a.max).toBeGreaterThanOrEqual(top);
        expect((a.max - a.min) / a.unit).toBeLessThanOrEqual(5 + 1e-9);
        if (format !== "score") expect(Number.isInteger(a.unit)).toBe(true);
      }
    }
  });

  it("writes max, min and majorUnit into the chart part (Keynote ignores a major unit without a max)", async () => {
    const c = line([37, 45, 48]);
    const xml = deckChartXml((await chartPart(c, { primary: DEFAULT_PRIMARY, font: "Arial" }))!.xml, c);
    const valAx = /<c:valAx>.*<\/c:valAx>/s.exec(xml)![0];
    expect(valAx).toContain(`<c:scaling><c:orientation val="minMax"/><c:max val="50"/><c:min val="0"/></c:scaling>`);
    expect(valAx).toContain(`<c:majorUnit val="10"/>`);
    expect(valAx.match(/<c:majorUnit /g)).toHaveLength(1);
  });

  it("positions: reversed axis from 0 with the 0 label hidden", async () => {
    const c = line([8, 6, 5], { format: "position", invert: true, title: "Average position" });
    const xml = deckChartXml((await chartPart(c, { primary: DEFAULT_PRIMARY, font: "Arial" }))!.xml, c);
    const valAx = /<c:valAx>.*<\/c:valAx>/s.exec(xml)![0];
    expect(valAx).toContain(`<c:orientation val="maxMin"/><c:max val="8"/><c:min val="0"/>`);
    expect(valAx).toContain(`<c:numFmt formatCode="0;-0;"`);
  });
});

describe("category labels", () => {
  it("a 30-day chart labels every third day; a short one labels every day", async () => {
    const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
    const long = line(days.map((_, i) => i), { x: days });
    const xml = deckChartXml((await chartPart(long, { primary: DEFAULT_PRIMARY, font: "Arial" }))!.xml, long);
    expect(/<c:catAx>.*<\/c:catAx>/s.exec(xml)![0]).toContain(`<c:tickLblSkip val="3"/><c:tickMarkSkip val="3"/><c:noMultiLvlLbl `);
    const short = line([1, 2, 3]);
    expect(deckChartXml((await chartPart(short, { primary: DEFAULT_PRIMARY, font: "Arial" }))!.xml, short)).not.toContain("tickLblSkip");
  });
});

describe("chart title and legend", () => {
  it("drops the chart's own title (autoTitleDeleted) and legend; the slide draws both on a caption row above the chart", async () => {
    for (const c of [lineChart(), { type: "share", title: "Share of clicks", parts: ["Branded", "Non-branded"], rows: [{ label: "September 2026", values: [40, 60] }], summary: "s" } satisfies ShareChart]) {
      const xml = deckChartXml((await chartPart(c, { primary: DEFAULT_PRIMARY, font: "Arial" }))!.xml, c);
      expect(xml).not.toContain("<c:title>");
      expect(xml).toContain(`<c:autoTitleDeleted val="1"/>`);
      expect(xml).not.toContain("<c:legend>");
      // Axis labels at 11 pt, not Word's 8 pt.
      expect(xml).not.toContain(`sz="800"`);
      expect(xml).toContain(`sz="1100"`);
    }
    const zip = await unzip(await renderDeck(fixtureDeck(), styleFor("cards")));
    const s5 = await text(zip, "ppt/slides/slide5.xml");
    expect(s5).toContain(`name="Chart caption"`);
    expect(s5).toContain("<a:t>Clicks per day</a:t>");
    // Legend: caption row, right-aligned, after the caption; the previous period is dashed and grey.
    const legend = /<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="Chart legend"\/>.*?<\/p:sp>/.exec(s5)![0];
    expect(legend).toContain(`algn="r"`);
    expect(legend).toContain("<a:t>September 2026</a:t>");
    expect(legend).toContain("<a:t>August 2026</a:t>");
    expect(legend).toContain("<a:t>     – – </a:t>");
    const caption = /<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="Chart caption"\/>.*?<\/p:sp>/.exec(s5)![0];
    const off = (sp: string) => Number(/<a:off x="(\d+)" y="(\d+)"/.exec(sp)![2]);
    expect(off(legend)).toBe(off(caption));
    expect(await text(zip, "ppt/charts/chart1.xml")).not.toContain("<c:title>");
  });

  it("the Word chart keeps its title (the change is deck-only)", async () => {
    const xml = (await chartPart(lineChart(), { primary: DEFAULT_PRIMARY, font: "Calibri" }))!.xml;
    expect(xml).toContain("<c:title>");
    expect(xml).toContain(`<c:autoTitleDeleted val="0"/>`);
  });
});

describe("transparent charts", () => {
  for (const id of THEME_IDS) {
    it(`${id}: the chart and plot areas have no fill, so the chart sits on the slide background`, async () => {
      const zip = await unzip(await renderDeck(fixtureDeck(), styleFor(id)));
      const xml = await text(zip, "ppt/charts/chart1.xml");
      expect(xml).toMatch(/<\/c:chart><c:spPr><a:noFill\/>/);
      expect(xml).toMatch(/<\/c:valAx><c:spPr><a:noFill\/>/);
      expect(xml).not.toContain(`<a:srgbClr val="FFFFFF"/>`);
    });
  }
});

describe("table column widths", () => {
  const head: RunStyle = { size: 11, font: "Arial", color: "#52606d", caps: true, spacing: 0.4 };
  const body: RunStyle = { size: 12, font: "Arial", color: "#1f2933" };

  it("a short column (Severity) doesn't take half the table while Finding wraps", () => {
    const header = ["Severity", "Finding", "Page"];
    const rows = [["high", "On-page check failed: the canonical tag points to a page that redirects", "/"]];
    const w = columnWidths(header, rows, 8.1, head, body);
    expect(w.reduce((a, v) => a + v, 0)).toBeCloseTo(8.1, 6);
    expect(w[1]).toBeGreaterThan(w[0]! * 2.5);
    expect(w[1]).toBeGreaterThan(w[2]! * 2.5);
  });

  it("columns get at least their content when it fits, and share the rest in proportion", () => {
    const header = ["Query", "Clicks"];
    const rows = [["drain cleaning near me", "90"]];
    const w = columnWidths(header, rows, 12.33, head, body);
    expect(w[0]!).toBeGreaterThan(textWidth("drain cleaning near me", body));
    expect(w[1]!).toBeGreaterThan(textWidth("CLICKS", head));
    expect(w.reduce((a, v) => a + v, 0)).toBeCloseTo(12.33, 6);
  });

  it("too wide: the widest column gives way, none drops below its minimum", () => {
    const long = "x ".repeat(60).trim();
    const w = columnWidths(["A", "B", "C"], [[long, long, "1"]], 6, head, body);
    expect(w.reduce((a, v) => a + v, 0)).toBeCloseTo(6, 6);
    expect(w[2]!).toBeGreaterThan(textWidth("C", head) + 0.16);
    expect(Math.min(w[0]!, w[1]!)).toBeGreaterThan(0.85);
    expect(w[0]).toBeCloseTo(w[1]!, 6);
  });
});

describe("table gutters", () => {
  it("a text column after a right-aligned number column gets a 0.25 in first-line indent and the width for it", async () => {
    const head: RunStyle = { size: 12, font: "Arial", color: "#52606d" };
    const body: RunStyle = { size: 14, font: "Arial", color: "#1f2933" };
    const rows = [["Largest Contentful Paint", "600 ms better", "good"]];
    const plainW = columnWidths(["Metric", "Change", "Rating now"], rows, 20, head, body, 0.85);
    const gutterW = columnWidths(["Metric", "Change", "Rating now"], rows, 20, head, body, 0.85, [false, true, false]);
    // Same total; the third column's share of it grows by the gutter.
    expect(gutterW[2]! / gutterW.reduce((a, v) => a + v, 0)).toBeGreaterThan(plainW[2]! / plainW.reduce((a, v) => a + v, 0));
    const deck = fixtureDeck();
    const s6 = deck.slides[5]!;
    if (s6.kind === "section" && s6.table) {
      s6.table.header = ["Metric", "Change", "Rating now"];
      // Three rows: one- and two-row tables are drawn as record cards, not a table.
      s6.table.rows = [["LCP", "600 ms better", "good"], ["CLS", "0.01 worse", "good"], ["INP", "20 ms better", "good"]];
      s6.table.numeric = [false, true, false];
    }
    const xml = await text(await unzip(await renderDeck(deck, styleFor("consulting"))), "ppt/slides/slide6.xml");
    const cells = xml.match(/<a:tc>.*?<\/a:tc>/g)!;
    expect(cells.filter((c) => c.includes(`<a:pPr marL="0" indent="228600"`))).toHaveLength(4);
    expect(cells.find((c) => c.includes("<a:t>good</a:t>"))).toContain(`indent="228600"`);
  });
});

describe("agenda numbers", () => {
  it("a tab stop and hanging indent at one x, so 1- and 2-digit numbers line up (7–12 items: two columns, 28 pt numbers)", async () => {
    const deck = fixtureDeck();
    const agenda = deck.slides.find((s) => s.kind === "agenda")!;
    if (agenda.kind === "agenda") agenda.items = Array.from({ length: 12 }, (_, i) => `Section ${i + 1}`);
    const zip = await unzip(await renderDeck(deck, styleFor("editorial")));
    const xml = await text(zip, `ppt/slides/slide${deck.slides.indexOf(agenda) + 1}.xml`);
    const paras = xml.match(/<a:p><a:pPr[^>]*>.*?<\/a:p>/g)!.filter((p) => p.includes("Section "));
    expect(paras).toHaveLength(12);
    const tab = agendaTab({ size: 28, bold: true, font: "Georgia", color: "#000000" });
    for (const p of paras) {
      expect(p).toContain(`marL="${Math.round(tab * 914400)}" indent="${-Math.round(tab * 914400)}"`);
      expect(p).toContain(`<a:tabLst><a:tab pos="${Math.round(tab * 914400)}" algn="l"/></a:tabLst>`);
      expect(p).toMatch(/<a:t>\d\d<\/a:t><\/a:r><a:r><a:rPr[^>]*>.*?<\/a:rPr><a:t>\t<\/a:t><\/a:r>/);
    }
    expect(paras.some((p) => p.includes("<a:t>12</a:t>"))).toBe(true);
  });
});

describe("bullet panels", () => {
  it("the side column's dot hangs just left of the text, and the text sits ≥ 0.3 in past the panel's rule", async () => {
    for (const id of THEME_IDS) {
      const zip = await unzip(await renderDeck(fixtureDeck(), styleFor(id)));
      const xml = await text(zip, "ppt/slides/slide5.xml");
      const item = /<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="Side item 1"\/>.*?<\/p:sp>/.exec(xml)![0];
      const size = Number(/ sz="(\d+)"/.exec(item)![1]) / 100;
      const hang = Math.round(bulletHang(size) * 914400);
      expect(item).toContain(`marL="${hang}" indent="${-hang}"`);
      expect(hang / 914400).toBeLessThan(0.3);
      const ix = Number(/<a:off x="(\d+)"/.exec(item)![1]) / 914400;
      const rule = deckTheme(id).callout;
      if (rule.fill || rule.left) expect(ix - SLIDE.sideX - (rule.left ? rule.left.weight / 72 : 0)).toBeGreaterThanOrEqual(0.3 - 1e-6);
    }
  });
});

describe("fonts", () => {
  it("every deck theme uses families installed on macOS and Windows (no Calibri, no CSS stacks)", () => {
    const ok = new Set(["Arial", "Arial Black", "Georgia", "Trebuchet MS", "Verdana", "Tahoma", "Times New Roman", "Courier New"]);
    for (const id of THEME_IDS) {
      const f = deckTheme(id).fonts;
      expect(ok.has(f.body), `${id} body ${f.body}`).toBe(true);
      expect(ok.has(f.heading), `${id} heading ${f.heading}`).toBe(true);
    }
  });

  it("no typeface attribute in the package is empty, a stack or a generic family (except the theme's ea/cs slots)", async () => {
    for (const id of THEME_IDS) {
      const zip = await unzip(await renderDeck(fixtureDeck(), styleFor(id)));
      for (const name of Object.keys(zip.files).filter((n) => n.endsWith(".xml"))) {
        const xml = await text(zip, name);
        for (const m of xml.matchAll(/<a:(latin|ea|cs) typeface="([^"]*)"/g)) {
          const [, slot, face] = m;
          if (name.startsWith("ppt/theme/") && slot !== "latin" && face === "") continue;
          if (face!.startsWith("+")) continue;
          expect(face, `${name} ${slot}`).toMatch(/^[A-Za-z0-9][A-Za-z0-9 -]*$/);
          expect(face).not.toMatch(/^(sans-serif|serif|monospace|system-ui)$/i);
        }
      }
    }
  });
});

describe("contrast (WCAG AA) for every theme and primary", () => {
  // 4.5:1 for text under 18 pt (14 pt bold), 3:1 for large text.
  const PRIMARIES = ["#1f5ea8", "#0b6e4f", "#ffd400", "#e11d48"];
  for (const id of THEME_IDS) {
    for (const primary of PRIMARIES) {
      it(`${id} with ${primary}`, () => {
        const t = deckTheme(id);
        const x = makeCtx(id, t, themePalette(primary, "#5b9bd5"), t.fonts, "");
        const bg = x.col(t.background);
        // Friendly's rounded cover panel carries the fill; the slide around it is the wash.
        const cover = t.title.panel === "rounded" ? coverFill(x)! : coverBackground(x);
        const pairs: [string, string, string, number][] = [
          ["title", x.col(t.heading.color), t.heading.pill ? x.p.tint : bg, 3],
          ["body", NEUTRAL.ink, bg, 4.5],
          ["footer and footnotes", NEUTRAL.faint, bg, 4.5],
          ["labels and legend", NEUTRAL.muted, bg, 4.5],
          ["agenda and section numbers", accentInk(x), bg, 4.5],
          ["table header", x.col(t.table.headerColor), bg, 4.5],
          ["cover title", x.col(t.title.titleColor), cover, 3],
          ["cover kicker", x.col(t.title.kickerColor), cover, 4.5],
          ["tile value", x.col(t.kpi.valueColor), t.kpi.fill ? x.col(t.kpi.fill) : bg, 3],
          ["chip good", TONE.good.fg, TONE.good.bg, 4.5],
          ["chip bad", TONE.bad.fg, TONE.bad.bg, 4.5],
          ["chip neutral", TONE.neutral.fg, TONE.neutral.bg, 4.5],
        ];
        if (t.table.zebra) pairs.push(["table on zebra", NEUTRAL.ink, x.col(t.table.zebra), 4.5]);
        if (t.callout.fill) pairs.push(["panel text", NEUTRAL.ink, x.col(t.callout.fill), 4.5]);
        if (t.kpi.fill) pairs.push(["tile label", NEUTRAL.muted, x.col(t.kpi.fill), 4.5], ["tile detail", NEUTRAL.faint, x.col(t.kpi.fill), 4.5]);
        for (const [what, fg, back, min] of pairs) expect(contrast(fg, back), `${what}: ${fg} on ${back}`).toBeGreaterThanOrEqual(min);
      });
    }
  }
});
