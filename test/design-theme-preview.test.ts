/** Release 0.4.0 T4 (P-C8): renderThemePreviews writes six sample reports, one per theme (fake printer, temp home, example.com). */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderThemePreviews, sampleReport } from "../src/reports/branding-preview.js";
import { htmlTheme } from "../src/reports/render/themes/index.js";
import { footerFont, type PdfOptions, type PdfPrinter } from "../src/reports/render/pdf.js";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import { POSIX_MODES } from "./platform.js";

const home = () => mkdtempSync(join(tmpdir(), "crawlmark-t4-prev-"));
const v = { version: "0.4.0" };

interface Call {
  html: string;
  opts: PdfOptions;
}

function fakePrinter(failOn: (n: number) => boolean = () => false) {
  const calls: Call[] = [];
  const printer: PdfPrinter = async (html, opts) => {
    calls.push({ html, opts });
    if (failOn(calls.length)) throw new Error("Chrome not found");
    return Buffer.from(`%PDF-fake ${calls.length}`);
  };
  return { calls, printer };
}

describe("renderThemePreviews", () => {
  it("writes six PDFs named 1-cards.pdf to 6-friendly.pdf, 0600 in a 0700 directory, in theme order", async () => {
    const h = home();
    const { calls, printer } = fakePrinter();
    const r = await renderThemePreviews(h, { agencyName: "Example Agency" }, { printer, ...v });
    expect(r.dir).toBe(join(h, "branding", "themes"));
    expect(r.files.map((f) => [f.theme, f.format])).toEqual(THEME_IDS.map((t) => [t, "pdf"]));
    expect(r.files.map((f) => f.path)).toEqual(THEME_IDS.map((t, i) => join(h, "branding", "themes", `${i + 1}-${t}.pdf`)));
    expect(r.warnings).toEqual([]);
    expect(calls).toHaveLength(6);
    for (const f of r.files) expect(readFileSync(f.path, "utf8")).toContain("%PDF-fake");
    if (POSIX_MODES) {
      expect(statSync(r.dir).mode & 0o777).toBe(0o700);
      for (const f of r.files) expect(statSync(f.path).mode & 0o777).toBe(0o600);
    }
  });

  it("a theme whose PDF fails is written as .html with a warning; the others stay PDF", async () => {
    const h = home();
    const { printer } = fakePrinter((n) => n === 3);
    const r = await renderThemePreviews(h, {}, { printer, ...v });
    expect(r.files[2]).toMatchObject({ theme: "editorial", format: "html", path: join(h, "branding", "themes", "3-editorial.html") });
    expect(r.files.filter((f) => f.format === "pdf")).toHaveLength(5);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/editorial.*Chrome not found.*HTML/);
    expect(readFileSync(r.files[2]!.path, "utf8")).toContain("<html");
    if (POSIX_MODES) expect(statSync(r.files[2]!.path).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlinked branding/themes directory and a symlinked branding directory", async () => {
    const h = home();
    const target = mkdtempSync(join(tmpdir(), "crawlmark-t4-target-"));
    mkdirSync(join(h, "branding"));
    symlinkSync(target, join(h, "branding", "themes"));
    const { printer } = fakePrinter();
    await expect(renderThemePreviews(h, {}, { printer, ...v })).rejects.toThrow(/symlink/);
    expect(existsSync(join(target, "1-cards.pdf"))).toBe(false);

    const h2 = home();
    symlinkSync(target, join(h2, "branding"));
    await expect(renderThemePreviews(h2, {}, { printer, ...v })).rejects.toThrow(/symlink/);
    expect(existsSync(join(target, "themes"))).toBe(false);
  });

  it("overwrites the previous run's files", async () => {
    const h = home();
    await renderThemePreviews(h, {}, { printer: fakePrinter().printer, ...v });
    const second = fakePrinter();
    const r = await renderThemePreviews(h, {}, { printer: second.printer, ...v });
    expect(readFileSync(r.files[0]!.path, "utf8")).toBe("%PDF-fake 1");
  });

  it("gives the printer each theme's footer font (the branding fonts apply in every theme)", async () => {
    const h = home();
    const { calls, printer } = fakePrinter();
    await renderThemePreviews(h, { bodyFont: "Inter", headingFont: "Merriweather" }, { printer, ...v });
    THEME_IDS.forEach((t, i) => {
      expect(calls[i]!.opts.fontFamily).toBe(footerFont({ body: "Inter", heading: "Merriweather", fallback: "sans-serif" }, t));
      expect(calls[i]!.opts.fontFamily).toContain("Inter");
    });
  });

  it("every file is the same standard-layout sample (contents, 'Sample data'), one per theme, with the branding's name", async () => {
    const h = home();
    const { calls, printer } = fakePrinter();
    await renderThemePreviews(h, { agencyName: "Example Agency", primaryColor: "#123456" }, { printer, ...v });
    for (const c of calls) {
      expect(c.html).toContain("Example Agency");
      expect(c.html).toContain("Sample data");
      expect(c.html).toContain("#123456");
    }
    const sample = sampleReport(undefined, { standard: true });
    expect(sample.template).toMatchObject({ contents: true, cover: { subtitle: "Sample data" } });
    expect(sample.template.layout).toBeUndefined();
  });

  // Until the HTML themes land (T1) every theme renders like cards, so the marker check only runs once they exist.
  it.runIf(htmlTheme("bold").css !== "")("each theme's sample carries its /* theme: <id> */ marker (cards: none)", async () => {
    const h = home();
    const { calls, printer } = fakePrinter();
    await renderThemePreviews(h, {}, { printer, ...v });
    THEME_IDS.forEach((t, i) => {
      if (t === "cards") expect(calls[i]!.html).not.toContain("/* theme:");
      else expect(calls[i]!.html).toContain(`/* theme: ${t} */`);
    });
  });
});
