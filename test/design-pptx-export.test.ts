/**
 * 0.4.0 T3a: export_report with formats ["pptx"], end to end through the real deck model (deck.ts, T3c) and
 * the real chart harvest (pptx/charts.ts, T3b). Replaces test/design-export-pptx-stub.test.ts.
 *
 * The deck-dependent cases skip while deck.ts is still the T0 stub (on the T3a branch before T3c is merged); after
 * the merge they all run.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { exportReport } from "../src/reports/export.js";
import { reportRelPath } from "../src/reports/paths.js";
import { buildDeck } from "../src/reports/render/deck.js";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { chartPart } from "../src/reports/render/pptx/charts.js";
import type { TemplateReport } from "../src/reports/report-types.js";
import { fixtureReport } from "./fixtures/reports/report.js";
import { POSIX_MODES } from "./platform.js";

const printer = vi.fn(async () => Buffer.from("%PDF-1.7 fake"));
const tmp = () => join(mkdtempSync(join(tmpdir(), "crawlmark-pptx-export-")), "reports");
const opts = (dir: string, extra = {}) => ({ formats: ["pptx"] as "pptx"[], reportsDir: dir, branding: {}, version: "0.4.0", printer, ...extra });

const SECRET = "ZZINTERNALZZ the client is unhappy with the Q2 pricing";
const narrative = {
  summary: { client: "A strong month for search. Impressions followed.", internal: `${SECRET} (summary)` },
  sections: { search: { client: "Clicks rose on the service pages. Two pages reached page one.", internal: `${SECRET} (search)` } },
  internal: `${SECRET} (general)`,
};

async function deckBuilt(): Promise<boolean> {
  try {
    buildDeck(buildReportDoc(await fixtureReport(), { branding: {}, version: "0.4.0" }));
    return true;
  } catch (err) {
    if (err instanceof Error && /not built yet/.test(err.message)) return false;
    throw err;
  }
}
const BUILT = await deckBuilt();

/** Every part of a .pptx as text, with each embedded workbook's parts unzipped too. */
async function allText(buf: Buffer): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const zip = await JSZip.loadAsync(buf);
  for (const name of Object.keys(zip.files).sort()) {
    const f = zip.file(name);
    if (!f) continue;
    if (name.endsWith(".xlsx")) {
      const wb = await JSZip.loadAsync(await f.async("nodebuffer"));
      for (const n of Object.keys(wb.files)) if (wb.file(n)) out.set(`${name}!${n}`, await wb.file(n)!.async("string"));
    } else if (!/\.(png|jpeg)$/.test(name)) out.set(name, await f.async("string"));
  }
  return out;
}

/** The monthly fixture with `n` copies of its search section (chart and table), each with commentary: two slides each. */
async function manySections(n: number): Promise<{ report: TemplateReport; narrative: { sections: Record<string, string> } }> {
  const r = await fixtureReport();
  const search = r.sections.find((s) => s.id === "search")!;
  r.sections = Array.from({ length: n }, (_, i) => ({ ...search, id: `s${i + 1}`, title: `Section ${i + 1}` }));
  return { report: r, narrative: { sections: Object.fromEntries(r.sections.map((s) => [s.id, "Clicks rose on the service pages.\n\n- Keep the FAQ blocks"])) } };
}

describe("export_report pptx", () => {
  it("the file extension is .pptx", () => {
    expect(reportRelPath("example.com", "2026-09", "monthly", { startDate: "2026-09-01", endDate: "2026-09-30" }, "pptx").file).toBe("monthly-2026-09.pptx");
  });

  it("a narrative naming DataForSEO makes a pptx-only export refuse before anything is written", async () => {
    const dir = tmp();
    await expect(exportReport(await fixtureReport(), opts(dir, { narrative: { summary: "We used DataForSEO for this." } }))).rejects.toThrow(/DataForSEO/);
    expect(existsSync(dir) ? readdirSync(dir, { recursive: true }) : []).toEqual([]);
  });

  describe.skipIf(!BUILT)("with the deck model", () => {
    it("writes <template>-<period>.pptx (0600) with one slide per deck slide and a chart part per chart slide", async () => {
      const dir = tmp();
      const report = await fixtureReport();
      const out = await exportReport(report, opts(dir));
      expect(out.files.map((f) => f.format)).toEqual(["pptx"]);
      const path = out.files[0]!.path;
      expect(path).toBe(join(dir, "example.com", "2026-09", "monthly-2026-09.pptx"));
      if (POSIX_MODES) expect(statSync(path).mode & 0o777).toBe(0o600);
      const deck = buildDeck(buildReportDoc(report, { branding: {}, version: "0.4.0" }));
      const zip = await JSZip.loadAsync(readFileSync(path));
      const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      expect(slides).toHaveLength(deck.slides.length);
      const charts = Object.keys(zip.files).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
      const chartSlides = deck.slides.filter((s) => s.kind === "section" && s.chart);
      // Every chart is drawn natively when chartPart works (it returns null only if docx's layout changed).
      const drawable = (await Promise.all(chartSlides.map(async (s) => (s.kind === "section" && s.chart ? chartPart(s.chart, { primary: "#1f5ea8", font: "Calibri" }) : null)))).filter(Boolean).length;
      expect(charts).toHaveLength(drawable);
      expect(drawable).toBe(chartSlides.length);
    });

    it("two exports of the same report are byte-identical", async () => {
      const report = await fixtureReport();
      const a = await exportReport(report, opts(tmp()));
      const b = await exportReport(report, opts(tmp()));
      expect(readFileSync(a.files[0]!.path).equals(readFileSync(b.files[0]!.path))).toBe(true);
    });

    it("white label: no crawlmark, Claude or DataForSEO in any part (embedded workbooks included); no generator in docProps", async () => {
      const dir = tmp();
      const out = await exportReport(await fixtureReport(), opts(dir, { branding: { hideCrawlmark: true, agencyName: "Example Agency" } }));
      const parts = await allText(readFileSync(out.files[0]!.path));
      for (const [name, xml] of parts) expect(xml, name).not.toMatch(/crawlmark|claude|dataforseo/i);
      expect(parts.get("docProps/core.xml")).toContain("<dc:creator>Example Agency</dc:creator>");
      expect(parts.get("docProps/app.xml")).toContain("<Application>Example Agency</Application>");
    });

    it("internal notes appear in no part; the notes slides carry the client commentary", async () => {
      const dir = tmp();
      const out = await exportReport(await fixtureReport(), opts(dir, { narrative }));
      const pptx = out.files.find((f) => f.format === "pptx")!;
      const parts = await allText(readFileSync(pptx.path));
      for (const [name, xml] of parts) expect(xml, name).not.toContain("ZZINTERNALZZ");
      const notes = [...parts].filter(([n]) => n.startsWith("ppt/notesSlides/notesSlide") && n.endsWith(".xml")).map(([, x]) => x).join("\n");
      expect(notes).toContain("Clicks rose on the service pages. Two pages reached page one.");
      expect(notes).toContain("A strong month for search. Impressions followed.");
      // the internal notes still get their own file
      expect(out.files.some((f) => f.audience === "internal")).toBe(true);
    });

    it("a 40-section report stays within 50 slides and the cap warning is in the result", async () => {
      const { report, narrative: many } = await manySections(40);
      const out = await exportReport(report, opts(tmp(), { narrative: many }));
      expect(out.warnings.some((w) => /^Deck: \d+ slide\(s\) left out to stay within 50: /.test(w))).toBe(true);
      const zip = await JSZip.loadAsync(readFileSync(out.files[0]!.path));
      expect(Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length).toBeLessThanOrEqual(50);
    });

    it("pptx alongside other formats; every theme renders", async () => {
      for (const theme of ["cards", "minimal", "editorial", "bold", "consulting", "friendly"] as const) {
        const out = await exportReport(await fixtureReport(), opts(tmp(), { formats: ["md", "pptx"], theme }));
        expect(out.files.map((f) => f.format), theme).toEqual(["md", "pptx"]);
        expect(out.warnings.filter((w) => /PPTX not written/.test(w))).toEqual([]);
      }
    });
  });
});
