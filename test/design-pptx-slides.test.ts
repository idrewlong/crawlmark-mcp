/**
 * 0.4.0 T3a: slide masters and slides per theme (hand-written decks; chartPart stubbed). Per-theme snapshots of
 * the slide master and the title slide, theme fonts and colours, theme looks (bold, friendly, consulting), tables,
 * the logo and escaping.
 */
import { describe, expect, it, vi } from "vitest";
import { NEUTRAL } from "../src/reports/render/color.js";
import { deckTheme } from "../src/reports/render/themes/deck-themes.js";
import { themePalette } from "../src/reports/render/themes/palette.js";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import { CONTROL, fixtureDeck, NASTY, styleFor, text, unzip } from "./fixtures/pptx/decks.js";
import { TINY_PNG } from "./fixtures/reports/report.js";

vi.mock("../src/reports/render/pptx/charts.js", async () => {
  const { fixedChartPart } = await import("./fixtures/pptx/decks.js");
  return { chartPart: vi.fn(async () => fixedChartPart()) };
});

const { renderDeck } = await import("../src/reports/render/pptx/index.js");

const FONTS: Record<string, [string, string]> = {
  cards: ["Arial", "Arial"],
  minimal: ["Arial", "Arial"],
  editorial: ["Georgia", "Georgia"],
  bold: ["Arial Black", "Arial"],
  consulting: ["Arial", "Arial"],
  friendly: ["Trebuchet MS", "Trebuchet MS"],
};

const fill = (hex: string) => `<a:srgbClr val="${hex.replace("#", "").toUpperCase()}"/>`;
const shapes = (xml: string) => xml.match(/<p:(?:sp|cxnSp)>.*?<\/p:(?:sp|cxnSp)>/g) ?? [];
const titleShape = (xml: string) => shapes(xml).find((s) => /<p:ph type="(ctrTitle|title)"/.test(s))!;
const texts = (xml: string) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);

describe("per-theme slide master and title slide", () => {
  for (const id of THEME_IDS) {
    it(`${id}: snapshots`, async () => {
      const zip = await unzip(await renderDeck(fixtureDeck(), styleFor(id)));
      await expect(await text(zip, "ppt/slideMasters/slideMaster1.xml")).toMatchFileSnapshot(`fixtures/reports/__snapshots__/pptx/${id}/slideMaster1.xml`);
      await expect(await text(zip, "ppt/slides/slide1.xml")).toMatchFileSnapshot(`fixtures/reports/__snapshots__/pptx/${id}/slide1.xml`);
    });

    it(`${id}: theme1 fonts follow P-C5, colours follow the palette`, async () => {
      const zip = await unzip(await renderDeck(fixtureDeck(), styleFor(id)));
      const theme = await text(zip, "ppt/theme/theme1.xml");
      const [major, minor] = FONTS[id]!;
      expect(theme).toContain(`<a:majorFont><a:latin typeface="${major}"/>`);
      expect(theme).toContain(`<a:minorFont><a:latin typeface="${minor}"/>`);
      expect(theme).toContain(`<a:accent1>${fill("#1f5ea8")}</a:accent1>`);
      expect(theme).toContain(`<a:dk1>${fill(NEUTRAL.ink)}</a:dk1>`);
      expect(theme).toMatch(new RegExp(`<a:theme [^>]*name="${id[0]!.toUpperCase()}${id.slice(1)}"`));
      // branding fonts replace the theme's: bodyFont alone also sets the heading
      const branded = await unzip(await renderDeck(fixtureDeck(), styleFor(id, { body: "Inter" })));
      const bt = await text(branded, "ppt/theme/theme1.xml");
      expect(bt).toContain(`<a:minorFont><a:latin typeface="Inter"/>`);
      expect(bt).toContain(`<a:majorFont><a:latin typeface="Inter"/>`);
      const s5 = await text(branded, "ppt/slides/slide5.xml");
      expect(s5).toContain(`<a:latin typeface="Inter"/>`);
      expect(s5).not.toContain(`<a:latin typeface="${minor}"`);
    });

    it(`${id}: the body background and title look come from deckTheme`, async () => {
      const zip = await unzip(await renderDeck(fixtureDeck(), styleFor(id)));
      const master = await text(zip, "ppt/slideMasters/slideMaster1.xml");
      const p = themePalette("#1f5ea8", "#5b9bd5");
      const bg = deckTheme(id).background;
      const bgHex = bg === "wash" ? p.wash : bg;
      expect(master).toContain(`<p:bg><p:bgPr>${`<a:solidFill>${fill(bgHex)}</a:solidFill>`}`);
      const title = titleShape(await text(zip, "ppt/slides/slide5.xml"));
      expect(title).toContain(`sz="${deckTheme(id).heading.size * 100}"`);
    });
  }
});

describe("theme looks", () => {
  it("bold: the title slide fill is dark, and a yellow primary still gives white text", async () => {
    const p = themePalette("#ffd400", "#5b9bd5");
    const zip = await unzip(await renderDeck(fixtureDeck(), styleFor("bold", { primary: "#ffd400" })));
    const layout = await text(zip, "ppt/slideLayouts/slideLayout1.xml");
    expect(layout).toContain(`<p:bg><p:bgPr><a:solidFill>${fill(p.dark)}</a:solidFill>`);
    const title = titleShape(await text(zip, "ppt/slides/slide1.xml"));
    expect(title).toContain(fill("#ffffff"));
    expect(p.onDark).toBe("#ffffff");
  });

  it("friendly: section titles sit in a rounded tint pill sized to the text", async () => {
    const p = themePalette("#1f5ea8", "#5b9bd5");
    const zip = await unzip(await renderDeck(fixtureDeck(), styleFor("friendly")));
    const xml = await text(zip, "ppt/slides/slide5.xml");
    const title = titleShape(xml);
    // The pill is its own shape (Keynote ignores a placeholder's geometry), drawn behind an unfilled title.
    const all: string[] = shapes(xml);
    const pill = all.find((s) => s.includes('name="Title pill"'))!;
    expect(all.indexOf(pill)).toBeLessThan(all.indexOf(title));
    expect(pill).toContain(`<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 50000"/></a:avLst></a:prstGeom>`);
    expect(pill).toContain(`<a:solidFill>${fill(p.tint)}</a:solidFill>`);
    expect(title).toContain("<a:noFill/>");
    expect(title).toContain(`wrap="none"`);
    expect(title).toContain(fill(p.tintInk));
    // Sized to the text: a short title gets a short pill.
    const agenda = shapes(await text(zip, "ppt/slides/slide2.xml")).find((s) => s.includes('name="Title pill"'))!;
    const width = (s: string) => Number(/<a:ext cx="(\d+)"/.exec(s)![1]) / 914_400;
    expect(width(agenda)).toBeGreaterThan(1.2);
    expect(width(agenda)).toBeLessThan(2.2);
  });

  it("consulting: section titles start with 01, 02, …", async () => {
    const deck = fixtureDeck();
    const zip = await unzip(await renderDeck(deck, styleFor("consulting")));
    for (const [i, s] of deck.slides.entries()) {
      if (s.kind !== "section") continue;
      const t = texts(titleShape(await text(zip, `ppt/slides/slide${i + 1}.xml`))).join("");
      expect(t).toBe(`${String(s.number).padStart(2, "0")}  ${s.title}`);
    }
    // other themes don't number
    const cards = await unzip(await renderDeck(deck, styleFor("cards")));
    expect(texts(titleShape(await text(cards, "ppt/slides/slide5.xml"))).join("")).toBe("Search performance");
  });

  it("cards: the master draws the primary bar; the title layout hides master shapes", async () => {
    const zip = await unzip(await renderDeck(fixtureDeck(), styleFor("cards")));
    const master = await text(zip, "ppt/slideMasters/slideMaster1.xml");
    expect(master).toContain(`name="Title bar"`);
    expect(await text(zip, "ppt/slideLayouts/slideLayout1.xml")).toContain(`showMasterSp="0"`);
  });
});

describe("tables", () => {
  it("at most 6 columns, header style and zebra from deckTheme", async () => {
    for (const id of THEME_IDS) {
      const t = deckTheme(id).table;
      const p = themePalette("#1f5ea8", "#5b9bd5");
      const zip = await unzip(await renderDeck(fixtureDeck(), styleFor(id)));
      const xml = await text(zip, "ppt/slides/slide6.xml");
      const tbl = xml.match(/<a:tbl>.*?<\/a:tbl>/)![0];
      expect(tbl.match(/<a:gridCol /g)!.length).toBeLessThanOrEqual(6);
      const rows = tbl.match(/<a:tr .*?<\/a:tr>/g)!;
      const header = rows[0]!;
      expect(header.includes(`cap="all"`)).toBe(t.headerCaps);
      expect(header.includes(` i="1"`)).toBe(t.headerItalic);
      expect(header.includes(`b="1"`)).toBe(t.headerBold);
      const zebra = t.zebra === null ? null : t.zebra === "wash" ? p.wash : t.zebra;
      if (zebra) expect(rows[2]).toContain(`<a:solidFill>${fill(zebra)}</a:solidFill></a:tcPr>`);
      else for (const r of rows.slice(1)) expect(r).not.toMatch(/<a:solidFill><a:srgbClr val="[0-9A-F]{6}"\/><\/a:solidFill><\/a:tcPr>/);
      expect(header).toContain(`<a:lnB w="${Math.round(t.headerRule.weight * 12700)}"`);
      // numeric columns right-aligned
      expect(rows[1]).toContain(`algn="r"`);
    }
  });
});

describe("logo", () => {
  it("one media part, referenced only from the title and closing slides, with alt text", async () => {
    const deck = fixtureDeck({ logo: true });
    const zip = await unzip(await renderDeck(deck, styleFor("cards", { logo: { mime: "image/png", data: TINY_PNG } })));
    const media = Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/"));
    expect(media).toEqual(["ppt/media/logo.png"]);
    for (let i = 1; i <= deck.slides.length; i++) {
      const rels = await text(zip, `ppt/slides/_rels/slide${i}.xml.rels`);
      const has = rels.includes("../media/logo.png");
      expect(has, `slide ${i}`).toBe(i === 1 || i === deck.slides.length);
      if (has) expect(await text(zip, `ppt/slides/slide${i}.xml`)).toMatch(/<p:pic><p:nvPicPr><p:cNvPr id="\d+" name="Logo" descr="Example Agency"\/>/);
    }
    // no logo bytes → no media, even when the deck asks for one
    const none = await unzip(await renderDeck(deck, styleFor("cards")));
    expect(Object.keys(none.files).some((n) => n.startsWith("ppt/media/"))).toBe(false);
    // JPEG
    const jpeg = Buffer.from("ffd8ffe000104a46494600010100000100010000ffc0001108000a001403011100021101031101ffd9", "hex");
    const j = await unzip(await renderDeck(deck, styleFor("cards", { logo: { mime: "image/jpeg", data: jpeg } })));
    expect(Object.keys(j.files).filter((n) => n.startsWith("ppt/media/"))).toEqual(["ppt/media/logo.jpeg"]);
    expect(await text(j, "[Content_Types].xml")).toContain(`<Default Extension="jpeg" ContentType="image/jpeg"/>`);
  });
});

describe("escaping", () => {
  it("<, &, quotes and a control character in a title and a table cell come out escaped; the control character is gone", async () => {
    const deck = fixtureDeck({ agencyName: NASTY, logo: true });
    const s = deck.slides[5]!;
    if (s.kind !== "section" || !s.table) throw new Error("fixture changed");
    s.title = NASTY;
    s.table.rows[0]![0] = NASTY;
    const zip = await unzip(await renderDeck(deck, styleFor("cards", { logo: { mime: "image/png", data: TINY_PNG } })));
    const xml = await text(zip, "ppt/slides/slide6.xml");
    const escaped = "A &lt; B &amp; &quot;C&quot; &apos;D&apos;";
    expect(texts(titleShape(xml)).join("")).toBe(escaped);
    expect(xml.match(new RegExp(escaped, "g"))!.length).toBe(2);
    for (const name of Object.keys(zip.files)) {
      if (!/\.(xml|rels)$/.test(name)) continue;
      const part = await text(zip, name);
      expect(part, name).not.toContain(CONTROL);
      expect(part, name).not.toContain("A < B");
    }
    expect(await text(zip, "ppt/slides/slide1.xml")).toContain(`descr="${escaped}"`);
  });
});
