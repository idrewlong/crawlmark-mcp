/**
 * 0.4.0 T3c: the deck model (slide plan, condensation, speaker notes, the 50-slide cap). Fixture data only
 * (example.com); no network.
 */
import { describe, expect, it } from "vitest";
import { buildReportDoc, type Block, type DocNarrativeBlock, type DocSection, type Kpi, type LineChart, type ReportDoc, type TableBlock } from "../src/reports/render/doc.js";
import { buildDeck, condense, DECK, notesText, type DeckSlide } from "../src/reports/render/deck.js";
import { fixtureReport } from "./fixtures/reports/report.js";
import { layoutReport } from "./fixtures/reports/release-b-render.js";

const v = { version: "0.4.0" };
const R = (t: string) => [{ t }];
const p = (t: string): DocNarrativeBlock => ({ kind: "p", runs: R(t) });

const chart: LineChart = { type: "line", title: "Clicks", x: ["2026-09-01"], series: [{ name: "Clicks", values: [1], role: "current" }], format: "count", summary: "Clicks rose." };
const kpi = (n: number): Kpi => ({ label: `K${n}`, value: String(n) });
const table = (rows: number, cols = 3): TableBlock => ({
  kind: "table",
  header: Array.from({ length: cols }, (_, i) => `H${i}`),
  rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => R(`r${r}c${c}`))),
  numeric: Array.from({ length: cols }, (_, i) => i > 0),
});
const sec = (id: string, blocks: Block[], commentary?: DocNarrativeBlock[]): DocSection => ({ id, anchor: `s-${id}`, title: `Title ${id}`, blocks, ...(commentary ? { commentary } : {}) });

async function baseDoc(): Promise<ReportDoc> {
  return buildReportDoc(await fixtureReport(), v);
}
async function withSections(sections: DocSection[], patch: Partial<ReportDoc> = {}): Promise<ReportDoc> {
  const d = await baseDoc();
  delete d.contents;
  return { ...d, sections, ...patch };
}
const sectionSlides = (deck: { slides: DeckSlide[] }) => deck.slides.filter((s) => s.kind === "section");

describe("condense", () => {
  const c = (text: string, max = 5) => condense([p(text)], max);

  it("takes the first sentence of a paragraph", () => {
    expect(c("Clicks grew. Impressions fell.")).toEqual(["Clicks grew."]);
    expect(c("Is it up? Yes it is.")).toEqual(["Is it up?"]);
  });

  it("documents the abbreviation case: 'e.g. The' splits", () => {
    expect(c("We tried e.g. The old pages. Then more.")).toEqual(["We tried e.g."]);
  });

  it("keeps a sentence of exactly 140 characters and cuts 141 at a word boundary", () => {
    const words = (n: number) => {
      let s = "";
      while (s.length < n) s += (s ? " " : "") + "word";
      return s.slice(0, n).trimEnd();
    };
    const exact = "a".repeat(100) + " " + "b".repeat(39);
    expect(exact).toHaveLength(140);
    expect(c(exact)).toEqual([exact]);
    const long = "a".repeat(100) + " " + "b".repeat(40);
    expect(long).toHaveLength(141);
    expect(c(long)).toEqual(["a".repeat(100) + "…"]);
    // Trailing , ; : are stripped before the ellipsis.
    const comma = "a".repeat(98) + ", " + "b".repeat(50);
    expect(c(comma)).toEqual(["a".repeat(98) + "…"]);
    expect(c(words(300))[0]!.length).toBeLessThanOrEqual(DECK.maxBulletChars);
  });

  it("uses each list item, drops duplicates and empties, skips headings, tables and charts", () => {
    const blocks: DocNarrativeBlock[] = [
      { kind: "h", runs: R("Heading") },
      p("Same."),
      { kind: "ul", items: [R("Same."), R("Item one. Detail."), R("  "), R("Item two")] },
      { kind: "ol", start: 3, items: [R("Third")] },
      { kind: "table", header: [R("a")], rows: [[R("x")]], align: ["left"] },
      { kind: "chart", chart },
      { kind: "chartRef", section: "search", index: 1 },
    ];
    expect(condense(blocks, 10)).toEqual(["Same.", "Item one.", "Item two", "Third"]);
  });

  it("respects max and collapses whitespace and tag runs", () => {
    expect(condense([{ kind: "ul", items: [R("a"), R("b"), R("c")] }], 2)).toEqual(["a", "b"]);
    expect(condense([{ kind: "p", runs: [{ t: "Status" }, { t: "good", tag: "good" }, { t: "  now\n ok" }] }], 1)).toEqual(["Status good now ok"]);
    expect(condense([p("x")], 0)).toEqual([]);
  });
});

describe("notesText", () => {
  it("formats headings, paragraphs, lists, tables and charts, blocks separated by a blank line", () => {
    const blocks: DocNarrativeBlock[] = [
      { kind: "h", runs: R("What changed") },
      { kind: "p", runs: [{ t: "Clicks " }, { t: "grew", b: true }] },
      { kind: "ul", items: [R("one"), R("two")] },
      { kind: "ol", start: 3, items: [R("three"), R("four")] },
      { kind: "table", header: [R("Page"), R("Clicks")], rows: [[R("/a"), R("1")]], align: ["left", "right"] },
      { kind: "chart", chart },
    ];
    expect(notesText(blocks)).toBe("What changed\n\nClicks grew\n\n- one\n- two\n\n3. three\n4. four\n\nPage | Clicks\n/a | 1\n\n[Chart: Clicks]");
  });

  it("cuts at 12,000 characters with an ellipsis", () => {
    const out = notesText([p("x".repeat(20_000))]);
    expect(out).toHaveLength(DECK.maxNotesChars);
    expect(out.endsWith("…")).toBe(true);
    expect(notesText([p("short")])).toBe("short");
  });
});

describe("buildDeck: the monthly fixture", () => {
  it("starts with a title slide, ends with a closing slide, and carries client text only", async () => {
    const doc = buildReportDoc(await layoutReport(), { ...v, branding: { agencyName: "Example Agency" } });
    const deck = buildDeck(doc);
    expect(deck.slides[0]!.kind).toBe("title");
    expect(deck.slides.at(-1)!.kind).toBe("closing");
    expect(deck.slides[1]!.kind).toBe("agenda");
    expect(deck.warnings).toEqual([]);
    const title = deck.slides[0] as Extract<DeckSlide, { kind: "title" }>;
    expect(title.title).toBe(doc.meta.clientName);
    expect(title.kicker).toBe(doc.meta.templateTitle);
    expect(title.agencyName).toBe("Example Agency");
    expect(title.logo).toBe(false);
    const closing = deck.slides.at(-1) as Extract<DeckSlide, { kind: "closing" }>;
    expect(closing.lines.at(-1)).toBe(`Generated ${doc.meta.generated}`);
    expect(deck.meta.generatedAt).toBe("2026-10-13T00:00:00.000Z");
    expect(sectionSlides(deck).length).toBeGreaterThan(3);
  });

  it("matches the model snapshot (theme-agnostic)", async () => {
    const narrative = { summary: { client: "Clicks grew 17.6% in September. Impressions followed.\n\n- Update the services pages\n- Fix the broken links", internal: "internal only" }, sections: { search: "Search held up well. Position improved." } };
    const deck = buildDeck(buildReportDoc(await layoutReport(), { ...v, narrative }));
    expect(JSON.stringify(deck)).not.toContain("internal only");
    await expect(JSON.stringify(deck, null, 2) + "\n").toMatchFileSnapshot("fixtures/reports/__snapshots__/deck/monthly.json");
  });

  it("is deterministic", async () => {
    const doc = buildReportDoc(await layoutReport(), v);
    expect(JSON.stringify(buildDeck(doc))).toBe(JSON.stringify(buildDeck(doc)));
  });

  it("keeps white-label and hideProviders wording out of the deck, and internal notes never enter", async () => {
    const doc = buildReportDoc(await fixtureReport(), { ...v, branding: { hideCrawlmark: true, agencyName: "Example Agency" }, narrative: { summary: { client: "Clicks grew. More follows.", internal: "SECRET-INTERNAL-NOTE" }, internal: "SECRET-INTERNAL-NOTE" } });
    const json = JSON.stringify(buildDeck(doc));
    expect(json).not.toContain("SECRET-INTERNAL-NOTE");
    expect(json).not.toMatch(/crawlmark|dataforseo/i);
  });
});

describe("buildDeck: takeaways (action subtitles)", () => {
  const sections = (deck: { slides: DeckSlide[] }) => deck.slides.filter((s): s is Extract<DeckSlide, { kind: "section" }> => s.kind === "section");

  it("a section's takeaway is its commentary's first sentence, which then isn't a bullet as well", async () => {
    const doc = await withSections([sec("a", [{ kind: "chart", chart }], [p("Clicks rose on the service pages. Impressions followed."), { kind: "ul", items: [R("Keep the FAQ blocks"), R("Refresh the pricing post")] }])]);
    const s = sections(buildDeck(doc))[0]!;
    expect(s.takeaway).toBe("Clicks rose on the service pages.");
    expect(s.bullets).toEqual(["Keep the FAQ blocks", "Refresh the pricing post"]);
  });

  it("without commentary it is the chart's own summary (first sentence); a section with neither has none", async () => {
    const summary = { ...chart, summary: "Clicks are up for the third month in a row. Mostly from service pages." };
    const deck = buildDeck(await withSections([sec("a", [{ kind: "chart", chart: summary }, table(3)]), sec("b", [table(3)])]));
    const [a, b] = sections(deck);
    expect(a!.takeaway).toBe("Clicks are up for the third month in a row.");
    expect(b!.takeaway).toBeUndefined();
    expect(b!.bullets).toEqual([]);
  });

  it("the key numbers verdict is the summary's first point; a short agenda carries the section takeaways as descriptions", async () => {
    const d = await withSections([sec("a", [table(3)], [p("Alpha rose.")]), sec("b", [table(3)]), sec("c", [table(3)], [p("Gamma fell.")]), sec("d", [table(3)])]);
    const deck = buildDeck({ ...d, summary: { title: "Summary", caption: "", narrative: [p("Clicks grew 12%. More text."), { kind: "ul", items: [R("one")] }] } });
    const kpis = deck.slides.find((s) => s.kind === "kpis") as Extract<DeckSlide, { kind: "kpis" }>;
    expect(kpis.takeaway).toBe("Clicks grew 12%.");
    const agenda = deck.slides.find((s) => s.kind === "agenda") as Extract<DeckSlide, { kind: "agenda" }>;
    expect(agenda.details).toEqual(["Alpha rose.", "", "Gamma fell.", ""]);
    // A long agenda (a list, not a grid) has no descriptions.
    const long = await withSections(Array.from({ length: 8 }, (_, i) => sec(`s${i}`, [table(1)], [p(`Point ${i}.`)])));
    expect((buildDeck(long).slides.find((s) => s.kind === "agenda") as Extract<DeckSlide, { kind: "agenda" }>).details).toBeUndefined();
  });

  it("takeaways are client text only: never internal notes, and white-label wording is already applied", async () => {
    const narrative = {
      summary: { client: "Clicks grew 17.6% in September. Impressions followed.", internal: "SECRET-INTERNAL-NOTE summary." },
      sections: { search: { client: "Search held up well. Position improved.", internal: "SECRET-INTERNAL-NOTE search." } },
      internal: "SECRET-INTERNAL-NOTE general.",
    };
    const doc = buildReportDoc(await fixtureReport(), { ...v, branding: { hideCrawlmark: true, agencyName: "Example Agency" }, narrative });
    const deck = buildDeck(doc);
    const takeaways = deck.slides.flatMap((s) => (s.kind === "section" || s.kind === "kpis") && s.takeaway ? [s.takeaway] : []);
    const details = deck.slides.flatMap((s) => (s.kind === "agenda" ? (s.details ?? []) : []));
    expect(takeaways).toContain("Search held up well.");
    expect(takeaways).toContain("Clicks grew 17.6% in September.");
    for (const t of [...takeaways, ...details]) {
      expect(t).not.toContain("SECRET-INTERNAL-NOTE");
      expect(t).not.toMatch(/crawlmark|dataforseo|claude/i);
    }
    // Every takeaway is text the client's report already shows: commentary or a chart summary.
    const docText = JSON.stringify(doc);
    for (const t of takeaways) expect(docText).toContain(t.replace(/…$/, ""));
  });
});

describe("buildDeck: meta", () => {
  it("author is crawlmark, or the agency name (or empty) with hideCrawlmark", async () => {
    const d = await baseDoc();
    expect(buildDeck(d).meta.author).toBe("crawlmark");
    expect(buildDeck({ ...d, branding: { ...d.branding, hideCrawlmark: true, agencyName: "Example Agency" } }).meta).toMatchObject({ author: "Example Agency", company: "Example Agency" });
    const { agencyName: _a, ...rest } = { ...d.branding, agencyName: undefined };
    expect(buildDeck({ ...d, branding: { ...rest, hideCrawlmark: true } }).meta).toMatchObject({ author: "", company: "" });
    expect(buildDeck(d).meta).toMatchObject({ title: d.meta.title, subject: d.meta.templateTitle });
  });
});

describe("buildDeck: the slide plan", () => {
  it("chart + table + commentary: two slides, chart and bullets first, the table (8 rows) on the continuation", async () => {
    const doc = await withSections([sec("a", [{ kind: "chart", chart }, table(20)], [p("One. Two."), p("Three"), p("Four")])]);
    const slides = sectionSlides(buildDeck(doc)) as Extract<DeckSlide, { kind: "section" }>[];
    expect(slides).toHaveLength(2);
    // The first commentary sentence is the takeaway (under the title), not a bullet as well.
    expect(slides[0]).toMatchObject({ continued: false, number: 1, takeaway: "One.", bullets: ["Three", "Four"], notes: "One. Two.\n\nThree\n\nFour" });
    expect(slides[0]!.chart).toBeDefined();
    expect(slides[0]!.table).toBeUndefined();
    expect(slides[1]).toMatchObject({ title: "Title a (continued)", continued: true, bullets: [] });
    expect(slides[1]!.table!.rows).toHaveLength(8);
    expect(slides[1]!.table).toMatchObject({ shown: 8, total: 20 });
    expect(slides[1]!.footnotes).toEqual(["Top 8 of 20 rows; the full table is in the report."]);
    expect(slides[1]!.notes).toBeUndefined();
  });

  it("chart + table without commentary or KPIs: one slide, five rows", async () => {
    const doc = await withSections([sec("a", [{ kind: "chart", chart }, table(7)])]);
    const slides = sectionSlides(buildDeck(doc)) as Extract<DeckSlide, { kind: "section" }>[];
    expect(slides).toHaveLength(1);
    expect(slides[0]!.table!.rows).toHaveLength(5);
    expect(slides[0]!.footnotes).toEqual(["Top 5 of 7 rows; the full table is in the report."]);
  });

  it("chart + KPIs without commentary: the tiles (at most four) go in the side panel", async () => {
    const doc = await withSections([sec("a", [{ kind: "chart", chart }, { kind: "kpiRow", items: [1, 2, 3, 4, 5, 6].map(kpi) }])]);
    const s = sectionSlides(buildDeck(doc))[0] as Extract<DeckSlide, { kind: "section" }>;
    expect(s.tiles).toHaveLength(4);
    expect(s.footnotes).toEqual([DECK_MORE]);
  });

  it("finds the chart inside columns", async () => {
    const doc = await withSections([sec("a", [{ kind: "columns", columns: [[{ kind: "chart", chart }], [table(2)]] }])]);
    const slides = sectionSlides(buildDeck(doc)) as Extract<DeckSlide, { kind: "section" }>[];
    expect(slides).toHaveLength(1);
    expect(slides[0]!.chart).toBeDefined();
    expect(slides[0]!.table!.rows).toHaveLength(2);
  });

  it("table-only: eight rows, six columns, cells cut at 60 characters, numeric kept, commentary beside it", async () => {
    const wide = table(10, 8);
    wide.rows[0]![0] = R("x".repeat(80));
    wide.rows[1]![1] = [{ t: "Gain" }, { t: "good", tag: "good" }];
    const doc = await withSections([sec("a", [wide], [p("Note.")])]);
    const s = sectionSlides(buildDeck(doc))[0] as Extract<DeckSlide, { kind: "section" }>;
    expect(s.table!.header).toHaveLength(6);
    expect(s.table!.rows).toHaveLength(8);
    expect(s.table!.numeric).toEqual([false, true, true, true, true, true]);
    expect(s.table!.rows[0]![0]).toBe("x".repeat(59) + "…");
    expect(s.table!.rows[1]![1]).toBe("Gain good");
    expect(s.takeaway).toBe("Note.");
    expect(s.bullets).toEqual([]);
    expect(s.footnotes).toEqual(["Top 8 of 10 rows; the full table is in the report."]);
  });

  it("KPI-only: tiles full width (at most eight), commentary below", async () => {
    const doc = await withSections([sec("a", [{ kind: "kpiRow", items: Array.from({ length: 10 }, (_, i) => kpi(i)) }], [p("Fine.")])]);
    const s = sectionSlides(buildDeck(doc))[0] as Extract<DeckSlide, { kind: "section" }>;
    expect(s.tiles).toHaveLength(8);
    expect(s.takeaway).toBe("Fine.");
    expect(s.bullets).toEqual([]);
    expect(s.footnotes).toEqual([DECK_MORE]);
  });

  it("text section: paragraphs and list items become bullets (at most five, 140 characters)", async () => {
    const doc = await withSections([sec("a", [{ kind: "paragraph", text: R("First. Second.") }, { kind: "list", items: Array.from({ length: 8 }, (_, i) => R(`item ${i}`)) }])]);
    const s = sectionSlides(buildDeck(doc))[0] as Extract<DeckSlide, { kind: "section" }>;
    expect(s.bullets).toEqual(["First.", "item 0", "item 1", "item 2", "item 3"]);
    expect(s.footnotes).toEqual([DECK_MORE]);
  });

  it("a `block` section becomes text slides: six bullets each, at most two slides, full text in the first slide's notes", async () => {
    const many = Array.from({ length: 20 }, (_, i) => p(`Point ${i}.`));
    const doc = await withSections([sec("g", [{ kind: "rich", blocks: many }]), sec("h", [{ kind: "rich", blocks: [p("Only one.")] }])]);
    const deck = buildDeck(doc);
    const text = deck.slides.filter((s): s is Extract<DeckSlide, { kind: "text" }> => s.kind === "text");
    expect(text.map((s) => [s.title, s.continued, s.bullets.length])).toEqual([["Title g", false, 6], ["Title g (continued)", true, 6], ["Title h", false, 1]]);
    expect(text[0]!.notes).toContain("Point 19.");
    expect(sectionSlides(deck)).toHaveLength(0);
  });

  it("keeps a 'Source:' note as a footnote; other remarks and sub-headings don't add the 'more detail' line", async () => {
    const doc = await withSections([sec("a", [table(2), { kind: "heading", level: 3, text: "Sub" }, { kind: "note", text: R("Source: Ahrefs. Figures as of 1 Oct 2026.") }, { kind: "note", text: R("Other remark") }])]);
    const s = sectionSlides(buildDeck(doc))[0] as Extract<DeckSlide, { kind: "section" }>;
    expect(s.footnotes).toEqual(["Source: Ahrefs. Figures as of 1 Oct 2026."]);
  });

  it("summary: narrative bullets and notes, else plain item text; closing notes are the About lines", async () => {
    const d = await baseDoc();
    const withNarrative = buildDeck({ ...d, summary: { title: "Summary", caption: "cap", narrative: [p("Alpha. Beta."), { kind: "ul", items: [R("one")] }] }, sections: [] });
    expect(withNarrative.slides.find((s) => s.kind === "summary")).toEqual({ kind: "summary", title: "Summary", bullets: ["Alpha.", "one"], caption: "cap", notes: "Alpha. Beta.\n\n- one" });
    const items = buildDeck({ ...d, summary: { title: "Highlights", caption: "", items: Array.from({ length: 8 }, (_, i) => R(`h${i}`)) }, sections: [] });
    const sum = items.slides.find((s) => s.kind === "summary") as Extract<DeckSlide, { kind: "summary" }>;
    expect(sum.bullets).toEqual(["h0", "h1", "h2", "h3", "h4"]);
    expect(sum.caption).toBeUndefined();
    const closing = items.slides.at(-1) as Extract<DeckSlide, { kind: "closing" }>;
    expect(closing.notes).toBe(d.about.map((a) => a.map((r) => r.t).join("")).join("\n"));
    const none = buildDeck({ ...d, summary: undefined, kpis: [], sections: [] });
    expect(none.slides.map((s) => s.kind)).toEqual(["title", "closing"]);
  });
});

describe("buildDeck: the agenda", () => {
  const nSections = (n: number) => Array.from({ length: n }, (_, i) => sec(`s${i}`, [table(1)]));
  const kinds = (d: { slides: DeckSlide[] }) => d.slides.map((s) => s.kind);

  it("is absent with three sections and no contents", async () => {
    expect(kinds(buildDeck(await withSections(nSections(3))))).not.toContain("agenda");
  });
  it("is present with four sections, listing their titles", async () => {
    const deck = buildDeck(await withSections(nSections(4)));
    expect(deck.slides[1]).toEqual({ kind: "agenda", title: "Agenda", items: ["Title s0", "Title s1", "Title s2", "Title s3"] });
  });
  it("is present with contents: true, and continuation slides are not listed twice", async () => {
    const d = await withSections([sec("a", [{ kind: "chart", chart }, table(9)], [p("x")])], { contents: [{ anchor: "s-a", title: "Title a" }] });
    const deck = buildDeck(d);
    expect(deck.slides[1]).toMatchObject({ kind: "agenda", items: ["Title a"] });
  });
});

const DECK_MORE = "More detail in the full report.";

describe("buildDeck: the 50-slide cap", () => {
  it("drops continuation slides, then text slides, then sections from the end, and rebuilds the agenda", async () => {
    // 40 chart+table sections (80 slides) and 10 two-slide text blocks (20), plus the fixed slides.
    const sections = [
      ...Array.from({ length: 40 }, (_, i) => sec(`s${i}`, [{ kind: "chart", chart }, table(9)], [p("c."), p("d")])),
      ...Array.from({ length: 10 }, (_, i) => sec(`t${i}`, [{ kind: "rich", blocks: Array.from({ length: 9 }, (_, j) => p(`P${j}.`)) }])),
    ];
    const deck = buildDeck(await withSections(sections));
    expect(deck.slides).toHaveLength(50);
    expect(deck.slides.some((s) => (s.kind === "section" || s.kind === "text") && s.continued)).toBe(false);
    expect(sectionSlides(deck)).toHaveLength(40);
    const fixed = deck.slides.length - 40 - deck.slides.filter((s) => s.kind === "text").length;
    const textLeft = 50 - fixed - 40;
    expect(deck.slides.filter((s) => s.kind === "text").map((s) => s.title)).toEqual(Array.from({ length: textLeft }, (_, i) => `Title t${i}`));
    const agenda = deck.slides.find((s) => s.kind === "agenda") as Extract<DeckSlide, { kind: "agenda" }>;
    expect(agenda.items).toHaveLength(40 + textLeft);
    expect(agenda.items.at(-1)).toBe(`Title t${textLeft - 1}`);
    expect(deck.warnings).toHaveLength(1);
    expect(deck.warnings[0]).toMatch(/^Deck: \d+ slide\(s\) left out to stay within 50: Title s0 \(continued\), /);
    expect(deck.warnings[0]).toContain("Title t9");
    expect(deck.warnings[0]).not.toContain("Title t0,");
    expect(deck.warnings[0]!.endsWith(". They're in the full report.")).toBe(true);
  });

  it("removes sections from the end when continuations and text slides are not enough", async () => {
    const sections = Array.from({ length: 60 }, (_, i) => sec(`s${i}`, [table(1)]));
    const deck = buildDeck(await withSections(sections));
    expect(deck.slides).toHaveLength(50);
    expect(deck.slides[0]!.kind).toBe("title");
    expect(deck.slides.at(-1)!.kind).toBe("closing");
    const left = sectionSlides(deck);
    expect(left.length).toBeLessThan(60);
    expect(left.at(-1)!.title).toBe(`Title s${left.length - 1}`);
    const agenda = deck.slides.find((s) => s.kind === "agenda") as Extract<DeckSlide, { kind: "agenda" }>;
    expect(agenda.items).toEqual(left.map((s) => s.title));
    expect(deck.warnings[0]).toContain(`Title s59`);
    expect(deck.warnings[0]).toMatch(/^Deck: \d+ slide\(s\) left out to stay within 50: /);
  });

  it("makes no warning at or under 50 slides", async () => {
    const deck = buildDeck(await withSections(Array.from({ length: 5 }, (_, i) => sec(`s${i}`, [table(1)]))));
    expect(deck.warnings).toEqual([]);
  });
});
