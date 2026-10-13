/** SEC-1 (Phase 12 C1 review): robots.txt wildcard matching is linear, with the same semantics as before. */
import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots, ROBOTS_MAX_BYTES, robotsPatternMatches, rulesFor } from "../src/analysis/robots.js";

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

/** The previous backtracking matcher, kept as the reference for the segment matcher (SEC-2). */
function referenceMatch(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const p = anchored ? pattern.slice(0, -1) : `${pattern}*`;
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (i < path.length) {
    if (j < p.length && p[j] !== "*" && p[j] === path[i]) {
      i++;
      j++;
    } else if (j < p.length && p[j] === "*") {
      star = j++;
      mark = i;
    } else if (star !== -1) {
      j = star + 1;
      i = ++mark;
    } else return false;
  }
  while (j < p.length && p[j] === "*") j++;
  return j === p.length;
}

describe("segment matcher (SEC-2)", () => {
  it("agrees with the previous matcher on 20,000 random patterns and paths", () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = (alphabet: string, len: number) => Array.from({ length: len }, () => alphabet[rnd(alphabet.length)]).join("");
    for (let k = 0; k < 20_000; k++) {
      const pattern = "/" + pick("ab*", rnd(7)) + (rnd(3) === 0 ? "$" : "");
      const path = "/" + pick("ab", rnd(9));
      expect(robotsPatternMatches(pattern, path), `${pattern} vs ${path}`).toBe(referenceMatch(pattern, path));
    }
  });

  it("isAllowed keeps longest-match and Allow-wins-a-tie with the early skip", () => {
    expect(isAllowed([{ allow: false, pattern: "/a" }, { allow: true, pattern: "/a" }], "/a")).toBe(true);
    expect(isAllowed([{ allow: true, pattern: "/a" }, { allow: false, pattern: "/a" }], "/a")).toBe(true);
    expect(isAllowed([{ allow: true, pattern: "/a" }, { allow: false, pattern: "/a/b" }], "/a/b")).toBe(false);
    expect(isAllowed([{ allow: false, pattern: "/a/b" }, { allow: true, pattern: "/a" }], "/a/b")).toBe(false);
    expect(isAllowed([{ allow: false, pattern: "/*" }, { allow: true, pattern: "/a$" }], "/a")).toBe(true);
  });

  it("reads only the first 500 KiB of robots.txt and drops exact duplicate rules", () => {
    const head = "User-agent: *\nDisallow: /early\n";
    const file = parseRobots(head + "#".repeat(ROBOTS_MAX_BYTES) + "\nUser-agent: *\nDisallow: /late\n");
    expect(file.truncated).toBe(true);
    expect(rulesFor(file, "x").rules.map((r) => r.pattern)).toEqual(["/early"]);
    expect(parseRobots(head).truncated).toBeUndefined();
  });

  it("drops a line cut by the cap instead of keeping a broader rule", () => {
    const filler = "# " + "x".repeat(ROBOTS_MAX_BYTES - 28) + "\n";
    const text = "User-agent: *\n" + filler + "Disallow: /private-area-that-crosses-the-cap\n";
    const file = parseRobots(text);
    expect(file.truncated).toBe(true);
    const { rules } = rulesFor(file, "googlebot");
    expect(isAllowed(rules, "/")).toBe(true);
    expect(rules.every((r) => r.pattern !== "/" && !r.pattern.includes("\uFFFD"))).toBe(true);
    expect(rulesFor(parseRobots("User-agent: *\nDisallow: /a\nDisallow: /a\nAllow: /a\n"), "x").rules).toHaveLength(2);
  });
});
