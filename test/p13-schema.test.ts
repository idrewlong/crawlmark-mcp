/** Phase 13 A-2: the technical_issues and indexing_issues section types, their paid rule and the section catalogue. Pure. */
import { describe, expect, it } from "vitest";
import { isPaidSection, SECTION_CATALOGUE, SECTION_TITLES, SECTION_TYPES, validateTemplateText, type SectionSpec } from "../src/reports/templates/schema.js";

const today = new Date("2026-10-13T12:00:00Z");
const file = (sections: string) => `version: 1\ntemplates:\n  t:\n    title: T\n    sections:\n${sections}`;

describe("Phase 13 section types", () => {
  it("accept their fields with defaults left out, and have default titles", () => {
    const r = validateTemplateText(
      file(
        "      - { id: issues, type: technical_issues, limit: 30, minSeverity: medium, sources: [audit, local_crawl], maxAgeDays: 45 }\n" +
          "      - { id: indexing, type: indexing_issues, maxInspections: 25, staleDays: 7, limit: 10, trendMonths: 6 }\n" +
          "      - { id: bare, type: technical_issues }\n",
      ),
      { today },
    );
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(SECTION_TITLES.technical_issues).toBe("Technical SEO issues");
    expect(SECTION_TITLES.indexing_issues).toBe("Google indexing");
  });

  it("reject unknown fields and out-of-range values with YAML paths", () => {
    const r = validateTemplateText(file("      - { id: i, type: indexing_issues, maxInspections: 201, colour: red }\n      - { id: t, type: technical_issues, limit: 0, sources: [nope] }\n"), { today });
    const paths = r.errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["templates.t.sections[0].colour", "templates.t.sections[0].maxInspections", "templates.t.sections[1].limit", "templates.t.sections[1].sources[0]"]));
  });

  it("the Ahrefs site-audit source makes technical_issues paid (paid: true required); issueUrls needs one", () => {
    const free = { id: "i", type: "technical_issues", sources: ["audit"] } as SectionSpec;
    const paid = { id: "i", type: "technical_issues", sources: ["audit", "ahrefs_site_audit"] } as SectionSpec;
    expect(isPaidSection(free)).toBe(false);
    expect(isPaidSection({ id: "i", type: "technical_issues" } as SectionSpec)).toBe(false);
    expect(isPaidSection(paid)).toBe(true);
    const r = validateTemplateText(file("      - { id: a, type: technical_issues, sources: [ahrefs_site_audit] }\n      - { id: b, type: technical_issues, issueUrls: 2 }\n      - { id: c, type: technical_issues, sources: [audit, audit] }\n"), { today });
    expect(r.errors).toEqual([
      { path: "templates.t.sections[0].paid", message: "the ahrefs_site_audit source spends Ahrefs units, so the section must set paid: true" },
      { path: "templates.t.sections[1].issueUrls", message: "issueUrls needs the ahrefs_site_audit source (it fetches example URLs from the provider)" },
      { path: "templates.t.sections[2].sources", message: "entries must be unique" },
    ]);
    expect(validateTemplateText(file("      - { id: a, type: technical_issues, paid: true, sources: [ahrefs_site_audit], issueUrls: 2 }\n"), { today }).valid).toBe(true);
  });

  it("the catalogue covers every section type", () => {
    expect(Object.keys(SECTION_CATALOGUE).sort()).toEqual([...SECTION_TYPES].sort());
    expect(SECTION_CATALOGUE.indexing_issues).toMatchObject({ group: "site", cost: "free" });
    expect(SECTION_CATALOGUE.technical_issues.cost).toBe("paid_optional");
    expect(SECTION_CATALOGUE.keyword_gap.cost).toBe("paid");
  });
});
