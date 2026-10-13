import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { BUILTIN_MONTHLY, STARTER_YAML } from "../src/reports/templates/builtin.js";
import { loadTemplates, resolveTemplate } from "../src/reports/templates/load.js";
import { lastCompleteQuarter, minusOneYear, periodSlug, rangeLabel, resolvePeriod } from "../src/reports/templates/period.js";
import { MAX_TEMPLATE_BYTES, validateTemplateText } from "../src/reports/templates/schema.js";
import { getReportTemplate, initStarterFile, listReportTemplates, validateReportTemplate } from "../src/reports/templates/service.js";
import { templatesCommand } from "../src/report-cli.js";
import { safeSegment } from "../src/reports/paths.js";

const today = new Date("2026-10-13T12:00:00Z");
const home = () => mkdtempSync(join(tmpdir(), "crawlmark-tpl-"));
const both = ["previous_period", "previous_year"] as const;

function file(body: string) {
  return `version: 1\ntemplates:\n${body}`;
}
const errorsOf = (text: string) => validateTemplateText(text, { today }).errors;

describe("template schema", () => {
  it("accepts the starter file, whose monthly is the builtin one", () => {
    const r = validateTemplateText(STARTER_YAML, { today });
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.value!.templates.monthly).toEqual(BUILTIN_MONTHLY);
    expect(Object.keys(r.value!.templates)).toEqual(["monthly", "quarterly"]);
  });

  it("checks every section type's extra fields", () => {
    const ok = file(`  t:
    title: T
    sections:
      - { id: a, type: search_overview, metrics: [clicks] }
      - { id: b, type: branded_split }
      - { id: c, type: organic_traffic, metrics: [users] }
      - { id: d, type: top_queries, limit: 100, includeBranded: false }
      - { id: e, type: query_movers, limit: 50 }
      - { id: f, type: page_movers, limit: 1 }
      - { id: g, type: top_pages, limit: 3 }
      - { id: h, type: landing_pages, limit: 3 }
      - { id: i, type: tracked_keywords, liveRanks: true, paid: true }
      - { id: j, type: opportunities, limit: 25 }
      - { id: k, type: audit_changes, limit: 50 }
      - { id: l, type: core_web_vitals_history, formFactor: DESKTOP, weeks: 40, scope: url, url: "https://example.com/" }
      - { id: m, type: tag_manager, optional: true, limit: 100 }
      - { id: n, type: data_spend }
      - { id: o, type: text, text: "Hello" }
`);
    expect(errorsOf(ok)).toEqual([]);
    for (const [line, path] of [
      ["{ id: a, type: top_queries, limit: 101 }", "templates.t.sections[0].limit"],
      ["{ id: a, type: query_movers, limit: 51 }", "templates.t.sections[0].limit"],
      ["{ id: a, type: opportunities, limit: 26 }", "templates.t.sections[0].limit"],
      ["{ id: a, type: core_web_vitals_history, weeks: 41 }", "templates.t.sections[0].weeks"],
      ["{ id: a, type: search_overview, metrics: [bounces] }", "templates.t.sections[0].metrics[0]"],
      ["{ id: a, type: text }", "templates.t.sections[0].text"],
      ["{ id: a, type: branded_split, limit: 3 }", "templates.t.sections[0].limit"],
    ] as const) {
      expect(errorsOf(file(`  t:\n    title: T\n    sections:\n      - ${line}\n`)).map((e) => e.path), line).toContain(path);
    }
  });

  it("names unknown fields, duplicate ids, bad ids and unknown types with YAML paths", () => {
    expect(errorsOf(file("  t:\n    title: T\n    colour: red\n    sections: [{ id: a, type: branded_split }]\n"))).toEqual([{ path: "templates.t.colour", message: 'unknown field "colour"' }]);
    expect(errorsOf(file("  t:\n    title: T\n    sections: [{ id: a, type: branded_split }, { id: a, type: data_spend }]\n"))[0]).toMatchObject({ path: "templates.t.sections[1].id" });
    expect(errorsOf(file("  t:\n    title: T\n    sections: [{ id: Bad_Id, type: branded_split }]\n"))[0]!.path).toBe("templates.t.sections[0].id");
    expect(errorsOf(file("  Bad:\n    title: T\n    sections: [{ id: a, type: branded_split }]\n")).length).toBeGreaterThan(0);
    expect(errorsOf(file("  t:\n    title: T\n    sections: [{ id: a, type: weather }]\n"))[0]).toMatchObject({ path: "templates.t.sections[0].type", message: expect.stringContaining("unknown section type") });
    expect(errorsOf("version: 2\ntemplates: {}\n").map((e) => e.path)).toContain("version");
  });

  it("requires optional: true on tag_manager and paid: true on paid sections", () => {
    expect(errorsOf(file("  t:\n    title: T\n    sections: [{ id: g, type: tag_manager }]\n"))).toEqual([
      { path: "templates.t.sections[0].optional", message: expect.stringContaining("opt-in") },
    ]);
    expect(errorsOf(file("  t:\n    title: T\n    sections: [{ id: k, type: tracked_keywords, liveRanks: true }]\n"))[0]!.path).toBe("templates.t.sections[0].paid");
  });

  it("checks custom periods: order, the Search Console lag, and the 480-day span", () => {
    const p = (start: string, end: string) => errorsOf(file(`  t:\n    title: T\n    period: { range: custom, start: "${start}", end: "${end}" }\n    sections: [{ id: a, type: branded_split }]\n`));
    expect(p("2026-09-01", "2026-09-30")).toEqual([]);
    expect(p("2026-10-01", "2026-10-11")).toEqual([]);
    expect(p("2026-10-01", "2026-10-12")[0]!.message).toMatch(/days ago/);
    expect(p("2026-09-30", "2026-09-01")[0]!.message).toMatch(/after end/);
    expect(p("2025-01-01", "2026-09-30")[0]!.message).toMatch(/480/);
  });

  it("gives line and column for YAML errors, refuses alias bombs and files over 256 KB", () => {
    expect(errorsOf("version: 1\ntemplates: [\n")[0]!.message).toMatch(/^YAML line \d+, column \d+/);
    expect(errorsOf("a: &a [1,2]\nb: &b [*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b]\n")[0]!.message).toMatch(/alias/i);
    expect(errorsOf("#".repeat(MAX_TEMPLATE_BYTES + 1))[0]!.message).toMatch(/256 KB/);
  });

  it("warns (not errors) about a logo that doesn't exist", () => {
    const r = validateTemplateText(`version: 1\nbranding: { logo: branding/logo.png }\ntemplates:\n  t: { title: T, sections: [{ id: a, type: data_spend }] }\n`, { today, logoExists: () => false });
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual([{ path: "branding.logo", message: expect.stringContaining("doesn't exist") }]);
  });
});

describe("template loader", () => {
  it("client file overrides global overrides builtin; branding merges field by field", () => {
    const h = home();
    mkdirSync(join(h, "config", "report-templates"), { recursive: true });
    writeFileSync(join(h, "config", "report-templates.yaml"), `version: 1\nbranding: { agencyName: Global Agency, primaryColor: "#111111", paper: A4 }\ndefaults: { formats: [pdf] }\ntemplates:\n  monthly: { title: Global monthly, sections: [{ id: a, type: data_spend }] }\n  extra: { title: Extra, sections: [{ id: a, type: data_spend }] }\n`);
    writeFileSync(join(h, "config", "report-templates", "example.com.yaml"), `version: 1\nbranding: { primaryColor: "#222222" }\ntemplates:\n  extra: { title: Client extra, sections: [{ id: b, type: branded_split }] }\n`);
    const loaded = loadTemplates({ homeDir: h, clientSlug: "example.com", today });
    expect(loaded.templates.get("monthly")).toMatchObject({ source: "global", spec: { title: "Global monthly" } });
    expect(loaded.templates.get("extra")).toMatchObject({ source: "client", spec: { title: "Client extra" } });
    expect(loaded.branding).toEqual({ agencyName: "Global Agency", primaryColor: "#222222", paper: "A4" });
    expect(loaded.defaults).toEqual({ template: "monthly", formats: ["pdf"] });
    // Without the client, the global file applies.
    expect(loadTemplates({ homeDir: h, today }).templates.get("extra")!.source).toBe("global");
    expect(resolveTemplate(loaded, "extra").spec).toMatchObject({ period: { range: "last_month" }, compare: ["previous_period", "previous_year"] });
  });

  it("an invalid global file leaves the builtin available and reports its errors", () => {
    const h = home();
    mkdirSync(join(h, "config"), { recursive: true });
    writeFileSync(join(h, "config", "report-templates.yaml"), "version: 1\ntemplates:\n  mine: { title: M, sections: [{ id: a, type: bogus }] }\n");
    const list = listReportTemplates(h, undefined, today);
    expect(list.templates.map((t) => [t.id, t.source])).toEqual([["monthly", "builtin"]]);
    expect(list.files.global).toMatchObject({ exists: true, valid: false, errors: [{ path: "templates.mine.sections[0].type" }] });
    expect(list.templates[0]).toMatchObject({ optionalSections: ["cwv", "gtm", "ranks"], paidSections: [] });
    expect(() => resolveTemplate(loadTemplates({ homeDir: h, today }), "mine")).toThrow(/No report template "mine".*monthly.*have errors/);
  });

  it("get_report_template fills defaults and reports the logo path and whether it exists", () => {
    const h = home();
    mkdirSync(join(h, "config"), { recursive: true });
    writeFileSync(join(h, "config", "report-templates.yaml"), "version: 1\nbranding: { logo: branding/logo.png }\ntemplates:\n  q: { title: Q, period: { range: last_quarter }, sections: [{ id: a, type: data_spend }] }\n");
    const t = getReportTemplate(h, "q", undefined, today);
    expect(t).toMatchObject({ id: "q", source: "global", template: { period: { range: "last_quarter" }, compare: ["previous_period", "previous_year"] } });
    expect(t.branding.logo).toEqual({ path: "branding/logo.png", resolved: join(h, "branding", "logo.png"), exists: false });
  });

  it("validate_report_template takes exactly one of yaml or file", () => {
    const h = home();
    expect(() => validateReportTemplate(h, {})).toThrow(/exactly one/);
    expect(() => validateReportTemplate(h, { yaml: "x", file: "global" })).toThrow(/exactly one/);
    expect(validateReportTemplate(h, { yaml: STARTER_YAML }, today)).toMatchObject({ valid: true, errors: [] });
    expect(validateReportTemplate(h, { file: "global" }, today)).toMatchObject({ valid: false, errors: [{ message: expect.stringContaining("doesn't exist") }] });
  });
});

describe("periods", () => {
  const monthly = { range: "last_month" } as const;
  it("last_month matches monthly_report: previous month and the same month last year", () => {
    expect(resolvePeriod(monthly, both, {}, today)).toEqual({
      current: { startDate: "2026-09-01", endDate: "2026-09-30" },
      label: "September 2026",
      folderMonth: "2026-09",
      comparisons: { previous_period: { startDate: "2026-08-01", endDate: "2026-08-31" }, previous_year: { startDate: "2025-09-01", endDate: "2025-09-30" } },
    });
  });

  it("last_quarter across a year boundary", () => {
    expect(lastCompleteQuarter(new Date("2026-02-10T00:00:00Z"))).toEqual({ year: 2025, q: 4 });
    const p = resolvePeriod({ range: "last_quarter" }, both, {}, new Date("2026-02-10T00:00:00Z"));
    expect(p).toMatchObject({ label: "Q4 2025", folderMonth: "2025-12", current: { startDate: "2025-10-01", endDate: "2025-12-31" } });
    expect(p.comparisons.previous_period).toEqual({ startDate: "2025-07-01", endDate: "2025-09-30" });
    expect(p.comparisons.previous_year).toEqual({ startDate: "2024-10-01", endDate: "2024-12-31" });
    expect(resolvePeriod({ range: "last_quarter" }, both, { quarter: "2026-Q1" }, today).comparisons.previous_period).toEqual({ startDate: "2025-10-01", endDate: "2025-12-31" });
  });

  it("last_n_days, custom, and only the requested comparisons", () => {
    const p = resolvePeriod({ range: "last_n_days", days: 28 }, ["previous_period"], {}, today);
    expect(p.current).toEqual({ startDate: "2026-09-13", endDate: "2026-10-10" });
    expect(p.comparisons).toEqual({ previous_period: { startDate: "2026-08-16", endDate: "2026-09-12" } });
    expect(p.label).toBe("13 Sep – 10 Oct 2026");
    const c = resolvePeriod({ range: "custom", start: "2025-12-15", end: "2026-01-14" }, [], {}, today);
    expect(c).toMatchObject({ label: "15 Dec 2025 – 14 Jan 2026", folderMonth: "2026-01", comparisons: {} });
  });

  it("maps 29 Feb to 28 Feb a year earlier", () => {
    expect(minusOneYear({ startDate: "2024-02-29", endDate: "2024-03-31" })).toEqual({ startDate: "2023-02-28", endDate: "2023-03-31" });
    const p = resolvePeriod(monthly, ["previous_year"], { startDate: "2024-02-01", endDate: "2024-02-29" }, today);
    expect(p.comparisons.previous_year).toEqual({ startDate: "2023-02-01", endDate: "2023-02-28" });
  });

  it("run overrides are mutually exclusive; a month on a quarter template is a one-month report", () => {
    expect(() => resolvePeriod(monthly, both, { month: "2026-08", quarter: "2026-Q2" }, today)).toThrow(/only one/);
    expect(() => resolvePeriod(monthly, both, { startDate: "2026-08-01" }, today)).toThrow(/go together/);
    expect(() => resolvePeriod(monthly, both, { quarter: "2026-Q5" }, today)).toThrow(/YYYY-Qn/);
    expect(() => resolvePeriod(monthly, both, { startDate: "2026-10-01", endDate: "2026-10-12" }, today)).toThrow(/days ago/);
    // R-4: impossible calendar days are refused, in overrides and in template files.
    expect(() => resolvePeriod(monthly, both, { startDate: "2026-02-01", endDate: "2026-02-31" }, today)).toThrow(/real YYYY-MM-DD/);
    expect(() => resolvePeriod(monthly, both, { startDate: "2026-13-01", endDate: "2026-13-02" }, today)).toThrow(/real YYYY-MM-DD/);
    expect(errorsOf(file('  t:\n    title: T\n    period: { range: custom, start: "2026-02-01", end: "2026-02-30" }\n    sections: [{ id: a, type: branded_split }]\n'))[0]).toMatchObject({ path: "templates.t.period.end", message: "is not a real date" });
    expect(resolvePeriod({ range: "last_quarter" }, both, { month: "2026-08" }, today).label).toBe("August 2026 (one month)");
  });

  it("labels and file slugs", () => {
    expect(rangeLabel({ startDate: "2026-07-01", endDate: "2026-09-30" })).toBe("1 Jul – 30 Sep 2026");
    expect(rangeLabel({ startDate: "2026-09-01", endDate: "2026-09-30" })).toBe("1–30 Sep 2026");
    expect(periodSlug({ startDate: "2026-09-01", endDate: "2026-09-30" })).toBe("2026-09");
    expect(periodSlug({ startDate: "2026-07-01", endDate: "2026-09-30" })).toBe("2026-q3");
    expect(periodSlug({ startDate: "2026-07-02", endDate: "2026-09-30" })).toBe("2026-07-02-to-2026-09-30");
    expect(safeSegment("Example.COM")).toBe("example.com");
  });
});

describe("crawlmark-cli report templates", () => {
  const io = (h: string) => {
    const lines: string[] = [];
    const errs: string[] = [];
    return { lines, errs, io: { out: (l = "") => lines.push(l), warn: (l: string) => errs.push(l), homeDir: h, cwd: h, today } };
  };

  it("init creates the starter once (0600) and then leaves it unchanged", () => {
    const h = home();
    const a = io(h);
    expect(templatesCommand("init", [], a.io)).toBe(0);
    const path = join(h, "config", "report-templates.yaml");
    expect(readFileSync(path, "utf8")).toBe(STARTER_YAML);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, "# edited\n" + STARTER_YAML);
    const b = io(h);
    expect(templatesCommand("init", [], b.io)).toBe(0);
    expect(b.lines.join("\n")).toMatch(/already exists; left it unchanged/);
    expect(readFileSync(path, "utf8")).toBe("# edited\n" + STARTER_YAML);
    expect(initStarterFile(h).created).toBe(false);
  });

  it("validate exits 1 naming the YAML path, 0 for a valid file; list shows sources", () => {
    const h = home();
    const bad = join(h, "bad.yaml");
    writeFileSync(bad, file("  t:\n    title: T\n    sections: [{ id: a, type: top_queries, limit: 0 }]\n"));
    const a = io(h);
    expect(templatesCommand("validate", ["bad.yaml"], a.io)).toBe(1);
    expect(a.lines.join("\n")).toContain("templates.t.sections[0].limit");
    templatesCommand("init", [], io(h).io);
    const b = io(h);
    expect(templatesCommand("validate", [], b.io)).toBe(0);
    const c = io(h);
    expect(templatesCommand("list", [], c.io)).toBe(0);
    expect(c.lines.join("\n")).toMatch(/monthly\s+Monthly SEO report\s+global/);
    expect(c.lines.join("\n")).toMatch(/quarterly\s+Quarterly SEO review\s+global/);
    expect(templatesCommand("bogus", [], io(h).io)).toBe(1);
    expect(existsSync(join(h, "reports"))).toBe(false);
  });

  it("the starter parses as plain YAML too (no anchors or tags)", () => {
    expect(parse(STARTER_YAML).version).toBe(1);
  });
});
