/**
 * Release B (B3): template writes for the new layout fields (cover, contents, pageBreakBefore), `block` sections
 * and the file-level `blocks` library: planTemplateWrite / applyTemplateWrite, and the create/update tools.
 * Temp homes only; example.com only; nothing live.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Client } from "../src/lib/clients.js";
import { loadTemplates } from "../src/reports/templates/load.js";
import { templateCatalogue } from "../src/reports/templates/builder.js";
import { runTemplateBuilder, type BuilderDeps, type NewBlock } from "../src/reports/templates/new-cli.js";
import { sampleTemplateReport } from "../src/reports/template-preview.js";
import type { Prompter } from "../src/setup/prompter.js";
import { recordingUi } from "../src/setup/ui.js";
import { applyTemplateWrite, planTemplateWrite, TemplateWriteError } from "../src/reports/templates/write.js";
import { confirmMessage, dialogReasons, templateWriteCall, type TemplateWriteArgs, type TemplateWriteDeps } from "../src/tools/report-template-write.js";
import { ProposalError } from "../src/reports/templates/proposals.js";

const today = new Date("2026-11-01T12:00:00Z");
const newHome = () => mkdtempSync(join(tmpdir(), "crawlmark-rb-write-"));
const globalFile = (home: string) => join(home, "config", "report-templates.yaml");
const clientFile = (home: string, slug: string) => join(home, "config", "report-templates", `${slug}.yaml`);

function put(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
}

const FILE = `# keep me
version: 1
blocks:
  glossary:
    title: Glossary
    text: Impressions are how often a page showed up in search.
templates:
  short:
    title: Short
    sections:
      - { id: search, type: search_overview }
      - { id: terms, type: block, block: glossary }
`;

const homeWith = (text = FILE) => {
  const h = newHome();
  put(globalFile(h), text);
  return h;
};

const update = (home: string, patch: Parameters<typeof planTemplateWrite>[0]["patch"], extra: Partial<Parameters<typeof planTemplateWrite>[0]> = {}) =>
  planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch, today, ...extra });

describe("patch.set cover and contents", () => {
  it("sets both, keeps comments, validates, and null removes them again", () => {
    const home = homeWith();
    const plan = update(home, { set: { cover: { subtitle: "Yearly review", preparedFor: "Jane Doe, Example Co", fields: ["preparedFor", "period", "generated"] }, contents: true } });
    expect(plan.after).toContain("# keep me");
    expect(plan.template.cover).toEqual({ subtitle: "Yearly review", preparedFor: "Jane Doe, Example Co", fields: ["preparedFor", "period", "generated"] });
    expect(plan.template.contents).toBe(true);
    expect(plan.diff.split("\n").filter((l) => /^[-+](?![-+]{2} )/.test(l)).every((l) => l.startsWith("+"))).toBe(true);
    expect(readFileSync(globalFile(home), "utf8")).toBe(FILE); // planning writes nothing
    applyTemplateWrite(plan, home, today);
    const saved = loadTemplates({ homeDir: home, today }).templates.get("short")!.spec;
    expect(saved.contents).toBe(true);
    const cleared = update(home, { set: { cover: null, contents: null } });
    expect(cleared.template.cover).toBeUndefined();
    expect(cleared.template.contents).toBeUndefined();
  });

  it("refuses a cover that lists preparedFor without a value, naming the field", () => {
    const home = homeWith();
    expect(() => update(home, { set: { cover: { fields: ["domain", "preparedFor"] } } })).toThrow(/cover\.fields lists preparedFor but cover\.preparedFor isn't set/);
  });

  it("warns that onepage ignores contents", () => {
    const home = homeWith();
    const plan = update(home, { set: { layout: "onepage", contents: true } });
    expect(plan.warnings.map((w) => w.message)).toContain("onepage reports ignore contents and page breaks");
  });
});

describe("patch.addSections with block sections and page breaks", () => {
  it("adds a block section and pageBreakBefore", () => {
    const home = homeWith();
    const plan = update(home, { addSections: [{ id: "method", type: "block", block: "glossary", pageBreakBefore: true, title: "How to read this" }] });
    const added = plan.template.sections.find((s) => s.id === "method")!;
    expect(added).toMatchObject({ type: "block", block: "glossary", pageBreakBefore: true, title: "How to read this" });
    expect(plan.diff).toContain("+      - { id: method, type: block, block: glossary, pageBreakBefore: true, title: How to read this }");
  });

  it("refuses a block section that names a block nobody has", () => {
    const home = homeWith();
    expect(() => update(home, { addSections: [{ id: "method", type: "block", block: "nope" }] })).toThrow(/no block "nope" in this file or the global template file/);
  });

  it("a client file may use the global file's block; the same section in the global file may not use a client-only block", () => {
    const home = homeWith();
    const plan = planTemplateWrite({
      homeDir: home,
      file: "client",
      clientSlug: "example.com",
      id: "board",
      mode: "create",
      template: { title: "Board", sections: [{ id: "search", type: "search_overview" }, { id: "terms", type: "block", block: "glossary" }] },
      today,
    });
    expect(plan.template.sections).toHaveLength(2);
    // Saving re-validates with the global block ids too.
    applyTemplateWrite(plan, home, today);
    expect(existsSync(clientFile(home, "example.com"))).toBe(true);
    const loaded = loadTemplates({ homeDir: home, clientSlug: "example.com", today });
    expect(loaded.files.client?.valid).toBe(true);
    expect(loaded.blocks.get("glossary")?.source).toBe("global");

    const home2 = newHome();
    put(clientFile(home2, "example.com"), `version: 1\nblocks:\n  only-here:\n    text: Client only.\n`);
    expect(() =>
      planTemplateWrite({ homeDir: home2, file: "global", id: "x", mode: "create", template: { title: "X", sections: [{ id: "b", type: "block", block: "only-here" }] }, today }),
    ).toThrow(/no block "only-here"/);
  });
});

describe("patch.setBlocks and removeBlockIds", () => {
  it("adds a block to a file that has none and replaces an existing one", () => {
    const home = homeWith("version: 1\ntemplates:\n  short:\n    title: Short\n    sections:\n      - { id: search, type: search_overview }\n");
    const add = update(home, { setBlocks: { methodology: { title: "Method", text: "Figures come from Search Console.\n\nSecond paragraph." } }, addSections: [{ id: "method", type: "block", block: "methodology" }] });
    expect(add.blocksSet).toEqual(["methodology"]);
    expect(add.after).toContain("blocks:");
    applyTemplateWrite(add, home, today);
    const loaded = loadTemplates({ homeDir: home, today });
    expect(loaded.blocks.get("methodology")).toMatchObject({ title: "Method", source: "global" });
    expect(loaded.blocks.get("methodology")!.text).toContain("Second paragraph.");

    const replace = update(home, { setBlocks: { methodology: { text: "New wording." } } });
    applyTemplateWrite(replace, home, today);
    const again = loadTemplates({ homeDir: home, today });
    expect(again.blocks.get("methodology")).toEqual({ text: "New wording.", source: "global" });
  });

  it("refuses a bad block id or an empty text, naming the patch path", () => {
    const home = homeWith();
    expect(() => update(home, { setBlocks: { "Bad Id": { text: "x" } } })).toThrow(/isn't a valid block id/);
    expect(() => update(home, { setBlocks: { fine: { text: "" } } })).toThrow(TemplateWriteError);
    try {
      update(home, { setBlocks: { fine: { text: "" } } });
    } catch (err) {
      expect((err as TemplateWriteError).errors[0]!.path).toBe("patch.setBlocks.fine.text");
    }
  });

  it("refuses to remove a block a section still uses and names the section; removes it once the section goes too", () => {
    const home = homeWith();
    let err: TemplateWriteError | undefined;
    try {
      update(home, { removeBlockIds: ["glossary"] });
    } catch (e) {
      err = e as TemplateWriteError;
    }
    expect(err).toBeInstanceOf(TemplateWriteError);
    expect(err!.message).toContain('templates.short section "terms"');
    expect(err!.errors[0]).toMatchObject({ path: "patch.removeBlockIds" });

    const plan = update(home, { removeSectionIds: ["terms"], removeBlockIds: ["glossary"] });
    // The only block went, so the empty `blocks:` map goes with it (the schema wants 1 to 50).
    expect(plan.after).not.toContain("blocks:");
    expect(plan.after).toContain("# keep me");
    applyTemplateWrite(plan, home, today);
    expect(loadTemplates({ homeDir: home, today }).blocks.size).toBe(0);
  });

  it("refuses to remove a block the file doesn't have, and an empty patch", () => {
    const home = homeWith();
    expect(() => update(home, { removeBlockIds: ["ghost"] })).toThrow(/no block "ghost"/);
    expect(() => update(home, {})).toThrow(/changes nothing/);
  });

  it("create with blocks (the CLI builder) saves the block next to the template", () => {
    const home = newHome();
    const plan = planTemplateWrite({
      homeDir: home,
      file: "global",
      id: "board",
      mode: "create",
      template: { title: "Board", sections: [{ id: "search", type: "search_overview" }, { id: "terms", type: "block", block: "terms" }] },
      blocks: { terms: { title: "Terms", text: "Clicks are visits from search." } },
      today,
    });
    expect(plan.blocksSet).toEqual(["terms"]);
    applyTemplateWrite(plan, home, today);
    expect(loadTemplates({ homeDir: home, today }).blocks.get("terms")?.text).toBe("Clicks are visits from search.");
  });
});

describe("update_report_template with blocks (proposal, token, dialog)", () => {
  const exampleClient = { slug: "example.com", domain: "example.com", name: "Example" } as unknown as Client;
  const deps = (home: string, extra: Partial<TemplateWriteDeps> = {}): TemplateWriteDeps => ({ homeDir: home, today, resolveClient: async () => exampleClient, estimate: async () => new Map(), ...extra });
  type Proposal = { proposal: true; valid: boolean; confirmToken: string; diff: string; warnings: { message: string }[]; message: string };
  const args = (): TemplateWriteArgs => ({
    id: "short",
    patch: { setBlocks: { methodology: { title: "Method", text: "Figures come from Search Console." } }, addSections: [{ id: "method", type: "block", block: "methodology", pageBreakBefore: true }] },
  });

  it("a proposal shows the diff and writes nothing", async () => {
    const home = homeWith();
    const p = (await templateWriteCall("update_report_template", args(), deps(home))) as Proposal;
    expect(p).toMatchObject({ proposal: true, valid: true });
    expect(p.diff).toContain("+  methodology:");
    expect(p.diff).toContain("pageBreakBefore: true");
    expect(p.message).toContain("Saving it from here will be refused");
    expect(readFileSync(globalFile(home), "utf8")).toBe(FILE);
  });

  it("without a dialog the save is refused (the block text goes into client reports); with the user's yes it saves", async () => {
    const home = homeWith();
    const p = (await templateWriteCall("update_report_template", args(), deps(home))) as Proposal;
    await expect(templateWriteCall("update_report_template", { ...args(), confirmToken: p.confirmToken }, deps(home))).rejects.toThrow(ProposalError);
    expect(readFileSync(globalFile(home), "utf8")).toBe(FILE);

    const asked: string[] = [];
    const p2 = (await templateWriteCall("update_report_template", args(), deps(home))) as Proposal;
    const saved = (await templateWriteCall("update_report_template", { ...args(), confirmToken: p2.confirmToken }, deps(home, { elicit: async (m) => (asked.push(m), true) }))) as { saved: boolean };
    expect(saved.saved).toBe(true);
    expect(asked[0]).toContain('Text block "methodology" titled "Method", 33 characters: "Figures come from Search Console."');
    expect(loadTemplates({ homeDir: home, today }).blocks.get("methodology")?.title).toBe("Method");
  });

  it("dialogReasons and confirmMessage name the blocks", () => {
    const home = homeWith();
    const plan = update(home, { setBlocks: { methodology: { text: "Wording." } } });
    expect(dialogReasons(plan).join(" ")).toContain("text blocks (methodology)");
    expect(confirmMessage({ ...plan, blockTexts: { methodology: { text: "Wording." } } })).toContain('Text block "methodology" (no title), 8 characters: "Wording."');
  });

  it("the tool refuses removing a used block in the proposal, with the section named", async () => {
    const home = homeWith();
    const p = (await templateWriteCall("update_report_template", { id: "short", patch: { removeBlockIds: ["glossary"] } }, deps(home))) as unknown as { valid: boolean; errors: { message: string }[] };
    expect(p.valid).toBe(false);
    expect(p.errors[0]!.message).toContain('section "terms"');
  });
});

describe("CLI builder: block section and contents", () => {
  /** A prompter that answers from a queue (any kind of question), recording what was asked. */
  function queue(answers: unknown[]): Prompter & { asked: string[] } {
    const asked: string[] = [];
    const next = (q: string, dflt: unknown) => {
      asked.push(q);
      if (!answers.length) throw new Error(`unexpected question: ${q}`);
      const a = answers.shift();
      return a === "default" ? dflt : a;
    };
    return {
      asked,
      ask: async (q, o = {}) => next(q, o.default ?? "") as string,
      secret: async () => "",
      confirm: async (q, d) => next(q, d) as boolean,
      choose: (async (q: string, _c: unknown, d: string) => next(q, d)) as Prompter["choose"],
      multiselect: (async (q: string, _c: unknown, d: readonly string[]) => next(q, [...d])) as NonNullable<Prompter["multiselect"]>,
      groupMultiselect: (async (q: string, _g: unknown, d: readonly string[]) => next(q, [...d])) as NonNullable<Prompter["groupMultiselect"]>,
      close() {},
    };
  }

  type TestDeps = BuilderDeps & { previews: Record<string, NewBlock>[]; ui: ReturnType<typeof recordingUi> };
  function builder(home: string, prompt: Prompter, extra: Partial<BuilderDeps> = {}): TestDeps {
    const ui = recordingUi();
    const previews: Record<string, NewBlock>[] = [];
    return {
      ui,
      prompt,
      cliDisplay: "crawlmark-cli",
      file: "global",
      replace: false,
      dryRun: false,
      catalogue: templateCatalogue(),
      estimates: async () => new Map(),
      target: () => ({ path: globalFile(home), ids: [], hasDefaultFormats: true, valid: true, blockIds: [] }),
      plan: (id, spec, o) => planTemplateWrite({ homeDir: home, file: "global", id, mode: "create", template: spec, ...(o.blocks ? { blocks: o.blocks } : {}), today }),
      preview: async (_id, _spec, blocks) => (previews.push(blocks ?? {}), { path: "/tmp/preview.html" }),
      save: (plan) => applyTemplateWrite(plan, home, today),
      previews,
      ...extra,
    } as TestDeps;
  }

  // id, title, sections, [block answers], optional sections, period, comparisons, layout
  const BASE = (sections: string[], block: unknown[] = []) => ["board", "default", sections, ...block, [], "last_month", ["previous_period"], "standard"];

  it("creates a new block with the template; contents can be turned on from the change menu", async () => {
    const home = newHome();
    const prompt = queue([...BASE(["search_overview", "block"], ["terms", "Terms", "Clicks are visits from search."]), "change", "contents", true, "save"]);
    const deps = builder(home, prompt);
    expect(await runTemplateBuilder(deps)).toBe(0);
    expect(prompt.asked.some((q) => q.startsWith("Block id"))).toBe(true);
    expect(prompt.asked.some((q) => q.startsWith("Add a contents list"))).toBe(true);
    const loaded = loadTemplates({ homeDir: home, today });
    const spec = loaded.templates.get("board")!.spec;
    expect(spec.contents).toBe(true);
    expect(spec.sections.find((s) => s.type === "block")).toMatchObject({ block: "terms" });
    expect(loaded.blocks.get("terms")).toMatchObject({ title: "Terms", text: "Clicks are visits from search." });
    // The preview got the new block's text.
    expect(deps.previews[0]!.terms!.text).toBe("Clicks are visits from search.");
  });

  it("offers the blocks that exist and uses the chosen one without creating another", async () => {
    const home = homeWith();
    const p = queue([...BASE(["search_overview", "block"], ["glossary"]), "save"]);
    const deps = builder(home, p, { target: () => ({ path: globalFile(home), ids: ["short"], hasDefaultFormats: true, valid: true, blockIds: ["glossary"] }) });
    expect(await runTemplateBuilder(deps)).toBe(0);
    expect(p.asked.some((q) => q.startsWith("Block id"))).toBe(false);
    const board = loadTemplates({ homeDir: home, today }).templates.get("board")!.spec;
    expect(board.sections.find((s) => s.type === "block")).toMatchObject({ block: "glossary" });
  });

  it("refuses to save a new block when the caller can't carry it (nothing is written)", async () => {
    const home = newHome();
    // plan() ignores the blocks, as a caller written before B3 would: the template then names a block that isn't there.
    const deps = builder(home, queue([...BASE(["search_overview", "block"], ["terms", "", "Some text."]), "cancel"]), {
      plan: (id, spec) => planTemplateWrite({ homeDir: home, file: "global", id, mode: "create", template: spec, today }),
    });
    expect(await runTemplateBuilder(deps)).toBe(0);
    expect(deps.ui.events.some((e) => e.startsWith("fail:") && e.includes('no block "terms"'))).toBe(true);
    expect(existsSync(globalFile(home))).toBe(false);
  });

  it("a one-page layout drops contents", async () => {
    const home = newHome();
    expect(await runTemplateBuilder(builder(home, queue([...BASE(["search_overview"]), "change", "contents", true, "save"])))).toBe(0);
    expect(loadTemplates({ homeDir: home, today }).templates.get("board")!.spec.contents).toBe(true);
    const home2 = newHome();
    expect(await runTemplateBuilder(builder(home2, queue([...BASE(["search_overview"]), "change", "layout", "onepage", "save"])))).toBe(0);
    const spec = loadTemplates({ homeDir: home2, today }).templates.get("board")!.spec;
    expect(spec.layout).toBe("onepage");
    expect(spec.contents).toBeUndefined();
  });
});

describe("template preview with Release B fields", () => {
  it("carries cover, contents and page breaks, and fills a block section with its text", () => {
    const r = sampleTemplateReport(
      "board",
      {
        title: "Board",
        cover: { preparedBy: "Example Agency" },
        contents: true,
        sections: [
          { id: "search", type: "search_overview" },
          { id: "terms", type: "block", block: "glossary", pageBreakBefore: true },
          { id: "gone", type: "block", block: "missing" },
        ],
      },
      new Date("2026-11-01T00:00:00Z"),
      { glossary: { title: "Glossary", text: "Clicks are visits." } },
    );
    expect(r.template).toMatchObject({ cover: { preparedBy: "Example Agency" }, contents: true });
    const terms = r.sections.find((s) => s.id === "terms")!;
    expect(terms).toMatchObject({ title: "Glossary", status: "ok", pageBreakBefore: true, data: { blockId: "glossary", text: "Clicks are visits." } });
    expect(r.sections.find((s) => s.id === "gone")).toMatchObject({ title: "Note", data: { text: expect.stringContaining("missing") } });
  });
});
