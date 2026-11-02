/**
 * PowerPoint themes (P-C6): one slide-master design per report theme. Units: inches and points. Colours are palette
 * roles or fixed #rrggbb neutrals (palette.ts); fonts are Office family names (P-C5). A few theme details the type
 * can't express (minimal's cover rule, bold's grey heading rule, friendly's rounded side panel) are drawn by
 * pptx/master.ts and pptx/slides.ts from the theme id.
 */
import type { ThemeId } from "../../templates/schema.js";
import type { Colour } from "./palette.js";

export interface DeckTheme {
  /** The same Office family names as DocxTheme. */
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
  };
  table: { headerColor: Colour; headerBold: boolean; headerCaps: boolean; headerItalic: boolean; headerRule: { color: Colour; weight: number }; zebra: Colour | null };
  /** The bullet panel beside a chart. */
  callout: { fill: Colour | null; left: { color: Colour; weight: number } | null };
}

/** A hairline: 0.75 pt. */
const THIN = 0.75;

const CARDS: DeckTheme = {
  fonts: { body: "Calibri", heading: "Calibri" },
  background: "#f4f6f9",
  title: { fill: "primary", panel: "full", strip: { side: "bottom", color: "accent", size: 0.1 }, titleSize: 40, titleBold: true, titleColor: "onFill", kickerColor: "onFillSoft" },
  heading: { size: 26, bold: true, color: "primaryInk", rule: null, bar: true, pill: false, numbered: false },
  kpi: { shape: "rounded", fill: "#ffffff", border: "#E4E7EB", topRule: null, separators: false, valueSize: 32, valueBold: true, valueColor: "ink", labelCaps: true, labelItalic: false },
  table: { headerColor: "muted", headerBold: true, headerCaps: true, headerItalic: false, headerRule: { color: "#CBD2D9", weight: 1 }, zebra: "#F7F8FA" },
  callout: { fill: "warm", left: { color: "primary", weight: 3 } },
};

const MINIMAL: DeckTheme = {
  fonts: { body: "Arial", heading: "Arial" },
  background: "#ffffff",
  title: { fill: null, panel: null, strip: null, titleSize: 44, titleBold: false, titleColor: "ink", kickerColor: "muted" },
  heading: { size: 26, bold: false, color: "ink", rule: { pos: "below", color: "ink", weight: THIN, width: "full" }, bar: false, pill: false, numbered: false },
  kpi: { shape: null, fill: null, border: null, topRule: null, separators: true, valueSize: 40, valueBold: false, valueColor: "ink", labelCaps: true, labelItalic: false },
  table: { headerColor: "muted", headerBold: false, headerCaps: true, headerItalic: false, headerRule: { color: "ink", weight: THIN }, zebra: null },
  callout: { fill: null, left: { color: "ink", weight: THIN } },
};

const EDITORIAL: DeckTheme = {
  fonts: { body: "Georgia", heading: "Georgia" },
  background: "#ffffff",
  title: { fill: null, panel: null, strip: { side: "top", color: "primary", size: 0.14 }, titleSize: 54, titleBold: false, titleColor: "ink", kickerColor: "primaryInk" },
  heading: { size: 32, bold: false, color: "ink", rule: { pos: "below", color: "ink", weight: THIN, width: "full" }, bar: false, pill: false, numbered: false },
  kpi: { shape: null, fill: null, border: null, topRule: { color: "ink", weight: 3 }, separators: false, valueSize: 40, valueBold: false, valueColor: "ink", labelCaps: false, labelItalic: true },
  table: { headerColor: "muted", headerBold: false, headerCaps: false, headerItalic: true, headerRule: { color: "ink", weight: THIN }, zebra: null },
  callout: { fill: "#FAF8F3", left: null },
};

/** Bold's heading: a short primary bar (0.6 × 0.06 in) over a full-width #DFE3E8 rule that the slide master draws. */
const BOLD: DeckTheme = {
  fonts: { body: "Arial", heading: "Arial Black" },
  background: "#ffffff",
  title: { fill: "dark", panel: "full", strip: { side: "bottom", color: "primary", size: 0.1 }, titleSize: 48, titleBold: true, titleColor: "onFill", kickerColor: "onFillSoft" },
  heading: { size: 26, bold: true, color: "dark", rule: { pos: "below", color: "primary", weight: 4.32, width: 0.6 }, bar: false, pill: false, numbered: false },
  kpi: { shape: null, fill: null, border: null, topRule: { color: "primary", weight: 4 }, separators: false, valueSize: 44, valueBold: true, valueColor: "dark", labelCaps: true, labelItalic: false },
  table: { headerColor: "dark", headerBold: true, headerCaps: true, headerItalic: false, headerRule: { color: "dark", weight: 1.5 }, zebra: "#F7F9FB" },
  callout: { fill: "#F5F7FA", left: { color: "primary", weight: 4 } },
};

const CONSULTING: DeckTheme = {
  fonts: { body: "Arial", heading: "Arial" },
  background: "#ffffff",
  title: { fill: null, panel: null, strip: { side: "left", color: "primary", size: 0.28 }, titleSize: 44, titleBold: false, titleColor: "ink", kickerColor: "primaryInk" },
  heading: { size: 26, bold: false, color: "ink", rule: { pos: "above", color: "ink", weight: THIN, width: "full" }, bar: false, pill: false, numbered: true },
  kpi: { shape: null, fill: null, border: null, topRule: { color: "ink", weight: THIN }, separators: true, valueSize: 36, valueBold: false, valueColor: "primaryInk", labelCaps: true, labelItalic: false },
  table: { headerColor: "muted", headerBold: false, headerCaps: true, headerItalic: false, headerRule: { color: "ink", weight: THIN }, zebra: null },
  callout: { fill: "#F6F7F9", left: null },
};

const FRIENDLY: DeckTheme = {
  fonts: { body: "Trebuchet MS", heading: "Trebuchet MS" },
  background: "wash",
  title: { fill: "primary", panel: "rounded", strip: null, titleSize: 40, titleBold: true, titleColor: "onFill", kickerColor: "onFillSoft" },
  heading: { size: 22, bold: true, color: "tintInk", rule: null, bar: false, pill: true, numbered: false },
  kpi: { shape: "rounded", fill: "#ffffff", border: "#E3E8EF", topRule: null, separators: false, valueSize: 32, valueBold: true, valueColor: "ink", labelCaps: false, labelItalic: false },
  table: { headerColor: "muted", headerBold: true, headerCaps: false, headerItalic: false, headerRule: { color: "#E3E8EF", weight: THIN }, zebra: "wash" },
  callout: { fill: "warm", left: null },
};

const DECK_THEMES: Record<ThemeId, DeckTheme> = { cards: CARDS, minimal: MINIMAL, editorial: EDITORIAL, bold: BOLD, consulting: CONSULTING, friendly: FRIENDLY };

export function deckTheme(id: ThemeId): DeckTheme {
  return DECK_THEMES[id] ?? CARDS;
}
