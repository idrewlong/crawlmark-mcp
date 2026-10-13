import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  domainStem,
  filterCandidates,
  brandToken,
  cleanSampleUrl,
  isBrandLookalike,
  mergeCandidates,
  pickSeeds,
  positionWeight,
  rankCandidates,
  type Candidate,
  type SeedSerp,
} from "../src/analysis/competitor-suggestions.js";
import { isBranded } from "../src/lib/brand.js";
import { buildDenylist } from "../src/lib/competitor-denylist.js";
import { lastDays } from "../src/lib/dates.js";
import { mapCompetitors, mapSerpOrganic } from "../src/providers/dataforseo-shape.js";

function fixture(name: string) {
  const json = JSON.parse(readFileSync(new URL(`./fixtures/dataforseo/${name}.json`, import.meta.url), "utf8"));
  return json.tasks[0].result[0];
}

const client = { domain: "exampleplumbing.com", name: "Example Plumbing Co" };

describe("seeds", () => {
  it("finds the domain stem past short suffix labels", () => {
    expect(domainStem("exampleplumbing.com")).toBe("exampleplumbing");
    expect(domainStem("shop.example.co.uk")).toBe("example");
    expect(domainStem("example")).toBe("example");
  });

  it("flags branded queries ignoring spaces and punctuation", () => {
    expect(isBranded("example plumbing reviews", client)).toBe(true);
    expect(isBranded("Example-Plumbing hours", client)).toBe(true);
    expect(isBranded("emergency plumber", client)).toBe(false);
  });

  it("catches initialism and suffix variants of the brand", () => {
    const c = { domain: "abbuildingsystems.com", name: "AB Building Systems" };
    for (const q of ["a b building", "ab building", "ab building solutions", "ab building inc", "AB Building, LLC", "ab building systems reviews", "ab"]) {
      expect(isBranded(q, c), q).toBe(true);
    }
    for (const q of ["modular home installation", "building contractor near me", "construction company springfield", "", "prefab homes", "systems integrator"]) {
      expect(isBranded(q, c), q).toBe(false);
    }
  });

  it("orders niche, tracked, then non-branded GSC, de-duplicated and capped", () => {
    const seeds = pickSeeds(
      {
        niche: "Emergency Plumber",
        tracked: ["drain repair", "emergency plumber"],
        gsc: ["example plumbing", "water heater plumber", "leak detection", "pipe repair plumber", "sewer line plumber", "weather report"],
        ranked: ["never used"],
      },
      client,
    );
    expect(seeds).toEqual([
      { keyword: "emergency plumber", from: "niche" },
      { keyword: "drain repair", from: "tracked" },
      { keyword: "water heater plumber", from: "gsc" }, // unrelated "leak detection" is skipped: no shared word with the niche
      { keyword: "pipe repair plumber", from: "gsc" },
      { keyword: "sewer line plumber", from: "gsc" },
    ]);
  });

  it("uses ranked keywords when nothing else is given, and returns none for no input", () => {
    expect(pickSeeds({ ranked: ["exampleplumbing", "boiler service"] }, client)).toEqual([{ keyword: "boiler service", from: "ranked" }]);
    expect(pickSeeds({}, client)).toEqual([]);
  });

  it("computes the last 28 days of Search Console data with the lag", () => {
    expect(lastDays(28, 3, new Date("2026-10-12T12:00:00Z"))).toEqual({ startDate: "2026-09-12", endDate: "2026-10-09" });
  });
});

describe("mapSerpOrganic (fixture)", () => {
  const out = mapSerpOrganic(fixture("serp_google_organic_live_regular"));

  it("keeps organic results with a domain, in rank order", () => {
    expect(out.keyword).toBe("example keyword");
    expect(out.locationCode).toBe(1006886);
    expect(out.items).toHaveLength(10);
    expect(out.items[0]).toEqual({
      position: 1,
      domain: "www.competitor-one.example",
      url: "https://www.competitor-one.example/services/",
      title: "Example result title 1",
    });
    expect(out.items.some((i) => i.domain === "local-pack.example")).toBe(false);
  });

  it("handles a missing result", () => {
    expect(mapSerpOrganic(undefined)).toEqual({ keyword: null, locationCode: null, items: [] });
  });
});

describe("merge, filter and rank", () => {
  const overlap = mapCompetitors(fixture("dataforseo_labs_google_competitors_domain_live")).items;
  const serp = mapSerpOrganic(fixture("serp_google_organic_live_regular")).items;
  const serps: SeedSerp[] = [
    { seed: "emergency plumber", hits: serp },
    { seed: "drain repair", hits: [{ domain: "competitor-two.example", position: 2, url: "https://competitor-two.example/drains" }] },
  ];

  it("merges sources per normalised domain with evidence", () => {
    const merged = mergeCandidates(overlap, serps);
    const one = merged.find((c) => c.domain === "competitor-one.example")!;
    // In the overlap fixture and twice in one SERP (positions 1 and 6): counted once, at its best.
    expect(one.sources).toEqual(["organic-overlap", "local-serp"]);
    expect(one.evidence).toMatchObject({
      intersectingKeywords: 116,
      avgPosition: 13.91,
      serpAppearances: 1,
      bestSerpPosition: 1,
      seeds: [{ keyword: "emergency plumber", position: 1 }],
      sampleUrl: "https://www.competitor-one.example/services/",
    });
    const two = merged.find((c) => c.domain === "competitor-two.example")!;
    expect(two.evidence.serpAppearances).toBe(2);
    expect(two.evidence.seeds.map((s) => s.keyword)).toEqual(["emergency plumber", "drain repair"]);
    expect(two.evidence.bestSerpPosition).toBe(2);
    expect(two.evidence.sampleUrl).toBe("https://competitor-two.example/drains");
    expect(merged.every((c) => c.domain === c.domain.replace(/^www\./, ""))).toBe(true);
  });

  it("excludes own site, current competitors, ignored domains and denylisted platforms", () => {
    const merged = mergeCandidates(overlap, serps);
    const { kept, excluded } = filterCandidates(merged, {
      ownDomain: "competitor-three.example",
      competitors: ["competitor-four.example"],
      ignored: ["competitor-six.example"],
      denylist: buildDenylist(["directory.example", "social.example"]).denylist,
    });
    expect(excluded).toEqual(
      expect.arrayContaining([
        { domain: "competitor-three.example", reason: "own-domain" },
        { domain: "competitor-four.example", reason: "already-competitor" },
        { domain: "competitor-six.example", reason: "ignored" },
        { domain: "directory.example", reason: "denylist" },
        { domain: "social.example", reason: "denylist" },
      ]),
    );
    const keptDomains = kept.map((c) => c.domain);
    for (const e of excluded) expect(keptDomains).not.toContain(e.domain);
    expect(keptDomains).toContain("competitor-one.example");
  });

  it("scores position weights as documented", () => {
    expect(positionWeight(1)).toBe(1);
    expect(positionWeight(20)).toBe(0.05);
    expect(positionWeight(21)).toBe(0);
  });

  it("ranks deterministically, combining both sources", () => {
    const c = (domain: string, inter: number | null, seeds: [string, number][]): Candidate => ({
      domain,
      sources: [],
      evidence: {
        intersectingKeywords: inter,
        avgPosition: null,
        estimatedTraffic: null,
        serpAppearances: seeds.length,
        bestSerpPosition: seeds.length ? Math.min(...seeds.map((s) => s[1])) : null,
        seeds: seeds.map(([keyword, position]) => ({ keyword, position })),
        sampleUrl: null,
      },
    });
    const list = [
      c("b.example", 100, []), // overlap 1.0 → 50
      c("a.example", null, [["k1", 1], ["k2", 1]]), // serp (1+1)/2 = 1.0 → 50
      c("c.example", 50, [["k1", 11]]), // 0.5*0.5 + 0.5*(0.5/2) = 0.375 → 37.5
      c("d.example", null, []), // 0
    ];
    const ranked = rankCandidates(list, { seedsSearched: 2 });
    // a and b tie on 50: more SERP appearances wins.
    expect(ranked.map((r) => [r.domain, r.score])).toEqual([
      ["a.example", 50],
      ["b.example", 50],
      ["c.example", 37.5],
      ["d.example", 0],
    ]);
    expect(rankCandidates([...list].reverse(), { seedsSearched: 2 }).map((r) => r.domain)).toEqual(
      ranked.map((r) => r.domain),
    );
  });

  it("puts all weight on the source that contributed", () => {
    const overlapOnly = rankCandidates(mergeCandidates(overlap, []), { seedsSearched: 0 });
    expect(overlapOnly[0]!.score).toBe(100); // the overlap leader
    const serpOnly = rankCandidates(mergeCandidates([], serps), { seedsSearched: 2 });
    expect(serpOnly[0]!.domain).toBe("competitor-two.example"); // 3rd in one seed SERP, 2nd in the other
    expect(serpOnly[0]!.score).toBe(Math.round(100 * ((positionWeight(3) + positionWeight(2)) / 2) * 10) / 10);
  });

  it("gives SERPs full weight when overlap succeeded but is empty or entirely filtered out", () => {
    const top = { seed: "k1", hits: [{ domain: "leader.example", position: 1, url: null }] };
    const both = [top, { ...top, seed: "k2" }];
    // Overlap call returned no rows.
    expect(rankCandidates(mergeCandidates([], both), { seedsSearched: 2 })[0]!.score).toBe(100);
    // Overlap rows exist but all were filtered out before ranking.
    const merged = mergeCandidates([{ domain: "own.example", intersectingKeywords: 50, avgPosition: 3, estimatedTraffic: 1 }], both);
    const { kept } = filterCandidates(merged, { ownDomain: "own.example", competitors: [], ignored: [], denylist: buildDenylist([]).denylist });
    expect(rankCandidates(kept, { seedsSearched: 2 })).toMatchObject([{ domain: "leader.example", score: 100 }]);
    // Overlap rows with null intersections contribute nothing either.
    const nulls = mergeCandidates([{ domain: "x.example", intersectingKeywords: null, avgPosition: null, estimatedTraffic: null }], both);
    expect(rankCandidates(nulls, { seedsSearched: 2 }).find((c) => c.domain === "leader.example")!.score).toBe(100);
  });
});

describe("cleanSampleUrl", () => {
  it("drops tracking parameters and fragments but keeps real ones", () => {
    expect(cleanSampleUrl("https://example.com/?srsltid=abc")).toBe("https://example.com/");
    expect(cleanSampleUrl("https://example.com/a?utm_source=x&page=2&gclid=1&fbclid=2#top")).toBe("https://example.com/a?page=2");
    expect(cleanSampleUrl("not a url")).toBe("not a url");
  });

  it("is applied to merged sample URLs", () => {
    const [c] = mergeCandidates([], [{ seed: "s", hits: [{ domain: "rival.example", position: 1, url: "https://rival.example/?srsltid=z" }] }]);
    expect(c!.evidence.sampleUrl).toBe("https://rival.example/");
  });
});

describe("brand lookalikes and AI seeds", () => {
  const ab = { domain: "abbuildingsystems.com", name: "AB Building Systems" };

  it("derives the brand token, ignoring common words", () => {
    expect(brandToken(ab)).toBe("ab");
    expect(brandToken({ domain: "westfieldhomes.com", name: "Westfield Homes" })).toBe("westfield");
    expect(brandToken({ domain: "thebesthomes.com", name: "The Best Homes" })).toBeNull();
    expect(brandToken({ domain: "bestplumbing.com", name: "Best Plumbing Co" })).toBeNull();
    expect(brandToken({ domain: "zedhomes.com", name: "Zed Homes" })).toBe("zed");
    expect(brandToken({ domain: "x.com", name: "Zed" })).toBeNull(); // 3+ letters must start the domain stem
  });

  it("matches stems by prefix for short tokens and containment for long ones", () => {
    expect(isBrandLookalike("abbuildingcompany.com", "ab")).toBe(true);
    expect(isBrandLookalike("cabinets.example.com", "ab")).toBe(false);
    expect(isBrandLookalike("rival-ab.com", "ab")).toBe(true); // ends with the token, 5 characters before it
    expect(isBrandLookalike("buildingwithab.com", "ab")).toBe(true);
    expect(isBrandLookalike("buildab.com", "ab")).toBe(true);
    expect(isBrandLookalike("xyab.com", "ab")).toBe(false); // fewer than 3 characters before the token
    expect(isBrandLookalike("grab.com", "ab")).toBe(false);
    expect(isBrandLookalike("scrabble.com", "ab")).toBe(false);
    expect(isBrandLookalike("cabinets.com", "ab")).toBe(false);
    expect(isBrandLookalike("thewestfieldgroup.com", "westfield")).toBe(true);
    expect(isBrandLookalike("anything.com", null)).toBe(false);
  });

  it("filters lookalikes with their own reason", () => {
    const merged = mergeCandidates(
      [
        { domain: "abbuildgroup.com", intersectingKeywords: 9, avgPosition: 3, estimatedTraffic: 1 },
        { domain: "rival.example", intersectingKeywords: 5, avgPosition: 3, estimatedTraffic: 1 },
      ],
      [],
    );
    const x = { ownDomain: "own.example", competitors: [], ignored: [], denylist: buildDenylist([]).denylist };
    const r = filterCandidates(merged, { ...x, brandToken: "ab" });
    expect(r.kept.map((c) => c.domain)).toEqual(["rival.example"]);
    expect(r.excluded).toEqual([{ domain: "abbuildgroup.com", reason: "brand-lookalike" }]);
    expect(filterCandidates(merged, x).kept).toHaveLength(2);
  });

  it("counts a standalone brand initialism as branded", () => {
    expect(isBranded("ab construction", ab)).toBe(true);
    expect(isBranded("modular home installation", ab)).toBe(false);
    expect(isBranded("abc roofing", ab)).toBe(false);
  });

  it("orders explicit seeds, niche, tracked, then GSC, and gates GSC on relevance", () => {
    const seeds = pickSeeds(
      {
        seeds: ["Prefab Home Builder", "modular home contractor"],
        niche: "modular home installation",
        tracked: ["adu builder"],
        gsc: ["construction website design springfield", "other building systems", "modular homes springfield", "home installation cost"],
      },
      ab,
    );
    expect(seeds.map((s) => [s.keyword, s.from])).toEqual([
      ["prefab home builder", "explicit"],
      ["modular home contractor", "explicit"],
      ["modular home installation", "niche"],
      ["adu builder", "tracked"],
      ["modular homes springfield", "gsc"],
    ]);
  });

  it("caps explicit seeds at 5 and uses GSC unfiltered when no seeds or niche exist", () => {
    expect(pickSeeds({ seeds: ["a1", "b2", "c3", "d4", "e5", "f6"] }, ab).map((s) => s.keyword)).toEqual(["a1", "b2", "c3", "d4", "e5"]);
    expect(pickSeeds({ gsc: ["unrelated thing"] }, ab)).toEqual([{ keyword: "unrelated thing", from: "gsc" }]);
  });
});

describe("local weighting", () => {
  const overlap = [{ domain: "a.example", intersectingKeywords: 10, avgPosition: 1, estimatedTraffic: 1 }];
  const serps: SeedSerp[] = [{ seed: "s", hits: [{ domain: "a.example", position: 1, url: null }] }];
  const merged = () => mergeCandidates(overlap, serps);

  it("keeps 0.5/0.5 without an area and uses 0.3/0.7 with one", () => {
    const b = { domain: "b.example", intersectingKeywords: null, avgPosition: null, estimatedTraffic: null };
    const two = (local: boolean) =>
      rankCandidates(mergeCandidates([...overlap, { ...b, domain: "c.example", intersectingKeywords: 5 }], [{ seed: "s", hits: [{ domain: "b.example", position: 1, url: null }] }]), {
        seedsSearched: 1,
        localArea: local,
      });
    expect(two(false).find((c) => c.domain === "b.example")!.score).toBe(50);
    expect(two(true).find((c) => c.domain === "b.example")!.score).toBe(70);
    expect(two(true).find((c) => c.domain === "c.example")!.score).toBe(15);
  });

  it("falls back to 0.5/0.5 when the SERPs returned no kept candidates, and to full weight for a single source", () => {
    const overlapOnlyHit = mergeCandidates(overlap, []);
    expect(rankCandidates(overlapOnlyHit, { seedsSearched: 1, localArea: true })[0]!.score).toBe(50);
    expect(rankCandidates(overlapOnlyHit, { seedsSearched: 0, localArea: true })[0]!.score).toBe(100);
    expect(rankCandidates(merged(), { seedsSearched: 1, localArea: true })[0]!.score).toBe(100);
  });
});

describe("local evidence ranks first", () => {
  const overlap = [
    { domain: "noise.example", intersectingKeywords: 100, avgPosition: 1, estimatedTraffic: 1 },
    { domain: "dealer.example", intersectingKeywords: 10, avgPosition: 1, estimatedTraffic: 1 },
  ];
  const serps: SeedSerp[] = [{ seed: "s", hits: [{ domain: "dealer.example", position: 5, url: null }] }];

  it("puts SERP candidates ahead of higher-scoring overlap-only ones and flags the latter", () => {
    const r = rankCandidates(mergeCandidates(overlap, serps), { seedsSearched: 1, localArea: true });
    expect(r.map((c) => c.domain)).toEqual(["dealer.example", "noise.example"]);
    expect(r[1]).toMatchObject({ weakEvidence: true });
    expect(r[1]!.score).toBeGreaterThan(r[0]!.score - 100); // scores are unchanged, only the order moves
    expect(r[0]!.weakEvidence).toBeUndefined();
  });

  it("keeps score order and no flag without a local area or without searched seeds", () => {
    const merged = mergeCandidates(overlap, serps);
    const noArea = rankCandidates(merged, { seedsSearched: 1 });
    expect(noArea.map((c) => c.domain)).toEqual(["noise.example", "dealer.example"].sort((a, b) => noArea.find((c) => c.domain === b)!.score - noArea.find((c) => c.domain === a)!.score));
    expect(noArea.some((c) => c.weakEvidence)).toBe(false);
    const noSeeds = rankCandidates(mergeCandidates(overlap, []), { seedsSearched: 0, localArea: true });
    expect(noSeeds.map((c) => c.domain)).toEqual(["noise.example", "dealer.example"]);
    expect(noSeeds.some((c) => c.weakEvidence)).toBe(false);
  });
});

describe("brand token edge cases", () => {
  it("strips accents instead of splitting on them", () => {
    const c = { domain: "mueller-bau.example", name: "Müller Bau" };
    expect(brandToken(c)).toBeNull(); // "muller" is not the stem's prefix ("mueller"): no token beats a wrong one
    const d = { domain: "mullerbau.example", name: "Müller Bau" };
    expect(brandToken(d)).toBe("muller");
    expect(isBrandLookalike("mullerbuild.example", "muller")).toBe(true);
    expect(isBrandLookalike("muscle.example", brandToken(d))).toBe(false);
    expect(isBranded("müller bau reviews", d)).toBe(true);
  });

  it("requires a 3+ letter token to start the domain stem", () => {
    const sun = { domain: "sunpros.example", name: "Sun Pros" };
    expect(brandToken(sun)).toBe("sun");
    expect(isBrandLookalike("sunprosolar.example", brandToken(sun))).toBe(true);
    expect(brandToken({ domain: "bestroofs.example", name: "Sun Pros" })).toBeNull();
    expect(isBrandLookalike("sunroomco.example", brandToken({ domain: "roofing.example", name: "Sun Roofing" }))).toBe(false);
  });

  it("ignores blank seeds when gating", () => {
    const c = { domain: "ab.example", name: "AB Building" };
    expect(pickSeeds({ seeds: [" ", ""], gsc: ["modular homes"] }, c)).toEqual([{ keyword: "modular homes", from: "gsc" }]);
    expect(pickSeeds({ seeds: ["  prefab homes "], gsc: ["prefab pricing"] }, c).map((x) => x.keyword)).toEqual(["prefab homes", "prefab pricing"]);
  });
});
