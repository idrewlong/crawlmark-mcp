import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { compareSplit, markBranded, splitBranded, type QueryRow } from "../src/analysis/branded.js";
import { isBranded, normalizeBrandTerm, toBrandTerms } from "../src/lib/brand.js";
import { setStringList } from "../src/lib/clients-file.js";
import { mergeClients, parseOverrides } from "../src/lib/clients.js";

const plumbing = { domain: "exampleplumbing.com", name: "Example Plumbing Co" };
const ab = { domain: "abbuildingsystems.example", name: "AB Building Systems" };

describe("isBranded: default matching", () => {
  it("ignores case, spacing and punctuation", () => {
    for (const q of ["example plumbing", "Example-Plumbing hours", "exampleplumbing", "EXAMPLE_PLUMBING reviews", "example.plumbing", "example  plumbing  co", "exampleplumbing.com"]) {
      expect(isBranded(q, plumbing), q).toBe(true);
    }
    expect(isBranded("emergency plumber", plumbing)).toBe(false);
    expect(isBranded("", plumbing)).toBe(false);
  });

  it("matches a hyphenated domain against spaced and joined queries", () => {
    const c = { domain: "example-plumbing.com", name: "example-plumbing.com" };
    expect(isBranded("example plumbing", c)).toBe(true);
    expect(isBranded("exampleplumbing", c)).toBe(true);
    expect(isBranded("example-plumbing near me", c)).toBe(true);
    expect(isBranded("plumbing near me", c)).toBe(false); // "plumbing" alone is not a brand
  });

  it("catches initialism and suffix variants (ported from looksBranded)", () => {
    for (const q of ["a b building", "ab building", "ab building solutions", "ab building inc", "AB Building, LLC", "ab building systems reviews", "ab", "ab construction"]) {
      expect(isBranded(q, ab), q).toBe(true);
    }
    for (const q of ["modular home installation", "building contractor near me", "construction company springfield", "", "prefab homes", "systems integrator", "abc roofing", "about us"]) {
      expect(isBranded(q, ab), q).toBe(false);
    }
  });

  it("strips accents", () => {
    expect(isBranded("müller bau reviews", { domain: "mullerbau.example", name: "Müller Bau" })).toBe(true);
    expect(isBranded("muller bau", { domain: "mullerbau.example", name: "Müller Bau" })).toBe(true);
  });

  it("does not mark trade words inside the name as branded, but keeps truncated brand prefixes", () => {
    const a = { domain: "austinplumbing.example", name: "Austin Plumbing" };
    const r = { domain: "apexroofing.example", name: "Apex Roofing" };
    expect(isBranded("plumbing", a)).toBe(false);
    expect(isBranded("roofing", r)).toBe(false);
    expect(isBranded("roof", r)).toBe(false);
    expect(isBranded("austinplumb", a)).toBe(true);
    expect(isBranded("austi", a)).toBe(true);
    expect(isBranded("apexroof", r)).toBe(true);
    expect(isBranded("exampl", plumbing)).toBe(true);
    expect(isBranded("exampleplumb", plumbing)).toBe(true);
  });

  it("uses the GA4 name when it differs from the client name", () => {
    const c = { domain: "example.com", name: "Display Name", ga4Name: "Old Trading Name" };
    expect(isBranded("old trading name reviews", c)).toBe(true);
    expect(isBranded("old trading name reviews", { domain: "example.com", name: "Display Name" })).toBe(false);
  });
});

describe("isBranded: explicit brandTerms add to the heuristics", () => {
  const client = { ...plumbing, brandTerms: ["ex plumbing", "Pipe Masters"] };

  it("matches terms with punctuation and spacing variants", () => {
    expect(isBranded("pipe-masters near me", client)).toBe(true);
    expect(isBranded("PIPEMASTERS", client)).toBe(true);
    expect(isBranded("ex plumbing", client)).toBe(true);
    expect(isBranded("ex-plumbing reviews", client)).toBe(true);
  });

  it("still uses the domain stem and name heuristics", () => {
    expect(isBranded("example plumbing hours", client)).toBe(true);
    expect(isBranded("a b building", { ...ab, brandTerms: ["unrelated name"] })).toBe(true);
  });

  it("matches a short term only as a whole word", () => {
    const c = { domain: "zzzz.example", name: "Zzzz", brandTerms: ["qx"] };
    expect(isBranded("qx pricing", c)).toBe(true);
    expect(isBranded("q x pricing", c)).toBe(true);
    expect(isBranded("qxylophone lessons", c)).toBe(false);
  });

  it("does not flag unrelated queries", () => {
    expect(isBranded("drain cleaning", client)).toBe(false);
  });
});

describe("brand term normalisation", () => {
  it("collapses spaces, drops empties and duplicates ignoring case and punctuation", () => {
    expect(toBrandTerms(["  Pipe   Masters ", "pipe-masters", "", "!!!", "Other"])).toEqual(["Pipe Masters", "Other"]);
    expect(normalizeBrandTerm("***")).toBeUndefined();
    expect(normalizeBrandTerm("x".repeat(101))).toBeUndefined();
  });
});

describe("splitBranded", () => {
  const rows: QueryRow[] = [
    { keys: ["example plumbing"], clicks: 40, impressions: 100, ctr: 40, position: 1 },
    { keys: ["exampleplumbing hours"], clicks: 10, impressions: 100, ctr: 10, position: 3 },
    { keys: ["emergency plumber"], clicks: 5, impressions: 400, ctr: 1.25, position: 8 },
    { keys: ["drain repair"], clicks: 5, impressions: 100, ctr: 5, position: 4 },
  ];

  it("totals clicks, impressions, CTR and impression-weighted position", () => {
    const s = splitBranded(rows, plumbing);
    expect(s.branded).toEqual({ queries: 2, clicks: 50, impressions: 200, ctr: 25, position: 2 });
    expect(s.nonBranded).toEqual({ queries: 2, clicks: 10, impressions: 500, ctr: 2, position: 7.2 });
  });

  it("returns a null position and zero CTR for an empty group", () => {
    expect(splitBranded([], plumbing).branded).toEqual({ queries: 0, clicks: 0, impressions: 0, ctr: 0, position: null });
  });

  it("compares two months", () => {
    const cur = splitBranded(rows, plumbing);
    const prev = splitBranded([], plumbing);
    const c = compareSplit(cur.branded, prev.branded);
    expect(c.change).toEqual({ clicks: null, impressions: null, ctr: null, position: null });
    expect(compareSplit(cur.nonBranded, cur.nonBranded).change.position).toBe(0);
  });

  it("marks each row", () => {
    expect(markBranded(rows, plumbing).map((r) => r.branded)).toEqual([true, true, false, false]);
  });
});

describe("brandTerms in clients.yaml", () => {
  const defaults = { locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5 };

  it("parses, normalises and defaults to an empty list", () => {
    const overrides = parseOverrides({
      clients: {
        "example.com": { domain: "example.com", brandTerms: ["Example  Co", "example-co", "ex co"] },
        "example.org": { domain: "example.org" },
      },
    });
    const clients = mergeClients([], overrides, defaults);
    expect(clients.find((c) => c.domain === "example.com")!.brandTerms).toEqual(["Example Co", "ex co"]);
    expect(clients.find((c) => c.domain === "example.org")!.brandTerms).toEqual([]);
  });

  it("rejects a term with no letters or digits", () => {
    expect(() => parseOverrides({ clients: { "example.com": { domain: "example.com", brandTerms: ["--"] } } })).toThrow(/brandTerms\[0\]/);
  });

  it("records the GA4 name when it differs from a yaml name", () => {
    const overrides = parseOverrides({ clients: { "example.com": { domain: "example.com", name: "Mine" } } });
    const [c] = mergeClients([{ domain: "example.com", ga4DisplayName: "Property Name", gscAlternates: [], ga4Alternates: [] }], overrides, defaults);
    expect(c!.ga4Name).toBe("Property Name");
  });
});

describe("setStringList", () => {
  const file = `# keep me\nclients:\n  example.com:\n    domain: example.com # inline\n    brandTerms: [old]\n`;

  it("replaces the list and keeps comments", () => {
    const out = setStringList(file, "example.com", "brandTerms", ["a b", "c"]);
    expect(out).toContain("# keep me");
    expect(out).toContain("# inline");
    expect(parseYaml(out).clients["example.com"].brandTerms).toEqual(["a b", "c"]);
  });

  it("removes the field for an empty list", () => {
    const out = setStringList(file, "example.com", "brandTerms", []);
    expect(parseYaml(out).clients["example.com"].brandTerms).toBeUndefined();
    expect(out).toContain("# keep me");
  });

  it("keeps the key-line comment and comments on the block", () => {
    const text = `clients:\n  example.com:\n    domain: example.com\n    # about brand terms\n    brandTerms: # names people search\n      - example co # adds to built-in\n      - ex co\n    niche: x\n`;
    const out = setStringList(text, "example.com", "brandTerms", ["example co", "new one"]);
    expect(out).toContain("# about brand terms");
    expect(out).toContain("# names people search"); // the yaml library moves a key-line comment to its own line, even on an untouched file
    expect(out).toContain("example co # adds to built-in");
    expect(parseYaml(out).clients["example.com"].brandTerms).toEqual(["example co", "new one"]);
    expect(out).toContain("niche: x");
  });

  it("throws for an unknown entry", () => {
    expect(() => setStringList(file, "nope.example", "brandTerms", ["x"])).toThrow(/no entry/);
  });
});

describe("isBranded: distinctive part of the domain stem", () => {
  const bella = { domain: "bellafornino.example", name: "bellafornino.example", brandTerms: ["bella forno"] };
  const el = { domain: "lafornino.example", name: "lafornino.example", brandTerms: ["la forno"] };

  it("counts the name without its leading article as the brand, but not a tail of the name", () => {
    expect(isBranded("fornino pizza", el)).toBe(true);
    expect(isBranded("fornino pizza", bella)).toBe(false); // "bella" is not an article; left to review-brand-terms
    expect(isBranded("bellafornino pizza", bella)).toBe(true);
    expect(isBranded("pizza near me", bella)).toBe(false);
    expect(isBranded("pizza near me", el)).toBe(false);
  });

  it("does not make a common word a brand because it ends a two-word name", () => {
    expect(isBranded("summit hotel", { domain: "bluesummit.example", name: "bluesummit.example" })).toBe(false);
    expect(isBranded("capital gains tax", { domain: "redwoodcapital.example", name: "redwoodcapital.example" })).toBe(false);
    expect(isBranded("harbor freight", { domain: "goldenharbor.example", name: "goldenharbor.example" })).toBe(false);
    expect(isBranded("bluesummit hotel", { domain: "bluesummit.example", name: "bluesummit.example" })).toBe(true);
  });

  it("needs a whole token of 5+ characters", () => {
    expect(isBranded("forninos", bella)).toBe(false);
    expect(isBranded("nino", bella)).toBe(false);
  });

  it("never turns a trade word or place of an exact-match domain into a brand", () => {
    const exact = { domain: "austinplumbing.example", name: "austinplumbing.example" };
    for (const q of ["plumbing", "plumber near me", "austin plumbers", "emergency plumbing", "plumbing repair austin"]) expect(isBranded(q, exact), q).toBe(false);
    const niche = { domain: "pipewellplumbing.example", name: "pipewellplumbing.example", niche: "emergency plumber" };
    expect(isBranded("pipewell", niche)).toBe(true);
    expect(isBranded("emergency plumber", niche)).toBe(false);
  });
});
