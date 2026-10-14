/**
 * Phase 12 C5: the ai_visibility template section. It runs only with paid: true in the template, allowPaid at
 * run time and AI_VISIBILITY_ENABLED=true; its sub-cap is checked in the run's pre-flight; questions are
 * escaped in every format.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError } from "../src/lib/budget.js";
import { exportReport } from "../src/reports/export.js";
import type { AiVisibilityData } from "../src/reports/report-types.js";
import { validateTemplateText } from "../src/reports/templates/schema.js";
import { fakeDeps } from "./fixtures/reports/deps.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const today = new Date("2026-10-13T12:00:00Z");
const TEMPLATE = `version: 1
templates:
  ai:
    title: AI
    period: { range: last_month }
    sections:
      - { id: search, type: search_overview }
      - { id: ai, type: ai_visibility, paid: true, limit: 5 }
`;
function homeWith(yaml: string): string {
  const home = mkdtempSync(join(tmpdir(), "crawlmark-c5-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "report-templates.yaml"), yaml);
  return home;
}
const DATA: AiVisibilityData = {
  mode: "mentions",
  platform: "google",
  domain: "example.com",
  mentions: {
    total: 3,
    items: [
      { question: "<script>alert(1)</script> | [x](https://evil.example)", aiSearchVolume: 2400, citedUrl: "https://www.example.com/pricing", position: 2 },
      { question: "water heater repair or replace", aiSearchVolume: 880, citedUrl: "https://blog.example.com/water-heaters", position: 4 },
    ],
  },
};

describe("ai_visibility section", () => {
  it("validates only with paid: true; limit up to 50; mode and platform enums", () => {
    expect(validateTemplateText(TEMPLATE, { today })).toMatchObject({ valid: true });
    expect(validateTemplateText(TEMPLATE.replace("paid: true, ", ""), { today }).errors).toEqual([{ path: "templates.ai.sections[1].paid", message: "ai_visibility is paid, so the section must set paid: true" }]);
    expect(validateTemplateText(TEMPLATE.replace("limit: 5", "limit: 51"), { today }).valid).toBe(false);
    expect(validateTemplateText(TEMPLATE.replace("limit: 5", "platform: perplexity"), { today }).valid).toBe(false);
  });

  it("without allowPaid it is skipped and nothing is called, even when switched on", async () => {
    const ai = vi.fn(async () => DATA);
    const est = vi.fn(() => ({ usd: 0.105, wouldExceed: false, message: "" }));
    const r = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "ai", include: [] }, fakeDeps({ aiVisibilityEnabled: () => true, aiVisibility: ai, aiVisibilityEstimate: est }));
    expect(r.sections.find((s) => s.id === "ai")).toMatchObject({ status: "skipped" });
    expect(ai).not.toHaveBeenCalled();
    expect(est).not.toHaveBeenCalled();
  });

  it("with allowPaid but switched off it is unavailable with a short reason, and nothing is called", async () => {
    const ai = vi.fn(async () => DATA);
    const r = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "ai", include: [], allowPaid: true }, fakeDeps({ aiVisibility: ai }));
    expect(r.sections.find((s) => s.id === "ai")).toMatchObject({ status: "unavailable", reason: "AI-search visibility is off (set AI_VISIBILITY_ENABLED=true to include it; it is paid)" });
    expect(ai).not.toHaveBeenCalled();
  });

  it("switched on: the estimate is reserved before the run; over the sub-cap the whole run stops before any paid request", async () => {
    const reserved: [number, unknown][] = [];
    const ai = vi.fn(async () => DATA);
    const ok = await fixtureReport(
      { homeDir: homeWith(TEMPLATE), template: "ai", include: [], allowPaid: true },
      fakeDeps({ aiVisibilityEnabled: () => true, aiVisibility: ai, aiVisibilityEstimate: () => ({ usd: 0.105, wouldExceed: false, message: "" }), withUsdReservation: async (_c, usd, fn, opts) => (reserved.push([usd, opts]), fn()) }),
    );
    // The run's reservation carries the AI share, so a concurrent ai_visibility call counts it against the sub-cap.
    expect(reserved).toEqual([[0.105, { aiUsd: 0.105 }]]);
    expect((ai.mock.calls[0] as unknown as [unknown, unknown])[1]).toEqual({ mode: "mentions", platform: "google", limit: 5 });
    expect(ok.sections.find((s) => s.id === "ai")).toMatchObject({ status: "ok", title: "AI search visibility" });

    const blocked = vi.fn(async () => DATA);
    const err = await fixtureReport(
      { homeDir: homeWith(TEMPLATE), template: "ai", include: [], allowPaid: true },
      fakeDeps({ aiVisibilityEnabled: () => true, aiVisibility: blocked, aiVisibilityEstimate: () => ({ usd: 0.105, wouldExceed: true, message: "the AI visibility cap has $0.0100 left" }) }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(blocked).not.toHaveBeenCalled();
  });

  it("two AI sections whose sum exceeds the AI sub-cap are refused before any request (R-1/SEC-4)", async () => {
    const two = TEMPLATE.replace("      - { id: ai, type: ai_visibility, paid: true, limit: 5 }\n", "      - { id: ai, type: ai_visibility, paid: true, limit: 5 }\n      - { id: ai2, type: ai_visibility, paid: true, mode: metrics }\n");
    expect(validateTemplateText(two, { today }).valid).toBe(true);
    const ai = vi.fn(async () => DATA);
    const reserve = vi.fn(async (_c: unknown, _u: number, fn: () => Promise<unknown>) => fn());
    // Each fits on its own ($0.105 and $0.11 < $0.15 left); together ($0.215) they don't.
    const err = await fixtureReport(
      { homeDir: homeWith(two), template: "ai", include: [], allowPaid: true },
      fakeDeps({ aiVisibilityEnabled: () => true, aiVisibility: ai, remainingAiUsd: () => 0.15, aiVisibilityEstimate: (_c, r) => ({ usd: r.mode === "metrics" ? 0.11 : 0.105, wouldExceed: false, message: "" }), withUsdReservation: reserve as never }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as Error).message).toMatch(/The ai_visibility sections together need about \$0\.2150 but the AI visibility cap .* has \$0\.1500 left/);
    expect(ai).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("renders in every format; questions are escaped and cited URLs are code, never links", async () => {
    const report = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "ai", include: [], allowPaid: true }, fakeDeps({ aiVisibilityEnabled: () => true, aiVisibility: async () => DATA }));
    const printer = vi.fn(async () => Buffer.from("%PDF-1.7"));
    const dir = join(mkdtempSync(join(tmpdir(), "crawlmark-c5-out-")), "reports");
    const out = await exportReport(report, { formats: ["md", "html", "docx", "pdf"], reportsDir: dir, branding: {}, version: "0.1.0", printer });
    const md = readFileSync(out.files[0]!.path, "utf8");
    const html = readFileSync(out.files[1]!.path, "utf8");
    const docXml = await (await JSZip.loadAsync(readFileSync(out.files[2]!.path))).file("word/document.xml")!.async("string");
    const pdfHtml = String((printer.mock.calls[0] as unknown as [string])[0]);
    for (const text of [md, html, docXml, pdfHtml]) {
      expect(text).toContain("Google AI Overviews");
      expect(text).toContain("water heater repair or replace");
    }
    expect(md).toContain("AI search visibility: DataForSEO LLM Mentions (paid).");
    expect(md).toContain("`https://www.example.com/pricing`");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('href="https://evil.example');
    expect(html).not.toContain('href="https://www.example.com/pricing');
  });
});
