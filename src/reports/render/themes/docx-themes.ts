/**
 * Word themes (spec P-C6). Cards reproduces docx.ts's 0.3.0 values exactly. Units: font sizes in half-points,
 * borders in eighths of a point (Word's maximum is 96), margins in twips.
 */
import type { ThemeId } from "../../templates/schema.js";
import type { Colour } from "./palette.js";

/** The Word tables also name two palette colours the shared Colour type lacks (bold's subtitle and cover rule). */
export type DocxColour = Colour | "onDarkSubtle" | "darkRule";

export interface Rule {
  color: DocxColour;
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
    kicker: { size: number; bold: boolean; color: DocxColour; spacing?: number };
    title: { size: number; bold: boolean; color: DocxColour };
    subtitle: { size: number; italic: boolean; color: DocxColour };
    /** A rule above the meta line; `before` is the space above it in twips. */
    metaRule: (Rule & { before: number }) | null;
  };
  heading2: { size: number; bold: boolean; color: DocxColour; italic?: boolean; top: Rule | null; bottom: Rule | null; shading: DocxColour | null; numbered: boolean };
  heading3: { italic: boolean; bold: boolean };
  table: { headerSize: number; headerBold: boolean; headerCaps: boolean; headerItalic: boolean; headerColor: DocxColour; headerRule: Rule; rowRule: Rule | null; zebra: DocxColour | null };
  kpi: {
    fill: DocxColour | null;
    top: Rule | null;
    separator: Rule | null;
    box: Rule | null;
    labelCaps: boolean;
    labelItalic: boolean;
    labelColor: DocxColour;
    valueSize: number;
    valueBold: boolean;
    valueColor: DocxColour;
    /** The value is set in the heading font. */
    valueHeading?: boolean;
  };
  callout: {
    fill: DocxColour | null;
    /** Cards only: the summary box is a shade lighter (this mix of primary and white) than the commentary box, as in 0.3.0. */
    summaryMix?: number;
    left: Rule | null;
    topBottom: Rule | null;
    labelCaps: boolean;
    labelItalic: boolean;
    labelBold: boolean;
    labelColor: DocxColour;
    labelSize: number;
  };
  /** Contents entries: link colour, underline, and a bold "NN." number before the title. */
  contents: { color: DocxColour; underline: boolean; numbered: boolean };
}

const ink = (size: number): Rule => ({ color: "ink", size });

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
  callout: { fill: "warm", summaryMix: 0.94, left: { color: "primary", size: 24 }, topBottom: null, labelCaps: true, labelItalic: false, labelBold: true, labelColor: "primaryInk", labelSize: 15 },
  contents: { color: "primaryInk", underline: true, numbered: false },
};

const MINIMAL: DocxTheme = {
  fonts: { body: "Arial", heading: "Arial" },
  cover: {
    fill: null,
    border: { side: "bottom", rule: ink(8) },
    margins: { top: 120, bottom: 200, left: 0, right: 0 },
    kicker: { size: 16, bold: false, color: "muted" },
    title: { size: 52, bold: false, color: "ink" },
    subtitle: { size: 24, italic: false, color: "muted" },
    metaRule: null,
  },
  heading2: { size: 26, bold: false, color: "ink", top: ink(8), bottom: null, shading: null, numbered: false },
  heading3: { italic: false, bold: true },
  table: { headerSize: 15, headerBold: true, headerCaps: true, headerItalic: false, headerColor: "muted", headerRule: ink(8), rowRule: { color: "#E6E8EB", size: 4 }, zebra: null },
  kpi: { fill: null, top: null, separator: { color: "#E6E8EB", size: 8 }, box: null, labelCaps: true, labelItalic: false, labelColor: "muted", valueSize: 44, valueBold: false, valueColor: "ink" },
  callout: { fill: null, left: ink(8), topBottom: null, labelCaps: true, labelItalic: false, labelBold: false, labelColor: "muted", labelSize: 15 },
  contents: { color: "ink", underline: false, numbered: false },
};

const EDITORIAL: DocxTheme = {
  fonts: { body: "Georgia", heading: "Georgia" },
  cover: {
    fill: null,
    border: { side: "top", rule: { color: "primary", size: 80 } },
    margins: { top: 600, bottom: 200, left: 0, right: 0 },
    kicker: { size: 18, bold: true, color: "primaryInk", spacing: 60 },
    title: { size: 88, bold: false, color: "ink" },
    subtitle: { size: 32, italic: true, color: "muted" },
    metaRule: { ...ink(8), before: 600 },
  },
  heading2: { size: 40, bold: false, color: "ink", top: null, bottom: ink(8), shading: null, numbered: false },
  heading3: { italic: true, bold: false },
  table: { headerSize: 18, headerBold: false, headerCaps: false, headerItalic: true, headerColor: "muted", headerRule: ink(8), rowRule: { color: "#E4E7EB", size: 4 }, zebra: null },
  kpi: { fill: null, top: ink(24), separator: null, box: null, labelCaps: false, labelItalic: true, labelColor: "muted", valueSize: 52, valueBold: false, valueColor: "ink", valueHeading: true },
  callout: { fill: "#FAF8F3", left: null, topBottom: ink(8), labelCaps: false, labelItalic: true, labelBold: false, labelColor: "muted", labelSize: 22 },
  contents: { color: "ink", underline: false, numbered: false },
};

const BOLD: DocxTheme = {
  fonts: { body: "Arial", heading: "Arial Black" },
  cover: {
    fill: "dark",
    border: { side: "bottom", rule: { color: "primary", size: 40 } },
    margins: { top: 300, bottom: 240, left: 320, right: 320 },
    kicker: { size: 16, bold: true, color: "onFillSoft" },
    title: { size: 60, bold: true, color: "onFill" },
    subtitle: { size: 24, italic: false, color: "onDarkSubtle" },
    metaRule: { color: "darkRule", size: 8, before: 160 },
  },
  heading2: { size: 30, bold: true, color: "dark", top: null, bottom: { color: "primary", size: 24 }, shading: null, numbered: false },
  heading3: { italic: false, bold: true },
  table: { headerSize: 15, headerBold: true, headerCaps: true, headerItalic: false, headerColor: "dark", headerRule: { color: "dark", size: 16 }, rowRule: { color: "#E4E7EB", size: 4 }, zebra: "#F7F9FB" },
  kpi: { fill: null, top: { color: "primary", size: 32 }, separator: null, box: null, labelCaps: true, labelItalic: false, labelColor: "dark", valueSize: 56, valueBold: true, valueColor: "dark" },
  callout: { fill: "#F5F7FA", left: { color: "primary", size: 36 }, topBottom: null, labelCaps: true, labelItalic: false, labelBold: true, labelColor: "dark", labelSize: 15 },
  contents: { color: "dark", underline: false, numbered: false },
};

const CONSULTING: DocxTheme = {
  fonts: { body: "Arial", heading: "Arial" },
  cover: {
    fill: null,
    border: { side: "left", rule: { color: "primary", size: 96 } },
    margins: { top: 300, bottom: 240, left: 400, right: 0 },
    kicker: { size: 16, bold: true, color: "primaryInk", spacing: 40 },
    title: { size: 60, bold: false, color: "ink" },
    subtitle: { size: 24, italic: false, color: "muted" },
    metaRule: { color: "#D9DDE2", size: 8, before: 160 },
  },
  heading2: { size: 28, bold: false, color: "ink", top: ink(8), bottom: null, shading: null, numbered: true },
  heading3: { italic: false, bold: true },
  table: { headerSize: 15, headerBold: true, headerCaps: true, headerItalic: false, headerColor: "muted", headerRule: ink(8), rowRule: { color: "#D9DDE2", size: 4 }, zebra: null },
  kpi: { fill: null, top: ink(8), separator: { color: "#D9DDE2", size: 8 }, box: null, labelCaps: true, labelItalic: false, labelColor: "muted", valueSize: 48, valueBold: false, valueColor: "primaryInk" },
  callout: { fill: "#F6F7F9", left: null, topBottom: null, labelCaps: true, labelItalic: false, labelBold: true, labelColor: "primaryInk", labelSize: 15 },
  contents: { color: "ink", underline: false, numbered: true },
};

const FRIENDLY: DocxTheme = {
  fonts: { body: "Trebuchet MS", heading: "Trebuchet MS" },
  cover: {
    fill: "primary",
    border: null,
    margins: { top: 300, bottom: 260, left: 360, right: 360 },
    kicker: { size: 16, bold: true, color: "onFillSoft" },
    title: { size: 52, bold: true, color: "onFill" },
    subtitle: { size: 24, italic: false, color: "onFillSoft" },
    metaRule: null,
  },
  heading2: { size: 26, bold: true, color: "tintInk", top: null, bottom: null, shading: "tint", numbered: false },
  heading3: { italic: false, bold: true },
  table: { headerSize: 17, headerBold: true, headerCaps: false, headerItalic: false, headerColor: "muted", headerRule: { color: "#E3E8EF", size: 6 }, rowRule: null, zebra: "wash" },
  kpi: { fill: null, top: null, separator: null, box: { color: "#E3E8EF", size: 8 }, labelCaps: false, labelItalic: false, labelColor: "muted", valueSize: 40, valueBold: true, valueColor: "ink" },
  callout: { fill: "warm", left: null, topBottom: null, labelCaps: false, labelItalic: false, labelBold: true, labelColor: "tintInk", labelSize: 20 },
  contents: { color: "ink", underline: false, numbered: false },
};

const THEMES: Record<ThemeId, DocxTheme> = { cards: CARDS, minimal: MINIMAL, editorial: EDITORIAL, bold: BOLD, consulting: CONSULTING, friendly: FRIENDLY };

export function docxTheme(id: ThemeId): DocxTheme {
  return THEMES[id];
}
