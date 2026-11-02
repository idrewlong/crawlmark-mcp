/** Release B1: commentary format and limits (B-C4). */
import { describe, expect, it } from "vitest";
import { MAX_INTERNAL_CHARS, MAX_NARRATIVE_CHARS, MAX_NARRATIVE_FIELD, parseNarrative, validateNarrative } from "../src/reports/render/narrative.js";

const ids = ["search", "brand", "traffic", "opportunities", "audit"];
const text = (n: number) => "x".repeat(n);

describe("limits", () => {
  it("accepts a 57,000-character narrative (summary 15,000 plus four sections around 10,500)", () => {
    const n = { summary: text(15_000), sections: { search: text(10_500), brand: text(10_500), traffic: text(10_500), opportunities: text(10_500) } };
    expect(() => validateNarrative(n, ids)).not.toThrow();
  });

  it("the constants are the spec's", () => {
    expect([MAX_NARRATIVE_CHARS, MAX_INTERNAL_CHARS, MAX_NARRATIVE_FIELD]).toEqual([100_000, 50_000, 20_000]);
  });

  it("accepts an 18,000-character field and rejects 20,001 naming the field", () => {
    expect(() => validateNarrative({ sections: { search: text(18_000) } }, ids)).not.toThrow();
    expect(() => validateNarrative({ sections: { search: text(20_001) } }, ids)).toThrow(/narrative\.sections\.search/);
    expect(() => validateNarrative({ summary: text(20_001) }, ids)).toThrow(/narrative\.summary/);
    expect(() => validateNarrative({ internal: text(20_001) }, ids)).toThrow(/narrative\.internal/);
    expect(() => validateNarrative({ sections: { search: { client: "a", internal: text(20_001) } } }, ids)).toThrow(/narrative\.sections\.search\.internal/);
  });

  it("rejects a client total over 100,000 and an internal total over 50,000", () => {
    const client = { summary: text(20_000), sections: { search: text(20_000), brand: text(20_000), traffic: text(20_000), opportunities: text(20_000), audit: text(1) } };
    expect(() => validateNarrative(client, ids)).toThrow(/100,?000/);
    expect(() => validateNarrative({ ...client, sections: { ...client.sections, audit: text(0) } }, ids)).not.toThrow();
    const internal = { internal: text(20_000), sections: { search: { internal: text(20_000) }, brand: { internal: text(10_001) } } };
    expect(() => validateNarrative(internal, ids)).toThrow(/internal.*50,?000/);
  });

  it("internal text does not count towards the client total", () => {
    const n = { summary: { client: text(20_000), internal: text(20_000) }, sections: { search: text(20_000) } };
    expect(() => validateNarrative(n, ids)).not.toThrow();
  });

  it("rejects section ids that aren't sections, and chart references to such ids", () => {
    expect(() => validateNarrative({ sections: { nope: "x" } }, ids)).toThrow(/nope/);
    expect(() => validateNarrative({ summary: "{{chart nope}}" }, ids)).toThrow(/narrative\.summary.*nope/);
    expect(() => validateNarrative({ sections: { search: "{{chart brand 2}}" } }, ids)).not.toThrow();
  });

  it("rejects tables over the column and row limits with the field name", () => {
    const wide = `| ${Array.from({ length: 13 }, (_, i) => `c${i}`).join(" | ")} |\n| ${Array.from({ length: 13 }, () => "---").join(" | ")} |\n`;
    expect(() => validateNarrative({ sections: { search: wide } }, ids)).toThrow("narrative.sections.search: a table has 13 columns; at most 12");
    const tall = `| a |\n| --- |\n${"| x |\n".repeat(201)}`;
    expect(() => validateNarrative({ summary: tall }, ids)).toThrow(/narrative\.summary: a table has 201 rows; at most 200/);
  });
});

const p = (s: string) => parseNarrative(s);
const flat = (runs: { t: string }[]) => runs.map((r) => r.t).join("");

describe("parser", () => {
  it("## and ### and #### are sub-headings (bold allowed); a single # stays literal", () => {
    expect(p("### Heading")).toEqual([{ kind: "h", runs: [{ t: "Heading" }] }]);
    expect(p("## A **b** c")).toEqual([{ kind: "h", runs: [{ t: "A " }, { t: "b", b: true }, { t: " c" }] }]);
    expect(p("#### Deep")[0]).toMatchObject({ kind: "h" });
    expect(p("# Title")).toEqual([{ kind: "p", runs: [{ t: "# Title" }] }]);
    expect(p("##### Five")).toEqual([{ kind: "p", runs: [{ t: "##### Five" }] }]);
    expect(p("##NoSpace")[0]).toMatchObject({ kind: "p" });
  });

  it("a heading ends the paragraph before it", () => {
    const b = p("Intro line\n## Next\nafter");
    expect(b.map((x) => x.kind)).toEqual(["p", "h", "p"]);
  });

  it("numbered lists: start and consecutive items join", () => {
    expect(p("1. a\n2. b")).toEqual([{ kind: "ol", start: 1, items: [[{ t: "a" }], [{ t: "b" }]] }]);
    expect(p("3) x\n4) y")).toEqual([{ kind: "ol", start: 3, items: [[{ t: "x" }], [{ t: "y" }]] }]);
    expect(p("1. a\n\n2. b").map((x) => x.kind)).toEqual(["ol", "ol"]);
  });

  it("a bullet list directly followed by a numbered list makes two lists", () => {
    expect(p("- a\n1. b").map((x) => x.kind)).toEqual(["ul", "ol"]);
  });

  it("bullets and bold are unchanged", () => {
    expect(p("- a\n* b **bold**")).toEqual([{ kind: "ul", items: [[{ t: "a" }], [{ t: "b " }, { t: "bold", b: true }]] }]);
    expect(p("**Bold** start line")).toEqual([{ kind: "p", runs: [{ t: "Bold", b: true }, { t: " start line" }] }]);
  });

  it("pipe table: alignment, escaped pipe, short row padded", () => {
    const [t] = p("| Name | Clicks |\n| :--- | ---: |\n| a \\| b | **12** |\n| short |\n");
    expect(t).toMatchObject({ kind: "table", align: ["left", "right"] });
    if (t?.kind !== "table") throw new Error("not a table");
    expect(t.header.map(flat)).toEqual(["Name", "Clicks"]);
    expect(t.rows).toHaveLength(2);
    expect(flat(t.rows[0]![0]!)).toBe("a | b");
    expect(t.rows[0]![1]).toEqual([{ t: "12", b: true }]);
    expect(t.rows[1]!.map(flat)).toEqual(["short", ""]);
  });

  it("a table ends at the first line that doesn't start with a pipe", () => {
    const b = p("| a |\n| --- |\n| 1 |\nafter");
    expect(b.map((x) => x.kind)).toEqual(["table", "p"]);
  });

  it("a pipe line without a separator is a paragraph", () => {
    expect(p("| not | a table |")).toEqual([{ kind: "p", runs: [{ t: "| not | a table |" }] }]);
  });

  it("chart references", () => {
    expect(p("{{chart search}}")).toEqual([{ kind: "chartRef", section: "search", index: 1 }]);
    expect(p("{{chart search 2}}")).toEqual([{ kind: "chartRef", section: "search", index: 2 }]);
    expect(p("see {{chart search}} here")[0]).toMatchObject({ kind: "p" });
    expect(p("{{chart search 10}}")[0]).toMatchObject({ kind: "p" });
  });

  it("a markup-looking cell stays literal text (inert for the renderers)", () => {
    const [t] = p("| <script>alert(1)</script> |\n| --- |\n| <img src=x onerror=1> |");
    if (t?.kind !== "table") throw new Error("not a table");
    expect(flat(t.header[0]!)).toBe("<script>alert(1)</script>");
  });

  it("control characters are stripped first", () => {
    expect(p("a\u0000b")).toEqual([{ kind: "p", runs: [{ t: "ab" }] }]);
  });
});
