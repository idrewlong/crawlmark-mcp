/** Release 0.4.0 T0: the theme and pptx additions to the template schema (all optional, 0.3.0 files unchanged). */
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, FORMATS, THEME_IDS, validateTemplateText } from "../src/reports/templates/schema.js";

const SECTIONS = "    sections:\n      - { id: search, type: search_overview }\n";
const file = (opts: { branding?: string; template?: string; formats?: string }) =>
  `version: 1\n${opts.branding ? `branding: { ${opts.branding} }\n` : ""}${opts.formats ? `defaults: { formats: ${opts.formats} }\n` : ""}templates:\n  mine:\n    title: Mine\n${opts.template ? `    ${opts.template}\n` : ""}${SECTIONS}`;

describe("theme and pptx schema additions", () => {
  it("accepts the combined file (branding theme, template theme, pptx format)", () => {
    const r = validateTemplateText(file({ branding: "theme: editorial", template: "theme: bold", formats: "[pdf, pptx]" }));
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("exports the ids, the default, and pptx and gdocs last in FORMATS", () => {
    expect(THEME_IDS).toEqual(["cards", "minimal", "editorial", "bold", "consulting", "friendly"]);
    expect(DEFAULT_THEME).toBe("cards");
    expect(FORMATS).toEqual(["md", "html", "pdf", "docx", "pptx", "gdocs"]);
  });

  it.each(THEME_IDS)("accepts %s in branding and in a template", (id) => {
    expect(validateTemplateText(file({ branding: `theme: ${id}` })).errors).toEqual([]);
    expect(validateTemplateText(file({ template: `theme: ${id}` })).errors).toEqual([]);
  });

  it("rejects an unknown theme with the field path", () => {
    const b = validateTemplateText(file({ branding: "theme: dark" }));
    expect(b.valid).toBe(false);
    expect(b.errors.some((e) => e.path === "branding.theme" && /Invalid option/.test(e.message))).toBe(true);
    const t = validateTemplateText(file({ template: "theme: dark" }));
    expect(t.valid).toBe(false);
    expect(t.errors.some((e) => e.path === "templates.mine.theme")).toBe(true);
  });

  it("allows six default formats and rejects seven", () => {
    expect(validateTemplateText(file({ formats: "[md, html, pdf, docx, pptx, gdocs]" })).errors).toEqual([]);
    const six = validateTemplateText(file({ formats: "[md, html, pdf, docx, pptx, gdocs, md]" }));
    expect(six.valid).toBe(false);
    expect(six.errors.some((e) => e.path === "defaults.formats")).toBe(true);
  });

  it("a 0.3.0 file with no theme still validates", () => {
    const r = validateTemplateText(file({ branding: "agencyName: Example Agency, primaryColor: '#224466'", formats: "[pdf]" }));
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });
});
