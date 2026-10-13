/**
 * Orchestration tests for the clients.yaml edit functions and suggestCompetitors,
 * against a temp CLIENTS_FILE with Google, discovery and DataForSEO mocked.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

// Runs before any import, so src/config.ts reads these instead of the project's files.
const dir = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const d = mkdtempSync(join(tmpdir(), "crawlmark-orch-"));
  process.env.CLIENTS_FILE = join(d, "clients.yaml");
  process.env.DATA_DIR = join(d, "data");
  process.env.COMPETITOR_DENYLIST_FILE = join(d, "no-denylist.txt");
  process.env.COMPETITOR_DENYLIST = "directory.example";
  return d;
});

const m = vi.hoisted(() => ({
  googleConfigured: vi.fn(() => false),
  listGscSites: vi.fn(),
  listGa4Properties: vi.fn(),
  syncWrites: { value: true },
  competitorDomains: vi.fn(),
  rankedKeywords: vi.fn(),
  serpOrganic: vi.fn(),
  gscQuery: vi.fn(),
}));

vi.mock("../src/providers/google.js", () => ({ googleConfigured: m.googleConfigured, googleAuthModeNote: () => undefined }));
vi.mock("../src/providers/discovery.js", () => ({ listGscSites: m.listGscSites, listGa4Properties: m.listGa4Properties }));
vi.mock("../src/providers/dataforseo.js", () => ({
  competitorDomains: m.competitorDomains,
  rankedKeywords: m.rankedKeywords,
  serpOrganic: m.serpOrganic,
}));
vi.mock("../src/providers/gsc.js", () => ({ gscQuery: m.gscQuery }));
// Lets a test simulate a discovery whose clients.yaml sync didn't write.
vi.mock("../src/lib/clients-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/clients-file.js")>();
  return { ...actual, applySync: (text: string | undefined, plan: never) => (m.syncWrites.value ? actual.applySync(text, plan) : (text ?? "")) };
});

const { addCompetitors, addKeywords, removeCompetitors, removeKeywords, resolveClient, setClientProfile } = await import("../src/clients.js");
const { gatherSeeds, suggestCompetitors } = await import("../src/competitors.js");

const FILE = join(dir, "clients.yaml");
const read = () => readFileSync(FILE, "utf8");
const entry = (key: string) => (parseYaml(read()) as { clients: Record<string, Record<string, unknown>> }).clients[key]!;
const paid = <T extends object>(v: T) => ({ ...v, costUsd: 0.01, fromCache: false });

beforeEach(() => {
  vi.clearAllMocks();
  m.googleConfigured.mockReturnValue(false);
  m.syncWrites.value = true;
  writeFileSync(FILE, "# keep me\nclients:\n  example.com:\n    domain: example.com # inline\n");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("list edits on clients.yaml", () => {
  it("creates a domain-only entry for a discovered client that isn't in clients.yaml yet", async () => {
    m.googleConfigured.mockReturnValue(true);
    m.syncWrites.value = false; // discovery finds it but its sync doesn't write
    m.listGscSites.mockResolvedValue({ value: [{ siteUrl: "sc-domain:found.example", permissionLevel: "siteOwner" }], fromCache: false });
    m.listGa4Properties.mockResolvedValue({ value: { properties: [], errors: [] }, fromCache: false });
    expect(read()).not.toContain("found.example");

    const r = await addCompetitors("https://www.found.example/", ["rival.example"]);
    expect(r.added.map((a) => a.domain)).toEqual(["rival.example"]);
    const e = entry("found.example");
    expect(e.domain).toBe("found.example");
    expect(e.competitors).toEqual([{ domain: "rival.example", source: "manual", addedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
    expect(Object.keys(e)).toEqual(["domain", "competitors"]);
    expect(read()).toContain("# keep me");
    expect(read()).toContain("domain: example.com # inline");
  });

  it("adds, removes and lists competitors and keywords, keeping comments", async () => {
    await addCompetitors("example.com", ["rival.example", "other.example", "example.com"], { note: "n", source: "suggested" });
    const rm = await removeCompetitors("www.example.com", ["https://rival.example/x", "missing.example"]);
    expect(rm.removed).toEqual(["rival.example"]);
    expect(rm.skipped.map((s) => s.reason)).toEqual(["not-listed"]);
    expect(rm.list.map((c) => c.domain)).toEqual(["other.example"]);
    expect((await resolveClient("example.com")).competitorEntries).toEqual([
      { domain: "other.example", note: "n", source: "suggested", addedAt: expect.any(String) },
    ]);

    await addKeywords("example.com", ["Drain Repair"]);
    expect((await removeKeywords("example.com", ["DRAIN  repair"])).removed).toEqual(["drain repair"]);
    expect(entry("example.com").trackedKeywords).toBeUndefined(); // empty list removed
    expect(read()).toContain("domain: example.com # inline");
  });

  it("sets and clears the profile", async () => {
    const set = await setClientProfile("example.com", { area: "Austin, Texas, United States", niche: " emergency  plumber ", name: "Example Co" });
    expect(set.profile).toEqual({ name: "Example Co", area: "Austin,Texas,United States", niche: "emergency plumber", brandTerms: [] });
    expect(entry("example.com")).toMatchObject({ area: "Austin,Texas,United States", niche: "emergency plumber", name: "Example Co" });

    const cleared = await setClientProfile("example.com", { niche: "", name: "" });
    expect(cleared.cleared).toEqual(["niche", "name"]);
    expect(cleared.profile).toEqual({ name: "example.com", area: "Austin,Texas,United States", niche: null, brandTerms: [] });
    expect(entry("example.com").niche).toBeUndefined();

    await expect(setClientProfile("example.com", { area: "Austin,,Texas" })).rejects.toThrow(/not a location name/);
    await expect(setClientProfile("example.com", {})).rejects.toThrow(/Nothing to set/);
  });

  it("sets, replaces and clears brand terms", async () => {
    const set = await setClientProfile("example.com", { brandTerms: [" Pipe  Masters ", "pipe-masters", "ex co"] });
    expect(set.profile.brandTerms).toEqual(["Pipe Masters", "ex co"]);
    expect(set.set).toEqual({ brandTerms: "Pipe Masters, ex co" });
    expect(entry("example.com").brandTerms).toEqual(["Pipe Masters", "ex co"]);
    expect(read()).toContain("domain: example.com # inline");

    const replaced = await setClientProfile("example.com", { brandTerms: ["only one"] });
    expect(replaced.profile.brandTerms).toEqual(["only one"]);

    const cleared = await setClientProfile("example.com", { brandTerms: [] });
    expect(cleared.cleared).toEqual(["brandTerms"]);
    expect(cleared.profile.brandTerms).toEqual([]);
    expect(entry("example.com").brandTerms).toBeUndefined();

    await expect(setClientProfile("example.com", { brandTerms: ["--"] })).rejects.toThrow(/Not a usable brand term/);
  });
});

describe("gatherSeeds", () => {
  const spend = () => ({ costUsd: 0, flags: [] as boolean[] });
  const gscRows = (queries: string[]) => queries.map((q, i) => ({ keys: [q], clicks: 0, impressions: 100 - i, ctr: 0, position: 5 }));

  it("uses niche then tracked keywords, and skips GSC and ranked keywords once there are 5", async () => {
    m.googleConfigured.mockReturnValue(true);
    const client = { ...(await resolveClient("example.com")), gscProperty: "sc-domain:example.com", trackedKeywords: ["a", "b", "c", "d", "e"] };
    m.gscQuery.mockClear(); // discovery's automatic brand-term inference may have queried Search Console for a new client
    const seeds = await gatherSeeds(client, "niche term", spend(), []);
    expect(seeds.map((s) => [s.keyword, s.from])).toEqual([["niche term", "niche"], ["a", "tracked"], ["b", "tracked"], ["c", "tracked"], ["d", "tracked"]]);
    expect(m.gscQuery).not.toHaveBeenCalled();
    expect(m.rankedKeywords).not.toHaveBeenCalled();
  });

  it("fills from GSC when there are fewer than 5, without ranked keywords", async () => {
    m.googleConfigured.mockReturnValue(true);
    m.gscQuery.mockResolvedValue(gscRows(["example brand", "pipe repair", "a"]));
    const client = { ...(await resolveClient("example.com")), gscProperty: "sc-domain:example.com", trackedKeywords: ["a"] };
    const seeds = await gatherSeeds(client, undefined, spend(), []);
    expect(seeds.map((s) => [s.keyword, s.from])).toEqual([["a", "tracked"], ["pipe repair", "gsc"]]); // branded query dropped
    expect(m.rankedKeywords).not.toHaveBeenCalled();
  });

  it("puts explicit seeds first and keeps only GSC queries related to them", async () => {
    m.googleConfigured.mockReturnValue(true);
    m.gscQuery.mockResolvedValue(gscRows(["website design springfield", "modular homes springfield"]));
    const client = { ...(await resolveClient("example.com")), gscProperty: "sc-domain:example.com" };
    const seeds = await gatherSeeds(client, "modular home installation", spend(), [], ["prefab builder"]);
    expect(seeds.map((s) => [s.keyword, s.from])).toEqual([["prefab builder", "explicit"], ["modular home installation", "niche"], ["modular homes springfield", "gsc"]]);
  });

  it("skips GSC without Google or a property, and uses ranked keywords only when there are no seeds", async () => {
    m.rankedKeywords.mockResolvedValue(paid({ target: null, totalCount: 1, items: [{ keyword: "boiler service" }] }));
    const s = spend();
    const seeds = await gatherSeeds(await resolveClient("example.com"), undefined, s, []);
    expect(m.gscQuery).not.toHaveBeenCalled();
    expect(seeds).toEqual([{ keyword: "boiler service", from: "ranked" }]);
    expect(s).toEqual({ costUsd: 0.01, flags: [false] });
  });

  it("notes a GSC failure and falls back to ranked keywords", async () => {
    m.googleConfigured.mockReturnValue(true);
    m.gscQuery.mockRejectedValue(new Error("quota"));
    m.rankedKeywords.mockResolvedValue(paid({ target: null, totalCount: 0, items: [] }));
    const notes: string[] = [];
    const client = { ...(await resolveClient("example.com")), gscProperty: "sc-domain:example.com" };
    expect(await gatherSeeds(client, undefined, spend(), notes)).toEqual([]);
    expect(notes[0]).toMatch(/Search Console queries unavailable.*quota/);
    expect(m.rankedKeywords).toHaveBeenCalledOnce();
  });
});

describe("suggestCompetitors", () => {
  const serp = (hits: [string, number][]) =>
    paid({ keyword: null, locationCode: null, items: hits.map(([domain, position]) => ({ domain, position, url: `https://${domain}/`, title: null })) });

  beforeEach(async () => {
    await setClientProfile("example.com", { niche: "emergency plumber", area: "Austin,Texas,United States" });
    await addCompetitors("example.com", ["existing.example"]);
    vi.clearAllMocks();
  });

  it("ranks on SERPs alone when the overlap call fails, and never writes", async () => {
    const before = read();
    m.competitorDomains.mockRejectedValue(new Error("Budget cap hit"));
    m.serpOrganic.mockResolvedValue(serp([["www.leader.example", 1], ["directory.example", 2], ["existing.example", 3], ["example.com", 4]]));
    const r = await suggestCompetitors("example.com");
    expect(m.serpOrganic).toHaveBeenCalledWith(expect.anything(), "emergency plumber", { depth: 20, locationName: "Austin,Texas,United States" });
    expect(r.sources.organicOverlap).toEqual({ ok: false, error: "Budget cap hit" });
    expect(r.candidates).toMatchObject([{ domain: "leader.example", score: 100, sources: ["local-serp"] }]);
    expect(r.excluded.counts).toEqual({ "already-competitor": 1, denylist: 1, "own-domain": 1 });
    expect(r.costUsd).toBe(0.01);
    expect(r.fromCache).toBe(false);
    expect(read()).toBe(before);
  });

  it("ranks on overlap alone when every SERP fails", async () => {
    m.competitorDomains.mockResolvedValue(
      paid({ target: null, totalCount: 2, items: [{ domain: "rival.example", intersectingKeywords: 40, avgPosition: 5, estimatedTraffic: 10 }] }),
    );
    m.serpOrganic.mockRejectedValue(new Error("timeout"));
    const r = await suggestCompetitors("example.com", { area: "Dallas, Texas, United States", limit: 3 });
    expect(r.market).toEqual({ locationName: "Dallas,Texas,United States", languageCode: "en" });
    expect(r.sources.localSerp).toEqual({ searched: 0, failed: [{ keyword: "emergency plumber", error: "timeout" }] });
    expect(r.candidates).toMatchObject([{ domain: "rival.example", score: 100 }]);
  });

  it("fails when both sources fail", async () => {
    m.competitorDomains.mockRejectedValue(new Error("no credentials"));
    m.serpOrganic.mockRejectedValue(new Error("no credentials"));
    await expect(suggestCompetitors("example.com")).rejects.toThrow(/No competitor data for example\.com.*organic overlap: no credentials/);
  });
});
