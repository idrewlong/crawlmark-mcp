import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  isOwnDomain,
  planAddCompetitors,
  planAddKeywords,
  planRemoveCompetitors,
  planRemoveKeywords,
  today,
} from "../src/lib/client-lists.js";
import {
  mergeClients,
  normalizeArea,
  normalizeCompetitorDomain,
  normalizeKeyword,
  parseOverrides,
  toCompetitorEntries,
  toKeywordEntries,
  type ClientDefaults,
} from "../src/lib/clients.js";

const DEFAULTS: ClientDefaults = { locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5 };
const META = { addedAt: "2026-10-12" };

describe("normalisers", () => {
  it("reduces competitor input to a bare domain", () => {
    expect(normalizeCompetitorDomain("https://www.Rival.example/services?x=1")).toBe("rival.example");
    expect(normalizeCompetitorDomain("www.rival.example")).toBe("rival.example");
    expect(normalizeCompetitorDomain("rival.example.")).toBe("rival.example");
    expect(normalizeCompetitorDomain("not a domain")).toBeUndefined();
    expect(normalizeCompetitorDomain("localhost")).toBeUndefined();
    expect(normalizeCompetitorDomain("")).toBeUndefined();
  });

  it("normalises keywords to lowercase single-spaced text", () => {
    expect(normalizeKeyword("  Emergency   Plumber\tAustin ")).toBe("emergency plumber austin");
    expect(normalizeKeyword("   ")).toBeUndefined();
    expect(normalizeKeyword("x".repeat(201))).toBeUndefined();
  });

  it("normalises an area to DataForSEO's comma form", () => {
    expect(normalizeArea("Austin, Texas,  United States")).toBe("Austin,Texas,United States");
    expect(normalizeArea("United States")).toBe("United States");
    expect(normalizeArea("Austin,,Texas")).toBeUndefined();
    expect(normalizeArea(" ")).toBeUndefined();
  });

  it("treats subdomains as the client's own site", () => {
    expect(isOwnDomain("example.com", "example.com")).toBe(true);
    expect(isOwnDomain("shop.example.com", "example.com")).toBe(true);
    expect(isOwnDomain("notexample.com", "example.com")).toBe(false);
  });

  it("formats today's local date as YYYY-MM-DD", () => {
    expect(today(new Date(2026, 9, 12, 23, 59))).toBe("2026-10-12");
    expect(today(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
  });
});

describe("entries from clients.yaml", () => {
  it("accepts plain strings and objects, normalising and de-duplicating", () => {
    expect(
      toCompetitorEntries([
        "https://www.rival.example/",
        { domain: "other.example", note: " local ", source: "suggested", addedAt: "2026-10-01" },
        "rival.example",
      ]),
    ).toEqual([
      { domain: "rival.example" },
      { domain: "other.example", note: "local", source: "suggested", addedAt: "2026-10-01" },
    ]);
    expect(toKeywordEntries(["Plumber Near Me", { keyword: "plumber  near me" }, { keyword: "drain repair", source: "manual" }])).toEqual([
      { keyword: "plumber near me" },
      { keyword: "drain repair", source: "manual" },
    ]);
  });

  it("parses mixed forms and the new profile fields", () => {
    const [o] = parseOverrides(
      parseYaml(`
clients:
  example.com:
    domain: example.com
    area: Austin,Texas,United States
    niche: emergency plumber
    competitors:
      - rival.example
      - domain: https://www.other.example/
        note: Same street
        source: suggested
        addedAt: "2026-10-12"
    trackedKeywords:
      - plumber near me
      - keyword: Drain Repair
        source: manual
`),
    );
    const [c] = mergeClients([], [o!], DEFAULTS);
    expect(c!.area).toBe("Austin,Texas,United States");
    expect(c!.niche).toBe("emergency plumber");
    expect(c!.competitors).toEqual(["rival.example", "other.example"]);
    expect(c!.competitorEntries[1]).toEqual({ domain: "other.example", note: "Same street", source: "suggested", addedAt: "2026-10-12" });
    expect(c!.trackedKeywords).toEqual(["plumber near me", "drain repair"]);
  });

  it("rejects a competitor that isn't a domain and an unknown source", () => {
    expect(() => parseOverrides({ clients: { a: { domain: "example.com", competitors: ["not a domain"] } } })).toThrow(
      /clients\.a\.competitors\[0\] "not a domain" is not a domain/,
    );
    expect(() =>
      parseOverrides({ clients: { a: { domain: "example.com", competitors: [{ domain: "rival.example", source: "robot" }] } } }),
    ).toThrow(/Invalid clients\.yaml/);
    expect(() => parseOverrides({ clients: { a: { domain: "example.com", trackedKeywords: [{ keyword: "   " }] } } })).toThrow(
      /trackedKeywords\[0\]/,
    );
  });

  it("leaves area and niche unset when blank", () => {
    const [c] = mergeClients([], [{ slug: "example.com", domain: "example.com", area: " , ", niche: "  " }], DEFAULTS);
    expect(c!.area).toBeUndefined();
    expect(c!.niche).toBeUndefined();
  });
});

describe("planAddCompetitors", () => {
  it("adds new domains and explains every skip", () => {
    const plan = planAddCompetitors(
      ["rival.example", { domain: "other.example" }],
      ["https://www.new.example/page", "www.rival.example", "example.com", "https://shop.example.com/", "new.example", "not a domain"],
      "example.com",
      { ...META, note: " seen in maps ", source: "suggested" },
    );
    expect(plan.add).toEqual([{ domain: "new.example", note: "seen in maps", source: "suggested", addedAt: "2026-10-12" }]);
    expect(plan.inputs).toEqual(["https://www.new.example/page"]);
    expect(plan.skipped.map((s) => [s.input, s.reason])).toEqual([
      ["www.rival.example", "already-listed"],
      ["example.com", "own-domain"],
      ["https://shop.example.com/", "own-domain"],
      ["new.example", "duplicate-input"],
      ["not a domain", "invalid"],
    ]);
  });

  it("defaults source to manual and omits a blank note", () => {
    expect(planAddCompetitors(undefined, ["rival.example"], "example.com", { ...META, note: "  " }).add).toEqual([
      { domain: "rival.example", source: "manual", addedAt: "2026-10-12" },
    ]);
  });
});

describe("planAddKeywords", () => {
  it("normalises, de-duplicates and skips tracked ones", () => {
    const plan = planAddKeywords(["plumber near me"], ["Plumber Near Me", "Drain  Repair", "drain repair", ""], META);
    expect(plan.add).toEqual([{ keyword: "drain repair", source: "manual", addedAt: "2026-10-12" }]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["already-listed", "duplicate-input", "invalid"]);
  });
});

describe("planRemove", () => {
  it("finds every written form of a competitor, including hand-written duplicates", () => {
    const plan = planRemoveCompetitors(
      ["rival.example", { domain: "other.example" }, "https://www.rival.example/"],
      ["www.rival.example", "missing.example", "rival.example", "nope"],
    );
    expect(plan.indexes).toEqual([0, 2]);
    expect(plan.removed).toEqual(["rival.example"]);
    expect(plan.skipped.map((s) => [s.input, s.reason])).toEqual([
      ["missing.example", "not-listed"],
      ["nope", "invalid"],
    ]);
  });

  it("removes keywords ignoring case and spacing", () => {
    const plan = planRemoveKeywords(["plumber near me", { keyword: "Drain Repair" }], ["DRAIN   repair"]);
    expect(plan.indexes).toEqual([1]);
    expect(plan.removed).toEqual(["drain repair"]);
  });

  it("reports everything not-listed when the client has no list", () => {
    expect(planRemoveCompetitors(undefined, ["rival.example"]).skipped[0]!.reason).toBe("not-listed");
  });
});
