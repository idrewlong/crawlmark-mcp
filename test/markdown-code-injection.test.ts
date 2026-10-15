import { describe, expect, it } from "vitest";
import { marked } from "marked";
import type { ReportDoc } from "../src/reports/render/doc.js";
import { markdownCode } from "../src/reports/render/escape.js";
import { toMarkdown } from "../src/reports/render/markdown.js";

const EVIL = "https://x.example/a\\|[click](https://evil.example)";

const doc = (value: string): ReportDoc => ({
  meta: { title: "T", clientName: "Example Co", domain: "example.com", templateTitle: "T", periodLabel: "September 2026", periodRange: "1-30 Sep 2026", generated: "13 Oct 2026", dataOnly: true, layout: "standard", runningHeader: "H" },
  badge: "Data-only report",
  kpis: [],
  sections: [{ id: "s", title: "Pages", blocks: [{ kind: "table", header: ["Page", "Clicks"], rows: [[[{ t: value }], [{ t: "5" }]]], numeric: [false, true] }] }],
  about: [],
  footer: "f",
  branding: { primaryColor: "#000000", accentColor: "#000000", paper: "Letter" },
});

describe("markdownCode backslash handling", () => {
  it("escapes backslashes before pipes", () => {
    expect(markdownCode("a\\|b")).toBe("`a\\\\\\|b`");
    expect(markdownCode("a\\b")).toBe("`a\\\\b`");
  });

  it("a backslash-pipe value in a table cell stays one code span and one cell (GFM parser)", () => {
    const md = toMarkdown(doc(EVIL));
    const html = marked.parse(md, { gfm: true, async: false });
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toContain("evil.example\"");
    const row = /<tbody>\s*<tr>([\s\S]*?)<\/tr>/.exec(html)![1]!;
    expect(row.match(/<td/g)).toHaveLength(2);
    expect(row).toContain("<code>");
  });

  it("plain pipes and trailing backslashes stay inside the cell", () => {
    for (const v of ["https://x.example/a|b", "https://x.example/a\\", "https://x.example/a\\\\|b"]) {
      const html = marked.parse(toMarkdown(doc(v)), { gfm: true, async: false });
      const row = /<tbody>\s*<tr>([\s\S]*?)<\/tr>/.exec(html)![1]!;
      expect(row.match(/<td/g)).toHaveLength(2);
    }
  });
});
