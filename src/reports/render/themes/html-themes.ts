/**
 * HTML and PDF themes. T0 stub: the types are final and cards (no extra CSS, the 0.3.0 rules) is complete; the
 * other ids return the cards values until the HTML stream (T1) fills them in.
 */
import type { ThemeId } from "../../templates/schema.js";
import type { ThemePalette } from "./palette.js";

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

const CARDS: HtmlTheme = { id: "cards", fonts: null, vars: () => "", css: "", onepageCss: "" };

export function htmlTheme(id: ThemeId): HtmlTheme {
  return id === "cards" ? CARDS : { ...CARDS, id };
}
