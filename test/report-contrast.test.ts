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
