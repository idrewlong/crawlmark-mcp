/**
 * Release 0.4.0 T1: layout checks that need a real Chrome (columns, page counts, phone width). Gated: runs only with
 * CRAWLMARK_LAYOUT_CHECK=1 (CI's LibreOffice job sets it; locally `CRAWLMARK_LAYOUT_CHECK=1 npm test -- design-layout`).
 * Fixture data only; Chrome is crawlmark's own managed one, with no network.
 */
import type { Page } from "puppeteer";
import { describe, expect, it } from "vitest";
import { withBrowser } from "../src/providers/browser.js";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toHtml } from "../src/reports/render/html.js";
import { chromePdfPrinter } from "../src/reports/render/pdf.js";
import { THEME_IDS, type ThemeId } from "../src/reports/templates/schema.js";
import { fixtureReport } from "./fixtures/reports/report.js";
import { layoutReport } from "./fixtures/reports/release-b-render.js";

const RUN = process.env.CRAWLMARK_LAYOUT_CHECK === "1";
const TIMEOUT = 120_000;

async function html(theme: ThemeId, onepage = false): Promise<string> {
  const report = onepage ? await fixtureReport({ template: "executive", include: [] }) : await layoutReport();
  return toHtml(buildReportDoc(report, { version: "0.4.0", theme, branding: { agencyName: "Example Agency" } }));
}

async function withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
  return withBrowser("layout check", undefined, async (browser) => {
    const page = await browser.newPage();
    try {
      return await work(page);
    } finally {
      await page.close();
    }
  });
}

describe.skipIf(!RUN)("theme layout in real Chrome", () => {
  it.each(["editorial", "friendly"] as const)("%s: both contents columns start at the same height (print media)", async (theme) => {
    const markup = await html(theme);
    const tops = await withPage(async (page) => {
      await page.setViewport({ width: 794, height: 1123 });
      await page.emulateMediaType("print");
      await page.setContent(markup, { waitUntil: "load" });
      return page.evaluate(() => {
        const items = Array.from(document.querySelectorAll(".contents li")).map((li) => li.getBoundingClientRect());
        const columns = new Map<number, number>();
        for (const r of items) columns.set(Math.round(r.left / 50), Math.min(columns.get(Math.round(r.left / 50)) ?? Infinity, r.top));
        return Array.from(columns.values());
      });
    });
    expect(tops.length, "two columns").toBe(2);
    expect(Math.abs(tops[0]! - tops[1]!)).toBeLessThanOrEqual(1);
  }, TIMEOUT);

  it.each(THEME_IDS as readonly ThemeId[])("%s: the one-page executive report prints on exactly one page", async (theme) => {
    const pdf = await chromePdfPrinter(await html(theme, true), { paper: "A4", footer: "Example Agency" });
    const pages = pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g)?.length ?? 0;
    expect(pages).toBe(1);
  }, TIMEOUT);

  it.each(THEME_IDS as readonly ThemeId[])("%s: no horizontal scroll at 375px", async (theme) => {
    const markup = await html(theme);
    const width = await withPage(async (page) => {
      await page.setViewport({ width: 375, height: 800 });
      await page.setContent(markup, { waitUntil: "load" });
      return page.evaluate(() => document.documentElement.scrollWidth);
    });
    expect(width).toBeLessThanOrEqual(375);
  }, TIMEOUT);
});
