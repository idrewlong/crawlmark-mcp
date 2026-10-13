/** docs/launch/blog-outline.md: a bold feature heading must start its own paragraph, or Markdown folds it into the bullet above. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("blog outline", () => {
  it("every bold heading line follows a blank line", () => {
    const lines = readFileSync(join(import.meta.dirname, "..", "docs", "launch", "blog-outline.md"), "utf8").split("\n");
    const merged = lines.flatMap((l, i) => (/^\*\*[^*]+\*\*/.test(l) && i > 0 && lines[i - 1]!.trim() !== "" ? [`${i + 1}: ${l.slice(0, 60)}`] : []));
    expect(merged).toEqual([]);
  });
});
