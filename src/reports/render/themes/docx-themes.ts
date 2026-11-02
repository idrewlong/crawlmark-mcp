/**
 * Word themes. T0 stub: the types are final and cards reproduces docx.ts's 0.3.0 values exactly; the other ids
 * return the cards values until the Word stream (T2) fills them in. Units: font sizes in half-points, borders in
 * eighths of a point (Word's maximum is 96), margins in twips.
 */
import type { ThemeId } from "../../templates/schema.js";
import type { Colour } from "./palette.js";

export interface Rule {
  color: Colour;
  size: number;
}

export interface DocxTheme {
  /** Word family names. */
  fonts: { body: string; heading: string };
  cover: {
    fill: "primary" | "dark" | null;
    border: { side: "top" | "bottom" | "left"; rule: Rule } | null;
    margins: { top: number; bottom: number; left: number; right: number };
    /** `spacing` is in twentieths of a point. */
    kicker: { size: number; bold: boolean; color: Colour; spacing?: number };
    title: { size: number; bold: boolean; color: Colour };
    subtitle: { size: number; italic: boolean; color: Colour };
    metaRule: Rule | null;
  };
  heading2: { size: number; bold: boolean; color: Colour; italic?: boolean; top: Rule | null; bottom: Rule | null; shading: Colour | null; numbered: boolean };
  heading3: { italic: boolean; bold: boolean };
  table: { headerSize: number; headerBold: boolean; headerCaps: boolean; headerItalic: boolean; headerColor: Colour; headerRule: Rule; rowRule: Rule | null; zebra: Colour | null };
  kpi: {
    fill: Colour | null;
    top: Rule | null;
    separator: Rule | null;
    box: Rule | null;
    labelCaps: boolean;
    labelItalic: boolean;
    labelColor: Colour;
    valueSize: number;
    valueBold: boolean;
    valueColor: Colour;
  };
  callout: { fill: Colour | null; left: Rule | null; topBottom: Rule | null; labelCaps: boolean; labelItalic: boolean; labelBold: boolean; labelColor: Colour; labelSize: number };
}

const CARDS: DocxTheme = {
  fonts: { body: "Calibri", heading: "Calibri" },
  cover: {
    fill: "primary",
    border: { side: "bottom", rule: { color: "accent", size: 36 } },
    margins: { top: 260, bottom: 220, left: 320, right: 320 },
    kicker: { size: 16, bold: true, color: "onFillSoft" },
    title: { size: 52, bold: true, color: "onFill" },
    subtitle: { size: 24, italic: false, color: "onFillSoft" },
    metaRule: null,
  },
  heading2: { size: 28, bold: true, color: "primaryInk", top: null, bottom: { color: "#E4E7EB", size: 6 }, shading: null, numbered: false },
  heading3: { italic: false, bold: true },
  table: { headerSize: 15, headerBold: true, headerCaps: true, headerItalic: false, headerColor: "muted", headerRule: { color: "#CBD2D9", size: 8 }, rowRule: { color: "#E4E7EB", size: 4 }, zebra: "#F7F8FA" },
  kpi: { fill: "#F1F4F8", top: null, separator: null, box: null, labelCaps: true, labelItalic: false, labelColor: "muted", valueSize: 40, valueBold: true, valueColor: "ink" },
  callout: { fill: "warm", left: { color: "primary", size: 24 }, topBottom: null, labelCaps: true, labelItalic: false, labelBold: true, labelColor: "primaryInk", labelSize: 15 },
};

export function docxTheme(_id: ThemeId): DocxTheme {
  return CARDS;
}
