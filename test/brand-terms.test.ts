import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { atLeast, autoAddable, distinctiveRemainder, editDistance, fuzzySubstring, inferBrandTerms, mergeCandidates, METHOD, nameSimilarity, sameStem, type BrandQueryRow } from "../src/analysis/brand-terms.js";
import { isBranded } from "../src/lib/brand.js";
import { planAddBrandTerms, planRemoveBrandTerms } from "../src/lib/client-lists.js";
import { appendListItems, setStringList } from "../src/lib/clients-file.js";
import { mergeClients, parseOverrides, toBrandTermEntries } from "../src/lib/clients.js";
import { squash } from "../src/lib/brand.js";

const gsc = (query: string, clicks: number, impressions: number, position: number): BrandQueryRow => ({ query, clicks, impressions, position });
const dfs = (query: string, position: number, searchVolume: number, estimatedTraffic?: number): BrandQueryRow => ({ query, position, searchVolume, estimatedTraffic: estimatedTraffic ?? null });

// A restaurant whose domain stem ("bellafornino") isn't how people search it ("bella forno ...").
const restaurant = { domain: "bellafornino.example", name: "bellafornino.example" };
const restaurantRows: BrandQueryRow[] = [
  gsc("bella forno pizza", 120, 200, 1.1),
  gsc("bella forno austin", 80, 140, 1.0),
  gsc("bella forno menu", 60, 100, 1.2),
  gsc("bella forno", 50, 90, 1.0),
  // Generic, but the site wins the local pack: high CTR at the top.
  gsc("pizza near me", 150, 300, 1.4),
  gsc("best pizza austin", 10, 400, 4.5),
  gsc("pizza delivery austin", 5, 300, 6),
  gsc("pizza austin", 20, 500, 3.8),
  gsc("italian restaurant austin", 8, 250, 5),
  gsc("bellafornino", 200, 250, 1), // already branded by the domain stem
  gsc("calzone", 3, 80, 7),
];

const terms = (rows: BrandQueryRow[], ctx = restaurant, source: "gsc" | "dataforseo" = "gsc", otherClients = [] as { domain: string; name: string; brandTerms?: string[] }[]) =>
  inferBrandTerms(rows, ctx, { source, otherClients });

describe("nameSimilarity", () => {
  it("scores a shortened or misspelled brand high and generic words low", () => {
    expect(editDistance("laforna", "lafornina")).toBe(2);
    expect(nameSimilarity("laforna", "lafornina")).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity("bellaforn", "bellaforno")).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity("bellaforno", "bellafornino")).toBeGreaterThanOrEqual(0.85);
    // A trade word that only starts the name is weak, not strong.
    expect(nameSimilarity("pizza", "pizzaplace")).toBeLessThan(0.75);
    expect(nameSimilarity("bella", "bellaforno")).toBeLessThan(0.75);
    expect(nameSimilarity("pizza", "bellafornino")).toBeLessThan(0.6);
    expect(nameSimilarity("abc", "abcdef")).toBe(0); // too short
  });
});

describe("inferBrandTerms (Search Console)", () => {
  const r = terms(restaurantRows);

  it("finds the spoken brand as a high-confidence candidate with evidence", () => {
    const c = r.candidates.find((x) => x.term === "bella forno");
    expect(c).toBeDefined();
    expect(c!.confidence).toBe("high");
    expect(c!.source).toBe("gsc");
    expect(c!.signals.nameSimilarity.fired).toBe(true);
    expect(c!.signals.navigational.fired).toBe(true);
    expect(c!.signals.concentration).toMatchObject({ fired: true, queries: 4 });
    expect(c!.queries.map((q) => q.query)).toContain("bella forno pizza");
    expect(c!.queries[0]).toMatchObject({ clicks: 120, impressions: 200, ctr: 60 });
  });

  it("never turns generic high-CTR queries, trade words or locations into brand terms", () => {
    const found = r.candidates.map((c) => c.term);
    for (const t of ["pizza", "pizza near me", "near me", "austin", "pizza austin", "menu", "italian restaurant", "bella forno pizza", "bella forno menu"]) {
      expect(found, t).not.toContain(t);
    }
    expect(r.genericWords).toEqual(expect.arrayContaining(["pizza", "austin", "restaurant"]));
  });

  it("drops shorter phrases an accepted candidate already covers", () => {
    expect(r.candidates.map((c) => c.term)).not.toContain("forno");
    expect(r.candidates.map((c) => c.term)).not.toContain("bella");
  });

  it("leaves out queries the client's matching already covers, and lists the remaining non-branded ones", () => {
    expect(r.stats).toEqual({ rows: 11, alreadyBranded: 1, analysed: 10 });
    const remaining = r.nonBrandedQueries.map((q) => q.query);
    expect(remaining).toContain("pizza near me");
    expect(remaining).not.toContain("bella forno pizza");
    expect(remaining).not.toContain("bellafornino");
    expect(remaining[0]).toBe("pizza near me"); // most clicks first
  });

  it("skips terms the client already has", () => {
    const again = terms(restaurantRows, { ...restaurant, brandTerms: ["bella forno"] } as typeof restaurant);
    expect(again.candidates.find((c) => c.term === "bella forno")).toBeUndefined();
    expect(again.stats.alreadyBranded).toBe(5);
  });

  it("caps navigational plus concentration without name similarity at medium", () => {
    // A brand that looks nothing like the domain.
    const rows = [gsc("sunny slice pizza", 90, 150, 1.0), gsc("sunny slice hours", 40, 70, 1.1), gsc("sunny slice", 60, 100, 1.0), gsc("pizza place", 2, 300, 8)];
    const c = terms(rows, { domain: "bfpizza.example", name: "bfpizza.example" }).candidates.find((x) => x.term === "sunny slice");
    expect(c).toBeDefined();
    expect(c!.signals.nameSimilarity.fired).toBe(false);
    expect(c!.confidence).toBe("medium");
    expect(atLeast([c!], "high")).toHaveLength(0);
    expect(atLeast([c!], "medium")).toHaveLength(1);
  });

  it("does not use 'near me' style queries as navigational evidence", () => {
    const rows = [gsc("pizza near me", 200, 300, 1.0), gsc("pizza near me open now", 50, 80, 1.0)];
    expect(terms(rows).candidates).toEqual([]);
  });

  it("reads 'the' style leading words as part of a brand but never alone", () => {
    const rows = [gsc("la forna pizza", 50, 80, 1.0), gsc("la forna hours", 30, 50, 1.0), gsc("la forna austin", 20, 40, 1.2), gsc("best pizza", 1, 300, 9)];
    const r2 = terms(rows, { domain: "lafornina.example", name: "lafornina.example" });
    expect(r2.candidates[0]).toMatchObject({ term: "la forna", confidence: "high" });
    expect(r2.candidates.map((c) => c.term)).not.toContain("el");
  });
});

describe("inferBrandTerms: lookalikes and trade phrases", () => {
  it("keeps a similarly named business the site ranks poorly for out of high and medium", () => {
    const rows = [gsc("bella fortin pizzeria", 0, 40, 48), gsc("bella fortin", 1, 30, 35), gsc("bella fortin menu", 0, 20, 40), gsc("pizza", 1, 400, 9)];
    const c = terms(rows).candidates.find((x) => x.term === "bella fortin");
    expect(c?.confidence ?? "low").toBe("low");
  });

  it("needs real volume for a similarity-only medium", () => {
    const one = terms([gsc("bella fornito", 0, 1, 1), gsc("pizza", 1, 400, 9)]).candidates.find((x) => x.term === "bella fornito");
    expect(one?.confidence).toBe("low");
    const some = terms([gsc("bella fornito", 0, 25, 2), gsc("pizza", 1, 400, 9)]).candidates.find((x) => x.term === "bella fornito");
    expect(some?.confidence).toBe("medium");
  });

  it("treats the trade-word end of a name as weak, never high", () => {
    expect(nameSimilarity("buildingsystems", "abbuildingsystems")).toBeLessThanOrEqual(0.7);
    const rows = [gsc("building systems", 30, 60, 1.2), gsc("building systems company", 20, 40, 1.0), gsc("modular building systems", 10, 30, 1.5)];
    const c = terms(rows, { domain: "abbuildingsystems.example", name: "AB Building Systems" }).candidates.find((x) => x.term === "building systems");
    expect(c?.confidence ?? "low").not.toBe("high");
  });
});

describe("inferBrandTerms: exact-match domains", () => {
  const plumbing = [
    gsc("austin plumber", 120, 260, 1.9),
    gsc("austin plumber reviews", 30, 60, 1.5),
    gsc("austin plumbers", 40, 120, 2.2),
    gsc("plumber near me", 20, 900, 6),
    gsc("best plumber austin", 10, 300, 5),
    gsc("emergency plumber austin", 8, 200, 7),
  ];
  const emd = { domain: "austinplumbing.example", name: "austinplumbing.example" };

  it("matches plurals and word endings of trade words", () => {
    expect(sameStem("plumber", "plumbing")).toBe(true);
    expect(sameStem("roofers", "roofer")).toBe(true);
    expect(sameStem("forno", "pizza")).toBe(false);
    expect(sameStem("austin", "austral")).toBe(false);
  });

  it("never turns a generic head term into a brand term from Search Console", () => {
    expect(terms(plumbing, emd).candidates).toEqual([]);
    // Even with no discovery queries, when the niche and area name the words.
    const onlyHead = terms(plumbing.slice(0, 3), { ...emd, niche: "plumbing", area: "Austin,Texas,United States" } as typeof emd);
    expect(onlyHead.candidates).toEqual([]);
  });

  it("never turns a generic head term into a brand term from DataForSEO", () => {
    const roofing = [dfs("dallas roofer", 1, 1300, 400), dfs("dallas roofers", 1, 900, 300), dfs("roofer near me", 5, 40000, 900), dfs("best roofer dallas", 3, 800, 90)];
    const ctx = { domain: "dallasroofers.example", name: "dallasroofers.example" };
    expect(terms(roofing, ctx, "dataforseo").candidates).toEqual([]);
    expect(terms(roofing.slice(0, 2), { ...ctx, niche: "roofing", area: "Dallas,Texas,United States" } as typeof ctx, "dataforseo").candidates).toEqual([]);
  });

  it("still finds a distinctive brand word on an exact-match-style domain", () => {
    const rows = [...plumbing, gsc("pipewel plumbing", 50, 80, 1.0), gsc("pipewel plumbing hours", 20, 30, 1.0), gsc("pipewel", 10, 15, 1.0)];
    const r = terms(rows, { domain: "pipewellplumbing.example", name: "pipewellplumbing.example", niche: "plumbing" } as typeof emd);
    expect(r.candidates.map((c) => c.term).some((t) => t.startsWith("pipewel"))).toBe(true);
    expect(r.candidates.map((c) => c.term)).not.toContain("austin plumber");
  });

  it("keeps an article-plus-word brand whose word also appears in discovery searches, when the domain has a distinctive part", () => {
    const rows = [
      gsc("la forna pizzeria", 10, 38, 1.4),
      gsc("la forna pizza", 7, 23, 3.3),
      gsc("la forna menu", 1, 3, 1.7),
      gsc("la forna", 1, 3, 1),
      gsc("forna near me", 0, 12, 6),
      gsc("forna pizza near me", 0, 8, 7),
      gsc("pizza near me", 79, 2475, 7.1),
      // The domain's own word ranks poorly because other businesses share it; that doesn't make the name generic.
      gsc("fornina", 3, 107, 15.4),
      gsc("il fornina", 5, 30, 12),
    ];
    expect(terms(rows, { domain: "lafornina.example", name: "lafornina.example" }).candidates[0]).toMatchObject({ term: "la forna", confidence: "high", autoQualified: true });
  });

  it("keeps a brand that also appears in 'near me' searches", () => {
    const rows = [...restaurantRows, gsc("bella forno near me", 40, 60, 1.0)];
    expect(terms(rows).candidates[0]).toMatchObject({ term: "bella forno", confidence: "high" });
  });
});

describe("strict auto-add", () => {
  const trade = new Set(["plumber", "roofer", "pizza"]);
  const kindOf = (p: string) => (trade.has(p) || ["plumbing", "roofers"].includes(p) ? ("trade" as const) : ["austin"].includes(p) ? ("place" as const) : null);

  it("finds the distinctive part of a name", () => {
    expect(distinctiveRemainder("austinplumbing", kindOf, true)).toBe("");
    // Without an area, a segment next to a trade word is a probable place.
    expect(distinctiveRemainder("dallasroofers", kindOf, false)).toBe("");
    expect(distinctiveRemainder("austinplumbingco", kindOf, true)).toBe("");
    expect(distinctiveRemainder("pipewellplumbingco", kindOf, true)).toBe("pipewell");
    expect(distinctiveRemainder("bellafornino", kindOf, false)).toBe("bellafornino");
    expect(distinctiveRemainder("lafornina", kindOf, false)).toBe("lafornina");
  });

  it("GSC exact-match domain without a profile: no auto-add, at most a needs-review suggestion", () => {
    const rows = [gsc("austin plumber", 120, 260, 2.1), gsc("austin plumber cost", 30, 60, 2.0), gsc("plumber near me", 20, 900, 6)];
    const r = terms(rows, { domain: "austinplumbing.example", name: "austinplumbing.example" });
    expect(autoAddable(r.candidates, "medium")).toEqual([]);
    expect(r.candidates.every((c) => c.confidence !== "high" && c.reviewReason?.startsWith("needs-review"))).toBe(true);
  });

  it("DataForSEO exact-match domain without a profile: no auto-add", () => {
    const rows = [dfs("dallas roofer company", 1, 1300, 400), dfs("dallas roofer reviews", 1, 900, 300), dfs("roofer near me", 5, 40000, 900)];
    const r = terms(rows, { domain: "dallasroofers.example", name: "dallasroofers.example" }, "dataforseo");
    expect(autoAddable(r.candidates, "medium")).toEqual([]);
    expect(r.candidates.every((c) => c.confidence !== "high")).toBe(true);
  });

  it("company-suffix domain with a niche and area: no auto-add", () => {
    const rows = [gsc("austin plumber", 120, 260, 2.1), gsc("austin plumber cost", 30, 60, 2.0), gsc("plumber near me", 20, 900, 6)];
    const ctx = { domain: "austinplumbingco.example", name: "austinplumbingco.example", niche: "emergency plumber", area: "Austin,Texas,United States" };
    const r = terms(rows, ctx as typeof restaurant);
    expect(autoAddable(r.candidates, "medium")).toEqual([]);
    expect(r.candidates.find((c) => c.term === "austin plumber")?.confidence ?? "none").not.toBe("high");
  });

  it("a distinctive brand on a company-suffix domain still qualifies", () => {
    const rows = [gsc("pipewel plumbing", 50, 80, 1.0), gsc("pipewel hours", 20, 30, 1.0), gsc("pipewel", 10, 15, 1.0), gsc("plumber near me", 20, 900, 6)];
    const r = terms(rows, { domain: "pipewellplumbingco.example", name: "pipewellplumbingco.example", niche: "plumbing", area: "Austin,Texas,United States" } as typeof restaurant);
    expect(autoAddable(r.candidates, "high").map((c) => c.term)).toContain("pipewel");
  });

  it("the restaurant's distinctive brand still auto-adds at high", () => {
    const c = terms(restaurantRows).candidates.find((x) => x.term === "bella forno")!;
    expect(c).toMatchObject({ confidence: "high", autoQualified: true, reviewReason: null });
    expect(autoAddable(terms(restaurantRows).candidates, "high").map((x) => x.term)).toEqual(["bella forno"]);
  });
});

describe("inferBrandTerms (DataForSEO)", () => {
  it("has no navigational signal and is high only with very strong name similarity", () => {
    const rows = [dfs("bella forno pizza", 1, 320, 90), dfs("bella forno menu", 1, 170, 50), dfs("sunny slice pizza", 1, 260, 70), dfs("sunny slice", 1, 200, 60), dfs("pizza near me", 12, 9000, 30)];
    const r = terms(rows, restaurant, "dataforseo");
    const bella = r.candidates.find((c) => c.term === "bella forno");
    const sunny = r.candidates.find((c) => c.term === "sunny slice");
    expect(bella).toMatchObject({ confidence: "high", source: "dataforseo" });
    expect(bella!.signals.navigational.fired).toBe(false);
    expect(bella!.queries[0]).toMatchObject({ query: "bella forno pizza", searchVolume: 320 });
    expect(sunny?.confidence ?? "low").not.toBe("high");
    expect(r.candidates.map((c) => c.term)).not.toContain("pizza");
  });
});

describe("client scoping", () => {
  const agency = { domain: "webagency.example", name: "Web Agency" };
  const agencyRows = [
    gsc("bella forno website", 30, 60, 1.0),
    gsc("bella forno web design", 20, 40, 1.0),
    gsc("web agency austin", 40, 70, 1.0),
    gsc("web agency reviews", 25, 40, 1.0),
    gsc("website design", 2, 400, 9),
  ];

  it("never proposes another client's brand, and reports it as other-client-brand", () => {
    const others = [{ domain: "bellafornino.example", name: "bellafornino.example", brandTerms: ["bella forno"] }];
    const r = terms(agencyRows, agency, "gsc", others);
    expect(r.candidates.map((c) => c.term).some((t) => t.includes("bella") || t.includes("forno"))).toBe(false);
    expect(r.excluded).toContainEqual(expect.objectContaining({ term: "bella forno", reason: "other-client-brand", client: "bellafornino.example" }));
  });

  it("excludes another client's brand even before it has brand terms (domain stem similarity)", () => {
    const r = terms(agencyRows, agency, "gsc", [{ domain: "bellafornino.example", name: "bellafornino.example" }]);
    expect(r.candidates.map((c) => c.term)).not.toContain("bella forno");
    expect(r.excluded.map((e) => e.reason)).toContain("other-client-brand");
  });

  it("excludes fragments and misspellings of another client's brand", () => {
    expect(fuzzySubstring("belaforno", "bellaforno")).toBeGreaterThanOrEqual(0.75);
    const rows = [
      gsc("bela forno", 20, 40, 1.0),
      gsc("belaforno", 15, 30, 1.0),
      gsc("bella fornos", 15, 25, 1.0),
      gsc("bela forno website", 10, 20, 1.0),
      gsc("website design", 2, 400, 9),
    ];
    const others = [{ domain: "bellafornino.example", name: "bellafornino.example", brandTerms: ["bella forno"] }];
    const r = terms(rows, { domain: "agencyx.example", name: "agencyx.example" }, "gsc", others);
    expect(r.candidates.map((c) => c.term).filter((t) => /bel|forn/.test(t))).toEqual([]);
    expect(r.excluded.map((e) => e.term)).toEqual(expect.arrayContaining(["bela", "fornos", "belaforno"]));
    expect(r.excluded.every((e) => e.reason === "other-client-brand" && e.client === "bellafornino.example")).toBe(true);
  });

  it("does not exclude a client's own brand because another client's name is loosely similar", () => {
    // Shares "forno" but nothing like "bella".
    const others = [{ domain: "vistaforno.example", name: "Vista Forno" }];
    const r = terms(restaurantRows, restaurant, "gsc", others);
    expect(r.candidates[0]).toMatchObject({ term: "bella forno", confidence: "high" });
  });

  it("a brand term on one client never makes a query branded for another", () => {
    const [a, b] = mergeClients(
      [],
      parseOverrides({ clients: { a: { domain: "bellafornino.example", brandTerms: [{ term: "bella forno", source: "auto-gsc" }] }, b: { domain: "otherplace.example" } } }),
      { locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5 },
    );
    expect(isBranded("bella forno pizza", a!)).toBe(true);
    expect(isBranded("bella forno pizza", b!)).toBe(false);
    expect(b!.brandTerms).toEqual([]);
  });
});

describe("mergeCandidates", () => {
  it("keeps one candidate per term, the stronger one", () => {
    const g = terms(restaurantRows).candidates;
    const d = terms([dfs("bella forno pizza", 1, 320, 90), dfs("bella forno menu", 2, 100, 10)], restaurant, "dataforseo").candidates;
    const merged = mergeCandidates([d, g]);
    expect(merged.filter((c) => c.term === "bella forno")).toHaveLength(1);
    expect(METHOD).toMatch(/other-client-brand/);
  });
});

describe("brand-term storage", () => {
  it("accepts strings and objects, normalised and de-duplicated", () => {
    const [c] = mergeClients(
      [],
      parseOverrides({ clients: { x: { domain: "bellaforno.example", brandTerms: ["Bella  Forn", { term: "bella-forn" }, { term: "BF Pizza", source: "auto-dataforseo", addedAt: "2026-10-12" }] } } }),
      { locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5 },
    );
    expect(c!.brandTerms).toEqual(["Bella Forn", "BF Pizza"]);
    expect(c!.brandTermEntries).toEqual([{ term: "Bella Forn" }, { term: "BF Pizza", source: "auto-dataforseo", addedAt: "2026-10-12" }]);
  });

  it("rejects an unknown source and an empty term", () => {
    expect(() => parseOverrides({ clients: { x: { domain: "x.example", brandTerms: [{ term: "x", source: "robot" }] } } })).toThrow(/brandTerms/);
    expect(() => parseOverrides({ clients: { x: { domain: "x.example", brandTerms: [{ term: "--" }] } } })).toThrow(/brandTerms\[0\]/);
  });

  it("plans adds with source and date, skipping listed and repeated terms", () => {
    const plan = planAddBrandTerms(["bella forn"], ["Bella-Forn", "bf pizza", "BF  pizza", "!!"], { source: "auto-gsc", addedAt: "2026-10-12" });
    expect(plan.add).toEqual([{ term: "bf pizza", source: "auto-gsc", addedAt: "2026-10-12" }]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["already-listed", "duplicate-input", "invalid"]);
    expect(planAddBrandTerms(undefined, ["x co"], { addedAt: "2026-10-12" }).add[0]!.source).toBe("manual");
  });

  it("plans removes in any written form", () => {
    const plan = planRemoveBrandTerms(["bella forn", { term: "Bella-Forn", source: "auto-gsc" }, "bf pizza"], ["BELLA FORN", "nope"]);
    expect(plan.indexes).toEqual([0, 1]);
    expect(plan.removed).toEqual(["BELLA FORN"]);
    expect(plan.skipped[0]!.reason).toBe("not-listed");
  });

  it("appends object entries and keeps them through a set_client_profile style replace", () => {
    const text = "clients:\n  x:\n    domain: bellaforno.example\n    brandTerms: [bella forn] # keep\n";
    const added = appendListItems(text, "x", "brandTerms", [{ term: "bf pizza", source: "auto-gsc", addedAt: "2026-10-12" }]);
    expect(added).toContain("# keep");
    const replaced = setStringList(added, "x", "brandTerms", ["BF Pizza", "bella forno"], { objectKey: "term", same: (a, b) => squash(a) === squash(b) });
    const list = (parseYaml(replaced) as { clients: { x: { brandTerms: unknown[] } } }).clients.x.brandTerms;
    expect(list).toEqual([{ term: "bf pizza", source: "auto-gsc", addedAt: "2026-10-12" }, "bella forno"]);
    expect(toBrandTermEntries(list as never).map((e) => e.term)).toEqual(["bf pizza", "bella forno"]);
  });
});
