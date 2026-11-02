/** Release 0.4.0 T0 (P-C3): the theme palette keeps every text colour readable (4.5:1) on any brand colour. */
import { describe, expect, it } from "vitest";
import { contrast } from "../src/reports/render/color.js";
import { themePalette } from "../src/reports/render/themes/palette.js";

const sweep: string[] = [];
for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) sweep.push(`#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`);
sweep.push("#1f5ea8", "#ffd400", "#777777", "#ffffff", "#000000");

const HEX = /^#[0-9a-f]{6}$/;
const near = (a: string, b: string, tol: number) => [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= tol);

describe("themePalette", () => {
  it("every value is #rrggbb", () => {
    for (const c of sweep) for (const [k, v] of Object.entries(themePalette(c, "#5b9bd5"))) expect(v, `${c} ${k}`).toMatch(HEX);
  });

  it("the dark colour holds white text at 12:1 or more, with soft and subtle text at 4.5:1 or more", () => {
    for (const c of sweep) {
      const p = themePalette(c, "#5b9bd5");
      expect(contrast(p.onDark, p.dark), c).toBeGreaterThanOrEqual(12);
      expect(contrast(p.onDarkSoft, p.dark), c).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.onDarkSubtle, p.dark), c).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("friendly: tintInk on tint and warm, and the chip text on the chip, reach 4.5:1", () => {
    for (const c of sweep) {
      const p = themePalette(c, "#5b9bd5");
      expect(contrast(p.tintInk, p.tint), c).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.tintInk, p.warm), c).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.onPrimary, p.chipBg), c).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.onChipSoft, p.chipBg), c).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.primaryInk, "#ffffff"), c).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.onPrimarySoft, p.primary), c).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the default primary stays close to the approved mockup colours", () => {
    const p = themePalette("#1f5ea8", "#5b9bd5");
    // Contract note: the spec says "within 6 per channel", but its own formula gives #112746, whose blue is 9 away from
    // #14213d. The formula is kept as written and the tolerance here is 9 (flagged in the T0 report).
    expect(p.dark).toBe("#112746");
    expect(near(p.dark, "#14213d", 9), p.dark).toBe(true);
    expect(near(p.tint, "#e9f0f8", 4), p.tint).toBe(true);
    expect(p.accent).toBe("#5b9bd5");
    expect(p.primary).toBe("#1f5ea8");
  });

  it("is deterministic", () => {
    expect(themePalette("#224466", "#cc6600")).toEqual(themePalette("#224466", "#cc6600"));
  });
});
