/**
 * PowerPoint deck writer (0.4.0): crawlmark's own PresentationML, written with jszip (no pptxgenjs). T0 holds the
 * types and stubs; `renderDeck` and `toPptx` are built in T3a.
 */
import type { ThemeId } from "../../templates/schema.js";
import type { Deck } from "../deck.js";
import type { DocBranding, ReportDoc } from "../doc.js";
import type { DeckTheme } from "../themes/deck-themes.js";
import type { ThemePalette } from "../themes/palette.js";

export interface DeckStyle {
  theme: ThemeId;
  palette: ThemePalette;
  deck: DeckTheme;
  fonts: { body: string; heading: string };
  logo?: DocBranding["logo"];
  footer: string;
  paper?: never;
}

export async function renderDeck(_deck: Deck, _style: DeckStyle): Promise<Buffer> {
  throw new Error("not built yet");
}

/** buildDeck(doc) + a style from doc.branding + renderDeck; `warnings` are the deck's. */
export async function toPptx(_doc: ReportDoc): Promise<{ data: Buffer; warnings: string[] }> {
  throw new Error("not built yet");
}
