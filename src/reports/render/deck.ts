/**
 * The deck model (0.4.0): a ReportDoc condensed into slides. Pure content, theme-agnostic; the PPTX writer
 * (pptx/) draws it. Deterministic text rules only (no AI); the text is client text only, because ReportDoc carries
 * nothing else (internal notes never enter it, and white label / hideProviders wording is already applied).
 */
import { coverEntries, type Block, type Chart, type DocNarrativeBlock, type DocSection, type Kpi, type ReportDoc, type TableBlock, type Text } from "./doc.js";

export const DECK = {
  maxSlides: 50,
  maxTableRows: 8,
  maxTableRowsUnderChart: 5,
  /** A share chart keeps its table on the same slide only up to this many rows (0.5.0); longer tables continue. */
  maxTableRowsUnderShare: 3,
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
  /** A cell's colour from the report (a toned change or a good/bad/warn tag), row by row; absent when no cell has one. */
  tones?: (DeckTone | null)[][];
  /** The report's proportional bar for one numeric column (one value per shown row): drawn as in-cell bars on short tables. */
  bar?: { col: number; values: number[] };
}

export type DeckTone = "good" | "bad" | "warn";

export type DeckSlide =
  | { kind: "title"; title: string; kicker: string; subtitle?: string; domain?: string; entries: { label: string; value: string }[]; badge?: string; agencyName?: string; logo: boolean }
  | { kind: "agenda"; title: "Agenda"; items: string[]; details?: string[] }
  | { kind: "kpis"; title: "Key numbers"; kpis: Kpi[]; caption?: string; takeaway?: string }
  | { kind: "summary"; title: string; bullets: string[]; caption?: string; notes?: string }
  | { kind: "section"; sectionId: string; title: string; number: number; continued: boolean; chart?: Chart; table?: DeckTable; tiles?: Kpi[]; bullets: string[]; footnotes: string[]; notes?: string; takeaway?: string; tableBeside?: true }
  | { kind: "text"; sectionId: string; title: string; continued: boolean; bullets: string[]; notes?: string }
  | { kind: "closing"; title: "Thank you"; agencyName?: string; lines: string[]; logo: boolean; notes?: string };

export interface Deck {
  meta: { title: string; subject: string; author: string; company: string; generatedAt: string };
  slides: DeckSlide[];
  /** Operator-only (slides dropped by the cap); copied into the export result's warnings. */
  warnings: string[];
}

const ELLIPSIS = "…";
const MORE_DETAIL = "More detail in the full report.";
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"“‘(\[])/;

/** The plain text of runs: tag runs get a space on both sides; whitespace is collapsed. */
function plain(runs: Text): string {
  let out = "";
  for (const r of runs) {
    if (r.tag && out && !out.endsWith(" ")) out += " ";
    out += r.t;
    if (r.tag) out += " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Cut to `max` characters at a word boundary, strip trailing `,;:` and spaces, append "…". Text within `max` is unchanged. */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const sp = head.lastIndexOf(" ");
  const cut = (sp > 0 ? head.slice(0, sp) : head).replace(/[,;:\s]+$/, "");
  return cut + ELLIPSIS;
}

/** Table cell text: cut to `max` characters with "…" (no word-boundary search). */
const cell = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max - 1).trimEnd() + ELLIPSIS);

const firstSentence = (text: string) => {
  const m = SENTENCE_END.exec(text);
  return m ? text.slice(0, m.index) : text;
};

/**
 * Exported for tests. The key-numbers verdict, computed only from the KPI labels and changes in the report ("Clicks up
 * 17.6% and impressions up 17.6% vs August 2026"). It never repeats summary text; undefined when no KPI has a change.
 */
export function kpiVerdict(kpis: Kpi[], caption?: string): string | undefined {
  const parts = kpis.flatMap((k, i) => {
    if (!k.delta || k.delta.dir === "flat") return [];
    const label = i && /^[A-Z][a-z]/.test(k.label) ? k.label[0]!.toLowerCase() + k.label.slice(1) : k.label;
    return [/ (better|worse)$/.test(k.delta.text) ? `${label} ${k.delta.text}` : `${label} ${k.delta.dir} ${k.delta.text}`];
  });
  if (!parts.length) return undefined;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]!;
  const vs = /^Change vs (.+?) \(/.exec(caption ?? "")?.[1];
  return vs ? `${list} vs ${vs}` : list;
}

/** Exported for tests. Deterministic condensation of commentary into at most `max` bullets (first sentences, 140 characters). */
export function condense(blocks: DocNarrativeBlock[], max: number): string[] {
  const out: string[] = [];
  const push = (text: string) => {
    const t = shorten(firstSentence(text), DECK.maxBulletChars);
    if (t && !out.includes(t)) out.push(t);
  };
  for (const b of blocks) {
    if (b.kind === "p") push(plain(b.runs));
    else if (b.kind === "ul" || b.kind === "ol") for (const item of b.items) push(plain(item));
  }
  return out.slice(0, Math.max(0, max));
}

const cutNotes = (t: string) => (t.length <= DECK.maxNotesChars ? t : t.slice(0, DECK.maxNotesChars - 1) + ELLIPSIS);

/** Exported for tests. The full client commentary as plain text for the speaker notes. */
export function notesText(blocks: DocNarrativeBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "h":
      case "p":
        parts.push(plain(b.runs));
        break;
      case "ul":
        parts.push(b.items.map((i) => `- ${plain(i)}`).join("\n"));
        break;
      case "ol":
        parts.push(b.items.map((i, n) => `${b.start + n}. ${plain(i)}`).join("\n"));
        break;
      case "table":
        parts.push([b.header, ...b.rows].map((row) => row.map(plain).join(" | ")).join("\n"));
        break;
      case "chart":
        parts.push(`[Chart: ${b.chart.title}]`);
        break;
      case "chartRef":
        break;
    }
  }
  return cutNotes(parts.filter((p) => p.length).join("\n\n"));
}

const notesOf = (blocks: DocNarrativeBlock[] | undefined): { notes?: string } => {
  const t = blocks ? notesText(blocks) : "";
  return t ? { notes: t } : {};
};

/** A cell's colour: the first toned run (a change), else the first good/bad/warn tag (a severity or status). */
function cellTone(runs: Text): DeckTone | null {
  const toned = runs.find((r) => r.tone);
  if (toned?.tone) return toned.tone;
  const tag = runs.find((r) => r.tag && r.tag !== "neutral");
  return tag?.tag && tag.tag !== "neutral" ? tag.tag : null;
}

/** A closing "Total" row (every run bold, the first cell "Total"): kept when a table's rows are cut (0.5.0). */
const isTotalRow = (r: Text[] | undefined) => !!r && plain(r[0] ?? []) === "Total" && r.every((c) => c.every((run) => run.b === true));

function deckTable(t: TableBlock, limit: number): DeckTable {
  const cols = Math.min(t.header.length, DECK.maxTableCols);
  const pinTotal = t.rows.length > limit && limit > 1 && isTotalRow(t.rows.at(-1));
  const idx = pinTotal ? [...t.rows.keys()].slice(0, limit - 1).concat(t.rows.length - 1) : [...t.rows.keys()].slice(0, limit);
  const src = idx.map((i) => t.rows[i]!);
  const rows = src.map((r) => Array.from({ length: cols }, (_, i) => cell(plain(r[i] ?? []), DECK.maxCellChars)));
  const tones = src.map((r) => Array.from({ length: cols }, (_, i) => cellTone(r[i] ?? [])));
  const bar = t.bar && t.bar.col < cols && t.bar.values.length >= t.rows.length ? { col: t.bar.col, values: idx.map((i) => t.bar!.values[i]!) } : undefined;
  const out: DeckTable = {
    header: t.header.slice(0, cols).map((h) => cell(h.replace(/\s+/g, " ").trim(), DECK.maxCellChars)),
    rows,
    numeric: Array.from({ length: cols }, (_, i) => t.numeric?.[i] === true),
    shown: rows.length,
    total: t.rows.length,
    ...(tones.some((r) => r.some((c) => c !== null)) ? { tones } : {}),
    ...(bar ? { bar } : {}),
  };
  if (pinTotal) pinnedTotal.add(out);
  return out;
}
/** Deck tables whose last row is a kept Total (for the "Top n of m rows" note). */
const pinnedTotal = new WeakSet<DeckTable>();

const topNote = (t: DeckTable) => {
  if (t.shown >= t.total) return [];
  // A kept Total row isn't one of the "top" rows.
  if (pinnedTotal.has(t)) return [`Top ${t.shown - 1} of ${t.total - 1} rows and the total; the full table is in the report.`];
  return [`Top ${t.shown} of ${t.total} rows; the full table is in the report.`];
};

/** Blocks in reading order, descending into columns. */
function flat(blocks: Block[]): Block[] {
  return blocks.flatMap((b) => (b.kind === "columns" ? b.columns.flatMap(flat) : [b]));
}

type SectionSlide = Extract<DeckSlide, { kind: "section" }>;
type TextSlide = Extract<DeckSlide, { kind: "text" }>;

function sectionSlides(sec: DocSection, number: number): (SectionSlide | TextSlide)[] {
  const only = sec.blocks.length === 1 ? sec.blocks[0] : undefined;
  if (only?.kind === "rich") return textSlides(sec, only.blocks);

  const blocks = flat(sec.blocks);
  const chart = blocks.find((b): b is Extract<Block, { kind: "chart" }> => b.kind === "chart")?.chart;
  const tableBlock = blocks.find((b): b is TableBlock => b.kind === "table" && b.rows.length > 0);
  const kpis = blocks.find((b): b is Extract<Block, { kind: "kpiRow" }> => b.kind === "kpiRow")?.items ?? [];
  // The takeaway (an action subtitle under the title): the commentary's first sentence, else the chart's own summary.
  // Both are client text the report already shows; the sentence leaves the bullets so it isn't said twice.
  const C = condense(sec.commentary ?? [], DECK.maxSectionBullets + 1);
  const N = C.slice(1);
  const takeaway = C[0] ?? (chart?.summary ? shorten(firstSentence(chart.summary.replace(/\s+/g, " ").trim()), DECK.maxBulletChars) : undefined);
  const prose = blocks.filter((b): b is Extract<Block, { kind: "paragraph" | "list" }> => b.kind === "paragraph" || b.kind === "list");
  const P =
    !chart && !tableBlock && !kpis.length
      ? prose.flatMap((b) => (b.kind === "paragraph" ? [shorten(firstSentence(plain(b.text)), DECK.maxBulletChars)] : b.items.map((i) => shorten(plain(i), DECK.maxBulletChars)))).filter(Boolean)
      : [];
  const sources = blocks.filter((b): b is Extract<Block, { kind: "note" }> => b.kind === "note").map((b) => plain(b.text)).filter((t) => t.startsWith("Source:"));

  const base = { kind: "section" as const, sectionId: sec.id, title: sec.title, number, continued: false };
  const lead = takeaway ? { takeaway } : {};
  let first: SectionSlide;
  let cont: SectionSlide | undefined;
  let leftover = false;
  let tableNotes: string[] = [];
  let kpiShown = false;

  /** A tile row (up to four KPIs) and the commentary bullets beside the main block. */
  const side = () => ({ bullets: N, tiles: kpis.slice(0, 4) });
  if (chart && (N.length || kpis.length)) {
    const s = side();
    kpiShown = s.tiles.length > 0;
    leftover ||= kpis.length > s.tiles.length;
    first = { ...base, ...lead, chart, ...(s.tiles.length ? { tiles: s.tiles } : {}), bullets: s.bullets, footnotes: [] };
    if (tableBlock) {
      const t = deckTable(tableBlock, DECK.maxTableRows);
      cont = { ...base, title: `${sec.title} (continued)`, continued: true, table: t, bullets: [], footnotes: topNote(t) };
    }
  } else if (chart && chart.type === "share" && tableBlock && tableBlock.rows.length > DECK.maxTableRowsUnderShare) {
    // 0.5.0: under a share chart a drawn table keeps only two or three rows, so a longer table gets its own slide.
    first = { ...base, ...lead, chart, bullets: [], footnotes: [] };
    const t = deckTable(tableBlock, DECK.maxTableRows);
    cont = { ...base, title: `${sec.title} (continued)`, continued: true, table: t, bullets: [], footnotes: topNote(t) };
  } else if (chart) {
    const t = tableBlock ? deckTable(tableBlock, DECK.maxTableRowsUnderChart) : undefined;
    tableNotes = t ? topNote(t) : [];
    // 0.5.0: a chart of one point per month (a long period) keeps the slide's full height, its table beside it; under
    // the chart a five-row table left twelve points about an inch of plot.
    const beside = t && chart.type === "line" && chart.perMonth ? { tableBeside: true as const } : {};
    first = { ...base, ...lead, chart, ...(t ? { table: t } : {}), ...beside, bullets: [], footnotes: [] };
  } else if (tableBlock) {
    const s = side();
    // A tile row above the table leaves room for five rows.
    const t = deckTable(tableBlock, s.tiles.length ? DECK.maxTableRowsUnderChart : DECK.maxTableRows);
    tableNotes = topNote(t);
    kpiShown = s.tiles.length > 0;
    leftover ||= kpis.length > s.tiles.length;
    first = { ...base, ...lead, table: t, ...(s.tiles.length ? { tiles: s.tiles } : {}), bullets: s.bullets, footnotes: [] };
  } else if (kpis.length) {
    const tiles = kpis.slice(0, 8);
    kpiShown = true;
    leftover ||= kpis.length > tiles.length;
    first = { ...base, ...lead, tiles, bullets: N, footnotes: [] };
  } else {
    const all = [...P, ...N];
    const bullets = all.slice(0, DECK.maxSectionBullets + 2);
    leftover ||= all.length > bullets.length;
    first = { ...base, ...lead, bullets, footnotes: [] };
  }

  // Data no slide shows (a second chart, table or KPI row, text that didn't fit): the slide says the rest is in the
  // report. Sub-headings and remarks (other than sources) are left out quietly, so the line isn't on every slide.
  leftover ||= blocks.filter((b) => b.kind === "chart").length > (chart ? 1 : 0);
  leftover ||= blocks.filter((b) => b.kind === "table" && b.rows.length > 0).length > (tableBlock ? 1 : 0);
  leftover ||= blocks.filter((b) => b.kind === "kpiRow").length > (kpiShown ? 1 : 0);
  leftover ||= prose.length > 0 && !P.length;

  first.footnotes = [...sources, ...tableNotes, ...(leftover ? [MORE_DETAIL] : [])];
  const notes = notesOf(sec.commentary).notes;
  if (notes) first.notes = notes;
  return cont ? [first, cont] : [first];
}

function textSlides(sec: DocSection, blocks: DocNarrativeBlock[]): TextSlide[] {
  const per = DECK.maxTextBullets;
  const all = condense(blocks, per * DECK.maxTextSlidesPerBlock);
  const notes = notesOf(blocks);
  const out: TextSlide[] = [];
  for (let i = 0; i < DECK.maxTextSlidesPerBlock; i++) {
    const bullets = all.slice(i * per, (i + 1) * per);
    if (!bullets.length && (i > 0 || !notes.notes)) break;
    out.push({
      kind: "text",
      sectionId: sec.id,
      title: i ? `${sec.title} (continued)` : sec.title,
      continued: i > 0,
      bullets,
      // The full text rides on the first slide only.
      ...(i === 0 ? notes : {}),
    });
  }
  return out;
}

const MONTH_INDEX: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
/** ReportDoc keeps only the display date ("13 Oct 2026"); the package needs one fixed instant, so rebuild it from that (or use a constant). */
function generatedAtOf(display: string): string {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(display.trim());
  const mi = m ? MONTH_INDEX[m[2]!] : undefined;
  if (!m || mi === undefined) return "2000-01-01T00:00:00.000Z";
  return new Date(Date.UTC(Number(m[3]), mi, Number(m[1]))).toISOString();
}

const isCont = (s: DeckSlide) => (s.kind === "section" || s.kind === "text") && s.continued;
const agendaItems = (slides: DeckSlide[]) => slides.flatMap((s) => ((s.kind === "section" || s.kind === "text") && !s.continued ? [s.title] : []));
/** The agenda's one-line descriptions (a short agenda only): each section's takeaway, "" where it has none. */
const agendaDetails = (slides: DeckSlide[]) => slides.flatMap((s) => ((s.kind === "section" || s.kind === "text") && !s.continued ? [s.kind === "section" ? (s.takeaway ?? "") : ""] : []));
/** Agendas up to this long are a grid of blocks with descriptions; longer ones are numbered lists. */
export const AGENDA_GRID_MAX = 6;

export function buildDeck(doc: ReportDoc): Deck {
  const b = doc.branding;
  const agencyName = b.agencyName?.trim() ? b.agencyName : undefined;
  const logo = Boolean(b.logo);
  const cv = coverEntries(doc.meta);

  const body: DeckSlide[] = [];
  const sum = doc.summary;
  if (sum) {
    const bullets = sum.narrative?.length
      ? condense(sum.narrative, DECK.maxSummaryBullets)
      : (sum.items ?? []).map((i) => shorten(plain(i), DECK.maxBulletChars)).filter(Boolean).slice(0, DECK.maxSummaryBullets);
    if (bullets.length) body.push({ kind: "summary", title: sum.title, bullets, ...(sum.caption ? { caption: sum.caption } : {}), ...notesOf(sum.narrative) });
  }
  doc.sections.forEach((sec, i) => body.push(...sectionSlides(sec, i + 1)));

  const slides: DeckSlide[] = [
    {
      kind: "title",
      title: doc.meta.clientName,
      kicker: doc.meta.templateTitle,
      ...(doc.meta.cover.subtitle ? { subtitle: doc.meta.cover.subtitle } : {}),
      ...(cv.domain ? { domain: doc.meta.domain } : {}),
      entries: cv.entries.map((e) => ({ label: e.label, value: e.value })),
      ...(cv.badge ? { badge: doc.badge } : {}),
      ...(agencyName ? { agencyName } : {}),
      logo,
    },
  ];
  if (doc.contents || agendaItems(body).length >= DECK.agendaMinSections) slides.push({ kind: "agenda", title: "Agenda", items: [] });
  const verdict = kpiVerdict(doc.kpis, doc.kpiCaption);
  if (doc.kpis.length) slides.push({ kind: "kpis", title: "Key numbers", kpis: doc.kpis, ...(doc.kpiCaption ? { caption: doc.kpiCaption } : {}), ...(verdict ? { takeaway: verdict } : {}) });
  slides.push(...body);
  const about = doc.about.map(plain).filter(Boolean).join("\n");
  slides.push({
    kind: "closing",
    title: "Thank you",
    ...(agencyName ? { agencyName } : {}),
    lines: [...(doc.footer ? [doc.footer] : []), `Generated ${doc.meta.generated}`],
    logo,
    ...(about ? { notes: cutNotes(about) } : {}),
  });

  // The cap (D3): continuation slides from the end, then text slides, then section slides from the end.
  const warnings: string[] = [];
  const planned = slides.slice();
  const dropped = new Set<DeckSlide>();
  const dropLast = (pred: (s: DeckSlide) => boolean) => {
    for (let i = slides.length - 1; i >= 0 && slides.length > DECK.maxSlides; i--) {
      if (pred(slides[i]!)) dropped.add(slides.splice(i, 1)[0]!);
    }
  };
  dropLast(isCont);
  dropLast((s) => s.kind === "text");
  dropLast((s) => s.kind === "section");
  if (dropped.size) warnings.push(`Deck: ${dropped.size} slide(s) left out to stay within ${DECK.maxSlides}: ${planned.filter((s) => dropped.has(s)).map((s) => s.title).join(", ")}. They're in the full report.`);

  // The agenda lists the slides that remain.
  const items = agendaItems(slides);
  const details = agendaDetails(slides);
  const withDetails = items.length <= AGENDA_GRID_MAX && details.some(Boolean) ? { details } : {};
  const out = slides.flatMap((s): DeckSlide[] => (s.kind === "agenda" ? (items.length ? [{ ...s, items, ...withDetails }] : []) : [s]));

  return {
    meta: {
      title: doc.meta.title,
      subject: doc.meta.templateTitle,
      author: b.hideCrawlmark ? (agencyName ?? "") : "crawlmark",
      company: agencyName ?? "",
      generatedAt: generatedAtOf(doc.meta.generated),
    },
    slides: out,
    warnings,
  };
}
