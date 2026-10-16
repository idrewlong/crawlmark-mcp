/** Phase 13 B-1: the backlinks, organic_visibility and competitor_overview section types, their paid rule and catalogue rows. Pure. */
import { describe, expect, it } from "vitest";
import { isPaidSection, PAID_SECTION_TYPES, SECTION_CATALOGUE, SECTION_TITLES, validateTemplateText, type SectionSpec } from "../src/reports/templates/schema.js";
import { CAPABILITIES, ROUTED_CAPABILITIES } from "../src/providers/seo-data.js";

const today = new Date("2026-10-13T12:00:00Z");
const file = (sections: string) => `version: 1\ntemplates:\n  t:\n    title: T\n    sections:\n${sections}`;

describe("Phase 13 B section types", () => {
  it("accept their fields with paid: true and have default titles", () => {
    const r = validateTemplateText(
      file(
        "      - { id: backlinks, type: backlinks, paid: true, trendMonths: 12, history: true }\n" +
          "      - { id: visibility, type: organic_visibility, paid: true, trendMonths: 0, history: false }\n" +
          "      - { id: competitors, type: competitor_overview, paid: true, limit: 5, source: saved_then_suggested }\n",
      ),
      { today },
    );
    expect(r.errors).toEqual([]);
    expect(SECTION_TITLES.backlinks).toBe("Backlinks");
    expect(SECTION_TITLES.organic_visibility).toBe("Organic search visibility");
    expect(SECTION_TITLES.competitor_overview).toBe("Competitors");
  });

  it("are paid: without paid: true each is an error at its paid path", () => {
    const r = validateTemplateText(file("      - { id: b, type: backlinks }\n      - { id: v, type: organic_visibility }\n      - { id: c, type: competitor_overview }\n"), { today });
    expect(r.errors.map((e) => e.path)).toEqual(["templates.t.sections[0].paid", "templates.t.sections[1].paid", "templates.t.sections[2].paid"]);
    for (const type of ["backlinks", "organic_visibility", "competitor_overview"]) {
      expect(PAID_SECTION_TYPES.has(type)).toBe(true);
      expect(isPaidSection({ id: "x", type } as SectionSpec)).toBe(true);
      expect(SECTION_CATALOGUE[type as "backlinks"]).toMatchObject({ group: "seo_data", cost: "paid" });
    }
  });

  it("reject out-of-range values and unknown fields", () => {
    const r = validateTemplateText(file("      - { id: b, type: backlinks, paid: true, trendMonths: 25, colour: red }\n      - { id: c, type: competitor_overview, paid: true, limit: 11, source: all }\n"), { today });
    expect(r.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["templates.t.sections[0].trendMonths", "templates.t.sections[0].colour", "templates.t.sections[1].limit", "templates.t.sections[1].source"]));
  });

  it("organicOverview and competitorOverview are routed capabilities DataForSEO and Ahrefs declare; Semrush's v4 API has neither", () => {
    for (const cap of ["organicOverview", "competitorOverview"] as const) {
      expect(ROUTED_CAPABILITIES).toContain(cap);
      for (const p of ["dataforseo", "ahrefs"] as const) expect(CAPABILITIES[p].has(cap)).toBe(true);
      expect(CAPABILITIES.semrush.has(cap)).toBe(false);
    }
  });
});
