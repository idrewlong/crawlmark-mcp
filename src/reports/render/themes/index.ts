/** Report theme registry (0.4.0). Each renderer concern lives in its own file so the three streams never share one. */
import type { ThemeId } from "../../templates/schema.js";

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  description: string;
}

export const THEMES: Record<ThemeId, ThemeInfo> = {
  cards: { id: "cards", label: "Cards", description: "Today's look: a coloured cover band and boxed sections." },
  minimal: { id: "minimal", label: "Minimal", description: "No boxes or shading, thin rules and lots of white space." },
  editorial: { id: "editorial", label: "Editorial", description: "Large serif headings, a full-page cover and a two-column summary." },
  bold: { id: "bold", label: "Bold", description: "A dark cover band, heavy headings and big numbers." },
  consulting: { id: "consulting", label: "Consulting", description: "Numbered sections, a colour strip on the cover and grey caps labels." },
  friendly: { id: "friendly", label: "Friendly", description: "Rounded shapes, soft tints of your colour and pill headings." },
};

export { htmlTheme, type HtmlTheme } from "./html-themes.js";
export { docxTheme, type DocxTheme } from "./docx-themes.js";
export { deckTheme, type DeckTheme } from "./deck-themes.js";
export { themePalette, type Colour, type ThemePalette } from "./palette.js";
