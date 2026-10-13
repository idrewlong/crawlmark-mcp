import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderUnavailableError } from "../src/lib/provider-ids.js";
import { computeHighlights } from "../src/reports/highlights.js";
import type { SectionResult, TemplateReport } from "../src/reports/report-types.js";
import { getStoredReport, planRun, runTemplate, ulid } from "../src/reports/templates/run.js";
import { putCache, cacheKey } from "../src/lib/cache.js";
import { client, CRUX_OK, fakeDeps } from "./fixtures/reports/deps.js";

const today = new Date("2026-10-13T12:00:00Z");
const home = () => mkdtempSync(join(tmpdir(), "crawlmark-run-"));
const opts = (h = home(), extra = {}) => ({ homeDir: h, today, month: "2026-09", ...extra });

describe("runTemplate", () => {
  it("runs the builtin monthly in template order, optional sections only when included", async () => {
    const r = await runTemplate(client, opts(), fakeDeps());
    expect(r.sections.map((s) => s.id)).toEqual(["search", "brand", "traffic", "queries", "query-movers", "pages", "page-movers", "landing", "tracked", "opportunities", "audit", "spend"]);
    expect(r.sections.every((s) => s.status === "ok")).toBe(true);
    expect(r.period).toMatchObject({ label: "September 2026", folderMonth: "2026-09" });
    expect(r.template).toEqual({ id: "monthly", title: "Monthly SEO report", source: "builtin" });
    expect(r.reportId).toMatch(/^rpt_[0-9A-Z]{26}$/);
    const withOpt = await runTemplate(client, opts(undefined, { include: ["gtm", "cwv"] }), fakeDeps());
    expect(withOpt.sections.slice(-2).map((s) => [s.id, s.status])).toEqual([["cwv", "ok"], ["gtm", "ok"]]);
  });

  it("search_overview data is compare() output for both comparisons, as in monthly_report", async () => {
    const r = await runTemplate(client, opts(), fakeDeps());
    const s = r.sections[0] as Extract<SectionResult, { status: "ok" }>;
    expect(s.data).toMatchObject({
      vsPreviousPeriod: { clicks: { value: 1120, change: 17.6 }, previous: { clicks: 952 } },
      vsPreviousYear: { clicks: { value: 1120, change: 66.7 }, previous: { clicks: 672 } },
    });
  });

  it("rejects unknown or non-optional include ids", async () => {
    await expect(runTemplate(client, opts(undefined, { include: ["nope"] }), fakeDeps())).rejects.toThrow(/no section "nope"/);
    await expect(runTemplate(client, opts(undefined, { include: ["search"] }), fakeDeps())).rejects.toThrow(/isn't optional/);
  });

  it("skips a paid section without allowPaid and runs it (after the budget check) with allowPaid", async () => {
    const h = home();
    mkdirSync(join(h, "config"), { recursive: true });
    writeFileSync(join(h, "config", "report-templates.yaml"), "version: 1\ntemplates:\n  live:\n    title: Live\n    sections: [{ id: ranks, type: tracked_keywords, liveRanks: true, paid: true }]\n");
    const serp = vi.fn(async () => ({ clientRank: 2, clientUrl: "https://example.com/" }));
    const skipped = await runTemplate(client, opts(h, { template: "live" }), fakeDeps({ serp }));
    expect(skipped.sections[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("allowPaid") });
    expect(serp).not.toHaveBeenCalled();
    // SEC-1: the whole paid estimate is checked and reserved while the sections run.
    const withUsdReservation = vi.fn(async (_c: unknown, _usd: number, fn: () => Promise<unknown>) => fn()) as never;
    const ran = await runTemplate(client, opts(h, { template: "live", allowPaid: true }), fakeDeps({ serp, withUsdReservation }));
    expect(withUsdReservation).toHaveBeenCalledWith(client, 3 * 0.002, expect.any(Function));
    expect(serp).toHaveBeenCalledTimes(3);
    expect(ran.sections[0]).toMatchObject({ status: "ok", data: { keywords: [{ liveRank: 2 }, { liveRank: 2 }, { liveRank: 2 }] } });
  });

  it("marks unavailable sources as unavailable and a throwing source as error; the rest stay ok", async () => {
    const noGa4 = { ...client, ga4PropertyId: undefined } as never;
    const r = await runTemplate(noGa4, opts(undefined, { include: ["cwv"] }), fakeDeps({
      gscTotals: async () => {
        throw new Error("Search Console said no");
      },
      cruxHistory: async () => {
        throw new ProviderUnavailableError("serpLive" as never, null, "CrUX History needs CRUX_API_KEY");
      },
    }));
    const by = Object.fromEntries(r.sections.map((s) => [s.id, s]));
    expect(by.search).toMatchObject({ status: "error", error: "Search Console said no" });
    expect(by.traffic).toMatchObject({ status: "unavailable", reason: "no GA4 property for example.com" });
    expect(by.landing!.status).toBe("unavailable");
    expect(by.cwv!.status).toBe("unavailable");
    expect(by.queries!.status).toBe("ok");
    const noGoogle = await runTemplate(client, opts(), fakeDeps({ googleConfigured: () => false }));
    expect(noGoogle.sections.find((s) => s.id === "search")).toMatchObject({ status: "unavailable", reason: expect.stringContaining("setup --step google") });
    const cruxNoData = await runTemplate(client, opts(undefined, { include: ["cwv"] }), fakeDeps({ cruxHistory: async () => ({ key: { origin: "https://example.com", formFactor: "PHONE" }, keySource: "CRUX_API_KEY", available: false, reason: "no CrUX data" }) }));
    expect(cruxNoData.sections.find((s) => s.id === "cwv")).toMatchObject({ status: "unavailable", reason: "no CrUX data" });
  });

  it("stores the report for export (reportId round-trip) and errors clearly when it expired", async () => {
    const r = await runTemplate(client, opts(), fakeDeps());
    expect(getStoredReport(r.reportId)).toEqual(r);
    putCache(cacheKey("report-run", r.reportId), -1, r);
    expect(() => getStoredReport(r.reportId)).toThrow(/expired.*run_report_template again/);
    expect(() => getStoredReport("nope")).toThrow(/isn't a report ID/);
    expect(ulid(0)).toMatch(/^0{10}[0-9A-Z]{16}$/);
  });

  it("an invalid global or client template file is an operator warning (file name only), never a note; the builtin still runs (R-3)", async () => {
    const h = home();
    mkdirSync(join(h, "config", "report-templates"), { recursive: true });
    writeFileSync(join(h, "config", "report-templates.yaml"), "version: 1\ntemplates: { monthly: { title: M, sections: [{ id: a, type: bogus }] } }\n");
    writeFileSync(join(h, "config", "report-templates", "example.com.yaml"), "version: 2\n");
    const r = await runTemplate(client, opts(h), fakeDeps());
    expect(r.template.source).toBe("builtin");
    expect(r.warnings).toEqual([
      expect.stringMatching(/^Template file report-templates\.yaml has errors and was ignored.*validate_report_template/),
      expect.stringMatching(/^Template file example\.com\.yaml has errors/),
    ]);
    expect(r.warnings!.join(" ")).not.toContain(h);
    expect(r.notes.some((n) => n.includes("Template file"))).toBe(false);
    expect((await runTemplate(client, opts(), fakeDeps())).warnings).toBeUndefined();
  });

  it("a quarterly template without previous_period compares the branded split with the previous year", async () => {
    const h = home();
    mkdirSync(join(h, "config"), { recursive: true });
    writeFileSync(join(h, "config", "report-templates.yaml"), "version: 1\ntemplates:\n  q:\n    title: Q\n    period: { range: last_quarter }\n    compare: [previous_year]\n    sections: [{ id: brand, type: branded_split }, { id: movers, type: query_movers }]\n");
    const plan = planRun(client, { homeDir: h, today, template: "q" });
    expect(plan.period.label).toBe("Q3 2026");
    const r = await runTemplate(client, { homeDir: h, today, template: "q" }, fakeDeps());
    expect(r.sections[0]).toMatchObject({ status: "ok", data: { comparedWith: "previous_year" } });
    expect(r.sections[1]).toMatchObject({ status: "ok", data: { comparedWith: "previous_year" } });
  });
});

const ok = (id: string, type: string, data: unknown): SectionResult => ({ id, type, title: id, status: "ok", data });
const period = { current: { startDate: "2026-09-01", endDate: "2026-09-30" }, label: "September 2026", folderMonth: "2026-09", comparisons: { previous_period: { startDate: "2026-08-01", endDate: "2026-08-31" }, previous_year: { startDate: "2025-09-01", endDate: "2025-09-30" } } };
const totals = (clicks: number, prevClicks: number, change: number | null) => ({ clicks: { value: clicks, change }, impressions: { value: 1, change: 0 }, ctr: { value: 1, change: 0 }, position: { value: 1, change: 0 }, previous: { clicks: prevClicks, impressions: 1, ctr: 1, position: 1 } });

describe("computeHighlights", () => {
  const hl = (sections: SectionResult[]) => computeHighlights({ sections, period } as Pick<TemplateReport, "sections" | "period">);

  it("clicks: fires at 5% and 20 clicks, not below either; quotes the absolute numbers", () => {
    expect(hl([ok("s", "search_overview", { vsPreviousPeriod: totals(1120, 1000, 12.0), vsPreviousYear: null })])).toEqual([
      { kind: "clicks-vs-previous-period", sectionId: "s", text: "Clicks rose 12.0% (from 1,000 to 1,120) vs August 2026.", value: 12 },
    ]);
    expect(hl([ok("s", "search_overview", { vsPreviousPeriod: totals(420, 400, 5.0), vsPreviousYear: null })])).toHaveLength(1);
    expect(hl([ok("s", "search_overview", { vsPreviousPeriod: totals(1049, 1000, 4.9), vsPreviousYear: null })])).toEqual([]);
    expect(hl([ok("s", "search_overview", { vsPreviousPeriod: totals(119, 100, 19), vsPreviousYear: null })])).toEqual([]);
    expect(hl([ok("s", "search_overview", { vsPreviousPeriod: null, vsPreviousYear: totals(500, 1000, -50) })])[0]!.text).toBe("Clicks fell 50.0% (from 1,000 to 500) vs September 2025.");
    expect(hl([ok("s", "search_overview", { vsPreviousPeriod: { ...totals(5, 0, null), previous: null }, vsPreviousYear: null })])).toEqual([]);
  });

  it("audit: resolved count and new critical/high; unverified never counted as resolved", () => {
    const f = (severity: string) => ({ id: severity, source: "onpage", rule: "r", url: "https://example.com/", severity, title: "t" });
    const diff = { new: [f("critical"), f("high"), f("low")], resolved: [f("medium")], persistent: [], unverified: [f("high"), f("high")], counts: {} };
    expect(hl([ok("a", "audit_changes", { limit: 10, comparison: { diff } })])[0]!.text).toBe("1 audit issue resolved, 2 new critical or high-severity issues since the last audit.");
    expect(hl([ok("a", "audit_changes", { limit: 10, comparison: null })])).toEqual([]);
  });

  it("tracked keywords moving 3+ places, CrUX rating changes, movers non-branded first; at most 8", () => {
    const kw = (keyword: string, prev: number, cur: number) => ({ keyword, branded: false, gscPosition: cur, gscPositionPrevious: prev, positionChange: Number((cur - prev).toFixed(1)) });
    const out = hl([
      ok("t", "tracked_keywords", { comparedWith: "previous_period", keywords: [kw("a", 9.1, 5.2), kw("b", 5, 7.9)] }),
      ok("c", "core_web_vitals_history", CRUX_OK),
      ok("m", "query_movers", { comparedWith: "previous_period", gainers: [{ key: "example co", clicks: 300, clicksDelta: 50, branded: true }, { key: "leak", clicks: 60, clicksDelta: 30, branded: false }], losers: [] }),
    ]);
    expect(out.map((h) => h.text)).toEqual([
      'Top gaining query: "leak" (+30 clicks, from 30 to 60).',
      'Tracked keyword "a": average position went from 9.1 to 5.2 (lower is better).',
      "LCP for real users (75th percentile) went from 2,900 ms (needs improvement) to 2,300 ms (good).",
    ]);
    const many = Array.from({ length: 12 }, (_, i) => kw(`k${i}`, 20, 10));
    expect(hl([ok("t", "tracked_keywords", { comparedWith: "previous_period", keywords: many })])).toHaveLength(8);
  });

  it("is deterministic on the fixture report", async () => {
    const r = await runTemplate(client, { homeDir: home(), today, month: "2026-09", store: false }, fakeDeps());
    expect(r.highlights.map((h) => h.kind)).toEqual(["clicks-vs-previous-period", "clicks-vs-previous-year", "non-branded-clicks", "organic-sessions", "top-gaining-query", "top-losing-query", "audit-changes"]);
    expect(r.highlights.every((h) => /\d/.test(h.text))).toBe(true);
  });
});
