import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { ClientTextLintError, DOCX_MIME, exportReport, MAX_INLINE_DOCX_BASE64, type ExportResult } from "../src/reports/export.js";
import { MAX_DOCS_LOGO_BYTES } from "../src/reports/render/docx.js";
import type { TemplateReport } from "../src/reports/report-types.js";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import { fixtureReport, TINY_PNG } from "./fixtures/reports/report.js";
import { yearlyReport } from "./fixtures/reports/yearly-data.js";

const tmp = () => mkdtempSync(join(tmpdir(), "crawlmark-gdocs-"));
const fakePdf = vi.fn(async () => Buffer.from("%PDF-1.7 fake"));
const base = (reportsDir: string, extra = {}) => ({ formats: [] as ("docx" | "md")[], reportsDir, branding: {}, version: "0.5.0", printer: fakePdf, ...extra });

type DocxInline = Extract<NonNullable<ExportResult["inline"]>, { base64: string }>;
const docxOf = (out: ExportResult): DocxInline => {
  expect(out.inlineError).toBeUndefined();
  const i = out.inline;
  if (!i || !("base64" in i)) throw new Error("no docx inline");
  return i;
};
const zipOf = (i: DocxInline) => JSZip.loadAsync(Buffer.from(i.base64, "base64"));

/** Deterministic incompressible bytes. */
function seededBytes(n: number): Buffer {
  let x = 987654321;
  return Buffer.from(Array.from({ length: n }, () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) >> 8) & 0xff));
}

/** A PNG of an exact byte size (the 2x1 PNG plus incompressible trailing bytes, like a real logo), as a logo file on disk. */
function logoFile(dir: string, bytes: number) {
  const path = join(dir, "logo.png");
  mkdirSync(dir, { recursive: true });
  const buf = Buffer.concat([TINY_PNG, seededBytes(bytes - TINY_PNG.length)]);
  writeFileSync(path, buf);
  return { path: "logo.png", resolved: path, exists: true };
}

describe("inline docx (Google Docs copy)", () => {
  it("returns base64 that unzips to a Word file naming the client (Y4.1)", async () => {
    const out = await exportReport(await fixtureReport(), base(join(tmp(), "r"), { inline: "docx" }));
    expect(out.inline?.mimeType).toBe(DOCX_MIME);
    const zip = await zipOf(docxOf(out));
    expect(await zip.file("word/document.xml")!.async("string")).toContain("example.com");
    expect(out.files).toEqual([]);
  });

  it("reports base64Chars, bytes, the title and the resolved theme; the export theme wins", async () => {
    const report = await fixtureReport();
    const plain = docxOf(await exportReport(report, base(join(tmp(), "r"), { inline: "docx" })));
    expect(plain.base64Chars).toBe(plain.base64.length);
    expect(plain.bytes).toBe(Buffer.from(plain.base64, "base64").length);
    expect(plain.title).toBe("Example Co - SEO report - September 2026");
    expect(plain.theme).toBe("cards");
    const fromBranding = docxOf(await exportReport(report, base(join(tmp(), "r"), { inline: "docx", branding: { theme: "editorial" } })));
    expect(fromBranding.theme).toBe("editorial");
    const override = docxOf(await exportReport(report, base(join(tmp(), "r"), { inline: "docx", branding: { theme: "editorial" }, theme: "bold" })));
    expect(override.theme).toBe("bold");
    const doc = await (await zipOf(override)).file("word/document.xml")!.async("string");
    expect(doc).not.toContain("<c:chart");
  });

  it("writes the other formats in the same call and leaves them listed", async () => {
    const dir = join(tmp(), "r");
    const out = await exportReport(await fixtureReport(), base(dir, { formats: ["docx"], inline: "docx" }));
    expect(out.files.map((f) => f.format)).toEqual(["docx"]);
    docxOf(out);
    // The file is the full report (charts included); the inline copy is the docs variant.
    const file = await JSZip.loadAsync(await (await import("node:fs/promises")).readFile(out.files[0]!.path));
    expect(Object.keys(file.files).some((f) => f.startsWith("word/charts/"))).toBe(true);
  });

  it("keeps internal notes out of the docx copy", async () => {
    const out = await exportReport(await fixtureReport(), base(join(tmp(), "r"), { inline: "docx", narrative: { summary: { client: "Good month.", internal: "SECRET-INTERNAL-NOTE" }, internal: "SECRET-GENERAL" } }));
    const zip = await zipOf(docxOf(out));
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name]!.dir || !/\.(xml|rels)$/.test(name)) continue;
      const text = await zip.file(name)!.async("string");
      expect(text, name).not.toContain("SECRET-");
    }
    expect(out.internalNotes).toContain("SECRET-INTERNAL-NOTE");
  });

  it("refuses a narrative naming DataForSEO before any render: no inline, nothing written", async () => {
    const dir = join(tmp(), "r");
    await expect(exportReport(await fixtureReport(), base(dir, { formats: ["md"], inline: "docx", narrative: { summary: "Numbers from DataForSEO." } }))).rejects.toBeInstanceOf(ClientTextLintError);
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps a 40 KB logo and leaves a 60 KB logo out with a warning", async () => {
    const dir = tmp();
    const small = await exportReport(await fixtureReport(), base(join(dir, "r"), { inline: "docx", branding: { logo: logoFile(join(dir, "a"), 40_000) } }));
    expect(Object.keys((await zipOf(docxOf(small))).files).some((f) => f.startsWith("word/media/"))).toBe(true);
    expect(small.warnings).toEqual([]);
    const big = await exportReport(await fixtureReport(), base(join(dir, "r"), { inline: "docx", branding: { logo: logoFile(join(dir, "b"), 60_000) } }));
    expect(Object.keys((await zipOf(docxOf(big))).files).some((f) => f.startsWith("word/media/"))).toBe(false);
    expect(big.warnings).toContain("Logo left out of the Google Docs copy (it is over 48 KB); a smaller PNG or JPEG would appear.");
  });

  describe("the size cap", () => {
    it("retries without the logo when only the logo pushes it over, and says so", async () => {
      const dir = tmp();
      const logo = logoFile(join(dir, "a"), MAX_DOCS_LOGO_BYTES);
      const noLogo = docxOf(await exportReport(await fixtureReport(), base(join(dir, "r"), { inline: "docx" })));
      // Between the no-logo size and the with-logo size.
      const cap = noLogo.base64Chars + 1000;
      const out = await exportReport(await fixtureReport(), base(join(dir, "r"), { inline: "docx", branding: { logo }, maxInlineDocxBase64: cap }));
      const i = docxOf(out);
      expect(i.base64Chars).toBeLessThanOrEqual(cap);
      expect(Object.keys((await zipOf(i)).files).some((f) => f.startsWith("word/media/"))).toBe(false);
      expect(out.warnings).toContain("Logo left out of the Google Docs copy to keep it small enough to pass through the chat.");
    });

    it("over the cap: no throw, no inline, the exact inlineError, the files still listed, the fallback sentence when no .docx exists", async () => {
      const dir = join(tmp(), "r");
      const out = await exportReport(await fixtureReport(), base(dir, { formats: ["md"], inline: "docx", maxInlineDocxBase64: 1000 }));
      expect(out.inline).toBeUndefined();
      expect(out.files.map((f) => f.format)).toEqual(["md"]);
      expect(out.inlineError).toMatch(
        /^The Google Docs copy is \d+ KB \([\d,]+ characters as base64; the limit is 1,000 so it can pass through the chat\)\. Save it with inline: "html" instead \(no logo, plain tables\), or upload the Word file to Google Drive yourself: export with formats: \["docx"\] and upload that file \(Drive converts it to a Google Doc when "Convert uploads" is on\)\.$/,
      );
    });

    it("names the local .docx path when one was written in the same call", async () => {
      const dir = join(tmp(), "r");
      const out = await exportReport(await fixtureReport(), base(dir, { formats: ["docx"], inline: "docx", maxInlineDocxBase64: 1000 }));
      expect(out.inline).toBeUndefined();
      const path = out.files.find((f) => f.format === "docx")!.path;
      expect(out.inlineError).toContain(`upload the Word file to Google Drive yourself: ${path}.`);
    });

    it("names the .docx path from an earlier export of the same template and period", async () => {
      const dir = join(tmp(), "r");
      const first = await exportReport(await fixtureReport(), base(dir, { formats: ["docx"] }));
      const out = await exportReport(await fixtureReport(), base(dir, { inline: "docx", maxInlineDocxBase64: 1000 }));
      expect(out.files).toEqual([]);
      expect(out.inlineError).toContain(first.files[0]!.path);
    });

    it("the default cap is 120,000 characters", () => {
      expect(MAX_INLINE_DOCX_BASE64).toBe(120_000);
      expect(MAX_DOCS_LOGO_BYTES).toBe(49_152);
    });
  });

  describe("fits under the cap with a 48 KB logo and a 20,000-character narrative, in every theme", () => {
    // Seeded pseudo-random words: compresses far worse than repeated prose, so the size check is a worst case.
    const longText = (n: number) => {
      let x = 12345;
      const next = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
      let out = "";
      while (out.length < n) out += `${Array.from({ length: 3 + (next() % 8) }, () => String.fromCharCode(97 + (next() % 26))).join("")} `;
      return out.slice(0, n).trim();
    };
    const cases: [string, () => Promise<TemplateReport>, string][] = [
      ["monthly", () => fixtureReport(), "search"],
      ["yearly", async () => yearlyReport(), "search"],
    ];
    for (const [name, make, section] of cases) {
      for (const theme of THEME_IDS) {
        it(`${name} / ${theme}`, async () => {
          const dir = tmp();
          const out = await exportReport(await make(), base(join(dir, "r"), { inline: "docx", theme, branding: { logo: logoFile(join(dir, "l"), MAX_DOCS_LOGO_BYTES) }, narrative: { summary: longText(20_000), sections: { [section]: longText(20_000) } } }));
          const i = docxOf(out);
          expect(i.base64Chars).toBeLessThanOrEqual(120_000);
          expect(Object.keys((await zipOf(i)).files).some((f) => f.startsWith("word/media/"))).toBe(true);
          expect(out.warnings).toEqual([]);
        });
      }
    }
  });
});
