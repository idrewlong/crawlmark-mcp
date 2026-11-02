import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { ClientTextLintError, exportReport, reportFilePath } from "../src/reports/export.js";
import { FORMATS } from "../src/reports/templates/schema.js";
import { fixtureReport, TINY_PNG } from "./fixtures/reports/report.js";
import { yearlyReport } from "./fixtures/reports/yearly-data.js";

const tmp = () => mkdtempSync(join(tmpdir(), "crawlmark-gdocs-"));
const fakePdf = vi.fn(async () => Buffer.from("%PDF-1.7 fake"));
const base = (reportsDir: string, extra = {}) => ({ formats: ["gdocs"] as ("gdocs" | "docx" | "md")[], reportsDir, branding: {}, version: "0.5.0", printer: fakePdf, ...extra });
const zipOf = (path: string) => JSZip.loadAsync(readFileSync(path));
const names = (z: JSZip) => Object.keys(z.files);

/** A PNG of an exact byte size (the 2x1 PNG plus incompressible trailing bytes), as a logo file on disk. */
function logoFile(dir: string, bytes: number) {
  const path = join(dir, "logo.png");
  mkdirSync(dir, { recursive: true });
  let x = 987654321;
  const pad = Buffer.from(Array.from({ length: bytes - TINY_PNG.length }, () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) >> 8) & 0xff));
  writeFileSync(path, Buffer.concat([TINY_PNG, pad]));
  return { path: "logo.png", resolved: path, exists: true };
}

describe("the gdocs format (Word copy for Google Docs)", () => {
  it("is a format, and the file is named <template>-<period>.google-docs.docx", async () => {
    expect(FORMATS).toContain("gdocs");
    const dir = join(tmp(), "r");
    const out = await exportReport(await fixtureReport(), base(dir));
    expect(out.files).toHaveLength(1);
    const f = out.files[0]!;
    expect(f.format).toBe("gdocs");
    expect(f.audience).toBe("client");
    expect(basename(f.path)).toMatch(/\.google-docs\.docx$/);
    expect(f.path).toBe(reportFilePath(dir, await fixtureReport(), "gdocs"));
    expect(out.inline).toBeUndefined();
  });

  it("writes a 0600 file in a 0700 folder that names the client", async () => {
    const dir = join(tmp(), "r");
    const out = await exportReport(await fixtureReport(), base(dir));
    const f = out.files[0]!;
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.path, "..")).mode & 0o777).toBe(0o700);
    expect(await (await zipOf(f.path)).file("word/document.xml")!.async("string")).toContain("example.com");
  });

  it("draws charts as tables: no chart parts or workbooks, while the normal docx keeps them", async () => {
    const out = await exportReport(await fixtureReport(), base(join(tmp(), "r"), { formats: ["docx", "gdocs"] }));
    const byFormat = Object.fromEntries(out.files.map((f) => [f.format, f.path]));
    const docs = await zipOf(byFormat["gdocs"]!);
    expect(names(docs).filter((n) => n.startsWith("word/charts/") || n.startsWith("word/embeddings/"))).toEqual([]);
    expect(await docs.file("word/document.xml")!.async("string")).not.toContain("<c:chart");
    expect(names(await zipOf(byFormat["docx"]!)).some((n) => n.startsWith("word/charts/"))).toBe(true);
  });

  it("is in the report's theme: the export theme wins over the branding's", async () => {
    const report = await fixtureReport();
    const render = async (extra: object) => {
      const out = await exportReport(report, base(join(tmp(), "r"), extra));
      return (await zipOf(out.files[0]!.path)).file("word/styles.xml")!.async("string");
    };
    const cards = await render({});
    const editorial = await render({ branding: { theme: "editorial" } });
    const bold = await render({ branding: { theme: "editorial" }, theme: "bold" });
    expect(editorial).not.toBe(cards);
    expect(bold).not.toBe(editorial);
  });

  it("keeps a logo over 48 KB (no size limit for a saved file)", async () => {
    const dir = tmp();
    const out = await exportReport(await fixtureReport(), base(join(dir, "r"), { branding: { logo: logoFile(join(dir, "a"), 60_000) } }));
    expect(names(await zipOf(out.files[0]!.path)).some((n) => n.startsWith("word/media/"))).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  it("works for the yearly report too", async () => {
    const out = await exportReport(yearlyReport(), base(join(tmp(), "r")));
    const z = await zipOf(out.files[0]!.path);
    expect(names(z).filter((n) => n.startsWith("word/charts/"))).toEqual([]);
    expect(await z.file("word/document.xml")!.async("string")).toContain("<w:tbl>");
  });

  it("keeps internal notes out of the Word copy and writes them to their own file", async () => {
    const out = await exportReport(await fixtureReport(), base(join(tmp(), "r"), { narrative: { summary: { client: "Good month.", internal: "SECRET-INTERNAL-NOTE" }, internal: "SECRET-GENERAL" } }));
    const gdocs = out.files.find((f) => f.format === "gdocs")!;
    const zip = await zipOf(gdocs.path);
    for (const name of names(zip)) {
      if (zip.files[name]!.dir || !/\.(xml|rels)$/.test(name)) continue;
      expect(await zip.file(name)!.async("string"), name).not.toContain("SECRET-");
    }
    const notes = out.files.find((f) => f.audience === "internal")!;
    expect(readFileSync(notes.path, "utf8")).toContain("SECRET-INTERNAL-NOTE");
  });

  it("refuses a narrative naming DataForSEO before anything is rendered: nothing is written", async () => {
    const dir = join(tmp(), "r");
    await expect(exportReport(await fixtureReport(), base(dir, { narrative: { summary: "Numbers from DataForSEO." } }))).rejects.toBeInstanceOf(ClientTextLintError);
    expect(existsSync(dir)).toBe(false);
  });

  it("white label: the copy carries no crawlmark name", async () => {
    const out = await exportReport(await fixtureReport(), base(join(tmp(), "r"), { branding: { hideCrawlmark: true, agencyName: "Example Agency" } }));
    const zip = await zipOf(out.files[0]!.path);
    for (const name of names(zip)) {
      if (zip.files[name]!.dir || !/\.(xml|rels)$/.test(name)) continue;
      expect((await zip.file(name)!.async("string")).toLowerCase(), name).not.toContain("crawlmark");
    }
  });

  it("is not produced unless asked for", async () => {
    const out = await exportReport(await fixtureReport(), base(join(tmp(), "r"), { formats: ["docx", "md"] }));
    expect(out.files.map((f) => f.format).sort()).toEqual(["docx", "md"]);
    expect(out.files.some((f) => f.path.endsWith(".google-docs.docx"))).toBe(false);
  });

  it("re-exporting overwrites", async () => {
    const dir = join(tmp(), "r");
    await exportReport(await fixtureReport(), base(dir));
    const again = await exportReport(await fixtureReport(), base(dir));
    expect(again.files[0]!.overwritten).toBe(true);
  });
});
