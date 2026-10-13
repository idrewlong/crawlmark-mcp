import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  domainStem,
  filterCandidates,
  looksBranded,
  mergeCandidates,
  pickSeeds,
  positionWeight,
  rankCandidates,
  type Candidate,
  type SeedSerp,
} from "../src/analysis/competitor-suggestions.js";
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
    expect(looksBranded("example plumbing reviews", client)).toBe(true);
    expect(looksBranded("Example-Plumbing hours", client)).toBe(true);
    expect(looksBranded("emergency plumber", client)).toBe(false);
  });

  it("orders niche, tracked, then non-branded GSC, de-duplicated and capped", () => {
    const seeds = pickSeeds(
      {
        niche: "Emergency Plumber",
        tracked: ["drain repair", "emergency plumber"],
        gsc: ["example plumbing", "water heater install", "leak detection", "pipe repair", "sewer line"],
        ranked: ["never used"],
      },
      client,
    );
    expect(seeds).toEqual([
      { keyword: "emergency plumber", from: "niche" },
      { keyword: "drain repair", from: "tracked" },
      { keyword: "water heater install", from: "gsc" },
      { keyword: "leak detection", from: "gsc" },
      { keyword: "pipe repair", from: "gsc" },
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
