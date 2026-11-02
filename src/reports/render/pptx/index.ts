/**
 * PowerPoint deck writer (0.4.0): crawlmark's own PresentationML, written with jszip (no third-party writer).
 * `toPptx` builds the deck model (deck.ts) from a ReportDoc, resolves the theme's style from the branding and
 * calls `renderDeck`. Charts are harvested from docx's chart generation (charts.ts), so they're native and keep
 * "Edit Data". The writer reads no file and no URL: the logo arrives as already-checked bytes.
 */
import type { ThemeId } from "../../templates/schema.js";
import { buildDeck, type Deck } from "../deck.js";
import type { DocBranding, ReportDoc } from "../doc.js";
import { deckTheme, type DeckTheme } from "../themes/deck-themes.js";
import { themePalette, type ThemePalette } from "../themes/palette.js";
import { deckChartXml } from "./chart-style.js";
import { chartPart, type ChartPart } from "./charts.js";
import { bodyLayoutXml, makeCtx, notesMasterXml, notesSlideXml, slideMasterXml, themeXml, titleLayoutXml } from "./master.js";
import { appXml, coreXml, CT, packageDate, presentationParts, PRES_PROPS, relsName, rootRels, TABLE_STYLES, VIEW_PROPS, writePackage, type Part } from "./package.js";
import { buildSlide, LOGO_TARGET } from "./slides.js";
import { REL, Rels } from "./xml.js";

export interface DeckStyle {
  theme: ThemeId;
  palette: ThemePalette;
  deck: DeckTheme;
  fonts: { body: string; heading: string };
  logo?: DocBranding["logo"];
  footer: string;
  paper?: never;
}

export const CHART_WARNING = "Deck: a chart couldn't be drawn (docx chart layout changed); its table is shown instead.";

/** The deck style for a document: its theme, the palette from its colours, theme fonts unless the branding sets its own. */
export function deckStyle(doc: ReportDoc): DeckStyle {
  const b = doc.branding;
  const t = deckTheme(b.theme);
  // As in 0.3.0: the heading falls back to the branding's body font before the theme's heading font.
  const fonts = { body: b.fonts.body ?? t.fonts.body, heading: b.fonts.heading ?? b.fonts.body ?? t.fonts.heading };
  return { theme: b.theme, palette: themePalette(b.primaryColor, b.accentColor), deck: t, fonts, ...(b.logo ? { logo: b.logo } : {}), footer: doc.footer };
}

async function render(deck: Deck, style: DeckStyle): Promise<{ data: Buffer; warnings: string[] }> {
  if (!deck.slides.length) throw new Error("the deck has no slides");
  const x = makeCtx(style.theme, style.deck, style.palette, style.fonts, style.footer);
  const warnings: string[] = [];
  const parts: Part[] = [];
  const add = (name: string, data: string | Buffer, contentType?: string) => parts.push({ name, data, ...(contentType ? { contentType } : {}) });
  const addRels = (part: string, rels: Rels) => add(relsName(part), rels.xml());

  // Slides first (they decide which charts, notes and media exist).
  const slideParts: Part[] = [];
  const extra: Part[] = [];
  let charts = 0;
  let notes = 0;
  let logoUsed = false;
  for (let i = 0; i < deck.slides.length; i++) {
    const s = deck.slides[i]!;
    let part: ChartPart | null | undefined;
    if (s.kind === "section" && s.chart) {
      part = await chartPart(s.chart, { primary: style.palette.primary, font: style.fonts.body });
      if (part) part = { ...part, xml: deckChartXml(part.xml, s.chart) };
    }
    const built = buildSlide(x, s, { number: i + 1, chart: part, chartNo: charts + 1, ...(style.logo ? { logo: style.logo } : {}) });
    if (built.chartFailed && !warnings.includes(CHART_WARNING)) warnings.push(CHART_WARNING);
    const name = `ppt/slides/slide${i + 1}.xml`;
    if (built.chart) {
      charts = built.chart.no;
      const chartName = `ppt/charts/chart${built.chart.no}.xml`;
      const chartRels = new Rels();
      chartRels.add(REL.package, `../embeddings/workbook${built.chart.no}.xlsx`);
      extra.push({ name: chartName, data: built.chart.part.xml, contentType: CT.chart }, { name: relsName(chartName), data: chartRels.xml() }, { name: `ppt/embeddings/workbook${built.chart.no}.xlsx`, data: built.chart.part.workbook });
    }
    if (built.notes) {
      notes++;
      const notesName = `ppt/notesSlides/notesSlide${i + 1}.xml`;
      built.rels.add(REL.notesSlide, `../notesSlides/notesSlide${i + 1}.xml`);
      const nr = new Rels();
      nr.add(REL.notesMaster, "../notesMasters/notesMaster1.xml");
      nr.add(REL.slide, `../slides/slide${i + 1}.xml`);
      extra.push({ name: notesName, data: notesSlideXml(x, built.notes), contentType: CT.notesSlide }, { name: relsName(notesName), data: nr.xml() });
    }
    logoUsed ||= built.logo;
    slideParts.push({ name, data: built.xml, contentType: CT.slide }, { name: relsName(name), data: built.rels.xml() });
  }

  const meta = { ...deck.meta, date: packageDate(deck.meta.generatedAt) };
  addRels("", rootRels());
  add("docProps/core.xml", coreXml(meta), CT.core);
  add("docProps/app.xml", appXml(meta, deck.slides.length, notes), CT.app);
  const pres = presentationParts(deck.slides.length);
  add("ppt/presentation.xml", pres.xml, CT.presentation);
  addRels("ppt/presentation.xml", pres.rels);
  add("ppt/presProps.xml", PRES_PROPS, CT.presProps);
  add("ppt/viewProps.xml", VIEW_PROPS, CT.viewProps);
  add("ppt/tableStyles.xml", TABLE_STYLES, CT.tableStyles);

  const masterRels = new Rels();
  masterRels.add(REL.slideLayout, "../slideLayouts/slideLayout1.xml");
  masterRels.add(REL.slideLayout, "../slideLayouts/slideLayout2.xml");
  masterRels.add(REL.theme, "../theme/theme1.xml");
  add("ppt/slideMasters/slideMaster1.xml", slideMasterXml(x), CT.slideMaster);
  addRels("ppt/slideMasters/slideMaster1.xml", masterRels);
  for (const [n, xml] of [[1, titleLayoutXml(x)], [2, bodyLayoutXml(x)]] as const) {
    const r = new Rels();
    r.add(REL.slideMaster, "../slideMasters/slideMaster1.xml");
    add(`ppt/slideLayouts/slideLayout${n}.xml`, xml, CT.slideLayout);
    addRels(`ppt/slideLayouts/slideLayout${n}.xml`, r);
  }
  const nmRels = new Rels();
  nmRels.add(REL.theme, "../theme/theme2.xml");
  add("ppt/notesMasters/notesMaster1.xml", notesMasterXml(x), CT.notesMaster);
  addRels("ppt/notesMasters/notesMaster1.xml", nmRels);
  add("ppt/theme/theme1.xml", themeXml(x), CT.theme);
  add("ppt/theme/theme2.xml", themeXml(x), CT.theme);

  parts.push(...slideParts, ...extra);
  if (logoUsed && style.logo) add(`ppt/media/${LOGO_TARGET(style.logo.mime).slice("../media/".length)}`, style.logo.data);
  return { data: await writePackage(parts, meta.date), warnings };
}

/** The writer: a deck model and a style in, .pptx bytes out (deterministic for the same input). */
export async function renderDeck(deck: Deck, style: DeckStyle): Promise<Buffer> {
  return (await render(deck, style)).data;
}

/** buildDeck(doc) + a style from doc.branding + renderDeck; `warnings` are the deck's (operator-only). */
export async function toPptx(doc: ReportDoc): Promise<{ data: Buffer; warnings: string[] }> {
  const deck = buildDeck(doc);
  const out = await render(deck, deckStyle(doc));
  return { data: out.data, warnings: [...deck.warnings, ...out.warnings] };
}
