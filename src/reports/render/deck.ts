/**
 * The deck model (0.4.0): a ReportDoc condensed into slides. Pure content, theme-agnostic; the PPTX writer
 * (pptx/) draws it. T0 holds the types and constants only; `buildDeck`, `condense` and `notesText` are built in T3c.
 */
import type { Chart, DocNarrativeBlock, Kpi, ReportDoc } from "./doc.js";

export const DECK = {
  maxSlides: 50,
  maxTableRows: 8,
  maxTableRowsUnderChart: 5,
  maxTableCols: 6,
  maxCellChars: 60,
  maxSectionBullets: 3,
  maxSummaryBullets: 5,
  maxTextBullets: 6,
  maxTextSlidesPerBlock: 2,
  maxBulletChars: 140,
  maxNotesChars: 12_000,
  agendaMinSections: 4,
} as const;

export interface DeckTable {
  header: string[];
  rows: string[][];
  numeric: boolean[];
  shown: number;
  total: number;
}

export type DeckSlide =
  | { kind: "title"; title: string; kicker: string; subtitle?: string; domain?: string; entries: { label: string; value: string }[]; badge?: string; agencyName?: string; logo: boolean }
  | { kind: "agenda"; title: "Agenda"; items: string[] }
  | { kind: "kpis"; title: "Key numbers"; kpis: Kpi[]; caption?: string }
  | { kind: "summary"; title: string; bullets: string[]; caption?: string; notes?: string }
  | { kind: "section"; sectionId: string; title: string; number: number; continued: boolean; chart?: Chart; table?: DeckTable; tiles?: Kpi[]; bullets: string[]; footnotes: string[]; notes?: string }
  | { kind: "text"; sectionId: string; title: string; continued: boolean; bullets: string[]; notes?: string }
  | { kind: "closing"; title: "Thank you"; agencyName?: string; lines: string[]; logo: boolean; notes?: string };

export interface Deck {
  meta: { title: string; subject: string; author: string; company: string; generatedAt: string };
  slides: DeckSlide[];
  /** Operator-only (slides dropped by the cap); copied into the export result's warnings. */
  warnings: string[];
}

const NOT_BUILT = "not built yet";

export function buildDeck(_doc: ReportDoc): Deck {
  throw new Error(NOT_BUILT);
}

/** Exported for tests. */
export function condense(_blocks: DocNarrativeBlock[], _max: number): string[] {
  throw new Error(NOT_BUILT);
}

/** Exported for tests. */
export function notesText(_blocks: DocNarrativeBlock[]): string {
  throw new Error(NOT_BUILT);
}
