/**
 * The template builder's preview (Phase 13 C, D20): the draft template rendered as one HTML file with the
 * same made-up example.com numbers as the branding preview. Sections the sample has data for (search
 * performance, query and page movers, opportunities, notes) are filled in; every other section is a card
 * that says what it shows when the report runs (paid ones: "shown when the report runs with --paid"). It
 * never reads client data and makes no network or paid call. Written to
 * `<REPORTS_DIR>/.preview/<client>/<template>.html` (folders 0700, file 0600, overwritten each time).
 */
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../lib/atomic-file.js";
import { sampleReport } from "./branding-preview.js";
import { loadLogo } from "./export.js";
import { computeHighlights } from "./highlights.js";
import { safeSegment } from "./paths.js";
import type { BlockSectionData, MoversData, SectionResult, TemplateReport } from "./report-types.js";
import { buildReportDoc } from "./render/doc.js";
import { toHtml } from "./render/html.js";
import type { ResolvedBranding } from "./templates/load.js";
import { isPaidSection, SECTION_CATALOGUE, SECTION_TITLES, type SectionSpec, type TemplateSpec } from "./templates/schema.js";

/** The card text for a section with no sample data. */
export const PAID_PLACEHOLDER = "Paid section: shown when the report runs with --paid.";
export const placeholderText = (s: SectionSpec) =>
  isPaidSection(s) || s.paid === true ? PAID_PLACEHOLDER : `Sample preview: ${SECTION_CATALOGUE[s.type].summary} Filled with the client's own data when the report runs.`;

const PAGE_MOVERS: MoversData = {
  comparedWith: "previous_period",
  gainers: [
    { key: "https://example.com/services/emergency", clicks: 210, clicksDelta: 32, position: 3.1, positionDelta: -0.4, branded: false },
    { key: "https://example.com/blog/water-heaters", clicks: 140, clicksDelta: 21, position: 7.9, positionDelta: -0.9, branded: false },
  ],
  losers: [{ key: "https://example.com/services/leaks", clicks: 70, clicksDelta: -40, position: 5.0, positionDelta: 0.6, branded: false }],
};

/** The text blocks a draft can use: this file's and the global file's, by id. */
export type BlockLibrary = Record<string, { title?: string | undefined; text: string }>;

/** The draft as a sample report (pure apart from the clock): example.com numbers, the draft's sections, titles and layout. */
export function sampleTemplateReport(id: string, spec: TemplateSpec, now = new Date(), blocks: BlockLibrary = {}): TemplateReport {
  const base = sampleReport(now);
  const byType = new Map(base.sections.map((s) => [s.type, s]));
  const compare = spec.compare ?? ["previous_period", "previous_year"];
  const sections: SectionResult[] = spec.sections.map((s) => {
    const brk = s.pageBreakBefore === true ? { pageBreakBefore: true as const } : {};
    if (s.type === "block") {
      const b = blocks[s.block];
      const data: BlockSectionData = { blockId: s.block, text: b?.text ?? `The text of the block "${s.block}" appears here.` };
      return { id: s.id, type: "block", title: s.title ?? b?.title ?? SECTION_TITLES.block, status: "ok", data, ...brk };
    }
    const title = s.title ?? SECTION_TITLES[s.type];
    const sample = byType.get(s.type);
    if (sample && sample.status === "ok") return { id: s.id, type: s.type, title, status: "ok", data: sample.data, ...brk };
    if (s.type === "page_movers") return { id: s.id, type: s.type, title, status: "ok", data: PAGE_MOVERS, ...brk };
    if (s.type === "text") return { id: s.id, type: "text", title, status: "ok", data: { text: s.text }, ...brk };
    return { id: s.id, type: "text", title, status: "ok", data: { text: placeholderText(s) }, ...brk };
  });
  const report: TemplateReport = {
    ...base,
    template: {
      id,
      title: spec.title,
      source: "global",
      ...(spec.layout === "onepage" ? { layout: "onepage" as const } : {}),
      ...(spec.cover ? { cover: spec.cover } : {}),
      ...(spec.contents === true ? { contents: true as const } : {}),
    },
    period: {
      ...base.period,
      comparisons: {
        ...(compare.includes("previous_period") ? { previous_period: base.period.comparisons.previous_period! } : {}),
        ...(compare.includes("previous_year") ? { previous_year: base.period.comparisons.previous_year! } : {}),
      },
    },
    sections,
    highlights: [],
  };
  report.highlights = computeHighlights(report);
  return report;
}

/** Make a folder (0700) unless it's a symlink. */
function safeDir(dir: string): void {
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${dir}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Render the preview HTML (sample data only) and write it. Returns the file's path. */
export function renderTemplatePreview(
  reportsDir: string,
  input: { clientSlug?: string | undefined; id: string; spec: TemplateSpec; branding: ResolvedBranding; version: string; now?: Date; blocks?: BlockLibrary },
): { path: string; logoWarning?: string } {
  const { logo, warning } = loadLogo(input.branding);
  const doc = buildReportDoc(sampleTemplateReport(input.id, input.spec, input.now, input.blocks), { branding: input.branding, logo, version: input.version, sample: true });
  const html = toHtml(doc);
  const root = resolve(reportsDir);
  const previewDir = join(root, ".preview");
  const clientDir = join(previewDir, safeSegment(input.clientSlug ?? "example.com"));
  if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${root}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  safeDir(previewDir);
  safeDir(clientDir);
  const path = join(clientDir, `${safeSegment(input.id)}.html`);
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${path}`);
  writeFileAtomic(path, html, 0o600);
  return { path, ...(warning ? { logoWarning: warning } : {}) };
}
