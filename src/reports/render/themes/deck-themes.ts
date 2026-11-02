/**
 * PowerPoint themes (P-C6): one slide-master design per report theme. Units: inches and points. Colours are palette
 * roles or fixed #rrggbb neutrals (palette.ts); fonts are Office family names (P-C5). A few theme details the type
 * can't express (minimal's cover rule, bold's grey heading rule, friendly's rounded side panel) are drawn by
 * pptx/master.ts and pptx/slides.ts from the theme id.
 */
import type { ThemeId } from "../../templates/schema.js";
import type { Colour } from "./palette.js";

export interface DeckTheme {
  /**
   * Family names installed with both macOS and Windows (Keynote and Quick Look fall back to Times for a family the
   * Mac doesn't have, so cards uses Arial here where Word uses Calibri).
   */
  fonts: { body: string; heading: string };
  /** Body slides. */
  background: Colour;
  title: {
    fill: "primary" | "dark" | null;
    panel: "full" | "rounded" | null;
    strip: { side: "top" | "bottom" | "left"; color: Colour; size: number } | null;
    titleSize: number;
    titleBold: boolean;
    titleColor: Colour;
    kickerColor: Colour;
  };
  heading: {
    size: number;
    bold: boolean;
    color: Colour;
    rule: { pos: "below" | "above"; color: Colour; weight: number; width: "full" | number } | null;
    /** Cards: a short primary bar left of the title. */
    bar: boolean;
    /** Friendly. */
    pill: boolean;
    /** Consulting. */
    numbered: boolean;
  };
  kpi: {
    shape: "rounded" | "square" | null;
    fill: Colour | null;
    border: Colour | null;
    topRule: { color: Colour; weight: number } | null;
    separators: boolean;
    valueSize: number;
    valueBold: boolean;
    valueColor: Colour;
    labelCaps: boolean;
    labelItalic: boolean;
    /** The change as a tinted chip (cards, bold, friendly), else coloured text. */
    chip: boolean;
  };
  table: { headerColor: Colour; headerBold: boolean; headerCaps: boolean; headerItalic: boolean; headerRule: { color: Colour; weight: number }; zebra: Colour | null };
  /** The bullet panel beside a chart, the summary banner and the key-numbers verdict. */
  callout: { fill: Colour | null; left: { color: Colour; weight: number } | null };
  /**
   * How content blocks sit on body slides (the brief's theme surfaces). `card`: every chart, table and record sits
   * in a rounded card (radius in inches); null draws no panel (structure comes from rules and whitespace).
   * `edgeBlock`: a primary block bleeding off the right edge of the agenda and key-numbers slides (bold).
   * `labelColumn`: commentary gets a small caps label column on its left (consulting). `lead`: the summary's and
   * text slides' first sentence is a large serif lead (editorial).
   */
  surface: { card: { radius: number; fill: Colour; border: Colour | null } | null; edgeBlock: boolean; labelColumn: boolean; lead: boolean };
}

/** A hairline: 0.75 pt. */
const THIN = 0.75;

const CARDS: DeckTheme = {
  fonts: { body: "Arial", heading: "Arial" },
  background: "#f4f6f9",
  title: { fill: "primary", panel: "full", strip: { side: "bottom", color: "accent", size: 0.1 }, titleSize: 56, titleBold: true, titleColor: "onFill", kickerColor: "onFillSoft" },
  heading: { size: 28, bold: true, color: "primaryInk", rule: null, bar: true, pill: false, numbered: false },
  kpi: { shape: "rounded", fill: "#ffffff", border: "#E4E7EB", topRule: null, separators: false, valueSize: 66, valueBold: true, valueColor: "ink", labelCaps: true, labelItalic: false, chip: true },
  table: { headerColor: "muted", headerBold: true, headerCaps: true, headerItalic: false, headerRule: { color: "#CBD2D9", weight: 1 }, zebra: "#F7F8FA" },
  callout: { fill: "tint", left: null },
  surface: { card: { radius: 0.12, fill: "#ffffff", border: "#E4E7EB" }, edgeBlock: false, labelColumn: false, lead: false },
};

const MINIMAL: DeckTheme = {
  fonts: { body: "Arial", heading: "Arial" },
  background: "#ffffff",
  title: { fill: null, panel: null, strip: null, titleSize: 60, titleBold: false, titleColor: "ink", kickerColor: "muted" },
  heading: { size: 30, bold: false, color: "ink", rule: { pos: "below", color: "ink", weight: THIN, width: "full" }, bar: false, pill: false, numbered: false },
  kpi: { shape: null, fill: null, border: null, topRule: null, separators: true, valueSize: 72, valueBold: false, valueColor: "ink", labelCaps: true, labelItalic: false, chip: false },
  table: { headerColor: "muted", headerBold: false, headerCaps: true, headerItalic: false, headerRule: { color: "ink", weight: THIN }, zebra: null },
  callout: { fill: null, left: null },
  surface: { card: null, edgeBlock: false, labelColumn: false, lead: false },
};

const EDITORIAL: DeckTheme = {
  fonts: { body: "Georgia", heading: "Georgia" },
  background: "#ffffff",
  title: { fill: null, panel: null, strip: { side: "top", color: "primary", size: 0.14 }, titleSize: 60, titleBold: false, titleColor: "ink", kickerColor: "primaryInk" },
  heading: { size: 34, bold: false, color: "ink", rule: { pos: "below", color: "ink", weight: THIN, width: "full" }, bar: false, pill: false, numbered: false },
  kpi: { shape: null, fill: null, border: null, topRule: { color: "ink", weight: 3 }, separators: false, valueSize: 60, valueBold: false, valueColor: "ink", labelCaps: false, labelItalic: true, chip: false },
  table: { headerColor: "muted", headerBold: false, headerCaps: false, headerItalic: true, headerRule: { color: "ink", weight: THIN }, zebra: null },
  callout: { fill: "#FAF8F3", left: null },
  surface: { card: null, edgeBlock: false, labelColumn: false, lead: true },
};

/** Bold's heading: a short primary bar (0.6 × 0.06 in) over a full-width #DFE3E8 rule that the slide master draws. */
const BOLD: DeckTheme = {
  fonts: { body: "Arial", heading: "Arial Black" },
  background: "#ffffff",
  title: { fill: "dark", panel: "full", strip: { side: "bottom", color: "primary", size: 0.1 }, titleSize: 54, titleBold: true, titleColor: "onFill", kickerColor: "onFillSoft" },
  heading: { size: 30, bold: true, color: "dark", rule: { pos: "below", color: "primary", weight: 4.32, width: 0.6 }, bar: false, pill: false, numbered: false },
  kpi: { shape: null, fill: null, border: null, topRule: { color: "primary", weight: 4 }, separators: false, valueSize: 72, valueBold: true, valueColor: "dark", labelCaps: true, labelItalic: false, chip: true },
  table: { headerColor: "dark", headerBold: true, headerCaps: true, headerItalic: false, headerRule: { color: "dark", weight: 1.5 }, zebra: "#F7F9FB" },
  callout: { fill: "#F5F7FA", left: { color: "primary", weight: 4 } },
  surface: { card: null, edgeBlock: true, labelColumn: false, lead: false },
};

const CONSULTING: DeckTheme = {
  fonts: { body: "Arial", heading: "Arial" },
  background: "#ffffff",
  title: { fill: null, panel: null, strip: { side: "left", color: "primary", size: 0.28 }, titleSize: 54, titleBold: false, titleColor: "ink", kickerColor: "primaryInk" },
  heading: { size: 28, bold: false, color: "ink", rule: { pos: "above", color: "ink", weight: THIN, width: "full" }, bar: false, pill: false, numbered: true },
  kpi: { shape: null, fill: null, border: null, topRule: { color: "ink", weight: THIN }, separators: true, valueSize: 60, valueBold: false, valueColor: "primaryInk", labelCaps: true, labelItalic: false, chip: false },
  table: { headerColor: "muted", headerBold: false, headerCaps: true, headerItalic: false, headerRule: { color: "ink", weight: THIN }, zebra: null },
  callout: { fill: "#F6F7F9", left: null },
  surface: { card: null, edgeBlock: false, labelColumn: true, lead: false },
};

const FRIENDLY: DeckTheme = {
  fonts: { body: "Trebuchet MS", heading: "Trebuchet MS" },
  background: "wash",
  title: { fill: "primary", panel: "rounded", strip: null, titleSize: 54, titleBold: true, titleColor: "onFill", kickerColor: "onFillSoft" },
  heading: { size: 24, bold: true, color: "tintInk", rule: null, bar: false, pill: true, numbered: false },
  kpi: { shape: "rounded", fill: "#ffffff", border: "#E3E8EF", topRule: null, separators: false, valueSize: 60, valueBold: true, valueColor: "ink", labelCaps: false, labelItalic: false, chip: true },
  table: { headerColor: "muted", headerBold: true, headerCaps: false, headerItalic: false, headerRule: { color: "#E3E8EF", weight: THIN }, zebra: "wash" },
  callout: { fill: "warm", left: null },
  surface: { card: { radius: 0.2, fill: "#ffffff", border: "#E3E8EF" }, edgeBlock: false, labelColumn: false, lead: false },
};

const DECK_THEMES: Record<ThemeId, DeckTheme> = { cards: CARDS, minimal: MINIMAL, editorial: EDITORIAL, bold: BOLD, consulting: CONSULTING, friendly: FRIENDLY };

export function deckTheme(id: ThemeId): DeckTheme {
  return DECK_THEMES[id] ?? CARDS;
}
