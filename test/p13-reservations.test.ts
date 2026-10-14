/**
 * Phase 13 A-3: whole-run unit reservations (D16) and estimateOnly report runs (D17). The ledger is the temp
 * SQLite from test/setup.ts; providers are local fakes or the real estimate functions with fetch stubbed to
 * fail, so no request leaves the machine.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";
import { BudgetExceededError, recordUnits, unitsThisMonth } from "../src/lib/budget.js";
import { pendingFor, remainingUnits, unitsCall, withUnitsReservation } from "../src/providers/units-billing.js";
import type { EstimateResult } from "../src/providers/seo-data.js";
import { estimateTemplate, loadDefaultRunDeps, runTemplate } from "../src/reports/templates/run.js";
import { client as fixtureClient, fakeDeps } from "./fixtures/reports/deps.js";

afterEach(() => vi.unstubAllGlobals());

function unitClient(slug: string, ahrefs: number): Client {
  return { slug, domain: slug, name: "Example Co", aliases: [], monthlyUnits: { ahrefs, semrush: 5_000 } } as unknown as Client;
}

describe("withUnitsReservation (D16)", () => {
  it("two concurrent runs whose sum exceeds the cap: the second is refused before any request", async () => {
    const c = unitClient("units-run.example.com", 1_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const requests: string[] = [];
    const runA = withUnitsReservation(c, "ahrefs", 600, async () => {
      // The run's own per-call check: its whole-run reservation isn't counted against it.
      const r = await unitsCall({
        client: c,
        provider: "ahrefs",
        capability: "test",
        keyParts: { run: "a" },
        ttl: 60,
        estimate: 600,
        run: async () => {
          requests.push("a");
          await gate;
          recordUnits(c.slug, "ahrefs", "/test", 600);
          return { value: "ok", units: 600 };
        },
      });
      return r.value;
    });
    // Run A's reservation (600) is counted once from outside, not again for the call inside it.
    await vi.waitFor(() => expect(requests).toEqual(["a"]));
    expect(pendingFor("ahrefs", [c.slug])).toEqual({ client: 600, global: 600 });
    expect(remainingUnits(c, "ahrefs").client).toBe(400);
    const runB = vi.fn(async () => {
      requests.push("b");
      return "b";
    });
    await expect(withUnitsReservation(c, "ahrefs", 600, runB)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(runB).not.toHaveBeenCalled();
    release();
    expect(await runA).toBe("ok");
    expect(requests).toEqual(["a"]);
    expect(unitsThisMonth(c.slug, "ahrefs")).toBe(600);
    // Released once the run ends.
    expect(pendingFor("ahrefs", [c.slug])).toEqual({ client: 0, global: 0 });
  });

  it("a run fits when the other run is for another provider or client", async () => {
    const a = unitClient("units-a.example.com", 1_000);
    const b = unitClient("units-b.example.com", 1_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = withUnitsReservation(a, "ahrefs", 900, () => gate);
    await expect(withUnitsReservation(b, "ahrefs", 900, async () => "b")).resolves.toBe("b");
    await expect(withUnitsReservation(a, "semrush", 900, async () => "s")).resolves.toBe("s");
    release();
    await held;
  });
});

describe("runTemplate reserves the live ranks of a tracked_keywords section with the run", () => {
  const live = "      - { id: kw, type: tracked_keywords, liveRanks: true, paid: true }\n";
  it("one reservation of keywords x the SERP estimate around the run; the per-keyword calls are not reserved again", async () => {
    const reserved: number[] = [];
    const serp = vi.fn(async () => ({ clientRank: 4, clientUrl: "https://example.com/" }));
    const deps = fakeDeps({ serp, withUsdReservation: async (_c, usd, fn) => (reserved.push(usd), fn()) });
    const r = await runTemplate(fixtureClient, { homeDir: homeWith(live), template: "paid", today, allowPaid: true, store: false }, deps);
    expect(reserved).toEqual([Number((fixtureClient.trackedKeywords.length * 0.002).toFixed(4))]);
    expect(serp).toHaveBeenCalledTimes(fixtureClient.trackedKeywords.length);
    expect(r.sections.find((s) => s.id === "kw")?.status).toBe("ok");
  });

  it("when the estimate doesn't fit the run is refused before any section or SERP request", async () => {
    const serp = vi.fn();
    const gscQuery = vi.fn(async () => []);
    const deps = fakeDeps({ serp, gscQuery, withUsdReservation: async () => { throw new BudgetExceededError("Budget cap hit for example.com"); } });
    await expect(runTemplate(fixtureClient, { homeDir: homeWith(live), template: "paid", today, allowPaid: true, store: false }, deps)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(serp).not.toHaveBeenCalled();
    expect(gscQuery).not.toHaveBeenCalled();
  });
});

const gapEstimate = (o: Partial<EstimateResult> & { provider: EstimateResult["provider"]; usd?: number; units?: number }): EstimateResult => ({
  estimateOnly: true,
  provider: o.provider,
  estimate: { provider: o.provider, requests: 2, usd: o.usd ?? 0, units: o.units ?? null, breakdown: "fixture", cached: false },
  remaining: { unit: o.provider === "dataforseo" ? "usd" : "units", client: 1, global: 1 },
  wouldExceed: o.wouldExceed ?? false,
  message: o.message ?? "fixture",
});

function homeWith(sections: string): string {
  const home = mkdtempSync(join(tmpdir(), "crawlmark-p13-est-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "report-templates.yaml"), `version: 1\ntemplates:\n  paid:\n    title: Paid\n    period: { range: last_month }\n    sections:\n      - { id: search, type: search_overview }\n${sections}`);
  return home;
}
const today = new Date("2026-10-13T12:00:00Z");

describe("runTemplate reserves each unit provider's whole estimate", () => {
  it("two Ahrefs keyword gap sections: one reservation of their sum, around every section", async () => {
    const reserved: [string, number][] = [];
    const deps = fakeDeps({
      keywordGap: async (_c, req, o) => {
        if (o.estimateOnly) return gapEstimate({ provider: "ahrefs", units: 300 });
        return { provider: "ahrefs", gaps: [], perCompetitor: req.competitors.map((d) => ({ domain: d, returned: 0 })) } as never;
      },
      withUnitsReservation: async (_c, p, u, fn) => {
        reserved.push([p, u]);
        return fn();
      },
    });
    const home = homeWith("      - { id: gap1, type: keyword_gap, paid: true, limit: 10 }\n      - { id: gap2, type: keyword_gap, paid: true, limit: 20 }\n");
    const r = await runTemplate(fixtureClient, { homeDir: home, template: "paid", today, allowPaid: true, store: false }, deps);
    expect(reserved).toEqual([["ahrefs", 600]]);
    expect(r.sections.filter((s) => s.type === "keyword_gap").map((s) => s.status)).toEqual(["ok", "ok"]);
  });

  it("refuses the whole run, before any section runs, when the units together don't fit", async () => {
    const gscQuery = vi.fn(async () => []);
    const deps = fakeDeps({
      gscQuery,
      keywordGap: async () => gapEstimate({ provider: "semrush", units: 400 }),
      remainingUnits: () => ({ client: 700, global: 50_000 }),
    });
    const home = homeWith("      - { id: gap1, type: keyword_gap, paid: true }\n      - { id: gap2, type: keyword_gap, paid: true }\n");
    await expect(runTemplate(fixtureClient, { homeDir: home, template: "paid", today, allowPaid: true, store: false }, deps)).rejects.toThrow(/need 800 semrush units but example.com has 700 left/);
    expect(gscQuery).not.toHaveBeenCalled();
  });
});

describe("estimateOnly (D17)", () => {
  const SECTIONS = "      - { id: gap, type: keyword_gap, paid: true, limit: 50 }\n      - { id: local, type: local_profile, paid: true, packKeywords: 2 }\n";

  it("prices keyword_gap + local_profile, sums them and makes no provider request", async () => {
    const keywordGap = vi.fn(async (_c: unknown, _r: unknown, o: { estimateOnly?: boolean }) => {
      if (!o.estimateOnly) throw new Error("a real gap request");
      return gapEstimate({ provider: "dataforseo", usd: 0.0242 });
    });
    const localProfile = vi.fn(async () => {
      throw new Error("a real local request");
    });
    const deps = fakeDeps({ keywordGap: keywordGap as never, localProfile, localProfileEstimateUsd: () => 0.0094 });
    const e = await estimateTemplate(fixtureClient, { homeDir: homeWith(SECTIONS), template: "paid", today }, deps);
    expect(e).toMatchObject({
      estimateOnly: true,
      template: "paid",
      total: { usd: 0.0336, units: { ahrefs: 0, semrush: 0 } },
      remaining: { usd: { client: 4.61, global: 49.5 } },
      wouldExceed: false,
    });
    expect(e.sections.map((s) => [s.id, s.provider, s.usd])).toEqual([
      ["gap", "dataforseo", 0.0242],
      ["local", "dataforseo", 0.0094],
    ]);
    expect(e.message).toMatch(/2 paid sections: DataForSEO \$0\.0336/);
    expect(keywordGap).toHaveBeenCalledTimes(1);
    expect(localProfile).not.toHaveBeenCalled();
  });

  it("over the cap: wouldExceed, with the provider's own message (which names a limit that fits)", async () => {
    const deps = fakeDeps({ keywordGap: async () => gapEstimate({ provider: "dataforseo", usd: 0.5, wouldExceed: true, message: "That needs $0.5000 of DataForSEO (…) but example.com has $0.0300 left this month. Use limit 10 ($0.0240), or raise monthlyBudgetUsd." }), remainingUsd: () => ({ clientUsd: 0.03, globalUsd: 40 }) });
    const e = await estimateTemplate(fixtureClient, { homeDir: homeWith(SECTIONS), template: "paid", today }, deps);
    expect(e.wouldExceed).toBe(true);
    expect(e.message).toMatch(/Use limit 10/);
    expect(e.message).toMatch(/has \$0\.0300 left this month/);
  });

  it("a template with no paid section costs nothing", async () => {
    const e = await estimateTemplate(fixtureClient, { homeDir: homeWith(""), template: "paid", today }, fakeDeps());
    expect(e).toMatchObject({ sections: [], total: { usd: 0 }, wouldExceed: false });
    expect(e.message).toMatch(/costs nothing/);
  });

  it("with the real estimate functions: DataForSEO keyword gap and local profile priced, fetch never called", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("no request may be made");
    });
    vi.stubGlobal("fetch", fetch);
    const c = { ...fixtureClient, slug: "estimate.example.com", competitors: ["competitor-a.example"], competitorEntries: [], gbpPlaceId: "ChIJexample", trackedKeywords: ["emergency plumber", "drain cleaning"], dataProvider: "dataforseo" } as unknown as Client;
    const e = await estimateTemplate(c, { homeDir: homeWith(SECTIONS), template: "paid", today }, await loadDefaultRunDeps());
    expect(fetch).not.toHaveBeenCalled();
    expect(e.sections.map((s) => s.provider)).toEqual(["dataforseo", "dataforseo"]);
    expect(e.total.usd).toBeGreaterThan(0);
    expect(e.total.usd).toBe(Number((e.sections[0]!.usd + e.sections[1]!.usd).toFixed(4)));
  });
});

describe("crawlmark-cli report --dry-run (D17)", () => {
  it("adds the paid sections' estimate to the dry-run result and runs nothing", async () => {
    const { reportCommand } = await import("../src/report-cli.js");
    const home = homeWith("      - { id: gap, type: keyword_gap, paid: true, limit: 50 }\n");
    const lines: string[] = [];
    const runTemplateCalls = vi.fn();
    const deps = fakeDeps({ keywordGap: async (_c, _r, o) => (o.estimateOnly ? gapEstimate({ provider: "dataforseo", usd: 0.018 }) : (runTemplateCalls(), ({} as never))) });
    const code = await reportCommand(
      [],
      { client: "example.com", template: "paid", month: "2026-09", paid: false, all: false, "dry-run": true },
      { out: (l = "") => void lines.push(l), warn: () => undefined, homeDir: home, cwd: home, today },
      { loadClients: async () => ({ clients: [fixtureClient], skipped: [] }), runDeps: async () => deps, printer: vi.fn() as never, reportsDir: join(home, "reports"), version: "0.1.0" },
    );
    expect(code).toBe(0);
    const out = JSON.parse(lines.join("\n"));
    expect(out.results[0].estimate).toMatchObject({ estimateOnly: true, total: { usd: 0.018 }, sections: [{ id: "gap", provider: "dataforseo", usd: 0.018 }] });
    expect(runTemplateCalls).not.toHaveBeenCalled();
  });
});
