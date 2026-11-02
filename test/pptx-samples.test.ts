/**
 * Writes sample decks to PPTX_SAMPLES_DIR so CI can check every XML part with xmllint and open each deck with
 * LibreOffice Impress: the monthly fixture in all six themes, a logo + white-label deck, and the technical and local
 * builtins in cards. `slides.json` maps each file to its slide count (CI compares it with the converted PDF's pages),
 * and `clients.json` to the client name the deck shows (CI looks for it in the converted text; decks show the client
 * name, not the domain). 0.5.0 adds the yearly report (all four yearly sections) in all six themes.
 * Skipped unless PPTX_SAMPLES_DIR is set.
 *
 * While deck.ts is still the T0 stub (the T3a branch before T3c is merged), the decks come from the hand-written
 * fixture deck instead, so the CI job still exercises the writer.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDeck } from "../src/reports/render/deck.js";
import { buildReportDoc, type ReportDoc } from "../src/reports/render/doc.js";
import { deckStyle, renderDeck } from "../src/reports/render/pptx/index.js";
import type { ThemeId } from "../src/reports/templates/schema.js";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import { fixtureDeck } from "./fixtures/pptx/decks.js";
import { fixtureReport, TINY_PNG } from "./fixtures/reports/report.js";
import { layoutReport } from "./fixtures/reports/release-b-render.js";
import { yearlyReport } from "./fixtures/reports/yearly-data.js";

const out = process.env.PPTX_SAMPLES_DIR;
const counts: Record<string, number> = {};
const clients: Record<string, string> = {};

const narrative = {
  summary: "Clicks grew **12%** month over month. Two pages moved onto page one.\n\n- Service pages drove most of the growth\n- One blog post slipped",
  sections: { search: "Clicks rose on the service pages. Impressions followed.\n\n- Keep the FAQ blocks\n- Refresh the pricing post" },
};

async function write(name: string, doc: ReportDoc) {
  let deck;
  try {
    deck = buildDeck(doc);
  } catch (err) {
    if (!(err instanceof Error && /not built yet/.test(err.message))) throw err;
    deck = fixtureDeck({ logo: !!doc.branding.logo, author: doc.branding.hideCrawlmark ? (doc.branding.agencyName ?? "") : "crawlmark", agencyName: doc.branding.agencyName ?? "Example Agency" });
  }
  const buf = await renderDeck(deck, deckStyle(doc));
  expect(buf.subarray(0, 2).toString()).toBe("PK");
  mkdirSync(out!, { recursive: true });
  writeFileSync(join(out!, name), buf);
  counts[name] = deck.slides.length;
  writeFileSync(join(out!, "slides.json"), `${JSON.stringify(counts, null, 2)}\n`);
  // The title slide shows the client name; CI checks the converted deck for it.
  const title = deck.slides[0];
  expect(title?.kind).toBe("title");
  expect(title?.title).toBe(doc.meta.clientName);
  expect(doc.meta.clientName).not.toMatch(/\.(com|org|net)$/);
  clients[name] = doc.meta.clientName;
  writeFileSync(join(out!, "clients.json"), `${JSON.stringify(clients, null, 2)}\n`);
}

describe.skipIf(!out)("PPTX samples for CI", () => {
  for (const theme of THEME_IDS) {
    it(`writes monthly-${theme}.pptx`, async () => {
      const report = await layoutReport();
      await write(`monthly-${theme}.pptx`, buildReportDoc(report, { version: "0.4.0", narrative, branding: { agencyName: "Example Agency", footer: "Example Agency · hello@example.com" }, theme: theme as ThemeId }));
    });
  }

  it("writes monthly-logo-white-label.pptx", async () => {
    const doc = buildReportDoc(await layoutReport(), {
      version: "0.4.0",
      narrative,
      branding: { agencyName: "Example Agency", hideCrawlmark: true, primaryColor: "#0b6e4f", footer: "Example Agency · hello@example.com" },
      logo: { mime: "image/png", data: TINY_PNG },
      theme: "friendly",
    });
    await write("monthly-logo-white-label.pptx", doc);
  });

  // 0.5.0: share charts by channel and page type, the wins table with goal tiles, the publish-year table.
  for (const theme of THEME_IDS) {
    it(`writes yearly-${theme}.pptx`, async () => {
      const report = yearlyReport();
      report.template = { ...report.template, cover: { preparedFor: "Jane Doe, Example Co", preparedBy: "Example Agency" } };
      const yearlyNarrative = {
        summary: "Clicks grew a third on 2024. Search brought the most sessions.\n\n- Service pages grew fastest\n- Two goals checked, one met",
        sections: { channels: "Search led the growth. Direct traffic followed.\n\n- Paid search held its share" },
      };
      await write(`yearly-${theme}.pptx`, buildReportDoc(report, { version: "0.5.0", narrative: yearlyNarrative, branding: { agencyName: "Example Agency", footer: "Example Agency · hello@example.com" }, theme: theme as ThemeId }));
    });
  }

  for (const id of ["technical", "local"]) {
    it(`writes ${id}-cards.pptx`, async () => {
      await write(`${id}-cards.pptx`, buildReportDoc(await fixtureReport({ template: id, include: [] }), { version: "0.4.0" }));
    });
  }
});
