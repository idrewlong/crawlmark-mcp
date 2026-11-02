/** SEC-1: a page of large JSON-LD arrays must not cost CPU in extraction (the walk is linear and capped). */
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { extractPublished } from "../src/analysis/publish-date.js";

const page = (body: string) => cheerio.load(`<html><head>${Array.from({ length: 20 }, () => `<script type="application/ld+json">${body}</script>`).join("")}</head><body></body></html>`);
const shapes: [string, string][] = [
  ["flat numbers", `[${Array(49_000).fill(1).join(",")}]`],
  ["empty objects", `[${Array(33_000).fill("{}").join(",")}]`],
  ["empty arrays", `[${Array(33_000).fill("[]").join(",")}]`],
];

describe("extractPublished stays cheap on huge JSON-LD arrays", () => {
  for (const [name, body] of shapes) {
    it(`20 scripts of ${body.length} chars (${name}) finish in well under a second (the old quadratic walk took 2 to 4 s)`, () => {
      expect(body.length).toBeLessThanOrEqual(100_000);
      const $ = page(body);
      const t0 = performance.now();
      const r = extractPublished($, "https://example.com/post");
      const ms = performance.now() - t0;
      console.log(`SEC-1 ${name}: ${ms.toFixed(1)} ms`);
      expect(r).toBeNull();
      // About 15 to 110 ms alone; the bound leaves room for a loaded CI runner and still fails the quadratic walk.
      expect(ms).toBeLessThan(1000);
    });
  }
  it("still finds an Article within the node cap, in document order", () => {
    const $ = cheerio.load(`<script type="application/ld+json">[${Array(500).fill("{}").join(",")},{"@type":"Article","datePublished":"2020-01-02"},{"@type":"Article","datePublished":"2021-01-02"}]</script>`);
    expect(extractPublished($, "https://example.com/post")).toEqual({ date: "2020-01-02", source: "jsonld" });
  });
});
