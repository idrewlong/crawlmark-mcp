/** Release 0.5.0 Y0.5: page groups (C3): Search Console regexes, local matching and validation. */
import { RE2JS } from "re2js";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_GROUPS, defaultPageGroups, groupOf, groupRegex, groupsRegex, OTHER_GROUP, validatePageGroups, type PageGroup } from "../src/lib/page-groups.js";

const matches = (re: string, url: string) => RE2JS.compile(re).matcher(url).find();

describe("groupRegex", () => {
  it("escapes RE2 metacharacters in prefixes and anchors after the host", () => {
    const re = groupRegex({ name: "Odd", prefix: ["/a.b+c?/"] });
    expect(re).toBe("^https?://[^/]+(?:/a\\.b\\+c\\?/)");
    expect(matches(re, "https://example.com/a.b+c?/page")).toBe(true);
    expect(matches(re, "https://example.com/aXb+c/page")).toBe(false);
    expect(matches(re, "https://example.com/aab/c?/")).toBe(false);
    // A prefix is matched from the path's start, not anywhere in the URL.
    expect(matches(re, "https://example.com/x/a.b+c?/")).toBe(false);
  });

  it("wraps each regex so its own alternation stays anchored", () => {
    const re = groupRegex({ name: "Products", prefix: ["/shop/"], regex: ["/products/[^/]+/$", "/p/|/item/"] });
    expect(re).toBe("^https?://[^/]+(?:/shop/|(?:/products/[^/]+/$)|(?:/p/|/item/))");
    expect(matches(re, "https://www.example.com/products/widget/")).toBe(true);
    expect(matches(re, "https://www.example.com/products/widget/extra")).toBe(false);
    expect(matches(re, "https://example.com/item/9")).toBe(true);
    expect(matches(re, "https://example.com/blog/item/9")).toBe(false);
  });

  it("the default Home group matches / and /?a=1 but not /blog/", () => {
    const home = groupRegex(DEFAULT_PAGE_GROUPS[0]!);
    expect(matches(home, "https://example.com/")).toBe(true);
    expect(matches(home, "https://example.com/?a=1")).toBe(true);
    expect(matches(home, "http://www.example.com/")).toBe(true);
    expect(matches(home, "https://example.com/blog/")).toBe(false);
    expect(matches(home, "https://example.com/about")).toBe(false);
  });
});

describe("groupsRegex", () => {
  it("is one alternation of every group's parts", () => {
    const gs: PageGroup[] = [
      { name: "Blog", prefix: ["/blog/", "/news/"] },
      { name: "Product", regex: ["/products/[^/]+/$"] },
    ];
    expect(groupsRegex(gs)).toBe("^https?://[^/]+(?:/blog/|/news/|(?:/products/[^/]+/$))");
    expect(matches(groupsRegex(gs), "https://example.com/news/x")).toBe(true);
    expect(matches(groupsRegex(gs), "https://example.com/products/a/")).toBe(true);
    expect(matches(groupsRegex(gs), "https://example.com/contact")).toBe(false);
  });
});

describe("groupOf", () => {
  const groups = defaultPageGroups();
  it("returns the first matching group, else Other", () => {
    expect(groupOf("https://example.com/", groups)).toBe("Home");
    expect(groupOf("https://example.com/blog/water-heaters", groups)).toBe("Blog");
    expect(groupOf("https://www.example.com/services/emergency", groups)).toBe("Services");
    expect(groupOf("https://example.com/service-areas/north", groups)).toBe("Locations");
    expect(groupOf("https://example.com/contact", groups)).toBe(OTHER_GROUP);
    expect(groupOf("/blog/x", groups)).toBe("Blog");
  });

  it("first match wins when groups overlap", () => {
    const gs: PageGroup[] = [
      { name: "Guides", prefix: ["/blog/guides/"] },
      { name: "Blog", prefix: ["/blog/"] },
    ];
    expect(groupOf("https://example.com/blog/guides/a", gs)).toBe("Guides");
    expect(groupOf("https://example.com/blog/b", gs)).toBe("Blog");
    expect(groupOf("https://example.com/blog/guides/a", [...gs].reverse())).toBe("Blog");
  });

  it("defaultPageGroups is a copy", () => {
    const a = defaultPageGroups();
    a[1]!.prefix!.push("/x/");
    expect(DEFAULT_PAGE_GROUPS[1]!.prefix).not.toContain("/x/");
  });
});

describe("validatePageGroups", () => {
  const ok: PageGroup = { name: "Blog", prefix: ["/blog/"] };
  it("accepts the defaults and a valid list", () => {
    expect(validatePageGroups(DEFAULT_PAGE_GROUPS)).toBeNull();
    expect(validatePageGroups([ok, { name: "Product pages", regex: ["/products/[^/]+/$"] }])).toBeNull();
  });

  it.each([
    ["no groups", [], /at least one page group/],
    ["13 groups", Array.from({ length: 13 }, (_, i) => ({ name: `G${i}`, prefix: [`/g${i}/`] })), /13 page groups; the most allowed is 12/],
    ["a duplicate name in another case", [ok, { name: "BLOG", prefix: ["/b/"] }], /page group "BLOG" appears twice/],
    ["Other as a name", [{ name: "other", prefix: ["/o/"] }], /"Other" is the name for pages no group matches/],
    ["an empty group", [{ name: "Empty" }], /page group "Empty" needs at least one prefix or regex/],
    ["an empty name", [{ name: "  ", prefix: ["/a/"] }], /page group 1 has no name/],
    ["a long name", [{ name: "x".repeat(41), prefix: ["/a/"] }], /longer than 40 characters/],
    ["a control character in a name", [{ name: "Bl\u0007og", prefix: ["/a/"] }], /control or invisible characters in its name/],
    ["a * in a prefix", [{ name: "Wild", prefix: ["/blog/*"] }], /page group "Wild": the prefix "\/blog\/\*" has a "\*"/],
    ["a prefix without /", [{ name: "Rel", prefix: ["blog/"] }], /the prefix "blog\/" must start with "\/"/],
    ["21 prefixes", [{ name: "Many", prefix: Array.from({ length: 21 }, (_, i) => `/p${i}/`) }], /21 prefixes; the most allowed is 20/],
    ["a lookaround", [{ name: "Look", regex: ["/blog/(?!draft)"] }], /page group "Look": the regex "\/blog\/\(\?!draft\)" lookarounds aren't supported \(Search Console uses RE2\)/],
    ["a backreference", [{ name: "Back", regex: ["/(a)\\1/"] }], /backreferences aren't supported \(Search Console uses RE2\)/],
    ["a broken regex", [{ name: "Broken", regex: ["/blog/(" ]}], /isn't a valid regular expression/],
  ] as [string, PageGroup[], RegExp][])("rejects %s", (_name, groups, message) => {
    expect(validatePageGroups(groups)).toMatch(message);
  });

  it("rejects lists whose combined expression is over 4,000 characters", () => {
    const groups = Array.from({ length: 12 }, (_, i) => ({ name: `G${i}`, prefix: Array.from({ length: 20 }, (_, j) => `/${String(i).padStart(2, "0")}-${String(j).padStart(2, "0")}-${"a".repeat(10)}/`) }));
    expect(groupsRegex(groups).length).toBeGreaterThan(4000);
    expect(validatePageGroups(groups)).toMatch(/-character expression; Search Console accepts about 4000/);
  });
});
