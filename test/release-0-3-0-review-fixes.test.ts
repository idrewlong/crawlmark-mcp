/**
 * 0.3.0 security, review and QA findings: one describe per finding id. Temp homes, fixture data, example.com
 * only; no network, no Chrome (the PDF printer is a fake).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClientTextLintError, exportReport, removeStaleInternalNotes, reportFilePath, ReportWriteError } from "../src/reports/export.js";
import { brandingFileText } from "../src/reports/branding-settings.js";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import { MAX_CHART_REFS, validateNarrative } from "../src/reports/render/narrative.js";
import { footerFont, printOnPage, type PdfOptions, type PdfPage } from "../src/reports/render/pdf.js";
import { lintClientText, lintView } from "../src/reports/render/term-lint.js";
import type { CompetitorOverviewData, KeywordGapData, SectionResult } from "../src/reports/report-types.js";
import { BlockSchema, validateTemplateText } from "../src/reports/templates/schema.js";
import { templatePlanFields, validateReportTemplate } from "../src/reports/templates/service.js";
import { planTemplateWrite, TemplateWriteError } from "../src/reports/templates/write.js";
import type { Choice, Prompter } from "../src/setup/prompter.js";
import { stepBranding } from "../src/setup/branding-step.js";
import { recordingUi } from "../src/setup/ui.js";
import type { WizardContext } from "../src/setup/wizard.js";
import { confirmMessage, dialogPreview, dialogReasons } from "../src/tools/report-template-write.js";
import { TOOL_NAMES } from "../src/tools/names.js";
import { COMPETITORS, p13bReport } from "./fixtures/reports/p13-data.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const tmp = () => mkdtempSync(join(tmpdir(), "crawlmark-030-fixes-"));
const today = new Date("2026-10-13T12:00:00Z");
const printer = vi.fn(async (_html: string, _o: PdfOptions) => Buffer.from("%PDF-1.7"));
const opts = (dir: string, extra = {}) => ({ formats: ["md"] as ("md" | "html" | "pdf")[], reportsDir: dir, branding: {}, version: "0.3.0", printer, ...extra });
const refusal = (p: Promise<unknown>) => p.then(() => Promise.reject(new Error("expected a refusal")), (e: unknown) => e as ClientTextLintError);
const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
};
const refs = (n: number, id = "search") => Array.from({ length: n }, () => `{{chart ${id}}}`).join("\n\n");
const chartCount = (doc: ReturnType<typeof buildReportDoc>) =>
  JSON.stringify(doc)
    .match(/"kind":"chart","chart"/g)
    ?.length ?? 0;

describe("SEC-1: {{chart}} references are capped per report", () => {
  it(`validateNarrative refuses more than ${MAX_CHART_REFS} references across the commentary, naming the field`, () => {
    expect(() => validateNarrative({ summary: refs(MAX_CHART_REFS) }, ["search"])).not.toThrow();
    expect(() => validateNarrative({ summary: refs(15), sections: { search: refs(6) } }, ["search"])).toThrow(/^narrative\.sections\.search: .*more than 20 \{\{chart\}\} references/);
    // Internal notes have no charts and don't count.
    expect(() => validateNarrative({ summary: { client: refs(20), internal: refs(50) } }, ["search"])).not.toThrow();
  });

  it("export_report refuses an over-the-limit narrative before writing", async () => {
    const dir = join(tmp(), "r");
    await expect(exportReport(await fixtureReport(), opts(dir, { narrative: { summary: refs(1000) } }))).rejects.toThrow(/narrative\.summary: .*\{\{chart\}\} references/);
    expect(existsSync(dir)).toBe(false);
  });

  it("resolution shares one budget across the summary, the sections and block texts, and warns once", async () => {
    const report = await fixtureReport();
    const baseline = chartCount(buildReportDoc(report, { version: "0.3.0" }));
    const blocks: SectionResult[] = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, type: "block", title: `Block ${i}`, status: "ok", data: { blockId: `blk${i}`, text: refs(20) } }));
    report.sections.push(...blocks);
    const doc = buildReportDoc(report, { version: "0.3.0", narrative: { summary: refs(15), sections: { search: refs(15) } } });
    expect(chartCount(doc) - baseline).toBe(MAX_CHART_REFS);
    expect(doc.warnings.filter((w) => /more than 20 \{\{chart\}\} references/.test(w))).toHaveLength(1);
    expect(doc.summary?.narrative?.filter((b) => b.kind === "chart")).toHaveLength(15);
  });

  it("a block text is parsed when it is saved: a bad table or too many references is refused", () => {
    const wide = `| ${Array.from({ length: 13 }, (_, i) => `c${i}`).join(" | ")} |\n|${" --- |".repeat(13)}\n| x |`;
    expect(BlockSchema.safeParse({ text: wide }).success).toBe(false);
    expect(BlockSchema.safeParse({ text: refs(21) }).success).toBe(false);
    expect(BlockSchema.safeParse({ text: refs(20) }).success).toBe(true);
    const bad = validateTemplateText(`version: 1\nblocks:\n  wide:\n    text: |\n${wide.split("\n").map((l) => `      ${l}`).join("\n")}\n`);
    expect(bad.valid).toBe(false);
    expect(bad.errors[0]!.path).toBe("blocks.wide.text");
    expect(bad.errors[0]!.message).toContain("13 columns");
    const home = tmp();
    put(join(home, "config", "report-templates.yaml"), "version: 1\ntemplates:\n  short:\n    title: Short\n    sections:\n      - { id: search, type: search_overview }\n");
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { setBlocks: { many: { text: refs(25) } } }, today })).toThrow(TemplateWriteError);
  });
});

describe("SEC-2: white label and per-export allowTerms", () => {
  const narrative = { summary: "Claude drafted this with striking_distance." };

  it("with white label on, an export's allowTerms can't allow built-in terms, and the refusal doesn't suggest it", async () => {
    for (const branding of [{ hideCrawlmark: true }, { hideProviders: true }]) {
      const e = await refusal(exportReport(await fixtureReport(), opts(join(tmp(), "r"), { branding, narrative, allowTerms: ["Claude", "striking_distance"] })));
      expect(e).toBeInstanceOf(ClientTextLintError);
      expect(e.hits.map((h) => h.term)).toEqual(["Claude"]);
      expect(e.hits[0]!.builtin).toBe(true);
      expect(e.message).toContain("allow it in the branding's allowTerms in the template file");
      expect(e.message).not.toContain("allow a term with allowTerms");
    }
  });

  it("with white label on, the branding allowTerms still allows a built-in term", async () => {
    const out = await exportReport(await fixtureReport(), opts(join(tmp(), "r"), { branding: { hideCrawlmark: true, allowTerms: ["Claude"] }, narrative, allowTerms: ["striking_distance"] }));
    expect(out.files).toHaveLength(1);
    expect(out.warnings).toContain("allowTerms for this export: striking_distance.");
  });

  it("without white label, an export's allowTerms allows every kind of term as before, and is echoed", async () => {
    const out = await exportReport(await fixtureReport(), opts(join(tmp(), "r"), { narrative, allowTerms: ["Claude", "striking_distance"] }));
    expect(out.warnings).toContain("allowTerms for this export: Claude, striking_distance.");
  });

  it("built-in terms in an export's allowTerms under white label are reported as not applied", async () => {
    const out = await exportReport(await fixtureReport(), opts(join(tmp(), "r"), { branding: { hideCrawlmark: true }, narrative: { summary: "Fine." }, allowTerms: ["DataForSEO", "Project Falcon"] }));
    expect(out.warnings).toContain("allowTerms for this export: Project Falcon.");
    expect(out.warnings.join(" ")).toMatch(/allowTerms not applied \(white label is on.*\): DataForSEO\./);
  });

  it("an export's allowTerms relaxes blockTerms under white label", async () => {
    const out = await exportReport(await fixtureReport(), opts(join(tmp(), "r"), { branding: { hideCrawlmark: true, blockTerms: ["Project Falcon"] }, narrative: { summary: "Project Falcon went well." }, allowTerms: ["project falcon"] }));
    expect(out.files).toHaveLength(1);
  });
});

describe("SEC-3: the text-block dialog shows the title, the length and both ends", () => {
  it("first and last 200 characters of a long text, with its title and length", () => {
    const text = `${"A".repeat(200)}${"M".repeat(19_600)}${"Z".repeat(200)}`;
    const home = tmp();
    put(join(home, "config", "report-templates.yaml"), "version: 1\ntemplates:\n  short:\n    title: Short\n    sections:\n      - { id: search, type: search_overview }\n");
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { setBlocks: { legal: { title: "Legal note", text } } }, today });
    const msg = confirmMessage({ ...plan, blockTexts: { legal: { title: "Legal note", text } } });
    expect(msg).toContain(`Text block "legal" titled "Legal note", 20,000 characters: "${"A".repeat(200)}" ... "${"Z".repeat(200)}"`);
    expect(msg).not.toContain("M".repeat(10));
    expect(dialogPreview("short\ntext")).toBe('"short text"');
  });
});

describe("SEC-4: the PDF footer font comes from the branding, never from the HTML", () => {
  it("commentary that writes a --font-body declaration doesn't reach the footer", async () => {
    printer.mockClear();
    const narrative = { summary: "Style note: --font-body: x</span><img src=x>; done." };
    await exportReport(await fixtureReport(), opts(join(tmp(), "r"), { formats: ["pdf"], narrative }));
    expect(printer.mock.calls[0]![1].fontFamily).toBe(footerFont({ body: null, heading: null, fallback: "sans-serif" }));
    printer.mockClear();
    await exportReport(await fixtureReport(), opts(join(tmp(), "r"), { formats: ["pdf"], narrative, branding: { bodyFont: "Inter" } }));
    expect(printer.mock.calls[0]![1].fontFamily).toMatch(/^'Inter', system-ui/);
  });

  it("printOnPage puts the given stack in the footer template, whatever the HTML says", async () => {
    let footer = "";
    const page = {
      setJavaScriptEnabled: async () => undefined,
      setRequestInterception: async () => undefined,
      on: () => undefined,
      setContent: async () => undefined,
      pdf: async (o: Record<string, unknown>) => ((footer = String(o.footerTemplate)), new Uint8Array([37])),
    };
    await printOnPage(page as unknown as PdfPage, "<style>:root { --font-body: evil; }</style>", { paper: "A4", footer: "x", fontFamily: "'Inter', serif" });
    expect(footer).toContain("font-family:'Inter', serif;");
    expect(footer).not.toContain("evil");
    await printOnPage(page as unknown as PdfPage, "<style>:root { --font-body: evil; }</style>", { paper: "A4", footer: "x" });
    expect(footer).toContain("font-family:system-ui,");
  });
});

describe("SEC-5: titles are checked", () => {
  it("the template title and section titles (a block section's title is its block's) in an export", async () => {
    const report = await fixtureReport();
    report.template.title = "crawlmark monthly";
    report.sections[0]!.title = "Data from DataForSEO";
    const e = await refusal(exportReport(report, opts(join(tmp(), "r"))));
    expect(e.hits.map((h) => `${h.where}:${h.term}`)).toEqual(["template.title:crawlmark", `sections.${report.sections[0]!.id}.title:DataForSEO`]);
  });

  it("validate_report_template warns about template, section and block titles", () => {
    const home = tmp();
    const yaml = "version: 1\nblocks:\n  g:\n    title: Claude glossary\n    text: Words.\ntemplates:\n  x:\n    title: Anthropic report\n    sections:\n      - { id: a, type: search_overview, title: low_ctr pages }\n      - { id: b, type: block, block: g }\n";
    const r = validateReportTemplate(home, { yaml }, today);
    expect(r.warnings.map((w) => w.path)).toEqual(["blocks.g.title", "templates.x.title", "templates.x.sections[0].title"]);
  });

  it("the CLI's plan check includes the template title and a block section's block title", () => {
    const fields = templatePlanFields({ title: "T", sections: [] }, [{ id: "b", type: "block", block: "g" }], new Map([["g", { title: "crawlmark notes", text: "ok" }]]), {});
    expect(fields.map((f) => f.where)).toEqual(["template.title", "sections.b.title", "blocks.g"]);
    expect(lintClientText(fields, { toolNames: TOOL_NAMES }).map((h) => h.where)).toEqual(["sections.b.title"]);
  });
});

describe("R1: hiding providers never rewrites client data", () => {
  const competitors: CompetitorOverviewData = { ...COMPETITORS, competitors: [...COMPETITORS.competitors, { domain: "dataforseo.com", origin: "saved", commonKeywords: 12, keywords: 900, traffic: 4000, inProviderList: true, keywordsChange: 3 }] };
  const gap: KeywordGapData = {
    provider: "dataforseo",
    competitors: ["dataforseo.com"],
    limit: 10,
    gaps: [{ keyword: "dataforseo api pricing", volume: 320, difficulty: { metric: "dataforseo_kd", value: 20 }, competitors: [{ domain: "dataforseo.com", position: 1, url: "https://example.com/dataforseo-review" }], clientPosition: null, clientCheck: "provider" }],
    perCompetitor: [{ domain: "dataforseo.com", returned: 1 }],
  };

  it("a dataforseo.com competitor row and a keyword naming it stay as they are; the provider's own wording is still hidden", () => {
    const report = p13bReport({ competitors, extra: [{ id: "gap", type: "keyword_gap", title: "Keyword gap", status: "ok", data: gap }] });
    report.highlights = [{ text: '"dataforseo api pricing" gained 12 clicks.' } as (typeof report.highlights)[number]];
    const md = toMarkdown(buildReportDoc(report, { version: "0.3.0", branding: { hideCrawlmark: true } }));
    expect(md).toContain("dataforseo.com");
    expect(md).toContain("dataforseo api pricing");
    expect(md).not.toContain("third-party data.com");
    expect(md).not.toContain("DataForSEO");
    // The provider's traffic label and metric label are still scrubbed.
    expect(md).toContain("Provider estimated traffic");
  });
});

describe("R2: cover texts need the user's own confirmation", () => {
  it("dialogReasons names the cover texts and the dialog lists them", () => {
    const home = tmp();
    put(join(home, "config", "report-templates.yaml"), "version: 1\ntemplates:\n  short:\n    title: Short\n    sections:\n      - { id: search, type: search_overview }\n");
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { set: { cover: { subtitle: "Quarterly review", preparedBy: "Example Agency" } } }, today });
    expect(dialogReasons(plan).join("; ")).toContain("it sets cover texts (subtitle, preparedBy)");
    const msg = confirmMessage(plan);
    expect(msg).toContain('Cover subtitle: "Quarterly review"');
    expect(msg).toContain('Cover preparedBy: "Example Agency"');
    const plain = planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { set: { title: "Shorter" } }, today });
    expect(dialogReasons(plain).join(" ")).not.toContain("cover");
  });
});

describe("R-cheap: stale internal notes and removed global blocks", () => {
  it("an export without internal notes removes the notes file an earlier export of the period left", async () => {
    const dir = join(tmp(), "r");
    const report = await fixtureReport();
    const first = await exportReport(report, opts(dir, { narrative: { summary: { client: "Fine.", internal: "Only for us." } } }));
    const notes = first.files.find((f) => f.audience === "internal")!.path;
    expect(existsSync(notes)).toBe(true);
    const second = await exportReport(report, opts(dir));
    expect(existsSync(notes)).toBe(false);
    expect(second.warnings.join(" ")).toContain(`Removed the internal notes file from an earlier export of this period (this export has none): ${notes}`);
    // formats: [] writes no file and leaves the folder alone.
    put(notes, "old");
    await exportReport(report, opts(dir, { formats: [], inline: "md" }));
    expect(readFileSync(notes, "utf8")).toBe("old");
  });

  it("refuses to remove anything that isn't a regular file", async () => {
    const dir = join(tmp(), "r");
    const report = await fixtureReport();
    mkdirSync(reportFilePath(dir, report, "md", "internal"), { recursive: true });
    expect(() => removeStaleInternalNotes(dir, report)).toThrow(ReportWriteError);
  });

  it("removing a global block warns about client files that still use it", () => {
    const home = tmp();
    put(join(home, "config", "report-templates.yaml"), "version: 1\nblocks:\n  legal:\n    text: Terms.\n  other:\n    text: Other.\ntemplates:\n  short:\n    title: Short\n    sections:\n      - { id: search, type: search_overview }\n");
    put(join(home, "config", "report-templates", "example.com.yaml"), "version: 1\ntemplates:\n  mine:\n    title: Mine\n    sections:\n      - { id: fine-print, type: block, block: legal }\n");
    put(join(home, "config", "report-templates", "example.org.yaml"), "version: 1\nblocks:\n  legal:\n    text: Own terms.\ntemplates:\n  mine:\n    title: Mine\n    sections:\n      - { id: fine-print, type: block, block: legal }\n");
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { removeBlockIds: ["legal"] }, today });
    const msgs = plan.warnings.filter((w) => w.path === "patch.removeBlockIds").map((w) => w.message);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('example.com.yaml still uses templates.mine section "fine-print" (block "legal")');
  });
});

describe("Q1: the term check sees through invisible characters, fullwidth letters and bold markers", () => {
  const terms = (text: string) => lintClientText([{ where: "summary", text }], { toolNames: TOOL_NAMES });

  it.each([
    ["zero-width space", "Data\u200bForSEO data"],
    ["soft hyphen", "Data\u00adForSEO data"],
    ["zero-width joiner", "Cl\u200daude wrote it"],
    ["fullwidth", "ＤａｔａＦｏｒＳＥＯ data"],
    ["bold split", "**Data**ForSEO data"],
    ["code split", "`crawl`mark ran it"],
  ])("%s", (_name, text) => {
    const hits = terms(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).not.toMatch(/[\u200b\u200d\u00ad*`]/);
  });

  it("snippets stay readable and ordinary text is unaffected", () => {
    expect(terms("Before **Data**ForSEO after")[0]!.snippet).toBe("Before DataForSEO after");
    expect(terms("**Claudette** and crawlmarks")).toEqual([]);
    expect(lintView("A\u200bB ＣＤ **e**")).toBe("AB CD e");
  });
});

describe("Q2: branding setup keeps unset values unset", () => {
  type Answer = string | boolean | string[];
  function scripted(answers: Answer[]): Prompter {
    const next = (q: string): Answer => {
      if (!answers.length) throw new Error(`Unexpected question: ${q}`);
      return answers.shift()!;
    };
    return {
      ask: async (q, o = {}) => {
        const a = next(q) as string;
        return a === "" ? (o.default ?? "") : a;
      },
      secret: async (q) => next(q) as string,
      confirm: async (q, d) => {
        const a = next(q);
        return a === "" ? d : (a as boolean);
      },
      choose: async <T extends string>(q: string, _c: readonly Choice<T>[], d: T) => ((next(q) as string) || d) as T,
      multiselect: async <T extends string>(q: string, _c: readonly Choice<T>[], d: readonly T[]) => {
        const a = next(q);
        return (Array.isArray(a) ? a : [...d]) as T[];
      },
      close() {},
    };
  }
  const ctxFor = (h: string, answers: Answer[]) =>
    ({
      prompt: scripted(answers),
      out: () => undefined,
      ui: recordingUi(),
      paths: { home: h, homeSource: "project", projectRoot: h, envFile: join(h, ".env"), userHome: h, cwd: h, desktopConfig: undefined },
      cliDisplay: "crawlmark-cli",
      dryRun: false,
    }) as unknown as WizardContext;
  // 13 fields, Enter at each, then "save" (the default).
  const enterEverywhere = (): Answer[] => [...Array.from({ length: 13 }, () => ""), ""];

  it("Enter at every prompt writes no colours, paper or formats the file didn't have", async () => {
    const h = tmp();
    const file = join(h, "config", "report-templates.yaml");
    const text = "version: 1\n# our branding\nbranding:\n  agencyName: Example Agency\n";
    put(file, text);
    const r = await stepBranding(ctxFor(h, enterEverywhere()));
    expect(r.outcome).toBe("done");
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("Enter keeps existing values exactly as written (quoting and block-style lists)", async () => {
    const h = tmp();
    const file = join(h, "config", "report-templates.yaml");
    const text = "version: 1\nbranding:\n  agencyName: 'Example Agency'\n  primaryColor: '#123456'\n  paper: A4\ndefaults:\n  formats:\n    - pdf\n    - docx\n";
    put(file, text);
    await stepBranding(ctxFor(h, enterEverywhere()));
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("brandingFileText leaves an unchanged formats list alone", () => {
    const text = "version: 1\ndefaults:\n  formats:\n    - pdf\n    - md\n";
    expect(brandingFileText(text, { formats: ["pdf", "md"] }, { client: false })).toBe(text);
    expect(brandingFileText(text, { formats: ["docx"] }, { client: false })).toContain("formats: [ docx ]");
  });
});

describe("SEC-6: DataForSEO crawl issue titles name no vendor", () => {
  it("titles an unmapped DataForSEO crawl check neutrally (the Found by column names the source)", async () => {
    const { dataForSeoCrawlIssues } = await import("../src/reports/technical-issues.js");
    const issues = dataForSeoCrawlIssues({ issues: [{ check: "has_render_blocking_resources", pages: 12 }] }, new Set(["has_render_blocking_resources"]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toBe("Crawl check failed: has render blocking resources");
    expect(JSON.stringify(issues)).not.toMatch(/dataforseo check/i);
  });
});

describe("SEC-7: invisible combining marks don't hide a term", () => {
  it("catches a variation selector and a combining grapheme joiner inside a built-in term", async () => {
    const { lintClientText } = await import("../src/reports/render/term-lint.js");
    for (const text of ["Cla️ude wrote this", "Cla͏ude wrote this"]) {
      const hits = lintClientText([{ where: "summary", text }], { toolNames: [], whiteLabel: true });
      expect(hits.length, text).toBeGreaterThan(0);
    }
  });
});
