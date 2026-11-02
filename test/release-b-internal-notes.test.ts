/** Release B1: client vs internal text (B-C5). Internal text goes to its own file and never into a client file. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { exportReport } from "../src/reports/export.js";
import { reportRelPath } from "../src/reports/paths.js";
import { internalText, clientText } from "../src/reports/render/narrative.js";
import { storeReport } from "../src/reports/templates/run.js";
import { client } from "./fixtures/reports/deps.js";
import { fixtureReport } from "./fixtures/reports/report.js";
import { POSIX_MODES } from "./platform.js";

vi.mock("../src/clients.js", () => ({ resolveClient: vi.fn(async () => (await import("./fixtures/reports/deps.js")).client) }));

const tmp = () => mkdtempSync(join(tmpdir(), "crawlmark-internal-"));
const printer = vi.fn(async (_html: string) => Buffer.from("%PDF-1.7"));
const opts = (dir: string, extra = {}) => ({ formats: ["md", "html", "docx", "pdf"] as ("md" | "html" | "docx" | "pdf")[], reportsDir: dir, branding: {}, version: "0.1.0", printer, ...extra });

const SECRET = "ZZINTERNALZZ the client is unhappy with the Q2 pricing";
const narrative = {
  summary: { client: "A strong month for search.", internal: `${SECRET} (summary)` },
  sections: { search: { client: "Clicks rose.", internal: `${SECRET} (search)` }, brand: "Brand traffic held." },
  internal: `${SECRET} (general)`,
};

describe("narrative text helpers", () => {
  it("a plain string is client text; a split has both parts", () => {
    expect(clientText("hi")).toBe("hi");
    expect(internalText("hi")).toBeUndefined();
    expect(clientText({ internal: "x" })).toBeUndefined();
    expect(internalText({ client: "a", internal: "b" })).toBe("b");
  });
});

describe("internal notes file", () => {
  it("a split narrative writes <template>-<period>.internal.md (0600, audience internal) and no client file has the internal text", async () => {
    const dir = join(tmp(), "reports");
    const report = await fixtureReport();
    const out = await exportReport(report, opts(dir, { narrative }));
    const internal = out.files.filter((f) => f.audience === "internal");
    expect(internal).toHaveLength(1);
    expect(internal[0]).toMatchObject({ format: "md", path: join(dir, "example.com", "2026-09", "monthly-2026-09.internal.md"), overwritten: false });
    expect(out.files.filter((f) => f.audience === "client").map((f) => f.format)).toEqual(["md", "html", "docx", "pdf"]);
    if (POSIX_MODES) expect(statSync(internal[0]!.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "example.com", "2026-09")).sort()).toEqual(["monthly-2026-09.docx", "monthly-2026-09.html", "monthly-2026-09.internal.md", "monthly-2026-09.md", "monthly-2026-09.pdf"]);

    const notes = readFileSync(internal[0]!.path, "utf8");
    expect(notes.startsWith("# Internal notes (not for the client)\n")).toBe(true);
    expect(notes).toContain("Example Co");
    expect(notes).toContain("September 2026");
    // General notes first, then the summary, then the sections in report order.
    const at = (s: string) => notes.indexOf(s);
    expect(at("(general)")).toBeGreaterThan(0);
    expect(at("(general)")).toBeLessThan(at("## Summary"));
    expect(at("## Summary")).toBeLessThan(at("(summary)"));
    expect(at("(summary)")).toBeLessThan(at("(search)"));
    expect(notes).toMatch(/## [^\n]+\n\nZZINTERNALZZ the client is unhappy with the Q2 pricing \(search\)/);
    expect(notes).not.toContain("Clicks rose.");

    const client = [
      readFileSync(join(dir, "example.com", "2026-09", "monthly-2026-09.md"), "utf8"),
      readFileSync(join(dir, "example.com", "2026-09", "monthly-2026-09.html"), "utf8"),
      await (await JSZip.loadAsync(readFileSync(join(dir, "example.com", "2026-09", "monthly-2026-09.docx")))).file("word/document.xml")!.async("string"),
      String(printer.mock.calls.at(-1)![0]),
    ];
    for (const text of client) {
      expect(text).not.toContain("ZZINTERNALZZ");
      expect(text).not.toContain("unhappy");
    }
    // The client commentary is there.
    expect(client[0]).toContain("A strong month for search.");
    expect(client[0]).toContain("Clicks rose.");
  });

  it("with formats: [] the notes come back as internalNotes and nothing is written; the inline copy has none of it", async () => {
    const dir = join(tmp(), "reports");
    const report = await fixtureReport();
    const out = await exportReport(report, opts(dir, { formats: [], inline: "html", narrative }));
    expect(out.files).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(out.internalNotes).toContain("(general)");
    expect(out.internalNotes).toContain("(search)");
    expect(out.inline!.content).not.toContain("ZZINTERNALZZ");
    expect(out.inline!.content).toContain("Clicks rose.");
  });

  it("a plain-string narrative behaves exactly as in 0.2.0: no internal file, no internalNotes", async () => {
    const dir = join(tmp(), "reports");
    const report = await fixtureReport();
    const out = await exportReport(report, opts(dir, { formats: ["md"], narrative: { summary: "Good month.", sections: { search: "Fine." } } }));
    expect(out.files.map((f) => [f.format, f.audience])).toEqual([["md", "client"]]);
    expect(out).not.toHaveProperty("internalNotes");
    expect(readdirSync(join(dir, "example.com", "2026-09"))).toEqual(["monthly-2026-09.md"]);
    // A split whose internal parts are empty or blank is the same.
    const blank = await exportReport(report, opts(join(tmp(), "r"), { formats: ["md"], narrative: { summary: { client: "Good.", internal: "  " }, internal: "" } }));
    expect(blank.files).toHaveLength(1);
  });

  it("re-exporting overwrites the internal file and says so", async () => {
    const dir = join(tmp(), "reports");
    const report = await fixtureReport();
    await exportReport(report, opts(dir, { formats: ["md"], narrative }));
    const again = await exportReport(report, opts(dir, { formats: ["md"], narrative }));
    expect(again.files.map((f) => [f.audience, f.overwritten])).toEqual([["client", true], ["internal", true]]);
  });

  it("internal text is escaped like client Markdown: no raw HTML, link or block marker", async () => {
    const dir = join(tmp(), "reports");
    const report = await fixtureReport();
    const hostile = "<script>alert(1)</script>\n\nsee https://example.com/x\n\n# not a heading\n\n| a |\n| --- |\n| <img src=x> |\n\n1. first\n2. second";
    const out = await exportReport(report, opts(dir, { formats: [], inline: "md", narrative: { internal: hostile } }));
    const notes = out.internalNotes!;
    expect(notes).not.toMatch(/(^|[^\\])<script/);
    expect(notes).not.toMatch(/(^|[^\\])<img/);
    expect(notes).toContain("\\<script\\>");
    expect(notes).toContain("`see https://example.com/x`");
    expect(notes).toContain("\\# not a heading");
    expect(notes).toContain("| a |");
    expect(notes).toContain("1. first\n2. second");
  });
});

describe("paths", () => {
  it("reportRelPath has an internal variant", () => {
    const period = { startDate: "2026-09-01", endDate: "2026-09-30" };
    expect(reportRelPath("example.com", "2026-09", "monthly", period, "md", "internal").file).toBe("monthly-2026-09.internal.md");
    expect(reportRelPath("example.com", "2026-09", "monthly", period, "md").file).toBe("monthly-2026-09.md");
  });
});

describe("export_report tool", () => {
  async function load() {
    const { registerReportTools } = await import("../src/tools/reports.js");
    type Cb = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    let cb: Cb | undefined;
    registerReportTools({ registerTool: (n: string, _d: unknown, c: Cb) => void (n === "export_report" && (cb = c)) } as never);
    return cb!;
  }
  const call = async (args: Record<string, unknown>) => {
    const cb = await load();
    const r = await cb({ client: client.domain, ...args });
    return { isError: r.isError, body: r.isError ? r.content[0]!.text : JSON.parse(r.content[0]!.text) };
  };

  it("refuses with every hit as structured data and writes nothing", async () => {
    const report = await fixtureReport();
    storeReport(report);
    const r = await call({ reportId: report.reportId, formats: ["md"], narrative: { summary: "Via DataForSEO and Claude.", sections: { search: "Ran striking_distance." } } });
    expect(r.isError).toBeFalsy();
    expect(r.body).toMatchObject({ refused: true, written: false, reportId: report.reportId });
    expect(r.body.hits.map((h: { where: string; term: string }) => `${h.where}:${h.term}`)).toEqual(["summary:DataForSEO", "summary:Claude", "sections.search:striking_distance"]);
    expect(r.body.error).toMatch(/^Client-facing text names internal terms/);
    const allowed = await call({ reportId: report.reportId, formats: ["md"], allowTerms: ["Claude", "DataForSEO"], narrative: { summary: "Via DataForSEO and Claude.", sections: { search: "Ran striking_distance." } } });
    expect(allowed.body.hits.map((h: { term: string }) => h.term)).toEqual(["striking_distance"]);
  });

  it("exports a split narrative and returns the internal file with its audience", async () => {
    const report = await fixtureReport();
    storeReport(report);
    const r = await call({ reportId: report.reportId, formats: ["md"], narrative });
    expect(r.body.files.map((f: { audience: string }) => f.audience)).toEqual(["client", "internal"]);
    const noFiles = await call({ reportId: report.reportId, formats: [], inline: "md", narrative });
    expect(noFiles.body.files).toEqual([]);
    expect(noFiles.body.internalNotes).toContain("(general)");
  });
});
