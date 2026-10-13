import { describe, expect, it } from "vitest";
import { BUILTIN_DENYLIST, buildDenylist, compileRule, isDenied, parseRules } from "../src/lib/competitor-denylist.js";

// Platform names live only in src/lib/competitor-denylist.ts. Sample hosts for
// the built-in rules are derived from the rules themselves; literal hosts here use .example.

const builtin = buildDenylist(BUILTIN_DENYLIST);

/** Hosts a rule should deny: the base form, a subdomain, and suffix variants for wildcard rules. */
function deniedSamples(rule: string): string[] {
  const prefix = rule.startsWith("*.");
  const suffix = rule.endsWith(".*");
  const core = rule.replace(/^\*\./, "").replace(/\.\*$/, "");
  if (prefix && suffix) return [`agency.${core}.uk`, `sub.agency.${core}.au`];
  if (prefix) return [`agency.${core}`, `sub.agency.${core}`];
  if (suffix) return [`${core}.com`, `${core}.de`, `${core}.co.uk`, `${core}.com.au`, `sub.${core}.com`, `sub.${core}.co.uk`];
  return [core, `sub.${core}`];
}

/** Look-alike hosts a rule must not deny on its own. */
function allowedSamples(rule: string): string[] {
  const prefix = rule.startsWith("*.");
  const suffix = rule.endsWith(".*");
  const core = rule.replace(/^\*\./, "").replace(/\.\*$/, "");
  if (prefix && suffix) return [`agency.${core}.com`];
  if (prefix) return [core.split(".")[0]!]; // the bare suffix label isn't a host under it
  if (suffix) return [`look${core}.com`, `${core}.example.com`];
  return [`look${core}`];
}

describe("built-in denylist", () => {
  it("compiles every built-in rule", () => {
    expect(builtin.invalid).toEqual([]);
  });

  it.each([...BUILTIN_DENYLIST])("denies hosts matching %s", (rule) => {
    const re = compileRule(rule)!;
    for (const host of deniedSamples(rule)) {
      expect(re.test(host), `${rule} vs ${host}`).toBe(true);
      expect(isDenied(host, builtin.denylist), host).toBe(true);
    }
  });

  it.each([...BUILTIN_DENYLIST])("does not over-match %s", (rule) => {
    const re = compileRule(rule)!;
    for (const host of allowedSamples(rule)) expect(re.test(host), `${rule} vs ${host}`).toBe(false);
  });

  it("leaves ordinary businesses alone", () => {
    for (const d of ["rival.example", "exampleplumbing.example", "governor.example", "education.example", "shop.rival.example"]) {
      expect(isDenied(d, builtin.denylist), d).toBe(false);
    }
  });
});

describe("rules", () => {
  it("parses files and comma lists, dropping comments and blanks", () => {
    expect(parseRules("# header\ndirectory.example  # why\n\n*.example.test\n")).toEqual(["directory.example", "*.example.test"]);
    expect(parseRules("a.example, b.example")).toEqual(["a.example", "b.example"]);
  });

  it("reports unusable rules", () => {
    expect(compileRule("not a rule")).toBeUndefined();
    expect(compileRule("*.")).toBeUndefined();
    expect(buildDenylist(["ok.example", "bad rule"]).invalid).toEqual(["bad rule"]);
  });

  it("matches bare, prefix and suffix wildcards", () => {
    const { denylist } = buildDenylist(["directory.example", "*.listing", "portal.*", "*.agency.*"]);
    expect(isDenied("directory.example", denylist)).toBe(true);
    expect(isDenied("www2.directory.example", denylist)).toBe(true);
    expect(isDenied("a.listing", denylist)).toBe(true);
    expect(isDenied("listing", denylist)).toBe(false);
    expect(isDenied("portal.com", denylist)).toBe(true);
    expect(isDenied("portal.co.uk", denylist)).toBe(true);
    expect(isDenied("portal.example.com", denylist)).toBe(false);
    expect(isDenied("city.agency.uk", denylist)).toBe(true);
    expect(isDenied("city.agency.com", denylist)).toBe(false); // *.x.* takes a country code only
  });

  it("lets ! rules override a deny", () => {
    const { denylist } = buildDenylist(["*.example", "!research.example"]);
    expect(isDenied("research.example", denylist)).toBe(false);
    expect(isDenied("lab.research.example", denylist)).toBe(false);
    expect(isDenied("other.example", denylist)).toBe(true);
  });
});
