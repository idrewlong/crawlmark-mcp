/** SEC-1 (Phase 12 C1 review): robots.txt wildcard matching is linear, with the same semantics as before. */
import { describe, expect, it } from "vitest";
import { isAllowed, robotsPatternMatches } from "../src/analysis/robots.js";

describe("robotsPatternMatches", () => {
  it("prefix, wildcard and $ semantics", () => {
    expect(robotsPatternMatches("/private", "/private/a")).toBe(true);
    expect(robotsPatternMatches("/private", "/priv")).toBe(false);
    expect(robotsPatternMatches("/*.pdf$", "/a/doc.pdf")).toBe(true);
    expect(robotsPatternMatches("/*.pdf$", "/a/doc.pdf?x=1")).toBe(false);
    expect(robotsPatternMatches("/a*b*c", "/axxbyyczz")).toBe(true);
    expect(robotsPatternMatches("/a*b*c", "/axxbyy")).toBe(false);
    expect(robotsPatternMatches("*", "/")).toBe(true);
    expect(robotsPatternMatches("/$", "/")).toBe(true);
    expect(robotsPatternMatches("/$", "/a")).toBe(false);
    expect(robotsPatternMatches("/a.b+(c)", "/a.b+(c)/d")).toBe(true);
    expect(robotsPatternMatches("/a.b", "/axb")).toBe(false);
  });

  it("30 wildcards against a 2,000-character path finish in well under 50 ms", () => {
    const pattern = "/" + "a*".repeat(30) + "b$";
    const path = "/" + "a".repeat(2000);
    const t = performance.now();
    expect(robotsPatternMatches(pattern, path)).toBe(false);
    expect(isAllowed([{ allow: false, pattern }], path)).toBe(true);
    expect(performance.now() - t).toBeLessThan(50);
  });
});
