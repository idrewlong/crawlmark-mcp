/** Release 0.5.0 Y0.1: year periods and the four yearly section types in template files (C1, C4). */
import { describe, expect, it } from "vitest";
import { DEFAULT_SECTION_IDS, templateCatalogue } from "../src/reports/templates/builder.js";
import { SECTION_CATALOGUE, SECTION_TITLES, SECTION_TYPES, validateTemplateText } from "../src/reports/templates/schema.js";

const today = new Date("2026-11-01T12:00:00Z");
const file = (template: object) => `version: 1\ntemplates:\n  y: ${JSON.stringify(template)}\n`;
const check = (template: object) => validateTemplateText(file(template), { today });
const one = (section: object, extra: object = {}) => check({ title: "Yearly", period: { range: "last_year" }, sections: [section], ...extra });

describe("year periods and yearly sections in template files", () => {
  it("accepts last_year with the four new section types and their options", () => {
    const r = check({
      title: "Yearly",
      period: { range: "last_year" },
      compare: ["previous_year"],
      sections: [
        { id: "channels", type: "channel_yoy", limit: 6, metric: "keyEvents" },
        { id: "page-types", type: "page_groups", groups: [{ name: "Blog", prefix: ["/blog/"] }, { name: "Products", regex: ["/products/[^/]+/$"] }] },
        { id: "content-years", type: "content_by_year", group: "Blog", maxYears: 5, minYear: 2010 },
        { id: "wins", type: "wins_misses", limit: 8, goals: [{ metric: "clicks", target: 12000, label: "Search clicks" }, { metric: "sessions", target: 20000 }] },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it.each(["year_to_date", "last_year", "last_12_months"])("accepts range %s", (range) => {
    expect(one({ id: "s", type: "search_overview" }, { period: { range } }).errors).toEqual([]);
  });

  it("names all seven ranges when the range is unknown", () => {
    const r = one({ id: "s", type: "search_overview" }, { period: { range: "last_decade" } });
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual([{ path: "templates.y.period.range", message: "range must be last_month, last_quarter, last_n_days, custom, year_to_date, last_year or last_12_months" }]);
  });

  it("rejects unknown fields on the year ranges", () => {
    expect(one({ id: "s", type: "search_overview" }, { period: { range: "last_year", days: 365 } }).errors[0]).toMatchObject({ path: "templates.y.period.days", message: 'unknown field "days"' });
  });

  describe("channel_yoy", () => {
    it("accepts each metric and a limit up to 20", () => {
      for (const metric of ["sessions", "users", "keyEvents"]) expect(one({ id: "c", type: "channel_yoy", metric, limit: 20 }).errors, metric).toEqual([]);
    });
    it.each([
      [{ metric: "pageviews" }, "templates.y.sections[0].metric"],
      [{ limit: 21 }, "templates.y.sections[0].limit"],
      [{ limit: 0 }, "templates.y.sections[0].limit"],
      [{ goals: [] }, "templates.y.sections[0].goals"],
    ])("rejects %j", (extra, path) => {
      const r = one({ id: "c", type: "channel_yoy", ...extra });
      expect(r.valid).toBe(false);
      expect(r.errors[0]!.path).toBe(path);
    });
  });

  describe("page_groups", () => {
    it("accepts no groups (the client's) or up to 12", () => {
      expect(one({ id: "p", type: "page_groups" }).errors).toEqual([]);
      expect(one({ id: "p", type: "page_groups", groups: Array.from({ length: 12 }, (_, i) => ({ name: `G${i}`, prefix: [`/g${i}/`] })) }).errors).toEqual([]);
    });
    it.each([
      [{ groups: [] }, "templates.y.sections[0].groups"],
      [{ groups: Array.from({ length: 13 }, (_, i) => ({ name: `G${i}`, prefix: [`/g${i}/`] })) }, "templates.y.sections[0].groups"],
      [{ groups: [{ name: "", prefix: ["/a/"] }] }, "templates.y.sections[0].groups[0].name"],
      [{ groups: [{ name: "x".repeat(41), prefix: ["/a/"] }] }, "templates.y.sections[0].groups[0].name"],
      [{ groups: [{ name: "Blog", prefix: ["/blog/"], extra: 1 }] }, "templates.y.sections[0].groups[0].extra"],
      [{ groups: [{ name: "Blog", prefix: ["x".repeat(201)] }] }, "templates.y.sections[0].groups[0].prefix[0]"],
    ])("rejects a malformed list %#", (extra, path) => {
      const r = one({ id: "p", type: "page_groups", ...extra });
      expect(r.valid).toBe(false);
      expect(r.errors[0]!.path).toBe(path);
    });
    it("rejects an RE2 lookaround with the section's groups path", () => {
      const r = one({ id: "p", type: "page_groups", groups: [{ name: "Blog", regex: ["/blog/(?!draft)"] }] });
      expect(r.valid).toBe(false);
      expect(r.errors).toEqual([{ path: "templates.y.sections[0].groups", message: expect.stringMatching(/page group "Blog": the regex .* lookarounds aren't supported \(Search Console uses RE2\)/) }]);
    });
    it("rejects a group named Other, an empty group and a * prefix", () => {
      for (const groups of [[{ name: "Other", prefix: ["/o/"] }], [{ name: "Empty" }], [{ name: "Wild", prefix: ["/a*/"] }]]) {
        const r = one({ id: "p", type: "page_groups", groups });
        expect(r.valid, JSON.stringify(groups)).toBe(false);
        expect(r.errors[0]!.path).toBe("templates.y.sections[0].groups");
      }
    });
  });

  describe("content_by_year", () => {
    it("accepts maxYears 3 to 20 and minYear 1995 to 2100", () => {
      expect(one({ id: "c", type: "content_by_year", maxYears: 3, minYear: 1995 }).errors).toEqual([]);
      expect(one({ id: "c", type: "content_by_year", maxYears: 20, minYear: 2100 }).errors).toEqual([]);
    });
    it.each([
      [{ maxYears: 2 }, "templates.y.sections[0].maxYears"],
      [{ maxYears: 21 }, "templates.y.sections[0].maxYears"],
      [{ minYear: 1994 }, "templates.y.sections[0].minYear"],
      [{ minYear: 2026.5 }, "templates.y.sections[0].minYear"],
      [{ group: "x".repeat(41) }, "templates.y.sections[0].group"],
    ])("rejects %j", (extra, path) => {
      const r = one({ id: "c", type: "content_by_year", ...extra });
      expect(r.valid).toBe(false);
      expect(r.errors[0]!.path).toBe(path);
    });
    it("warns (doesn't fail) for a group that isn't a default one", () => {
      const r = one({ id: "c", type: "content_by_year", group: "Products" });
      expect(r.valid).toBe(true);
      expect(r.warnings).toEqual([{ path: "templates.y.sections[0].group", message: 'no default page group named "Products"; the client\'s own groups may have it' }]);
      for (const group of ["Blog", "blog", "Other", "Home"]) expect(one({ id: "c", type: "content_by_year", group }).warnings, group).toEqual([]);
    });
  });

  describe("wins_misses", () => {
    const goal = { metric: "clicks", target: 100 };
    it("accepts 1 to 6 goals and a limit up to 10", () => {
      expect(one({ id: "w", type: "wins_misses", limit: 10, goals: Array.from({ length: 6 }, () => goal) }).errors).toEqual([]);
      for (const metric of ["clicks", "impressions", "sessions", "keyEvents"]) expect(one({ id: "w", type: "wins_misses", goals: [{ metric, target: 1, label: "A goal" }] }).errors, metric).toEqual([]);
    });
    it.each([
      [{ goals: Array.from({ length: 7 }, () => ({ metric: "clicks", target: 100 })) }, "templates.y.sections[0].goals"],
      [{ goals: [] }, "templates.y.sections[0].goals"],
      [{ goals: [{ metric: "clicks", target: 0 }] }, "templates.y.sections[0].goals[0].target"],
      [{ goals: [{ metric: "clicks", target: 10.5 }] }, "templates.y.sections[0].goals[0].target"],
      [{ goals: [{ metric: "ctr", target: 5 }] }, "templates.y.sections[0].goals[0].metric"],
      [{ goals: [{ metric: "clicks", target: 5, label: "x".repeat(81) }] }, "templates.y.sections[0].goals[0].label"],
      [{ goals: [{ metric: "clicks", target: 5, due: "2026" }] }, "templates.y.sections[0].goals[0].due"],
      [{ limit: 11 }, "templates.y.sections[0].limit"],
    ])("rejects %j", (extra, path) => {
      const r = one({ id: "w", type: "wins_misses", ...extra });
      expect(r.valid).toBe(false);
      expect(r.errors[0]!.path).toBe(path);
    });
  });

  describe("compare with a year range", () => {
    it.each(["year_to_date", "last_year", "last_12_months"])("warns when %s compares only with previous_period", (range) => {
      const r = one({ id: "s", type: "search_overview" }, { period: { range }, compare: ["previous_period"] });
      expect(r.valid).toBe(true);
      expect(r.warnings).toEqual([{ path: "templates.y.compare", message: `for ${range}, the previous period is the same as the previous year; the report shows it as previous_year` }]);
    });
    it("doesn't warn for both comparisons, previous_year alone, or other ranges", () => {
      expect(one({ id: "s", type: "search_overview" }, { compare: ["previous_period", "previous_year"] }).warnings).toEqual([]);
      expect(one({ id: "s", type: "search_overview" }, { compare: ["previous_year"] }).warnings).toEqual([]);
      expect(one({ id: "s", type: "search_overview" }, { period: { range: "last_quarter" }, compare: ["previous_period"] }).warnings).toEqual([]);
    });
  });

  it("titles, catalogue entries and builder ids for the new types", () => {
    for (const t of ["channel_yoy", "page_groups", "content_by_year", "wins_misses"] as const) expect(SECTION_TYPES).toContain(t);
    expect(SECTION_TITLES).toMatchObject({
      channel_yoy: "Traffic by channel, year over year",
      page_groups: "Search clicks by page type",
      content_by_year: "Content by publish year",
      wins_misses: "Wins and misses",
    });
    expect(SECTION_CATALOGUE.channel_yoy).toEqual({ group: "analytics", cost: "free", needs: "Google Analytics 4", summary: "Sessions, users and key events per GA4 channel against the same dates a year earlier (all traffic, not only organic)." });
    expect(SECTION_CATALOGUE.page_groups).toEqual({ group: "search", cost: "free", needs: "Google Search Console", summary: "Search clicks and impressions per page type (blog, services, locations…) from Search Console page filters." });
    expect(SECTION_CATALOGUE.content_by_year).toEqual({ group: "site", cost: "free", needs: "a saved local crawl and Google Search Console", summary: "Pages and search clicks by the year each page was published, from the newest saved crawl." });
    expect(SECTION_CATALOGUE.wins_misses).toEqual({ group: "search", cost: "free", needs: "Google Search Console (GA4 for traffic goals)", summary: "Goals met or missed, and the biggest gains and losses, by fixed published thresholds." });
    expect(DEFAULT_SECTION_IDS).toMatchObject({ channel_yoy: "channels", page_groups: "page-types", content_by_year: "content-years", wins_misses: "wins" });
    const cat = templateCatalogue();
    for (const t of ["channel_yoy", "page_groups", "content_by_year", "wins_misses"]) expect(cat.find((e) => e.type === t), t).toMatchObject({ paid: false, cost: "free" });
  });
});
