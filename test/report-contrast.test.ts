/**
 * WCAG AA contrast (4.5:1) for report text: the cover band's text and secondary text on any brand colour, and the
 * small grey text (captions, colophon, page header and footer) on every light background the files use. Pure.
 */
import { describe, expect, it } from "vitest";
import { contrast, NEUTRAL, softTextOn, textOn } from "../src/reports/render/color.js";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toHtml } from "../src/reports/render/html.js";
import { p13Report } from "./fixtures/reports/p13-data.js";

const sweep: string[] = [];
for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) sweep.push(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
sweep.push("#1f5ea8", "#ffd400", "#777777", "#808080", "#767676", "#e87ba4", "#2e8540", "#5b9bd5");

describe("report text contrast", () => {
  it("cover text and its softer secondary text reach 4.5:1 on every brand colour", () => {
    for (const p of sweep) {
      const on = textOn(p);
      expect(contrast(on, p), p).toBeGreaterThanOrEqual(4.5);
      expect(contrast(softTextOn(on, p), p), p).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("small grey and muted text reach 4.5:1 on white, the zebra rows and the surface", () => {
    for (const bg of ["#ffffff", NEUTRAL.zebra, NEUTRAL.surface]) {
      expect(contrast(NEUTRAL.faint, bg), bg).toBeGreaterThanOrEqual(4.5);
      expect(contrast(NEUTRAL.muted, bg), bg).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the HTML uses those colours for the cover, captions and page header, with custom branding too", () => {
    for (const primaryColor of ["#1f5ea8", "#ffd400", "#777777"]) {
      const html = toHtml(buildReportDoc(p13Report(), { version: "0.1.0", branding: { primaryColor } }));
      const soft = /--on-primary-soft: (#[0-9a-f]{6})/.exec(html)![1]!;
      const on = /--on-primary: (#[0-9a-f]{6})/.exec(html)![1]!;
      expect(contrast(soft, primaryColor), primaryColor).toBeGreaterThanOrEqual(4.5);
      expect(contrast(on, primaryColor), primaryColor).toBeGreaterThanOrEqual(4.5);
      expect(html).toContain(`--faint: ${NEUTRAL.faint};`);
    }
  });
});

describe("theme text contrast (release 0.4.0)", () => {
  const block = (html: string, id: string) => html.slice(html.indexOf(`/* theme: ${id} */`));
  const variable = (css: string, name: string) => new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(css)![1]!;
  const resolved = (theme: "bold" | "friendly", primaryColor: string) =>
    block(toHtml(buildReportDoc(p13Report(), { version: "0.4.0", theme, branding: { primaryColor } })), theme);

  it("bold: its text colours reach 4.5:1 on the derived dark colour", () => {
    for (const p of sweep) {
      const css = resolved("bold", p);
      const dark = variable(css, "dark");
      for (const n of ["on-dark", "on-dark-soft", "on-dark-subtle"]) expect(contrast(variable(css, n), dark), `${p} ${n}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("friendly: tint ink on tint and warm, chip text on the chip fill", () => {
    for (const p of sweep) {
      const css = resolved("friendly", p);
      const ink = variable(css, "tint-ink");
      for (const bg of ["tint", "warm", "surface"]) expect(contrast(ink, variable(css, bg)), `${p} ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(variable(css, "on-chip-soft"), variable(css, "chip-bg")), p).toBeGreaterThanOrEqual(4.5);
      expect(contrast(textOn(p), variable(css, "chip-bg")), p).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the fixed neutrals the themes use", () => {
    expect(contrast(NEUTRAL.muted, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(NEUTRAL.muted, "#faf8f3"), "editorial commentary").toBeGreaterThanOrEqual(4.5);
    expect(contrast("#5c6670", "#ffffff"), "consulting muted").toBeGreaterThanOrEqual(4.5);
    expect(contrast("#5c6670", "#f6f7f9"), "consulting commentary").toBeGreaterThanOrEqual(4.5);
    expect(contrast(NEUTRAL.muted, "#f7f9fb"), "bold zebra").toBeGreaterThanOrEqual(4.5);
    expect(contrast(NEUTRAL.ink, "#f5f7fa"), "bold summary").toBeGreaterThanOrEqual(4.5);
  });
});
