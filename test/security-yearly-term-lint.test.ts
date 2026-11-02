/** SEC-2: goal labels, page-group names and the content_by_year group are client text, so the term check covers them. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClientTextLintError, clientTextFields, exportReport } from "../src/reports/export.js";
import type { SectionResult, TemplateReport } from "../src/reports/report-types.js";
import { validateReportTemplate } from "../src/reports/templates/service.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const printer = vi.fn(async () => Buffer.from("%PDF-1.7"));
const opts = (extra = {}) => ({ formats: ["md"] as "md"[], reportsDir: join(mkdtempSync(join(tmpdir(), "crawlmark-sec2-")), "r"), branding: { hideCrawlmark: true }, version: "0.5.0", printer, ...extra });
const ok = (id: string, type: string, data: unknown): SectionResult => ({ id, type, title: id, status: "ok", data });

async function withYearly(): Promise<TemplateReport> {
  const r = await fixtureReport();
  r.sections.push(
    ok("wm", "wins_misses", {
      comparedWith: null,
      goals: [{ kind: "win", rule: "goal", text: "Goal met: DataForSEO leads 1,120 (target 1,000)", metric: "clicks", current: 1120, previous: null, target: 1000 }],
      wins: [],
      misses: [],
      skippedGoals: [],
    }),
    ok("pg", "page_groups", { comparedWith: null, method: "gsc", groupsSource: "yaml", rows: [{ name: "crawlmark pages", clicks: 1, impressions: 2, ctr: 0.5, position: 1, share: 100 }], unattributed: null }),
    ok("cy", "content_by_year", { crawlId: "c", crawledAt: "2026-01-01T00:00:00.000Z", group: "crawlmark", pagesConsidered: 0, rows: [], sources: [] }),
  );
  return r;
}

describe("export term check covers yearly client text", () => {
  it("refuses a white-label report naming a term in a goal label, a page-group name or the content_by_year group, with paths", async () => {
    const e = await exportReport(await withYearly(), opts()).then(() => Promise.reject(new Error("expected a refusal")), (x: unknown) => x as ClientTextLintError);
    expect(e).toBeInstanceOf(ClientTextLintError);
    expect(e.hits.map((h) => `${h.where}:${h.term}`)).toEqual(["sections.wm.goals[0].label:DataForSEO", "sections.pg.pageGroups[0].name:crawlmark", "sections.cy.group:crawlmark"]);
  });

  it("allowTerms semantics are unchanged: the branding's allowTerms allow, an export's own do not (white label)", async () => {
    const r = await withYearly();
    const okRun = await exportReport(r, opts({ branding: { hideCrawlmark: true, allowTerms: ["DataForSEO", "crawlmark"] } }));
    expect(okRun.files.length).toBe(1);
    await expect(exportReport(r, opts({ allowTerms: ["DataForSEO", "crawlmark"] }))).rejects.toBeInstanceOf(ClientTextLintError);
  });

  it("clean yearly text passes and adds no fields beyond the three paths", async () => {
    const r = await withYearly();
    r.sections = r.sections.map((s) => (s.id === "wm" ? ok("wm", "wins_misses", { goals: [{ text: "Goal met: Leads 5 (target 4)", metric: "clicks" }], skippedGoals: [] }) : s.id === "pg" ? ok("pg", "page_groups", { rows: [{ name: "Blog" }] }) : s.id === "cy" ? ok("cy", "content_by_year", { group: null }) : s));
    const paths = clientTextFields(r, undefined, {}).map((f) => f.where);
    expect(paths).toContain("sections.wm.goals[0].label");
    expect(paths).toContain("sections.pg.pageGroups[0].name");
    expect(paths.some((p) => p.endsWith(".group"))).toBe(false);
  });
});

describe("template validation lists the same text as warnings", () => {
  const yaml = (sections: string) => `version: 1\ntemplates:\n  y:\n    title: Y\n    sections:\n${sections}\n`;
  it("warns on goal labels, page-group names and the content_by_year group", () => {
    const r = validateReportTemplate(
      mkdtempSync(join(tmpdir(), "crawlmark-sec2-home-")),
      {
        yaml: yaml(
          [
            '      - { id: wm, type: wins_misses, goals: [{ metric: clicks, target: 10, label: "DataForSEO leads" }] }',
            '      - { id: pg, type: page_groups, groups: [{ name: "crawlmark pages", prefix: ["/a/"] }] }',
            '      - { id: cy, type: content_by_year, group: "crawlmark" }',
          ].join("\n"),
        ),
      },
      new Date("2026-10-13T12:00:00Z"),
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings.filter((w) => w.message.includes("internal term")).map((w) => w.path)).toEqual(["templates.y.sections[0].goals[0].label", "templates.y.sections[1].groups[0].name", "templates.y.sections[2].group"]);
  });
});
