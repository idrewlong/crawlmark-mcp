/**
 * Shared helpers for the Release B renderer tests: a report with the new layout switched on, and commentary
 * blocks that use every new kind (sub-heading, numbered lists, a table, chart references). Fixture data only
 * (example.com). The blocks are produced through a mocked parser in the tests that need real chart references,
 * so these tests don't depend on the parser that ships with the text pipeline.
 */
import JSZip from "jszip";
import type { NarrativeBlock } from "../../../src/reports/render/narrative.js";
import type { TemplateReport } from "../../../src/reports/report-types.js";
import { fixtureReport } from "./report.js";

export const XSS = "<img src=x onerror=alert(1)>";

/** Every new commentary kind once; `{{chart search}}` resolves, `{{chart search 9}}` has no chart. */
export function richBlocks(): NarrativeBlock[] {
  return [
    { kind: "h", runs: [{ t: "What changed" }] },
    { kind: "p", runs: [{ t: "Clicks " }, { t: "grew", b: true }, { t: " this month." }] },
    { kind: "ol", start: 1, items: [[{ t: "Update the services pages" }], [{ t: "Fix the broken links" }]] },
    { kind: "ol", start: 3, items: [[{ t: "Review again in October" }]] },
    {
      kind: "table",
      header: [[{ t: "Page" }], [{ t: "Clicks" }]],
      rows: [
        [[{ t: "/services" }], [{ t: "120", b: true }]],
        [[{ t: XSS }], [{ t: "7" }]],
        [[{ t: "short row" }]],
      ],
      align: ["left", "right"],
    },
    { kind: "chartRef", section: "search", index: 1 },
    { kind: "chartRef", section: "search", index: 9 },
    { kind: "ul", items: [[{ t: "A bullet after the chart" }]] },
  ];
}

/** The text that a mocked parser turns into richBlocks(). */
export const RICH_MARK = "@@RICH@@";

/** The monthly fixture report with a cover, a contents list and two page breaks switched on. */
export async function layoutReport(): Promise<TemplateReport> {
  const r = await fixtureReport();
  r.template.cover = { subtitle: "Quarterly check-in", preparedFor: "Jane Doe, Example Co", preparedBy: "Example Agency", fields: ["preparedFor", "period", "generated"] };
  r.template.contents = true;
  const i = r.sections.findIndex((s) => s.id === "queries");
  const j = r.sections.findIndex((s) => s.id === "opportunities");
  for (const k of [i, j]) if (k >= 0) r.sections[k] = { ...r.sections[k]!, pageBreakBefore: true };
  return r;
}

export async function zipOf(buf: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(buf);
}
export const part = async (zip: JSZip, name: string) => zip.file(name)!.async("string");
