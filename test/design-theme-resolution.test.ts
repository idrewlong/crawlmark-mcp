/** Release 0.4.0 T0 (P-C2, D7): the report theme is export override > template > client/global branding > cards. */
import { describe, expect, it } from "vitest";
import { buildReportDoc } from "../src/reports/render/doc.js";
import type { TemplateReport } from "../src/reports/report-types.js";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import { getStoredReport, storeReport } from "../src/reports/templates/run.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const v = { version: "0.4.0" };

describe("theme resolution", () => {
  it("1. nothing set: cards", async () => {
    expect(buildReportDoc(await fixtureReport(), v).branding.theme).toBe("cards");
  });

  it("2. branding theme (the merged client-over-global value) applies", async () => {
    expect(buildReportDoc(await fixtureReport(), { ...v, branding: { theme: "friendly" } }).branding.theme).toBe("friendly");
  });

  it("3. the template theme beats the branding theme", async () => {
    const r = await fixtureReport();
    r.template.theme = "bold";
    expect(buildReportDoc(r, { ...v, branding: { theme: "friendly" } }).branding.theme).toBe("bold");
  });

  it("4. the export override beats the template and the branding", async () => {
    const r = await fixtureReport();
    r.template.theme = "bold";
    expect(buildReportDoc(r, { ...v, branding: { theme: "friendly" }, theme: "minimal" }).branding.theme).toBe("minimal");
  });

  it("5. a stored report from 0.3.0 (no template.theme) resolves the branding theme", async () => {
    const r = await fixtureReport();
    expect(r.template).not.toHaveProperty("theme");
    storeReport(r);
    const stored: TemplateReport = JSON.parse(JSON.stringify(getStoredReport(r.reportId)));
    expect(stored.template).not.toHaveProperty("theme");
    expect(buildReportDoc(stored, { ...v, branding: { theme: "consulting" } }).branding.theme).toBe("consulting");
    expect(buildReportDoc(stored, v).branding.theme).toBe("cards");
  });

  it.each(THEME_IDS)("the export override %s is always honoured", async (id) => {
    expect(buildReportDoc(await fixtureReport(), { ...v, theme: id }).branding.theme).toBe(id);
  });
});
