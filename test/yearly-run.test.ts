/**
 * Release 0.5.0 Y0.7: the builtin yearly template and the `year` override through runTemplate, the report CLI
 * (--year) and the report tools. Fake run deps, temp home and reports folder; no network.
 */
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { env } from "../src/config.js";
import { cliHint } from "../src/lib/cli-hint.js";
import { reportCommand, type ReportCliDeps, type ReportFlags } from "../src/report-cli.js";
import { runTemplate } from "../src/reports/templates/run.js";
import { registerReportTools } from "../src/tools/reports.js";
import { client, fakeDeps } from "./fixtures/reports/deps.js";

const today = new Date("2026-10-13T12:00:00Z");
const flags = (f: Partial<ReportFlags>): ReportFlags => ({ all: false, paid: false, "dry-run": false, ...f });

function harness() {
  const home = mkdtempSync(join(tmpdir(), "crawlmark-yearly-run-"));
  const lines: string[] = [];
  const errs: string[] = [];
  const deps: ReportCliDeps = {
    loadClients: async () => ({ clients: [client], skipped: [] }),
    runDeps: async () => fakeDeps(),
    printer: vi.fn(async () => Buffer.from("%PDF-1.7 fake")),
    reportsDir: join(home, "reports"),
    version: "0.5.0",
  };
  const io = { out: (l = "") => lines.push(l), warn: (l: string) => errs.push(l), homeDir: home, cwd: home, today };
  return { deps, io, errs, lines, home };
}

describe("the builtin yearly template", () => {
  it("runs 2025 against 2024: the four yearly sections are not built yet (Y0), the others are ok", async () => {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-yearly-run-"));
    const r = await runTemplate(client, { homeDir: home, today, template: "yearly", include: ["content-years"], store: false }, fakeDeps());
    expect(r.template).toEqual({ id: "yearly", title: "Yearly SEO review", source: "builtin", contents: true });
    expect(r.period).toEqual({
      current: { startDate: "2025-01-01", endDate: "2025-12-31" },
      label: "2025",
      folderMonth: "2025-12",
      comparisons: { previous_year: { startDate: "2024-01-01", endDate: "2024-12-31" } },
    });
    expect(r.sections.map((s) => [s.id, s.status, s.status === "unavailable" ? s.reason : null])).toEqual([
      ["search", "ok", null],
      ["channels", "unavailable", "not built yet"],
      ["page-types", "unavailable", "not built yet"],
      ["pages", "ok", null],
      ["page-movers", "ok", null],
      ["content-years", "unavailable", `no saved local crawl for example.com yet (run ${cliHint()} crawl, free)`],
      ["wins", "unavailable", "not built yet"],
    ]);
    expect(r.sections.find((s) => s.id === "channels")!.title).toBe("Traffic by channel, year over year");
  });

  it("year: 2025 on the monthly template is a whole year against the year before", async () => {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-yearly-run-"));
    const r = await runTemplate(client, { homeDir: home, today, year: "2025", store: false }, fakeDeps());
    expect(r.period).toMatchObject({ label: "2025", folderMonth: "2025-12", comparisons: { previous_year: { startDate: "2024-01-01" } } });
    expect(Object.keys(r.period.comparisons)).toEqual(["previous_year"]);
    const s = r.sections.find((x) => x.id === "search") as { data: { vsPreviousPeriod: unknown; vsPreviousYear: unknown } };
    expect(s.data.vsPreviousPeriod).toBeNull();
    expect(s.data.vsPreviousYear).not.toBeNull();
  });

  it("year and month together, a short year and a future year are refused", async () => {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-yearly-run-"));
    await expect(runTemplate(client, { homeDir: home, today, year: "2025", month: "2025-03", store: false }, fakeDeps())).rejects.toThrow("Give only one of year, month, quarter, or startDate and endDate.");
    await expect(runTemplate(client, { homeDir: home, today, year: "2027", store: false }, fakeDeps())).rejects.toThrow("2027 hasn't started yet.");
  });
});

describe("crawlmark-cli report --year", () => {
  it("writes yearly-2025.* under <client>/2025-12/", async () => {
    const h = harness();
    const code = await reportCommand([], flags({ client: "example.com", template: "yearly", year: "2025", format: "pdf,docx,pptx" }), h.io, h.deps);
    expect(h.errs).toEqual([]);
    expect(code).toBe(0);
    const dir = join(h.deps.reportsDir, "example.com", "2025-12");
    expect(readdirSync(dir).sort()).toEqual(["yearly-2025.docx", "yearly-2025.pdf", "yearly-2025.pptx"]);
    const out = JSON.parse(h.lines.join("\n"));
    expect(out.results[0]).toMatchObject({ template: "yearly", period: { label: "2025", folderMonth: "2025-12" } });
  });

  it("--dry-run shows the year's file paths and writes nothing", async () => {
    const h = harness();
    expect(await reportCommand([], flags({ client: "example.com", template: "yearly", year: "2025", format: "md", "dry-run": true }), h.io, h.deps)).toBe(0);
    const out = JSON.parse(h.lines.join("\n"));
    expect(out.results[0].wouldWrite[0]).toMatch(/example\.com[\\/]2025-12[\\/]yearly-2025\.md$/);
    expect(existsSync(h.deps.reportsDir)).toBe(false);
  });

  it("--year with --month, or a malformed year, is a usage error", async () => {
    const both = harness();
    expect(await reportCommand([], flags({ client: "example.com", year: "2025", month: "2025-03" }), both.io, both.deps)).toBe(1);
    expect(both.errs.join("\n")).toMatch(/Give only one of --year, --month, --quarter, or --start and --end\./);
    const bad = harness();
    expect(await reportCommand([], flags({ client: "example.com", year: "25" }), bad.io, bad.deps)).toBe(1);
    expect(bad.errs.join("\n")).toMatch(/--year takes YYYY, e\.g\. 2025 \(got "25"\)/);
  });
});

describe("report tools take year", () => {
  type Def = { description: string; inputSchema: Record<string, z.ZodType> };
  type Cb = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  const tools = () => {
    const defs = new Map<string, { def: Def; cb: Cb }>();
    registerReportTools({ registerTool: (n: string, d: Def, c: Cb) => void defs.set(n, { def: d, cb: c }) } as never);
    return defs;
  };

  it("run_report_template and export_report accept YYYY only; list_report_templates names yearly", () => {
    const t = tools();
    for (const name of ["run_report_template", "export_report"]) {
      const schema = z.object(t.get(name)!.def.inputSchema);
      expect(schema.safeParse({ client: "example.com", year: "2025" }).success, name).toBe(true);
      expect(schema.safeParse({ client: "example.com", year: "25" }).success, name).toBe(false);
      expect(schema.safeParse({ client: "example.com", year: "2025-01" }).success, name).toBe(false);
    }
    expect(t.get("list_report_templates")!.def.description).toContain("`yearly` for last year against the year before");
  });

  it("export_report with a reportId refuses a year argument", async () => {
    writeFileSync(env.CLIENTS_FILE, "clients:\n  example.com:\n    domain: example.com\n");
    const r = await tools().get("export_report")!.cb({ client: "example.com", reportId: `rpt_${"0".repeat(26)}`, year: "2025", formats: [] });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("With reportId, leave out year: the stored report already fixes the template and period.");
  });
});
