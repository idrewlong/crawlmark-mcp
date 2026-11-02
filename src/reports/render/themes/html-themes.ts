/**
 * HTML and PDF themes. Each theme is the approved mockup CSS (themes/css/<id>.ts) layered after the built-in
 * stylesheet, with its colours either fixed neutrals or variables derived from the branding (palette.ts). Cards is
 * the built-in look: no extra CSS, and no font block unless the branding sets fonts (the 0.3.0 rules).
 * Fonts are local family names only (B-D4): no web fonts, no @import, no url().
 */
import type { ThemeId } from "../../templates/schema.js";
import type { ThemePalette } from "./palette.js";
import { CSS as BOLD, ONEPAGE_CSS as BOLD_ONEPAGE } from "./css/bold.js";
import { CSS as CONSULTING, ONEPAGE_CSS as CONSULTING_ONEPAGE } from "./css/consulting.js";
import { CSS as EDITORIAL, ONEPAGE_CSS as EDITORIAL_ONEPAGE } from "./css/editorial.js";
import { CSS as FRIENDLY, ONEPAGE_CSS as FRIENDLY_ONEPAGE } from "./css/friendly.js";
import { CSS as MINIMAL } from "./css/minimal.js";

export interface HtmlTheme {
  id: ThemeId;
  /** Theme defaults; null for cards (the 0.3.0 rules apply: no font block unless branding sets fonts). */
  fonts: { body: string; heading: string } | null;
  /** `:root { … }` with palette-derived variables ("" for themes without any). */
  vars(p: ThemePalette): string;
  /** Static CSS appended after the built-in stylesheet ("" for cards). */
  css: string;
  /** Appended after `css` when the layout is onepage ("" when none is needed). */
  onepageCss: string;
}

const HELVETICA = '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", "Nimbus Sans", sans-serif';
const SERIF_BODY = 'Georgia, Cambria, "Times New Roman", "Liberation Serif", "DejaVu Serif", serif';
const SERIF_HEADING = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", "URW Palladio L", P052, Georgia, serif';
const AVENIR = '"Avenir Next", Avenir, "Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", sans-serif';
const CONSULTING_SANS = '"Helvetica Neue", "Segoe UI", Arial, "Liberation Sans", sans-serif';
const FRIENDLY_SANS = '"Avenir Next", Nunito, "Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", sans-serif';

const NO_VARS = () => "";

const THEMES: Record<ThemeId, HtmlTheme> = {
  cards: { id: "cards", fonts: null, vars: NO_VARS, css: "", onepageCss: "" },
  minimal: { id: "minimal", fonts: { body: HELVETICA, heading: HELVETICA }, vars: NO_VARS, css: MINIMAL, onepageCss: "" },
  editorial: { id: "editorial", fonts: { body: SERIF_BODY, heading: SERIF_HEADING }, vars: NO_VARS, css: EDITORIAL, onepageCss: EDITORIAL_ONEPAGE },
  bold: {
    id: "bold",
    fonts: { body: AVENIR, heading: AVENIR },
    vars: (p) => `:root { --dark: ${p.dark}; --on-dark: ${p.onDark}; --on-dark-soft: ${p.onDarkSoft}; --on-dark-subtle: ${p.onDarkSubtle}; --dark-rule: ${p.darkRule}; --surface: #ffffff; }`,
    css: BOLD,
    onepageCss: BOLD_ONEPAGE,
  },
  consulting: { id: "consulting", fonts: { body: CONSULTING_SANS, heading: CONSULTING_SANS }, vars: NO_VARS, css: CONSULTING, onepageCss: CONSULTING_ONEPAGE },
  friendly: {
    id: "friendly",
    fonts: { body: FRIENDLY_SANS, heading: FRIENDLY_SANS },
    vars: (p) =>
      `:root { --surface: ${p.wash}; --zebra: ${p.wash}; --rule: #e3e8ef; --tint: ${p.tint}; --tint-ink: ${p.tintInk}; --warm: ${p.warm}; --chip-bg: ${p.chipBg}; --on-chip-soft: ${p.onChipSoft}; }`,
    css: FRIENDLY,
    onepageCss: FRIENDLY_ONEPAGE,
  },
};

export function htmlTheme(id: ThemeId): HtmlTheme {
  return THEMES[id];
}
