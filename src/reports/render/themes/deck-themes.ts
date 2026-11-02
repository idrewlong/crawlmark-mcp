/**
 * PowerPoint themes. T0 stub: the types are final and cards is complete; the other ids return the cards values
 * until the PPTX writer stream (T3a) fills them in. Units: inches and points.
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

const CARDS: DeckTheme = {
  fonts: { body: "Calibri", heading: "Calibri" },
  background: "#f4f6f9",
  title: { fill: "primary", panel: "full", strip: { side: "bottom", color: "accent", size: 0.1 }, titleSize: 40, titleBold: true, titleColor: "onFill", kickerColor: "onFillSoft" },
  heading: { size: 26, bold: true, color: "primaryInk", rule: null, bar: true, pill: false, numbered: false },
  kpi: { shape: "rounded", fill: "#ffffff", border: "#E4E7EB", topRule: null, separators: false, valueSize: 32, valueBold: true, valueColor: "ink", labelCaps: true, labelItalic: false },
  table: { headerColor: "muted", headerBold: true, headerCaps: true, headerItalic: false, headerRule: { color: "#CBD2D9", weight: 1 }, zebra: "#F7F8FA" },
  callout: { fill: "warm", left: { color: "primary", weight: 3 } },
};

export function deckTheme(_id: ThemeId): DeckTheme {
  return CARDS;
}
