/**
 * The branding preview (`setup --step branding`, `report preview-branding`): a one-page report in the
 * executive layout with the agency's name, logo, colours, footer, paper size and white-label setting,
 * filled with made-up example.com numbers and badged "Sample data". It never reads client data and makes
 * no network or paid call; the only outside process is the local Chrome that prints the PDF (offline, JS off).
 */
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../lib/atomic-file.js";
import { stripControl } from "../lib/terminal-text.js";
import { loadLogo } from "./export.js";
import { computeHighlights } from "./highlights.js";
import type { MoversData, OpportunityLists, SearchOverviewData, TemplateReport } from "./report-types.js";
import { buildReportDoc } from "./render/doc.js";
import { toHtml } from "./render/html.js";
import type { PdfPrinter } from "./render/pdf.js";
import type { ResolvedBranding } from "./templates/load.js";

const day = (start: string, i: number) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);

/** A gentle weekday/weekend shape that adds up to `total` over `days` days. */
function series(start: string, days: number, total: number, wave: number): { date: string; v: number }[] {
  const w = Array.from({ length: days }, (_, i) => {
    const dow = new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).getUTCDay();
    return (1 + 0.15 * Math.sin(i / wave) + 0.006 * i) * (dow === 0 || dow === 6 ? 0.7 : 1);
  });
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x, i) => ({ date: day(start, i), v: Math.round((total * x) / sum) }));
}

/** Made-up example.com numbers for the preview (fixed, so the preview looks the same every time). */
export function sampleReport(generatedAt = new Date()): TemplateReport {
  const cur = { startDate: "2026-09-01", endDate: "2026-09-30" };
  const prev = { startDate: "2026-08-01", endDate: "2026-08-31" };
  const py = { startDate: "2025-09-01", endDate: "2025-09-30" };
  const clicks = series(cur.startDate, 30, 1120, 4.1);
  const impressions = series(cur.startDate, 30, 20000, 4.1);
  const prevClicks = series(prev.startDate, 31, 952, 3.7);
  const prevImpr = series(prev.startDate, 31, 17000, 3.7);
  const totals = { clicks: 1120, impressions: 20000, ctr: 5.6, position: 7.5 };
  const p = { clicks: 952, impressions: 17000, ctr: 5.6, position: 8.2 };
  const y = { clicks: 672, impressions: 12000, ctr: 5.6, position: 8.2 };
  const vs = (o: typeof p) => ({
    clicks: { value: totals.clicks, change: Number((((totals.clicks - o.clicks) / o.clicks) * 100).toFixed(1)) },
    impressions: { value: totals.impressions, change: Number((((totals.impressions - o.impressions) / o.impressions) * 100).toFixed(1)) },
    ctr: { value: totals.ctr, change: Number((totals.ctr - o.ctr).toFixed(2)) },
    position: { value: totals.position, change: Number((totals.position - o.position).toFixed(1)) },
    previous: o,
  });
  const search: SearchOverviewData = {
    metrics: ["clicks", "impressions", "ctr", "position"],
    current: totals,
    vsPreviousPeriod: vs(p),
    vsPreviousYear: vs(y),
    daily: {
      current: clicks.map((c, i) => ({ date: c.date, clicks: c.v, impressions: impressions[i]!.v })),
      previous: prevClicks.map((c, i) => ({ date: c.date, clicks: c.v, impressions: prevImpr[i]!.v })),
      comparedWith: "previous_period",
    },
  };
  const movers: MoversData = {
    comparedWith: "previous_period",
    gainers: [
      { key: "emergency plumber", clicks: 180, clicksDelta: 27, position: 6.4, positionDelta: -0.7, branded: false },
      { key: "water heater repair", clicks: 120, clicksDelta: 18, position: 8.1, positionDelta: -0.7, branded: false },
      { key: "drain cleaning near me", clicks: 90, clicksDelta: 13, position: 11.3, positionDelta: -0.7, branded: false },
    ],
    losers: [{ key: "leak detection", clicks: 60, clicksDelta: -93, position: 4.2, positionDelta: 0.4, branded: false }],
  };
  const opportunities = {
    window: cur,
    method: "Sample data.",
    strikingDistance: {
      total: 2,
      top: [
        { query: "drain cleaning near me", topPage: "https://example.com/services/drains", position: 11.3, impressions: 5200, clicks: 90, ctr: 1.73, estimatedExtraClicks: 400 },
        { query: "water heater repair", topPage: "https://example.com/blog/water-heaters", position: 8.1, impressions: 3100, clicks: 120, ctr: 3.87, estimatedExtraClicks: 160 },
      ],
    },
    lowCtr: { total: 1, top: [{ query: "emergency plumber", page: "https://example.com/services/emergency", position: 2.4, impressions: 4200, clicks: 180, ctr: 4.29, expectedCtr: 15.1, estimatedExtraClicks: 450 }] },
    cannibalization: { total: 0, top: [] },
  } as unknown as OpportunityLists;
  const report: TemplateReport = {
    reportId: "rpt_00000000000000000000SAMPLE",
    client: { slug: "example.com", name: "Example Co", domain: "example.com" },
    template: { id: "executive", title: "Executive summary", source: "builtin", layout: "onepage" },
    period: { current: cur, label: "September 2026", folderMonth: "2026-09", comparisons: { previous_period: prev, previous_year: py } },
    generatedAt: generatedAt.toISOString(),
    sections: [
      { id: "search", type: "search_overview", title: "Clicks this period", status: "ok", data: search },
      { id: "wins", type: "query_movers", title: "Top wins", status: "ok", data: movers },
      { id: "next", type: "opportunities", title: "Next steps", status: "ok", data: opportunities },
    ],
    highlights: [],
    notes: [],
    spend: { usd: 0, units: { ahrefs: 0, semrush: 0 } },
  };
  report.highlights = computeHighlights(report);
  return report;
}

export interface PreviewResult {
  path: string;
  format: "pdf" | "html";
  /** Why the PDF couldn't be made (usually no Chrome); the HTML preview was written instead. */
  warning?: string;
  /** The logo couldn't be used (missing, too big, not PNG/JPEG). */
  logoWarning?: string;
}

/**
 * Render the preview to `<home>/branding/preview.pdf` (0600, overwritten each time), or `preview.html` when
 * the PDF can't be printed. The branding directory is 0700 and never a symlink.
 */
export async function renderBrandingPreview(homeDir: string, branding: ResolvedBranding, opts: { printer: PdfPrinter; version: string; now?: Date }): Promise<PreviewResult> {
  const { logo, warning: logoWarning } = loadLogo(branding);
  const doc = buildReportDoc(sampleReport(opts.now), { branding, logo, version: opts.version, sample: true });
  const html = toHtml(doc);
  const dir = join(homeDir, "branding");
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${dir}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const extra = logoWarning ? { logoWarning } : {};
  try {
    const pdf = await opts.printer(html, { paper: doc.branding.paper, footer: doc.footer });
    const path = join(dir, "preview.pdf");
    writeFileAtomic(path, pdf, 0o600);
    return { path, format: "pdf", ...extra };
  } catch (err) {
    const path = join(dir, "preview.html");
    writeFileAtomic(path, html, 0o600);
    return { path, format: "html", warning: `The PDF preview couldn't be made (${stripControl((err as Error).message).slice(0, 200)}), so it's HTML.`, ...extra };
  }
}
