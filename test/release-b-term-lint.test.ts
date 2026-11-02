/** Release B1: the internal-term check that refuses export (B-C5). */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClientTextLintError, exportReport } from "../src/reports/export.js";
import { lintClientText } from "../src/reports/render/term-lint.js";
import { validateReportTemplate } from "../src/reports/templates/service.js";
import { TOOL_NAMES } from "../src/tools/names.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const tmp = () => mkdtempSync(join(tmpdir(), "crawlmark-lint-"));
const printer = vi.fn(async () => Buffer.from("%PDF-1.7"));
const opts = (dir: string, extra = {}) => ({ formats: ["md", "html"] as ("md" | "html")[], reportsDir: dir, branding: {}, version: "0.1.0", printer, ...extra });
const lint = (text: string, extra: { allowTerms?: string[]; blockTerms?: string[] } = {}) => lintClientText([{ where: "summary", text }], { toolNames: TOOL_NAMES, ...extra });
const terms = (text: string, extra = {}) => lint(text, extra).map((h) => h.term);

describe("export refuses client text that names internal terms", () => {
  it("a white-label export with a leaking narrative writes nothing and lists every hit", async () => {
    const dir = join(tmp(), "reports");
    const report = await fixtureReport();
    const err = await exportReport(report, opts(dir, { branding: { hideCrawlmark: true }, narrative: { summary: "Keyword data from DataForSEO via striking_distance shows gains." } })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientTextLintError);
    expect((err as Error).message).toMatch(/^Client-facing text names internal terms: summary: "DataForSEO" \(….*DataForSEO.*…\); summary: "striking_distance"/);
    expect((err as Error).message).toContain("allowTerms");
    expect((err as ClientTextLintError).hits.map((h) => h.term)).toEqual(["DataForSEO", "striking_distance"]);
    expect(existsSync(dir)).toBe(false);
  });

  it("lists hits across fields, and an allowTerms param lists only the others", async () => {
    const report = await fixtureReport();
    const narrative = { summary: "DataForSEO and Claude helped.", sections: { search: "Used striking_distance." } };
    const e1 = await exportReport(report, opts(join(tmp(), "r"), { narrative })).then(() => Promise.reject(new Error("expected a refusal")), (e: unknown) => e as ClientTextLintError);
    expect(e1.hits.map((h) => `${h.where}:${h.term}`)).toEqual(["summary:DataForSEO", "summary:Claude", "sections.search:striking_distance"]);
    const e2 = await exportReport(report, opts(join(tmp(), "r"), { narrative, allowTerms: ["Claude"] })).then(() => Promise.reject(new Error("expected a refusal")), (e: unknown) => e as ClientTextLintError);
    expect(e2.hits.map((h) => h.term)).toEqual(["DataForSEO", "striking_distance"]);
  });

  it("branding allowTerms and blockTerms apply to an export", async () => {
    const report = await fixtureReport();
    const dir = join(tmp(), "reports");
    const ok = await exportReport(report, opts(dir, { narrative: { summary: "Claude wrote this." }, branding: { allowTerms: ["claude"] } }));
    expect(ok.files.length).toBe(2);
    const blocked = await exportReport(report, opts(join(tmp(), "r"), { narrative: { summary: "Project Falcon went well." }, branding: { blockTerms: ["Project Falcon"] } })).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(ClientTextLintError);
  });

  it("checks the cover texts, the branding footer and the commentary note, but not internal text", async () => {
    const report = await fixtureReport();
    report.template.cover = { subtitle: "Built with crawlmark", preparedFor: "Acme" };
    const e = await exportReport(report, opts(join(tmp(), "r"), { branding: { footer: "ask Claude", commentaryNote: "via MCP server" } })).then(() => Promise.reject(new Error("expected a refusal")), (e: unknown) => e as ClientTextLintError);
    expect(e.hits.map((h) => h.where)).toEqual(["cover.subtitle", "branding.footer", "branding.commentaryNote"]);
    report.template.cover = undefined;
    const ok = await exportReport(report, opts(join(tmp(), "r"), { narrative: { summary: { client: "Fine.", internal: "DataForSEO striking_distance Claude" }, internal: "crawlmark" } }));
    expect(ok.files.length).toBeGreaterThan(0);
  });

  it("checks block and text sections that the report shows", async () => {
    const home = tmp();
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "report-templates.yaml"),
      'version: 1\nblocks:\n  note: { text: "Data from DataForSEO." }\ntemplates:\n  x:\n    title: X\n    sections:\n      - { id: n, type: block, block: note }\n      - { id: t, type: text, text: "Run run_report_template again." }\n',
    );
    const report = await fixtureReport({ homeDir: home, template: "x", include: [] });
    const e = await exportReport(report, opts(join(tmp(), "r"))).then(() => Promise.reject(new Error("expected a refusal")), (e: unknown) => e as ClientTextLintError);
    expect(e.hits.map((h) => `${h.where}:${h.term}`)).toEqual(["blocks.note:DataForSEO", "sections.t.text:run_report_template"]);
  });
});

describe("lintClientText", () => {
  it("flags every built-in term category", () => {
    expect(terms("crawlmark Claude Anthropic DataForSEO")).toEqual(["crawlmark", "Claude", "Anthropic", "DataForSEO"]);
    expect(terms("the MCP server and the MCP tool")).toEqual(["MCP server", "MCP tool"]);
    expect(terms("crawlmark-cli report and crawlmark-mcp")).toEqual(["crawlmark-cli", "crawlmark-mcp"]);
    expect(terms("allowPaid estimateOnly reportId CRAWLMARK_HOME ~/.crawlmark")).toEqual(["allowPaid", "estimateOnly", "reportId", "CRAWLMARK_HOME", "~/.crawlmark"]);
    expect(terms("tool striking_distance and low_ctr")).toEqual(["striking_distance", "low_ctr"]);
    expect(terms("id rpt_01JFIXTURE0000000000000000 here")).toEqual(["rpt_01JFIXTURE0000000000000000"]);
    expect(terms("set DATAFORSEO_PASSWORD and AHREFS_API_KEY and X_ENABLED")).toEqual(["DATAFORSEO_PASSWORD", "AHREFS_API_KEY", "X_ENABLED"]);
  });

  it("matches case-insensitively and by whole word", () => {
    expect(terms("CRAWLMARK and dataforseo")).toEqual(["crawlmark", "DataForSEO"]);
    expect(terms("claudette and crawlmarks and mcp servers")).toEqual([]);
    expect(terms("Claude's note")).toEqual(["Claude"]);
    expect(terms("mcp  server")).toEqual(["MCP server"]);
  });

  it("single-word tool names are ordinary words; Ahrefs, Semrush and Google are attribution", () => {
    expect(TOOL_NAMES).toContain("lighthouse");
    expect(terms("The lighthouse report, accessibility, and cannibalization. Source: Ahrefs, Semrush, Google Search Console.")).toEqual([]);
  });

  it("a longer term hides the shorter one inside it, and allowing the longer shows the shorter", () => {
    expect(terms("run crawlmark-cli now")).toEqual(["crawlmark-cli"]);
    expect(terms("run crawlmark-cli now", { allowTerms: ["crawlmark-cli"] })).toEqual(["crawlmark"]);
  });

  it("allowTerms (exact, case-insensitive) and blockTerms", () => {
    expect(terms("DataForSEO and Claude", { allowTerms: ["claude"] })).toEqual(["DataForSEO"]);
    expect(terms("AHREFS_API_KEY", { allowTerms: ["ahrefs_api_key"] })).toEqual([]);
    expect(terms("Project Falcon is next", { blockTerms: ["project falcon"] })).toEqual(["project falcon"]);
    expect(terms("Claude", { blockTerms: ["Claude"], allowTerms: ["Claude"] })).toEqual([]);
  });

  it("the snippet is at most 80 characters around the hit, without control characters or newlines", () => {
    const long = `${"a ".repeat(100)}DataForSEO${" b".repeat(100)}`;
    const [h] = lint(long);
    expect(h!.snippet.length).toBeLessThanOrEqual(80);
    expect(h!.snippet).toContain("DataForSEO");
    const [n] = lint("before\nthe\u0000 striking_distance\ttool after");
    expect(n!.snippet).toBe("before the striking_distance tool after");
    expect(lint(`${"x".repeat(70)} MCP server ${"y".repeat(70)}`)[0]!.snippet.length).toBeLessThanOrEqual(80);
  });

  it("lists a repeated term at most five times per field", () => {
    expect(lint("Claude ".repeat(12))).toHaveLength(5);
  });

  it("empty text has no hits", () => {
    expect(lintClientText([{ where: "summary", text: "" }], { toolNames: TOOL_NAMES })).toEqual([]);
  });
});

describe("template texts", () => {
  it("validate_report_template reports hits as warnings with the YAML path", () => {
    const yaml = [
      "version: 1",
      "branding: { footer: Built with crawlmark }",
      "blocks:",
      '  note: { text: "Powered by DataForSEO." }',
      "templates:",
      "  x:",
      "    title: X",
      "    cover: { subtitle: Made by Claude }",
      "    sections:",
      '      - { id: a, type: text, text: "Use striking_distance" }',
    ].join("\n");
    const r = validateReportTemplate(tmp(), { yaml });
    expect(r.valid).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(["blocks.note", "templates.x.sections[0].text", "templates.x.cover.subtitle", "branding.footer"]);
    expect(r.warnings[0]!.message).toContain('"DataForSEO"');
    const allowed = validateReportTemplate(tmp(), { yaml: yaml.replace("branding: { footer: Built with crawlmark }", "branding: { footer: Built with crawlmark, allowTerms: [crawlmark] }") });
    expect(allowed.warnings.map((w) => w.path)).not.toContain("branding.footer");
  });
});

describe("TOOL_NAMES", () => {
  it("equals the manifest's tool list and the tools the server registers", async () => {
    const manifest = JSON.parse((await import("node:fs")).readFileSync(join(import.meta.dirname, "..", "mcpb", "manifest.json"), "utf8")) as { tools: { name: string }[] };
    expect([...TOOL_NAMES].sort()).toEqual(manifest.tools.map((t) => t.name).sort());
    const names = new Set<string>();
    const fake = { registerTool: (n: string) => void names.add(n), registerPrompt: () => undefined } as never;
    const dir = join(import.meta.dirname, "..", "src", "tools");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const mod = (await import(`../src/tools/${f.replace(/\.ts$/, ".js")}`)) as Record<string, unknown>;
      for (const [k, v] of Object.entries(mod)) if (/^register\w*Tools$/.test(k) && typeof v === "function") (v as (s: never) => void)(fake);
    }
    expect([...names].sort()).toEqual([...TOOL_NAMES].sort());
  });
});
