/**
 * Phase 13 B Done-when, against fake provider servers (fetch stubbed on the closed local port; real provider code):
 * `crawlmark-cli report --client example.com --template monthly --include backlinks,visibility --paid --format pdf`
 * writes a PDF whose HTML shows the labelled authority metric and the referring-domain change vs the stored August
 * snapshot, and a second run the same day makes no provider request. estimateOnly with all three paid sections prices
 * each and makes no request; a client cap that can't cover them refuses the run before the first request.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";
import { reportCommand } from "../src/report-cli.js";
import { saveSnapshot } from "../src/lib/snapshots.js";
import { estimateTemplate, loadDefaultRunDeps, runTemplate, type RunDeps } from "../src/reports/templates/run.js";
import { BudgetExceededError } from "../src/lib/budget.js";
import { client as fixtureClient, fakeDeps } from "./fixtures/reports/deps.js";

const dx = (n: string) => readFileSync(new URL(`./fixtures/dataforseo/${n}`, import.meta.url), "utf8");
const DFS: Record<string, string> = {
  "/v3/backlinks/summary/live": dx("backlinks_summary_live.json"),
  "/v3/backlinks/history/live": dx("p13/backlinks_history_live.json"),
  "/v3/dataforseo_labs/google/domain_rank_overview/live": dx("p13/domain_rank_overview_live.json"),
  "/v3/dataforseo_labs/google/historical_rank_overview/live": dx("p13/historical_rank_overview_live.json"),
  "/v3/dataforseo_labs/google/competitors_domain/live": dx("p13/competitors_domain_live.json"),
};
function fake(): string[] {
  const log: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.hostname !== "127.0.0.1") throw new Error(`test tried to reach a real host: ${url.hostname}`);
      log.push(url.pathname);
      return DFS[url.pathname] ? new Response(DFS[url.pathname], { status: 200 }) : new Response("{}", { status: 404 });
    }),
  );
  return log;
}
afterEach(() => vi.unstubAllGlobals());

/** Fixture Google data with the real provider sections (and the real budget for them). */
async function deps(over: Partial<RunDeps> = {}): Promise<RunDeps> {
  const real = await loadDefaultRunDeps();
  return fakeDeps({ planProviderSection: real.planProviderSection, planIssueSources: real.planIssueSources, ...over });
}

describe("report --template monthly --include backlinks,visibility --paid", () => {
  it("PDF with the labelled authority and the change vs the stored August snapshot; the second run requests nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-p13b-cli-"));
    const c = { ...fixtureClient } as Client;
    // August, stored by last month's report.
    const now = Date.now();
    saveSnapshot({ client: c.slug, kind: "backlinks", target: "example.com", provider: "dataforseo", market: "global", day: "2026-08-31", source: "live", capturedAt: now - 40 * 86_400_000, data: { referringDomains: 180, backlinks: 1500, authority: { metric: "dataforseo_rank", value: 290 } } }, now);
    const log = fake();
    const htmls: string[] = [];
    const printer = vi.fn(async (html: string) => {
      htmls.push(html);
      return Buffer.from("%PDF-1.7 fixture");
    });
    const run = async () => {
      const lines: string[] = [];
      const code = await reportCommand(
        [],
        { client: "example.com", template: "monthly", include: "backlinks,visibility", format: "pdf", month: "2026-09", paid: true, all: false, "dry-run": false },
        { out: (l = "") => void lines.push(l), warn: () => undefined, homeDir: home, cwd: home, today: new Date("2026-10-13T12:00:00Z") },
        { loadClients: async () => ({ clients: [c], skipped: [] }), runDeps: async () => deps(), printer: printer as never, reportsDir: join(home, "reports"), version: "0.1.0" },
      );
      return { code, out: JSON.parse(lines.join("\n")) };
    };
    const first = await run();
    expect(first.code).toBe(0);
    expect(first.out.results[0].files.map((f: { format: string }) => f.format)).toEqual(["pdf"]);
    expect(log.length).toBeGreaterThan(0);
    const html = htmls[0]!;
    expect(html).toContain("<h2>Backlinks</h2>");
    expect(html).toContain("DataForSEO Rank (0–1000)");
    expect(html).toMatch(/vs 180 in August 2026/);
    expect(html).toContain("Source: DataForSEO.");
    for (const bad of ["units", "$", "2840", "provider_history"]) expect(html, bad).not.toContain(bad);

    const before = log.length;
    const second = await run();
    expect(second.code).toBe(0);
    expect(log.length).toBe(before);
  });
});

describe("estimateOnly and caps with all three paid sections", () => {
  it("prices each section with no request; a cap that can't cover them refuses the run before the first request", async () => {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-p13b-est-"));
    const c = { ...fixtureClient, slug: "est.example.com", domain: "est.example.com", competitors: ["competitor-a.example"] } as unknown as Client;
    const log = fake();
    const d = await deps();
    const est = await estimateTemplate(c, { template: "quarterly", include: ["backlinks", "visibility", "competitors"], homeDir: home, today: new Date("2026-10-13T12:00:00Z") }, d);
    expect(log).toHaveLength(0);
    expect(est.sections.map((s) => [s.id, s.provider, s.requests])).toEqual([
      ["backlinks", "dataforseo", 2],
      ["visibility", "dataforseo", 2],
      ["competitors", "dataforseo", 2],
    ]);
    expect(est.total.usd).toBeCloseTo(0.025 + 0.025 + 0.01212 + 0.11 + 0.0144 + 0.01212, 4);
    expect(est.message).toContain("3 paid sections");

    const refuse = await deps({ withUsdReservation: async () => { throw new BudgetExceededError("over the client cap"); } });
    await expect(runTemplate(c, { template: "quarterly", include: ["backlinks", "visibility", "competitors"], allowPaid: true, homeDir: home, today: new Date("2026-10-13T12:00:00Z"), store: false }, refuse)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(log).toHaveLength(0);
  });
});
