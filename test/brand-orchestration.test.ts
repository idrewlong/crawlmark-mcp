/**
 * Orchestration tests for brand terms: add/remove, suggest_brand_terms (Search
 * Console first, DataForSEO fallback, apply) and the automatic run for new
 * clients found by discovery, against a temp CLIENTS_FILE with providers mocked.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

const dir = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const d = mkdtempSync(join(tmpdir(), "crawlmark-brand-"));
  process.env.CLIENTS_FILE = join(d, "clients.yaml");
  process.env.DATA_DIR = join(d, "data");
  return d;
});

const m = vi.hoisted(() => ({
  googleConfigured: vi.fn(() => false),
  listGscSites: vi.fn(),
  listGa4Properties: vi.fn(),
  rankedKeywords: vi.fn(),
  gscQuery: vi.fn(),
}));

vi.mock("../src/providers/google.js", () => ({ googleConfigured: m.googleConfigured, googleAuthModeNote: () => undefined }));
vi.mock("../src/providers/discovery.js", () => ({ listGscSites: m.listGscSites, listGa4Properties: m.listGa4Properties }));
vi.mock("../src/providers/dataforseo.js", () => ({ rankedKeywords: m.rankedKeywords }));
vi.mock("../src/providers/gsc.js", () => ({ gscQuery: m.gscQuery }));

const { addBrandTerms, loadRegistry, removeBrandTerms, resolveClient, setClientProfile } = await import("../src/clients.js");
const { suggestBrandTerms, suggestBrandTermsForAll } = await import("../src/brand-terms.js");
const { isBranded } = await import("../src/lib/brand.js");

const FILE = join(dir, "clients.yaml");
const read = () => readFileSync(FILE, "utf8");
const entry = (key: string) => (parseYaml(read()) as { clients: Record<string, Record<string, unknown>> }).clients[key]!;

const row = (q: string, clicks: number, impressions: number, position: number) => ({ keys: [q], clicks, impressions, ctr: impressions ? (clicks / impressions) * 100 : 0, position });
/** Search Console rows for the restaurant: a spoken brand that differs from the domain stem, plus generic queries and filler. */
const restaurantGsc = [
  row("bella forno pizza", 120, 200, 1.1),
  row("bella forno austin", 80, 140, 1.0),
  row("bella forno menu", 60, 100, 1.2),
  row("bella forno", 50, 90, 1.0),
  row("pizza near me", 150, 300, 1.4),
  row("best pizza austin", 10, 400, 4.5),
  row("pizza austin", 20, 500, 3.8),
  ...Array.from({ length: 20 }, (_, i) => row(`pizza topping idea ${i}`, 0, 30, 15)),
];
const paid = <T extends object>(v: T) => ({ ...v, costUsd: 0.0101, fromCache: false });

beforeEach(() => {
  vi.clearAllMocks();
  m.googleConfigured.mockReturnValue(false);
  m.listGscSites.mockResolvedValue({ value: [], fromCache: false });
  m.listGa4Properties.mockResolvedValue({ value: { properties: [], errors: [] }, fromCache: false });
  writeFileSync(
    FILE,
    [
      "# keep me",
      "clients:",
      "  bellafornino.example:",
      "    domain: bellafornino.example",
      "    gscProperty: sc-domain:bellafornino.example",
      "  webagency.example:",
      "    domain: webagency.example # inline",
      "    name: Web Agency",
      "    gscProperty: sc-domain:webagency.example",
      "",
    ].join("\n"),
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("add_brand_terms / remove_brand_terms", () => {
  it("adds object entries to that client only, and removes them in any form", async () => {
    const r = await addBrandTerms("bellafornino.example", ["Bella Forno", "bella-forno", "  "], { source: "suggested" });
    expect(r.added.map((a) => a.term)).toEqual(["Bella Forno"]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["duplicate-input", "invalid"]);
    expect(entry("bellafornino.example").brandTerms).toEqual([{ term: "Bella Forno", source: "suggested", addedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
    expect(entry("webagency.example").brandTerms).toBeUndefined();
    expect(read()).toContain("# keep me");
    expect(read()).toContain("domain: webagency.example # inline");

    const a = await resolveClient("bellafornino.example");
    const b = await resolveClient("webagency.example");
    expect(isBranded("bella forno pizza", a)).toBe(true);
    expect(isBranded("bella forno pizza", b)).toBe(false);

    const gone = await removeBrandTerms("bellafornino.example", ["BELLA FORNO", "nope"]);
    expect(gone.removed).toEqual(["BELLA FORNO"]);
    expect(gone.skipped[0]!.reason).toBe("not-listed");
    expect(entry("bellafornino.example").brandTerms).toBeUndefined();
  });

  it("set_client_profile still replaces the list and keeps metadata on terms it keeps", async () => {
    await addBrandTerms("bellafornino.example", ["bella forno"], { source: "auto-gsc" });
    const r = await setClientProfile("bellafornino.example", { brandTerms: ["Bella Forno", "bf pizza"] });
    expect(r.profile.brandTerms).toEqual(["bella forno", "bf pizza"]);
    expect(entry("bellafornino.example").brandTerms).toEqual([{ term: "bella forno", source: "auto-gsc", addedAt: expect.any(String) }, "bf pizza"]);
    await setClientProfile("bellafornino.example", { brandTerms: [] });
    expect(entry("bellafornino.example").brandTerms).toBeUndefined();
  });
});

describe("suggestBrandTerms", () => {
  it("uses Search Console only when it has enough rows, and applies high candidates to that client only", async () => {
    m.googleConfigured.mockReturnValue(true);
    m.gscQuery.mockResolvedValue(restaurantGsc);
    const dry = await suggestBrandTerms("bellafornino.example");
    expect(dry.candidates[0]).toMatchObject({ term: "bella forno", confidence: "high", source: "gsc" });
    expect(dry.sources.gsc).toMatchObject({ used: true, rows: restaurantGsc.length });
    expect(dry.sources.dataforseo.used).toBe(false);
    expect(m.rankedKeywords).not.toHaveBeenCalled();
    expect(dry.applied).toBeNull();
    expect(dry.costUsd).toBe(0);
    expect(dry.nonBrandedQueries.map((q) => q.query)).toContain("pizza near me");
    expect(entry("bellafornino.example").brandTerms).toBeUndefined();
    // Only the client's own property was queried.
    expect(m.gscQuery).toHaveBeenCalledTimes(1);
    expect(m.gscQuery.mock.calls[0]![0].domain).toBe("bellafornino.example");

    const applied = await suggestBrandTerms("bellafornino.example", { apply: true });
    expect(applied.applied!.added).toEqual([expect.objectContaining({ term: "bella forno", source: "auto-gsc" })]);
    expect(applied.currentBrandTerms).toEqual(["bella forno"]);
    expect(entry("webagency.example").brandTerms).toBeUndefined();
  });

  it("falls back to DataForSEO for a client with no Search Console property", async () => {
    m.rankedKeywords.mockResolvedValue(
      paid({ target: "bellafornino.example", totalCount: 3, items: [
        { keyword: "bella forno pizza", position: 1, searchVolume: 320, url: null, estimatedTraffic: 90 },
        { keyword: "bella forno menu", position: 1, searchVolume: 170, url: null, estimatedTraffic: 50 },
        { keyword: "pizza near me", position: 12, searchVolume: 9000, url: null, estimatedTraffic: 30 },
      ] }),
    );
    const r = await suggestBrandTerms("bellafornino.example", { apply: true });
    expect(m.gscQuery).not.toHaveBeenCalled();
    expect(m.rankedKeywords).toHaveBeenCalledWith(expect.objectContaining({ domain: "bellafornino.example" }), "bellafornino.example", 100);
    expect(r.sources.gsc.skipped).toMatch(/Google/);
    expect(r.candidates[0]).toMatchObject({ term: "bella forno", source: "dataforseo", confidence: "high" });
    expect(r.costUsd).toBe(0.0101);
    expect(r.fromCache).toBe(false);
    expect(entry("bellafornino.example").brandTerms).toEqual([expect.objectContaining({ term: "bella forno", source: "auto-dataforseo" })]);
  });

  it("does not spend on sparse Search Console data by default", async () => {
    m.googleConfigured.mockReturnValue(true);
    m.gscQuery.mockResolvedValue(restaurantGsc.slice(0, 5));
    const r = await suggestBrandTerms("bellafornino.example");
    expect(m.rankedKeywords).not.toHaveBeenCalled();
    expect(r.sources.gsc.rows).toBe(5);
    expect(r.sources.dataforseo).toMatchObject({ used: false, skipped: expect.stringMatching(/allowPaid: true/) });
    expect(r.costUsd).toBe(0);
  });

  it("uses DataForSEO for sparse Search Console data only with allowPaid: true", async () => {
    m.googleConfigured.mockReturnValue(true);
    m.gscQuery.mockResolvedValue(restaurantGsc.slice(0, 5));
    m.rankedKeywords.mockResolvedValue(paid({ target: "bellafornino.example", totalCount: 0, items: [] }));
    const r = await suggestBrandTerms("bellafornino.example", { allowPaid: true });
    expect(m.rankedKeywords).toHaveBeenCalledTimes(1);
    expect(r.sources.dataforseo.used).toBe(true);
  });

  it("reports a Search Console error and never falls back to paid", async () => {
    m.googleConfigured.mockReturnValue(true);
    m.gscQuery.mockRejectedValue(new Error("403 forbidden"));
    await expect(suggestBrandTerms("bellafornino.example")).rejects.toThrow(/Search Console: 403 forbidden/);
    await expect(suggestBrandTerms("bellafornino.example", { allowPaid: true })).rejects.toThrow(/Search Console: 403 forbidden/);
    expect(m.rankedKeywords).not.toHaveBeenCalled();
  });

  it("does not make paid calls when they are off", async () => {
    const r = await suggestBrandTerms("bellafornino.example", { allowPaid: false });
    expect(m.rankedKeywords).not.toHaveBeenCalled();
    expect(r.candidates).toEqual([]);
    expect(r.sources.dataforseo.skipped).toMatch(/Paid calls are off/);
  });

  it("never adopts another client's brand from its own queries", async () => {
    m.googleConfigured.mockReturnValue(true);
    await addBrandTerms("bellafornino.example", ["bella forno"]);
    m.gscQuery.mockResolvedValue([
      row("bella forno website", 30, 60, 1.0),
      row("bella forno web design", 20, 40, 1.0),
      row("web agency austin", 40, 70, 1.0),
      ...Array.from({ length: 20 }, (_, i) => row(`website design tip ${i}`, 0, 30, 15)),
    ]);
    const r = await suggestBrandTerms("webagency.example", { apply: true, minConfidence: "medium" });
    expect(r.candidates.map((c) => c.term).some((t) => /bella|forno/.test(t))).toBe(false);
    expect(r.excluded).toContainEqual(expect.objectContaining({ term: "bella forno", reason: "other-client-brand", client: "bellafornino.example" }));
    expect(JSON.stringify(entry("webagency.example").brandTerms ?? [])).not.toMatch(/forno/);
  });

  it("throws when every source it tried failed", async () => {
    m.rankedKeywords.mockRejectedValue(new Error("Budget cap hit"));
    await expect(suggestBrandTerms("bellafornino.example")).rejects.toThrow(/DataForSEO: Budget cap hit/);
  });
});

describe("suggestBrandTermsForAll (CLI --all)", () => {
  const ranked = paid({ target: "bellafornino.example", totalCount: 1, items: [{ keyword: "bella forno pizza", position: 1, searchVolume: 320, url: null, estimatedTraffic: 90 }] });

  it("makes no paid calls without --paid, even when Google isn't set up", async () => {
    m.rankedKeywords.mockResolvedValue(ranked);
    const results = await suggestBrandTermsForAll(["bellafornino.example", "webagency.example"]);
    expect(m.rankedKeywords).not.toHaveBeenCalled();
    expect([...results.keys()]).toEqual(["bellafornino.example", "webagency.example"]);
  });

  it("with --paid, pays only for clients with no usable Search Console", async () => {
    m.rankedKeywords.mockResolvedValue(ranked);
    await suggestBrandTermsForAll(["bellafornino.example"], { paid: true });
    expect(m.rankedKeywords).toHaveBeenCalledTimes(1);
  });

  it("with --paid, never pays for sparse Search Console data or after a Search Console error", async () => {
    m.googleConfigured.mockReturnValue(true);
    m.gscQuery.mockResolvedValue(restaurantGsc.slice(4, 6)); // two generic rows, no candidates
    await suggestBrandTermsForAll(["bellafornino.example"], { paid: true });
    m.gscQuery.mockRejectedValue(new Error("quota"));
    const r = await suggestBrandTermsForAll(["bellafornino.example"], { paid: true, paidSparse: true });
    expect(r.get("bellafornino.example")).toBeInstanceOf(Error);
    expect(m.rankedKeywords).not.toHaveBeenCalled();
  });

  it("with --paid-sparse, pays for sparse Search Console data", async () => {
    m.googleConfigured.mockReturnValue(true);
    m.gscQuery.mockResolvedValue(restaurantGsc.slice(4, 6));
    m.rankedKeywords.mockResolvedValue(ranked);
    await suggestBrandTermsForAll(["bellafornino.example"], { paidSparse: true });
    expect(m.rankedKeywords).toHaveBeenCalledTimes(1);
  });
});

describe("strict auto-add in apply and discovery", () => {
  it("apply never saves a generic exact-match term", async () => {
    m.googleConfigured.mockReturnValue(true);
    writeFileSync(FILE, "clients:\n  austinplumbing.example:\n    domain: austinplumbing.example\n    gscProperty: sc-domain:austinplumbing.example\n");
    m.gscQuery.mockResolvedValue([
      row("austin plumber", 120, 260, 2.1),
      row("austin plumber cost", 30, 60, 2.0),
      row("plumber near me", 20, 900, 6),
      ...Array.from({ length: 20 }, (_, i) => row(`plumbing tip ${i}`, 0, 30, 15)),
    ]);
    const r = await suggestBrandTerms("austinplumbing.example", { apply: true, minConfidence: "medium" });
    expect(r.applied!.added).toEqual([]);
    expect(entry("austinplumbing.example").brandTerms).toBeUndefined();
  });

  it("discovery never auto-saves for a new exact-match-domain client", async () => {
    m.googleConfigured.mockReturnValue(true);
    m.listGscSites.mockResolvedValue({ value: [{ siteUrl: "sc-domain:dallasplumbing.example", permissionLevel: "siteOwner" }], fromCache: false });
    m.gscQuery.mockResolvedValue([row("dallas plumber", 120, 260, 2.1), row("dallas plumber cost", 30, 60, 2.0), row("plumber near me", 20, 900, 6)]);
    const reg = await loadRegistry({ refresh: true });
    expect(reg.clientsFile.added).toEqual(["dallasplumbing.example"]);
    expect(entry("dallasplumbing.example").brandTerms).toBeUndefined();
    expect(reg.discovery.notes.join("\n")).toMatch(/dallasplumbing\.example: no brand terms qualified for automatic adding/);
  });
});

describe("automatic brand terms for new clients", () => {
  it("runs Search Console inference for a newly discovered client, saves high candidates and notes it, never calling DataForSEO", async () => {
    m.googleConfigured.mockReturnValue(true);
    m.listGscSites.mockResolvedValue({ value: [{ siteUrl: "sc-domain:casarojita.example", permissionLevel: "siteOwner" }], fromCache: false });
    m.gscQuery.mockResolvedValue([
      row("casa roja tacos", 120, 200, 1.1),
      row("casa roja hours", 60, 100, 1.0),
      row("casa roja austin", 40, 70, 1.0),
      row("tacos near me", 150, 300, 1.4),
    ]);
    const reg = await loadRegistry({ refresh: true });
    expect(reg.clientsFile.added).toEqual(["casarojita.example"]);
    expect(entry("casarojita.example").brandTerms).toEqual([expect.objectContaining({ term: "casa roja", source: "auto-gsc" })]);
    expect(reg.discovery.notes.join("\n")).toMatch(/casarojita\.example: added brand terms "casa roja" \(auto-gsc/);
    expect(m.rankedKeywords).not.toHaveBeenCalled();
    // Existing clients are untouched.
    expect(entry("bellafornino.example").brandTerms).toBeUndefined();
  });

  it("a failing inference is only a note; the sync result stands", async () => {
    m.googleConfigured.mockReturnValue(true);
    m.listGscSites.mockResolvedValue({ value: [{ siteUrl: "sc-domain:broken.example", permissionLevel: "siteOwner" }], fromCache: false });
    m.gscQuery.mockRejectedValue(new Error("quota"));
    const reg = await loadRegistry({ refresh: true });
    expect(reg.clientsFile.added).toEqual(["broken.example"]);
    expect(reg.clientsFile.error).toBeUndefined();
    expect(reg.discovery.notes.join("\n")).toMatch(/broken\.example: automatic brand terms failed: .*quota/);
    expect(entry("broken.example").brandTerms).toBeUndefined();
  });
});
