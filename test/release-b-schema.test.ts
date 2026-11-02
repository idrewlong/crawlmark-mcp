import { describe, expect, it } from "vitest";
import { validateTemplateText, SECTION_CATALOGUE, SECTION_TITLES, SECTION_TYPES, COVER_FIELDS, MAX_BLOCK_CHARS, TemplateFileSchema } from "../src/reports/templates/schema.js";
import { DEFAULT_SECTION_IDS } from "../src/reports/templates/builder.js";

const TODAY = new Date("2026-10-13T12:00:00Z");
const v = (yaml: string, opts: { knownBlocks?: ReadonlySet<string> } = {}) => validateTemplateText(yaml, { today: TODAY, ...opts });
const file = (extra: string, sections = "      - { id: search, type: search_overview }") => `version: 1\n${extra}\ntemplates:\n  t:\n    title: T\n    sections:\n${sections}\n`;
const withTemplate = (tpl: string) => `version: 1\ntemplates:\n  t:\n    title: T\n${tpl}\n    sections:\n      - { id: search, type: search_overview }\n      - { id: pages, type: top_pages }\n`;
const msgs = (r: { errors: { path: string; message: string }[] }) => r.errors.map((e) => `${e.path}: ${e.message}`);

describe("Release B file: the full new shape", () => {
  it("accepts cover, contents, pageBreakBefore, a block section and file-level blocks", () => {
    const r = v(`version: 1
blocks:
  glossary:
    title: Glossary
    text: "**CTR** is click-through rate."
templates:
  t:
    title: T
    contents: true
    cover:
      subtitle: Monthly SEO review
      preparedFor: Jane Doe, Example Co
      preparedBy: Example Agency
      fields: [preparedFor, period, generated]
    sections:
      - { id: search, type: search_overview }
      - { id: gloss, type: block, block: glossary, pageBreakBefore: true }
`);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.value?.blocks?.glossary?.title).toBe("Glossary");
  });
});

describe("cover", () => {
  it("accepts every cover field and rejects an unknown one", () => {
    expect(COVER_FIELDS).toEqual(["domain", "period", "compare", "generated", "preparedFor", "preparedBy", "badge"]);
    expect(v(withTemplate("    cover: { fields: [domain, period, compare, generated, badge] }")).valid).toBe(true);
    expect(msgs(v(withTemplate("    cover: { fields: [logo] }"))).join("\n")).toMatch(/cover\.fields\[0\]/);
  });
  it("rejects unknown cover keys, an empty fields list, more than seven, and over-long text", () => {
    expect(v(withTemplate("    cover: { colour: red }")).errors[0]?.message).toMatch(/unknown field "colour"/);
    expect(v(withTemplate("    cover: { fields: [] }")).valid).toBe(false);
    expect(v(withTemplate(`    cover: { subtitle: "${"x".repeat(161)}" }`)).valid).toBe(false);
    expect(v(withTemplate(`    cover: { preparedFor: "${"x".repeat(121)}" }`)).valid).toBe(false);
    expect(v(withTemplate(`    cover: { subtitle: "${"x".repeat(160)}" }`)).valid).toBe(true);
  });
  it("rejects control characters in cover text", () => {
    expect(v(withTemplate('    cover: { subtitle: "a\\u202Eb" }')).valid).toBe(false);
  });
  it("rejects duplicate cover fields", () => {
    const r = v(withTemplate("    cover: { fields: [period, period] }"));
    expect(msgs(r)).toContain("templates.t.cover.fields: entries must be unique");
  });
  it("needs a value for preparedFor / preparedBy when they are listed", () => {
    const r = v(withTemplate("    cover: { fields: [preparedFor, preparedBy] }"));
    expect(msgs(r)).toEqual([
      "templates.t.cover.fields: cover.fields lists preparedFor but cover.preparedFor isn't set",
      "templates.t.cover.fields: cover.fields lists preparedBy but cover.preparedBy isn't set",
    ]);
    expect(v(withTemplate("    cover: { preparedFor: Jane, fields: [preparedFor] }")).valid).toBe(true);
  });
  it("contents is a boolean", () => {
    expect(v(withTemplate("    contents: true")).valid).toBe(true);
    expect(v(withTemplate("    contents: yes please")).valid).toBe(false);
  });
});

describe("pageBreakBefore", () => {
  it("is an optional boolean on every section", () => {
    expect(v(file("", "      - { id: search, type: search_overview, pageBreakBefore: true }\n      - { id: pages, type: top_pages, pageBreakBefore: false }")).valid).toBe(true);
    expect(v(file("", "      - { id: search, type: search_overview, pageBreakBefore: 1 }")).valid).toBe(false);
  });
  it("warns for a page break before the first section, and for onepage layouts", () => {
    const first = v(file("", "      - { id: search, type: search_overview, pageBreakBefore: true }"));
    expect(first.valid).toBe(true);
    expect(first.warnings.map((w) => w.message)).toContain("a page break before the first section does nothing");
    const one = v(`version: 1\ntemplates:\n  t:\n    title: T\n    layout: onepage\n    contents: true\n    sections:\n      - { id: search, type: search_overview }\n      - { id: pages, type: top_pages, pageBreakBefore: true }\n`);
    expect(one.valid).toBe(true);
    expect(one.warnings.map((w) => w.message)).toContain("onepage reports ignore contents and page breaks");
    // Only once per template.
    expect(one.warnings.filter((w) => /onepage/.test(w.message))).toHaveLength(1);
  });
  it("does not warn for a plain onepage template or a standard one with page breaks after the first section", () => {
    expect(v(`version: 1\ntemplates:\n  t:\n    title: T\n    layout: onepage\n    sections:\n      - { id: search, type: search_overview }\n`).warnings).toEqual([]);
    expect(v(file("", "      - { id: search, type: search_overview }\n      - { id: pages, type: top_pages, pageBreakBefore: true }")).warnings).toEqual([]);
  });
});

describe("blocks and block sections", () => {
  it("registers the block type everywhere the catalogue lists types", () => {
    expect(SECTION_TYPES).toContain("block");
    expect(SECTION_TITLES.block).toBe("Note");
    expect(SECTION_CATALOGUE.block).toMatchObject({ group: "other", cost: "free" });
    expect(DEFAULT_SECTION_IDS.block).toBe("block");
  });
  it("limits block text, title and the number of blocks", () => {
    expect(MAX_BLOCK_CHARS).toBe(20_000);
    const ok = (text: string) => TemplateFileSchema.safeParse({ version: 1, blocks: { a: { text } } }).success;
    expect(ok("x".repeat(20_000))).toBe(true);
    expect(ok("x".repeat(20_001))).toBe(false);
    expect(ok("")).toBe(false);
    expect(TemplateFileSchema.safeParse({ version: 1, blocks: { a: { title: "x".repeat(121), text: "t" } } }).success).toBe(false);
    expect(TemplateFileSchema.safeParse({ version: 1, blocks: {} }).success).toBe(false);
    expect(TemplateFileSchema.safeParse({ version: 1, blocks: { "Bad Id": { text: "t" } } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`b${i}`, { text: "t" }]));
    expect(TemplateFileSchema.safeParse({ version: 1, blocks: many }).success).toBe(false);
    expect(TemplateFileSchema.safeParse({ version: 1, blocks: { a: { text: "t", colour: "red" } } }).success).toBe(false);
  });
  it("rejects control characters in block text but keeps newlines", () => {
    expect(TemplateFileSchema.safeParse({ version: 1, blocks: { a: { text: "one\n\ntwo\tthree" } } }).success).toBe(true);
    expect(TemplateFileSchema.safeParse({ version: 1, blocks: { a: { text: "a\u202Eb" } } }).success).toBe(false);
  });
  it("errors on a block section that names an unknown block", () => {
    const r = v(file("", "      - { id: note, type: block, block: glossary }"));
    expect(msgs(r)).toEqual([`templates.t.sections[0].block: no block "glossary" in this file or the global template file`]);
  });
  it("passes when the block is in this file or in knownBlocks", () => {
    const sec = "      - { id: note, type: block, block: glossary }";
    expect(v(file("blocks:\n  glossary: { text: Hi }", sec)).valid).toBe(true);
    expect(v(file("", sec), { knownBlocks: new Set(["glossary"]) }).valid).toBe(true);
    expect(v(file("", sec), { knownBlocks: new Set(["other"]) }).valid).toBe(false);
  });
  it("requires a valid block id on a block section", () => {
    expect(v(file("", "      - { id: note, type: block }")).valid).toBe(false);
    expect(v(file("", "      - { id: note, type: block, block: Bad Id }")).valid).toBe(false);
  });
});

describe("branding additions", () => {
  const b = (line: string) => v(`version: 1\nbranding:\n  ${line}\n`);
  it("accepts plain font family names", () => {
    expect(b("bodyFont: Inter").valid).toBe(true);
    expect(b("bodyFont: Source Sans 3").valid).toBe(true);
    expect(b("headingFont: Open-Sans").valid).toBe(true);
  });
  it("rejects names that could break out of CSS or XML or point at a file", () => {
    for (const bad of ["Inter;}", "../x.ttf", "a/b", "Inter.ttf", '"Inter"', "Inter, serif", "<b>", "-Inter", " Inter"]) {
      expect(b(`bodyFont: ${JSON.stringify(bad)}`).valid, bad).toBe(false);
    }
    expect(b('bodyFont: ""').valid).toBe(false);
    expect(b(`bodyFont: ${"x".repeat(61)}`).valid).toBe(false);
  });
  it("fontFallback is sans-serif or serif", () => {
    expect(b("fontFallback: serif").valid).toBe(true);
    expect(b("fontFallback: mono").valid).toBe(false);
  });
  it("hideProviders is a boolean", () => {
    expect(b("hideProviders: true").valid).toBe(true);
    expect(b("hideProviders: maybe").valid).toBe(false);
  });
  it("accepts commentaryNote, including the empty string, and rejects control characters and over-long text", () => {
    expect(b('commentaryNote: ""').valid).toBe(true);
    expect(b("commentaryNote: Written by our team.").valid).toBe(true);
    expect(b(`commentaryNote: ${"x".repeat(201)}`).valid).toBe(false);
    expect(b('commentaryNote: "a\\u202Eb"').valid).toBe(false);
  });
  it("allowTerms and blockTerms are bounded lists of 2 to 60 character terms", () => {
    expect(b("allowTerms: [Claude]").valid).toBe(true);
    expect(b("blockTerms: [Acme Internal]").valid).toBe(true);
    expect(b("allowTerms: [x]").valid).toBe(false);
    expect(b(`allowTerms: [${JSON.stringify("x".repeat(61))}]`).valid).toBe(false);
    expect(v(`version: 1\nbranding:\n  allowTerms: [${Array.from({ length: 51 }, (_, i) => `term${i}`).join(", ")}]\n`).valid).toBe(false);
    expect(v(`version: 1\nbranding:\n  blockTerms: [${Array.from({ length: 101 }, (_, i) => `term${i}`).join(", ")}]\n`).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// B0.2 to B0.4: loading, validating with a client, running and the report document.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildReportDoc, ABOUT_ANCHOR, WHITE_LABEL_COMMENTARY_TEXT, COMMENTARY_TEXT } from "../src/reports/render/doc.js";
import { toHtml } from "../src/reports/render/html.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import { clientText, internalText } from "../src/reports/render/narrative.js";
import { clientTemplatesFile, globalTemplatesFile } from "../src/reports/paths.js";
import { loadTemplates } from "../src/reports/templates/load.js";
import { validateReportTemplate, validateTemplateFileAt } from "../src/reports/templates/service.js";
import { fixtureReport } from "./fixtures/reports/report.js";
import { client } from "./fixtures/reports/deps.js";

const newHome = () => mkdtempSync(join(tmpdir(), "crawlmark-rb-"));
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const GLOBAL_BLOCKS = `version: 1
blocks:
  glossary: { title: Glossary, text: "**CTR** is click-through rate." }
  method: { text: "How we measure." }
`;
const CLIENT_USING_GLOBAL = `version: 1
templates:
  t:
    title: T
    sections:
      - { id: search, type: search_overview }
      - { id: gloss, type: block, block: glossary }
`;

describe("loading blocks", () => {
  it("merges global and client blocks; a client block replaces the global block of the same id as a whole", () => {
    const home = newHome();
    put(globalTemplatesFile(home), GLOBAL_BLOCKS);
    put(clientTemplatesFile(home, client.slug), `version: 1\nblocks:\n  glossary: { text: "Client glossary." }\n`);
    const loaded = loadTemplates({ homeDir: home, clientSlug: client.slug, today: TODAY });
    expect(loaded.blocks.get("glossary")).toEqual({ text: "Client glossary.", source: "client" });
    expect(loaded.blocks.get("method")).toEqual({ text: "How we measure.", source: "global" });
    expect(loadTemplates({ homeDir: home, today: TODAY }).blocks.get("glossary")).toEqual({ title: "Glossary", text: "**CTR** is click-through rate.", source: "global" });
  });

  it("a client template can use a global block", () => {
    const home = newHome();
    put(globalTemplatesFile(home), GLOBAL_BLOCKS);
    put(clientTemplatesFile(home, client.slug), CLIENT_USING_GLOBAL);
    const loaded = loadTemplates({ homeDir: home, clientSlug: client.slug, today: TODAY });
    expect(loaded.files.client?.valid).toBe(true);
    expect(loaded.templates.get("t")?.source).toBe("client");
  });

  it("a global template that uses a client-only block is invalid", () => {
    const home = newHome();
    put(globalTemplatesFile(home), CLIENT_USING_GLOBAL);
    put(clientTemplatesFile(home, client.slug), `version: 1\nblocks:\n  glossary: { text: "Only for this client." }\n`);
    const loaded = loadTemplates({ homeDir: home, clientSlug: client.slug, today: TODAY });
    expect(loaded.files.global.valid).toBe(false);
    expect(loaded.files.global.errors?.[0]?.message).toMatch(/no block "glossary"/);
  });

  it("a client file is invalid when the global file is invalid or has no such block", () => {
    const home = newHome();
    put(globalTemplatesFile(home), "version: 1\n");
    put(clientTemplatesFile(home, client.slug), CLIENT_USING_GLOBAL);
    expect(loadTemplates({ homeDir: home, clientSlug: client.slug, today: TODAY }).files.client?.valid).toBe(false);
  });
});

describe("validate_report_template with a client", () => {
  it("resolves the global file's blocks for the client's file and for yaml given with a client", () => {
    const home = newHome();
    put(globalTemplatesFile(home), GLOBAL_BLOCKS);
    put(clientTemplatesFile(home, client.slug), CLIENT_USING_GLOBAL);
    expect(validateReportTemplate(home, { file: "client", clientSlug: client.slug }, TODAY)).toMatchObject({ valid: true, errors: [] });
    expect(validateReportTemplate(home, { yaml: CLIENT_USING_GLOBAL, clientSlug: client.slug }, TODAY).valid).toBe(true);
    // Without a client the yaml stands alone.
    expect(validateReportTemplate(home, { yaml: CLIENT_USING_GLOBAL }, TODAY).valid).toBe(false);
    // The CLI's validate-by-path treats any file but the global one as a client file.
    expect(validateTemplateFileAt(clientTemplatesFile(home, client.slug), home, TODAY).valid).toBe(true);
    expect(validateTemplateFileAt(globalTemplatesFile(home), home, TODAY).valid).toBe(true);
  });
});

describe("running a template with Release B fields", () => {
  const TEMPLATE = `version: 1
blocks:
  glossary: { title: Glossary, text: "**CTR** is click-through rate." }
  plain: { text: "No title." }
templates:
  t:
    title: T
    contents: true
    cover: { subtitle: Monthly review, preparedFor: Jane Doe, fields: [preparedFor, period] }
    sections:
      - { id: search, type: search_overview }
      - { id: gloss, type: block, block: glossary, pageBreakBefore: true }
      - { id: plain, type: block, block: plain, title: Own title }
      - { id: plain2, type: block, block: plain }
`;
  async function run() {
    const home = newHome();
    put(clientTemplatesFile(home, client.slug), TEMPLATE);
    return fixtureReport({ homeDir: home, template: "t", include: [] });
  }

  it("resolves block text and titles, and copies the layout into the report", async () => {
    const r = await run();
    expect(r.template).toMatchObject({ id: "t", contents: true, cover: { subtitle: "Monthly review", preparedFor: "Jane Doe", fields: ["preparedFor", "period"] } });
    const [search, gloss, plain, plain2] = r.sections;
    expect(search).not.toHaveProperty("pageBreakBefore");
    expect(gloss).toMatchObject({ status: "ok", title: "Glossary", pageBreakBefore: true, data: { blockId: "glossary", text: "**CTR** is click-through rate." } });
    expect(plain).toMatchObject({ status: "ok", title: "Own title" });
    expect(plain2).toMatchObject({ status: "ok", title: "Note" });
    expect(plain).not.toHaveProperty("pageBreakBefore");
  });

  it("a client template whose global block was removed is invalid, so the run can't reach a missing block", async () => {
    const home = newHome();
    put(globalTemplatesFile(home), GLOBAL_BLOCKS);
    put(clientTemplatesFile(home, client.slug), CLIENT_USING_GLOBAL);
    const ok = await fixtureReport({ homeDir: home, template: "t", include: [] });
    expect(ok.sections[1]).toMatchObject({ status: "ok", data: { blockId: "glossary" } });
    put(globalTemplatesFile(home), "version: 1\n");
    await expect(fixtureReport({ homeDir: home, template: "t", include: [] })).rejects.toThrow(/No report template "t"/);
  });
});

describe("narrative text helpers", () => {
  it("a plain string is client text; a split object keeps the two apart", () => {
    expect(clientText("hi")).toBe("hi");
    expect(internalText("hi")).toBeUndefined();
    expect(clientText({ client: "c", internal: "i" })).toBe("c");
    expect(internalText({ client: "c", internal: "i" })).toBe("i");
    expect(clientText({ internal: "i" })).toBeUndefined();
    expect(clientText(undefined)).toBeUndefined();
    expect(internalText(undefined)).toBeUndefined();
  });
});

describe("the report document carries the Release B layout without rendering it", () => {
  it("defaults: today's cover fields, no contents, no fonts, a commentary note, no warnings", async () => {
    const doc = buildReportDoc(await fixtureReport(), { version: "0.3.0" });
    expect(doc.meta.cover).toEqual({ fields: ["domain", "period", "compare", "generated", "badge"] });
    expect(doc.contents).toBeUndefined();
    expect(doc.warnings).toEqual([]);
    expect(doc.branding.fonts).toEqual({ body: null, heading: null, fallback: "sans-serif" });
    expect(doc.branding.hideProviders).toBeUndefined();
    expect(doc.branding.commentaryNote).toBe(COMMENTARY_TEXT);
    for (const s of doc.sections) {
      expect(s.anchor).toBe(`s-${s.id}`);
      expect(s).not.toHaveProperty("pageBreakBefore");
    }
  });

  it("cover fields default to include preparedFor and preparedBy when set", async () => {
    const r = await fixtureReport();
    r.template.cover = { subtitle: "Sub", preparedFor: "Jane", preparedBy: "Agency" };
    expect(buildReportDoc(r, { version: "0.3.0" }).meta.cover).toEqual({ fields: ["domain", "period", "compare", "generated", "preparedFor", "preparedBy", "badge"], subtitle: "Sub", preparedFor: "Jane", preparedBy: "Agency" });
    r.template.cover = { preparedBy: "Agency", fields: ["preparedBy", "period"] };
    expect(buildReportDoc(r, { version: "0.3.0" }).meta.cover).toEqual({ fields: ["preparedBy", "period"], preparedBy: "Agency" });
  });

  it("contents lists the sections then About; page breaks pass through in the standard layout only", async () => {
    const r = await fixtureReport();
    r.template.contents = true;
    r.sections[1] = { ...r.sections[1]!, pageBreakBefore: true };
    const doc = buildReportDoc(r, { version: "0.3.0" });
    expect(doc.contents?.at(-1)).toEqual({ anchor: ABOUT_ANCHOR, title: "About this report" });
    expect(doc.contents?.slice(0, -1)).toEqual(doc.sections.map((s) => ({ anchor: s.anchor, title: s.title })));
    expect(doc.sections.filter((s) => s.pageBreakBefore).map((s) => s.id)).toEqual([r.sections[1]!.id].filter((id) => doc.sections.some((s) => s.id === id)));
    r.template.layout = "onepage";
    const one = buildReportDoc(r, { version: "0.3.0" });
    expect(one.contents).toBeUndefined();
    expect(one.sections.some((s) => s.pageBreakBefore)).toBe(false);
  });

  it("fonts, hideProviders and commentaryNote come from the branding", async () => {
    const r = await fixtureReport();
    const b = (branding: object) => buildReportDoc(r, { version: "0.3.0", branding }).branding;
    expect(b({ bodyFont: "Inter", headingFont: "Merriweather", fontFallback: "serif" }).fonts).toEqual({ body: "Inter", heading: "Merriweather", fallback: "serif" });
    expect(b({}).hideProviders).toBeUndefined();
    expect(b({ hideCrawlmark: true }).hideProviders).toBe(true);
    expect(b({ hideCrawlmark: true, hideProviders: false }).hideProviders).toBeUndefined();
    expect(b({ hideProviders: true }).hideProviders).toBe(true);
    expect(b({ hideCrawlmark: true }).commentaryNote).toBe(WHITE_LABEL_COMMENTARY_TEXT);
    expect(b({ commentaryNote: "Our words." }).commentaryNote).toBe("Our words.");
    expect(b({ commentaryNote: "" }).commentaryNote).toBeNull();
    expect(b({ hideCrawlmark: true, commentaryNote: "" }).commentaryNote).toBeNull();
  });

  it("only client text counts: a split narrative's internal part never reaches the document", async () => {
    const r = await fixtureReport();
    const doc = buildReportDoc(r, { version: "0.3.0", narrative: { summary: { client: "Client summary.", internal: "SECRET internal summary." }, sections: { search: { internal: "SECRET only internal." } }, internal: "SECRET general." } });
    const all = toMarkdown(doc) + toHtml(doc);
    expect(all).toContain("Client summary.");
    expect(all).not.toContain("SECRET");
    expect(doc.meta.dataOnly).toBe(false);
    // Internal text alone does not turn a data-only report into one with commentary.
    const only = buildReportDoc(r, { version: "0.3.0", narrative: { summary: { internal: "SECRET" } } });
    expect(only.meta.dataOnly).toBe(true);
    expect(toMarkdown(only)).not.toContain("SECRET");
  });
});
