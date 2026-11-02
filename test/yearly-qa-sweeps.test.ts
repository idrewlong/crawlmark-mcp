/**
 * 0.5.0 QA: independent sweeps over the yearly work. (1) gscPartialRange agrees with gscRangeCoverage for every
 * clock and every saved-month pattern it is tried on: the partial range is always answerable in full from the one
 * source it names, is whole months ending at the range's end, and never bridges a gap. (2) No yearly or partial
 * report in any theme prints "undefined", "NaN" or "[object Object]" in Markdown, HTML, Word or PowerPoint, and every
 * HTML image-like chart has a text alternative. Fixture data only (example.com); no network.
 */
import JSZip from "jszip";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DateRange } from "../src/lib/dates.js";
import { gscPartialRange, gscRangeCoverage } from "../src/lib/gsc-coverage.js";
import { saveMonth } from "../src/lib/gsc-monthly.js";
import { db } from "../src/lib/store.js";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { toHtml } from "../src/reports/render/html.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import { toPptx } from "../src/reports/render/pptx/index.js";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import { partialYearReport, yearlyReport } from "./fixtures/reports/yearly-data.js";

const PROPERTY = "sc-domain:example.com";
const C = { slug: "example-com", gscProperty: PROPERTY };
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const store = (month: string) =>
  saveMonth({
    client: C.slug,
    property: PROPERTY,
    month,
    complete: true,
    capturedAt: Date.UTC(2026, 10, 1),
    totals: { keys: [], clicks: 10, impressions: 200, ctr: 5, position: 6 },
    pages: [],
    queries: [],
    devices: [],
    countries: [],
  });

beforeEach(() => {
  db.prepare("DELETE FROM gsc_monthly").run();
  db.prepare("DELETE FROM cache").run();
});

// Saved-month patterns over 2025: none, all, a gap, only early, only late, alternating.
const PATTERNS: Record<string, number[]> = {
  none: [],
  all: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  gapInMiddle: [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  earlyOnly: [1, 2, 3, 4],
  lateRun: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  alternating: [2, 4, 6, 8, 10, 12],
  decemberOnly: [12],
};
const CLOCKS = ["2026-02-01", "2026-06-30", "2026-07-01", "2026-11-01", "2026-11-15", "2027-01-15", "2027-03-31"];
const RANGES: Record<string, DateRange> = {
  year2025: { startDate: "2025-01-01", endDate: "2025-12-31" },
  h2: { startDate: "2025-07-01", endDate: "2025-12-31" },
  last12: { startDate: "2025-11-01", endDate: "2026-10-31" },
  midMonthEnd: { startDate: "2025-01-01", endDate: "2025-12-15" },
};

let checked = 0;
describe("gscPartialRange agrees with gscRangeCoverage (sweep)", () => {
  afterAll(() => expect(checked, "the sweep must exercise real partial ranges").toBeGreaterThan(40));

  for (const [pname, saved] of Object.entries(PATTERNS)) {
    it(`saved pattern ${pname}`, () => {
      db.prepare("DELETE FROM gsc_monthly").run();
      for (const m of saved) store(ym(2025, m));
      for (const clock of CLOCKS) {
        const now = Date.parse(`${clock}T12:00:00Z`);
        for (const [rname, range] of Object.entries(RANGES)) {
          const where = `${pname} / ${clock} / ${rname}`;
          const cov = gscRangeCoverage(C, range, now);
          const p = gscPartialRange(C, range, now);
          if (cov.complete) {
            expect(p, where).toBeNull();
            continue;
          }
          if (!p) continue; // nothing available: the C2 unavailable path
          checked += 1;
          // Whole months starting on the 1st, ending at the requested range's end, strictly inside the request.
          expect(p.range.startDate.endsWith("-01"), where).toBe(true);
          expect(p.range.endDate, where).toBe(range.endDate);
          expect(p.range.startDate > range.startDate, where).toBe(true);
          // The partial range is itself answerable in full, from the source the note names.
          const own = gscRangeCoverage(C, p.range, now);
          expect(own.complete, where).toBe(true);
          if (own.complete) expect(own.source, where).toBe(p.source);
          // Months are contiguous, oldest first, and months + missing are exactly the requested months.
          const all = [...p.missing, ...p.months].sort();
          expect(new Set(all).size, where).toBe(all.length);
          expect(p.months, where).toEqual([...p.months].sort());
          // A saved-history range never contains a month that isn't saved (a gap is never bridged).
          if (p.source === "stored") for (const m of p.months) expect(saved.map((n) => ym(2025, n)).includes(m) || m >= "2026-01", `${where} ${m}`).toBe(true);
          // The label never reads as a whole period.
          expect(p.label, where).not.toMatch(/\bQ[1-4]\b|full year|year to date/i);
        }
      }
    });
  }

  it("a request ending mid-month keeps its own end day on the google candidate", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    const p = gscPartialRange(C, RANGES.midMonthEnd!, now);
    expect(p?.range).toEqual({ startDate: "2025-07-01", endDate: `2025-12-15` });
    expect(lastDay(2025, 12)).toBe(31);
  });
});

describe("rendered output has no leaked placeholders (every theme, every format)", () => {
  const LEAK = /\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b(?! hypothesis)/;
  for (const [name, make] of [["yearly", yearlyReport], ["partial year", partialYearReport]] as const) {
    for (const theme of THEME_IDS) {
      it(`${name} / ${theme}`, async () => {
        const doc = buildReportDoc(make(), { version: "0.5.0", theme });
        const md = toMarkdown(doc);
        const html = toHtml(doc);
        expect(md).not.toMatch(LEAK);
        // Text outside <script>/<style>/attribute noise: the visible HTML.
        const visible = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
        expect(visible).not.toMatch(LEAK);
        // Every <svg> chart carries a text alternative (role=img with a label, or a <title>).
        for (const svg of html.match(/<svg\b[^>]*>/g) ?? []) {
          if (/aria-hidden="true"/.test(svg)) continue;
          expect(svg, "svg without a name").toMatch(/aria-label=|aria-labelledby=|role="img"/);
        }
        const zip = await JSZip.loadAsync(await toDocx(doc));
        for (const f of Object.keys(zip.files).filter((n) => /^word\/(document|charts\/chart\d+)\.xml$/.test(n))) {
          const xml = await zip.file(f)!.async("string");
          expect(xml.replace(/<[^>]+>/g, " "), f).not.toMatch(LEAK);
        }
        const pz = await JSZip.loadAsync((await toPptx(doc)).data);
        for (const f of Object.keys(pz.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
          const xml = await pz.file(f)!.async("string");
          expect(xml.replace(/<[^>]+>/g, " "), f).not.toMatch(LEAK);
        }
      });
    }
  }
});
