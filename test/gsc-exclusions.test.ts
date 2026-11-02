import { describe, expect, it } from "vitest";
import { exclusionRegex, isExcludedQuery, parseExclusion, validateExclusions } from "../src/lib/gsc-exclusions.js";

const C1 = ["example login", "/^site:example\\.com/"];

describe("parseExclusion", () => {
  it("treats /.../ as a regex and anything else as a normalised exact query", () => {
    expect(parseExclusion("/^site:example\\.com/")).toEqual({ kind: "regex", source: "^site:example\\.com" });
    expect(parseExclusion("  Example   LOGIN ")).toEqual({ kind: "exact", query: "example login" });
    expect(parseExclusion("//")).toEqual({ kind: "exact", query: "//" });
    expect(parseExclusion("/a/")).toEqual({ kind: "regex", source: "a" });
  });
});

describe("exclusionRegex", () => {
  it("builds the C1 example exactly", () => {
    expect(exclusionRegex(C1)).toBe("(?i)^(?:example login)$|(?:^site:example\\.com)");
  });
  it("escapes exact parts (. and +) and de-duplicates", () => {
    expect(exclusionRegex(["a.b+c", "A.B+C", "x y"])).toBe("(?i)^(?:a\\.b\\+c|x y)$");
  });
  it("joins several regexes and is null when empty", () => {
    expect(exclusionRegex(["/one/", "/two/"])).toBe("(?i)(?:one)|(?:two)");
    expect(exclusionRegex([])).toBeNull();
  });
});

describe("validateExclusions", () => {
  it("accepts the C1 example", () => {
    expect(validateExclusions(C1)).toBeNull();
  });
  it("rejects lookarounds with the documented wording", () => {
    expect(validateExclusions(["/(?=x)/"])).toBe(`"/(?=x)/" isn't a usable exclusion: lookarounds aren't supported (Search Console uses RE2).`);
    expect(validateExclusions(["/(?!x)/"])).toMatch(/lookarounds/);
    expect(validateExclusions(["/(?<=x)y/"])).toMatch(/lookarounds/);
    expect(validateExclusions(["/(?<!x)y/"])).toMatch(/lookarounds/);
  });
  it("rejects backreferences but allows an escaped backslash and class contents", () => {
    expect(validateExclusions(["/(a)\\1/"])).toMatch(/backreferences/);
    expect(validateExclusions(["/a\\\\1/"])).toBeNull();
    expect(validateExclusions(["/[(?=]x/"])).toBeNull();
  });
  it("rejects invalid regexes, empty items, long items and bad list sizes", () => {
    expect(validateExclusions(["/(/"])).toMatch(/valid regular expression/);
    expect(validateExclusions([" "])).toMatch(/is empty/);
    expect(validateExclusions(["x".repeat(201)])).toMatch(/longer than 200/);
    expect(validateExclusions([])).toMatch(/at least one/);
    expect(validateExclusions(Array.from({ length: 101 }, (_, i) => `q${i}`))).toMatch(/most allowed is 100/);
  });
  it("caps the combined expression at 4,000 characters", () => {
    const many = Array.from({ length: 30 }, (_, i) => `/${String(i).padStart(3, "0")}${"x".repeat(150)}/`);
    expect(validateExclusions(many)).toMatch(/-character expression/);
    expect(validateExclusions(many.slice(0, 20))).toBeNull();
  });
});

describe("isExcludedQuery", () => {
  it("matches exact queries ignoring case and spacing, and regexes anywhere in the query", () => {
    expect(isExcludedQuery("Example  Login", C1)).toBe(true);
    expect(isExcludedQuery("example login page", C1)).toBe(false);
    expect(isExcludedQuery("site:example.com pdf", C1)).toBe(true);
    expect(isExcludedQuery("my site:example.com", C1)).toBe(false);
  });
});

describe("catastrophic patterns (RE2JS, linear time)", () => {
  it("accepts a pattern that backtracks exponentially in V8 (Google's RE2 accepts it) and matches fast", async () => {
    const { validateExclusions, isExcludedQuery } = await import("../src/lib/gsc-exclusions.js");
    expect(validateExclusions(["/^([a-z ]+)+$/"])).toBeNull();
    const long = "a".repeat(5000) + "!";
    const t = performance.now();
    expect(isExcludedQuery(long, ["/^([a-z ]+)+$/"])).toBe(false);
    expect(isExcludedQuery("blue widgets near me", ["/^([a-z ]+)+$/"])).toBe(true);
    expect(performance.now() - t).toBeLessThan(100);
  });

  it("still rejects lookbehind and backreferences with a clear message", async () => {
    const { validateExclusions } = await import("../src/lib/gsc-exclusions.js");
    expect(validateExclusions(["/(?<=x)y/"])).toMatch(/lookarounds aren't supported/);
    expect(validateExclusions(["/(a)\\1/"])).toMatch(/backreferences aren't supported/);
  });
});
