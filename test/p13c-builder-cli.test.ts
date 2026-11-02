/**
 * Phase 13 C: `crawlmark-cli report templates new` with a scripted UI. Fixture deps only: no network, no
 * real config home, no paid call; the preview uses sample example.com data.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Client } from "../src/lib/clients.js";
import { templatesCommand, templatesNewCommand, type TemplatesNewDeps, type TemplatesNewFlags } from "../src/report-cli.js";
import { PAID_PLACEHOLDER, sampleTemplateReport } from "../src/reports/template-preview.js";
import { draftSpec } from "../src/reports/templates/new-cli.js";
import type { RunDeps } from "../src/reports/templates/run.js";
import { validateTemplateText } from "../src/reports/templates/schema.js";
import { createPrompter, PromptAbortedError, type Choice, type ChoiceGroup, type LineSource, type Prompter } from "../src/setup/prompter.js";
import { recordingUi } from "../src/setup/ui.js";
import { POSIX_MODES } from "./platform.js";

const today = new Date("2026-10-13T12:00:00Z");
const newHome = () => mkdtempSync(join(tmpdir(), "crawlmark-p13c-cli-"));
const globalFile = (home: string) => join(home, "config", "report-templates.yaml");
const EXISTING = "# Our templates: keep this comment.\nversion: 1\ntemplates:\n  short:\n    title: Short # inline\n    sections:\n      - { id: search, type: search_overview }\n";
const client = { slug: "example.com", domain: "example.com", name: "Example", trackedKeywords: [], competitors: [] } as unknown as Client;

type Answer = unknown | "default" | Error;
interface Step {
  /** The prompter method and a pattern the question must match. */
  kind: "ask" | "confirm" | "choose" | "multiselect" | "groupMultiselect";
  q: RegExp;
  a: Answer;
}

/** A Prompter that answers from a script, checking each question in order. */
function scripted(steps: Step[]): Prompter & { asked: string[]; groups: ChoiceGroup<string>[][] } {
  const asked: string[] = [];
  const groups: ChoiceGroup<string>[][] = [];
  const next = (kind: Step["kind"], question: string, dflt: unknown) => {
    asked.push(`${kind}: ${question}`);
    const s = steps.shift();
    if (!s) throw new Error(`unexpected ${kind}: ${question}`);
    if (s.kind !== kind || !s.q.test(question)) throw new Error(`expected ${s.kind} ${s.q}, got ${kind}: ${question}`);
    if (s.a instanceof Error) throw s.a;
    return s.a === "default" ? dflt : s.a;
  };
  return {
    asked,
    groups,
    async ask(q, o = {}) {
      return next("ask", q, o.default ?? "") as string;
    },
    async secret() {
      throw new Error("no secrets here");
    },
    async confirm(q, d) {
      return next("confirm", q, d) as boolean;
    },
    async choose<T extends string>(q: string, _c: readonly Choice<T>[], d: T) {
      return next("choose", q, d) as T;
    },
    async multiselect<T extends string>(q: string, _c: readonly Choice<T>[], d: readonly T[]) {
      return next("multiselect", q, [...d]) as T[];
    },
    async groupMultiselect<T extends string>(q: string, g: readonly ChoiceGroup<T>[], d: readonly T[]) {
      groups.push(g as unknown as ChoiceGroup<string>[]);
      return next("groupMultiselect", q, [...d]) as T[];
    },
    close() {},
  };
}

/** RunDeps for estimates only: DataForSEO at $0.025 per provider section; anything else unused. */
function fakeRunDeps(): RunDeps {
  return {
    planProviderSection: async () => ({ estimate: { provider: "dataforseo", usd: 0.025, units: 0, requests: 1, reused: false, parts: ["summary"] }, run: async () => { throw new Error("no run in tests"); } }),
    gapCompetitors: () => {
      throw new Error("no saved competitors for example.com");
    },
    localProfileEstimateUsd: () => 0,
    aiVisibilityEnabled: () => false,
  } as unknown as RunDeps;
}

function setup(steps: Step[], opts: { file?: string; interactive?: boolean; runDeps?: () => Promise<RunDeps>; existing?: string | null } = {}) {
  const home = newHome();
  const reportsDir = join(home, "reports");
  if (opts.existing !== null) {
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(globalFile(home), opts.existing ?? EXISTING, { mode: 0o600 });
  }
  const ui = recordingUi();
  const prompt = scripted(steps);
  const out: string[] = [];
  const warn: string[] = [];
  const deps: TemplatesNewDeps = {
    interactive: opts.interactive ?? true,
    ui: async () => ({ ui, prompt }),
    resolveClient: (id) => {
      if (id !== "example.com") throw new Error(`No client "${id}" in clients.yaml.`);
      return client;
    },
    runDeps: opts.runDeps ?? (async () => fakeRunDeps()),
    reportsDir,
    version: "0.0.0-test",
    cliDisplay: "crawlmark-cli",
  };
  const run = (flags: TemplatesNewFlags = {}, args: string[] = []) => templatesNewCommand(args, flags, { out: (l = "") => out.push(l), warn: (l) => warn.push(l), homeDir: home, cwd: home, today }, deps);
  return { home, reportsDir, ui, prompt, out, warn, run };
}

/** The usual answers after the sections question. */
const tail = (period: unknown = "last_quarter"): Step[] => [
  { kind: "multiselect", q: /^Optional sections/, a: "default" },
  { kind: "choose", q: /^Report period/, a: period },
  { kind: "multiselect", q: /^Compare with/, a: "default" },
  { kind: "choose", q: /^Layout/, a: "default" },
];

describe("report templates new", () => {
  it("saves a free-only template that validate accepts; the file's comments are still there and only the new block is added", async () => {
    const t = setup([
      { kind: "ask", q: /^Template id/, a: "board" },
      { kind: "ask", q: /^Title/, a: "Quarterly board pack" },
      { kind: "groupMultiselect", q: /^Sections to include/, a: ["search_overview", "technical_issues", "indexing_issues"] },
      ...tail(),
      { kind: "confirm", q: /no default report format/, a: "default" },
      { kind: "choose", q: /^Save this template\?/, a: "save" },
    ]);
    expect(await t.run({ client: "example.com" })).toBe(0);
    const text = readFileSync(globalFile(t.home), "utf8");
    expect(text.startsWith(EXISTING)).toBe(true);
    expect(text).toContain("# Our templates: keep this comment.");
    expect(text).toContain("# inline");
    expect(text.slice(EXISTING.length)).toBe(
      "  board:\n    title: Quarterly board pack\n    period: { range: last_quarter }\n    compare: [ previous_period, previous_year ]\n    sections:\n      - { id: search, type: search_overview }\n      - { id: issues, type: technical_issues }\n      - { id: indexing, type: indexing_issues }\n",
    );
    if (POSIX_MODES) expect(statSync(globalFile(t.home)).mode & 0o777).toBe(0o600);
    expect(readFileSync(`${globalFile(t.home)}.bak`, "utf8")).toBe(EXISTING);
    // `report templates validate` accepts it.
    const lines: string[] = [];
    expect(templatesCommand("validate", [], { out: (l = "") => lines.push(l), warn: (l) => lines.push(l), homeDir: t.home, cwd: t.home, today })).toBe(0);
    expect(lines.join("\n")).toContain("is valid");
    // The preview (sample data) was written under .preview with 0600 in 0700 folders, and the diff shown.
    const preview = join(t.reportsDir, ".preview", "example.com", "board.html");
    if (POSIX_MODES) expect(statSync(preview).mode & 0o777).toBe(0o600);
    if (POSIX_MODES) expect(statSync(join(t.reportsDir, ".preview")).mode & 0o777).toBe(0o700);
    expect(readFileSync(preview, "utf8")).toContain("Sample data");
    expect(t.ui.events.some((e) => e.startsWith("preview: Changes to ") && e.includes("+  board:"))).toBe(true);
    expect(t.ui.events.some((e) => e.includes('Saved template "board" (validated)'))).toBe(true);
    expect(t.ui.events.some((e) => e.includes("crawlmark-cli report --client example.com --template board"))).toBe(true);
  });

  it("labels sections free or paid with this client's estimate, and declines a paid section by default", async () => {
    const t = setup([
      { kind: "ask", q: /^Template id/, a: "board" },
      { kind: "ask", q: /^Title/, a: "default" },
      { kind: "groupMultiselect", q: /^Sections to include/, a: ["search_overview", "backlinks"] },
      { kind: "confirm", q: /^Include Backlinks\? It costs about \$0\.025 \(DataForSEO\) every time the report runs with --paid/, a: "default" },
      ...tail("last_month"),
      { kind: "confirm", q: /no default report format/, a: "default" },
      { kind: "choose", q: /^Save this template\?/, a: "save" },
    ]);
    expect(await t.run({ client: "example.com" })).toBe(0);
    const labels = t.prompt.groups[0]!.flatMap((g) => g.choices.map((c) => c.label));
    expect(labels).toContain("Search performance (free)");
    expect(labels).toContain("Backlinks (paid \u00b7 DataForSEO \u00b7 ~$0.025 per run for example.com)");
    expect(labels).toContain("Bing search performance (free \u00b7 needs BING_WEBMASTER_API_KEY)");
    expect(t.prompt.groups[0]!.map((g) => g.label)).toEqual(["Search Console", "Analytics", "Site health", "SEO data (paid)", "Local search", "AI search", "Other"]);
    const r = validateTemplateText(readFileSync(globalFile(t.home), "utf8"), { today });
    expect(r.value!.templates!.board!.sections.map((s) => s.type)).toEqual(["search_overview"]);
    expect(r.value!.templates!.board!.title).toBe("Board");
  });

  it("an accepted paid section is saved with paid: true and optional, and the hint says --paid", async () => {
    const t = setup([
      { kind: "ask", q: /^Template id/, a: "board" },
      { kind: "ask", q: /^Title/, a: "default" },
      { kind: "groupMultiselect", q: /^Sections to include/, a: ["search_overview", "backlinks"] },
      { kind: "confirm", q: /^Include Backlinks\?/, a: true },
      ...tail("last_month"),
      { kind: "confirm", q: /no default report format/, a: true },
      { kind: "multiselect", q: /^Default report format/, a: ["pdf", "docx"] },
      { kind: "choose", q: /^Save this template\?/, a: "save" },
    ]);
    expect(await t.run({ client: "example.com" })).toBe(0);
    const text = readFileSync(globalFile(t.home), "utf8");
    expect(text).toContain("- { id: backlinks, type: backlinks, optional: true, paid: true }");
    expect(text).toContain("defaults:\n  formats: [ pdf, docx ]\n");
    expect(t.ui.events.some((e) => e.includes("--include backlinks and --paid"))).toBe(true);
  });

  it("change something, then cancel: nothing written", async () => {
    const t = setup([
      { kind: "ask", q: /^Template id/, a: "board" },
      { kind: "ask", q: /^Title/, a: "default" },
      { kind: "groupMultiselect", q: /^Sections/, a: ["search_overview"] },
      ...tail(),
      { kind: "confirm", q: /no default report format/, a: false },
      { kind: "choose", q: /^Save this template\?/, a: "change" },
      { kind: "choose", q: /^What would you like to change/, a: "layout" },
      { kind: "choose", q: /^Layout/, a: "onepage" },
      { kind: "choose", q: /^Save this template\?/, a: "cancel" },
    ]);
    expect(await t.run()).toBe(0);
    expect(readFileSync(globalFile(t.home), "utf8")).toBe(EXISTING);
    expect(existsSync(`${globalFile(t.home)}.bak`)).toBe(false);
    expect(t.ui.events).toContain("result: skipped: Nothing saved.");
  });

  it("Ctrl-C at any point writes nothing (exit 130)", async () => {
    const t = setup([
      { kind: "ask", q: /^Template id/, a: "board" },
      { kind: "ask", q: /^Title/, a: "default" },
      { kind: "groupMultiselect", q: /^Sections/, a: new PromptAbortedError() },
    ]);
    expect(await t.run({ client: "example.com" })).toBe(130);
    expect(t.warn).toContain("Cancelled; nothing written.");
    expect(readFileSync(globalFile(t.home), "utf8")).toBe(EXISTING);
    expect(existsSync(join(t.reportsDir, ".preview"))).toBe(false);
  });

  it("refuses an id already in the file or a builtin unless --replace", async () => {
    const t = setup([
      { kind: "ask", q: /^Template id/, a: "short" },
      { kind: "ask", q: /^Template id/, a: "monthly" },
      { kind: "ask", q: /^Template id/, a: "Bad Id" },
    ]);
    expect(await t.run()).toBe(1);
    expect(t.ui.events.join("\n")).toMatch(/already in .*--replace/);
    expect(t.ui.events.join("\n")).toMatch(/builtin template/);
    expect(readFileSync(globalFile(t.home), "utf8")).toBe(EXISTING);
  });

  it("without --client: no estimates (no run deps loaded), sample preview under .preview/example.com, paid shown as (paid)", async () => {
    const t = setup(
      [
        { kind: "ask", q: /^Template id/, a: "exec" },
        { kind: "ask", q: /^Title/, a: "default" },
        { kind: "groupMultiselect", q: /^Sections/, a: ["search_overview", "query_movers", "page_movers", "opportunities", "competitor_overview"] },
        { kind: "confirm", q: /^Include Competitors\? It costs money every time the report runs with --paid \(the amount depends/, a: true },
        ...tail("last_month"),
        { kind: "confirm", q: /no default report format/, a: "default" },
        { kind: "choose", q: /^Save this template\?/, a: "save" },
      ],
      {
        existing: null,
        runDeps: async () => {
          throw new Error("estimates must not load without a client");
        },
      },
    );
    expect(await t.run()).toBe(0);
    expect(t.prompt.groups[0]!.flatMap((g) => g.choices.map((c) => c.label))).toContain("Competitors (paid)");
    const html = readFileSync(join(t.reportsDir, ".preview", "example.com", "exec.html"), "utf8");
    expect(html).toContain("Paid section: shown when the report runs with");
    // A new file starts as version: 1 + templates:.
    expect(readFileSync(globalFile(t.home), "utf8").startsWith("version: 1\ntemplates:\n  exec:\n")).toBe(true);
  });

  it("--file client writes the client's own file; --dry-run writes only the preview", async () => {
    const steps = (): Step[] => [
      { kind: "ask", q: /^Template id/, a: "board" },
      { kind: "ask", q: /^Title/, a: "default" },
      { kind: "groupMultiselect", q: /^Sections/, a: ["search_overview"] },
      ...tail(),
      { kind: "confirm", q: /no default report format/, a: false },
      { kind: "choose", q: /^Save this template\?/, a: "save" },
    ];
    const dry = setup(steps());
    expect(await dry.run({ client: "example.com", file: "client", "dry-run": true })).toBe(0);
    expect(existsSync(join(dry.home, "config", "report-templates", "example.com.yaml"))).toBe(false);
    expect(existsSync(join(dry.reportsDir, ".preview", "example.com", "board.html"))).toBe(true);
    expect(dry.ui.events.some((e) => e.includes("Dry run: would save"))).toBe(true);

    const real = setup(steps());
    expect(await real.run({ client: "example.com", file: "client" })).toBe(0);
    expect(existsSync(join(real.home, "config", "report-templates", "example.com.yaml"))).toBe(true);
    expect(readFileSync(globalFile(real.home), "utf8")).toBe(EXISTING);
  });

  it("needs a terminal; --yes creates nothing; flags are checked", async () => {
    const t = setup([], { interactive: false });
    expect(await t.run()).toBe(1);
    expect(t.warn.join("\n")).toMatch(/templates new is interactive; write the YAML and run `crawlmark-cli report templates validate`/);
    expect(await t.run({ yes: true })).toBe(0);
    expect(t.out.join("\n")).toMatch(/Nothing created/);
    expect(await t.run({ file: "elsewhere" })).toBe(1);
    expect(await t.run({ file: "client" })).toBe(1);
    expect(await t.run({}, ["extra"])).toBe(1);
    expect(await setup([]).run({ client: "nope.example" })).toBe(1);
    expect(readFileSync(globalFile(t.home), "utf8")).toBe(EXISTING);
  });

  it("stops before asking anything when the target file is invalid", async () => {
    const t = setup([], { existing: "version: 1\ntemplates: [\n" });
    expect(await t.run()).toBe(1);
    expect(t.ui.events.join("\n")).toMatch(/has errors; fix it first/);
  });
});

describe("report templates new: text blocks", () => {
  const blockTail = (): Step[] => [
    { kind: "multiselect", q: /^Optional sections/, a: "default" },
    { kind: "choose", q: /^Report period/, a: "last_month" },
    { kind: "multiselect", q: /^Compare with/, a: "default" },
    { kind: "choose", q: /^Layout/, a: "default" },
    { kind: "confirm", q: /no default report format/, a: false },
    { kind: "choose", q: /^Save this template\?/, a: "save" },
  ];

  it("creates a template with a new text block and saves both; the block shows in the template and the file validates", async () => {
    const t = setup(
      [
        { kind: "ask", q: /^Template id/, a: "board" },
        { kind: "ask", q: /^Title/, a: "Board pack" },
        { kind: "groupMultiselect", q: /^Sections to include/, a: ["search_overview", "block"] },
        { kind: "ask", q: /^Block id/, a: "glossary" },
        { kind: "ask", q: /^Block title/, a: "Glossary" },
        { kind: "ask", q: /^Block text/, a: "CTR is clicks divided by impressions." },
        ...blockTail(),
      ],
    );
    expect(await t.run({ client: "example.com" })).toBe(0);
    const text = readFileSync(globalFile(t.home), "utf8");
    expect(text.startsWith(EXISTING)).toBe(true);
    expect(text).toContain("type: block, block: glossary");
    expect(text).toMatch(/blocks:\n {2}glossary:\n {4}title: Glossary\n {4}text: /);
    expect(text).toContain("CTR is clicks divided by impressions.");
    expect(t.out.join("\n") + t.ui.events.join("\n")).not.toMatch(/can't save a new text block/);
    // The preview was made with the new block, and `validate` accepts the saved file.
    expect(existsSync(join(t.reportsDir, ".preview", "example.com", "board.html"))).toBe(true);
    expect(readFileSync(join(t.reportsDir, ".preview", "example.com", "board.html"), "utf8")).toContain("CTR is clicks divided by impressions.");
    const lines: string[] = [];
    expect(templatesCommand("validate", [], { out: (l = "") => lines.push(l), warn: (l) => lines.push(l), homeDir: t.home, cwd: t.home, today })).toBe(0);
  });

  it("a client file can pick a block that lives in the global file; nothing is copied into the client file", async () => {
    const existing = `${EXISTING}blocks:\n  method:\n    title: Method\n    text: How the numbers were counted.\n`;
    const t = setup(
      [
        { kind: "ask", q: /^Template id/, a: "board" },
        { kind: "ask", q: /^Title/, a: "Board pack" },
        { kind: "groupMultiselect", q: /^Sections to include/, a: ["search_overview", "block"] },
        { kind: "choose", q: /^Which text block/, a: "method" },
        ...blockTail(),
      ],
      { existing },
    );
    expect(await t.run({ client: "example.com", file: "client" })).toBe(0);
    const clientFile = readFileSync(join(t.home, "config", "report-templates", "example.com.yaml"), "utf8");
    expect(clientFile).toContain("type: block, block: method");
    expect(clientFile).not.toContain("blocks:");
    expect(readFileSync(globalFile(t.home), "utf8")).toBe(existing);
    const lines: string[] = [];
    expect(templatesCommand("validate", [join(t.home, "config", "report-templates", "example.com.yaml")], { out: (l = "") => lines.push(l), warn: (l) => lines.push(l), homeDir: t.home, cwd: t.home, today })).toBe(0);
  });
});

describe("draft spec and preview", () => {
  it("paid sections carry paid: true; Tag Manager is always optional; the note keeps its text", () => {
    const spec = draftSpec({ title: "T", types: ["backlinks", "tag_manager", "text"], text: "Hello", optional: new Set(), period: { range: "last_month" }, compare: [], layout: "onepage" });
    expect(spec).toEqual({
      title: "T",
      period: { range: "last_month" },
      compare: [],
      layout: "onepage",
      sections: [
        { id: "backlinks", type: "backlinks", paid: true },
        { id: "gtm", type: "tag_manager", optional: true },
        { id: "note", type: "text", text: "Hello" },
      ],
    });
  });

  it("the sample report uses example.com sample numbers for the draft's sections and placeholders elsewhere", () => {
    const r = sampleTemplateReport("board", { title: "Board", compare: ["previous_period"], sections: [{ id: "search", type: "search_overview" }, { id: "backlinks", type: "backlinks", paid: true }, { id: "issues", type: "technical_issues" }] });
    expect(r.client.domain).toBe("example.com");
    expect(r.period.comparisons.previous_year).toBeUndefined();
    expect(r.sections.map((s) => [s.id, s.type, s.status])).toEqual([["search", "search_overview", "ok"], ["backlinks", "text", "ok"], ["issues", "text", "ok"]]);
    expect((r.sections[1] as { data: { text: string } }).data.text).toBe(PAID_PLACEHOLDER);
  });
});

describe("plain grouped multiselect", () => {
  it("lists choices under group headings, numbered across groups, and parses numbers or names", async () => {
    const lines: string[] = [];
    const answers = ["9", "1,3"];
    const src: LineSource = { line: async () => answers.shift()!, secret: async () => "", close() {} };
    const p = createPrompter(src, (s) => lines.push(s));
    const groups: ChoiceGroup<string>[] = [
      { label: "Search Console", choices: [{ value: "a", label: "A (free)" }, { value: "b", label: "B (free)" }] },
      { label: "SEO data (paid)", choices: [{ value: "c", label: "C (paid)" }] },
    ];
    expect(await p.groupMultiselect!("Sections", groups, ["a"])).toEqual(["a", "c"]);
    expect(lines).toEqual(["Sections", "  Search Console", "    1) A (free) (default)", "    2) B (free)", "  SEO data (paid)", "    3) C (paid)", "Not one of the options: 9."]);
  });
});

describe("clack grouped multiselect", () => {
  const CANCEL = Symbol("cancel");
  const groups: ChoiceGroup<string>[] = [
    { label: "Search Console", choices: [{ value: "a", label: "A (free)" }] },
    { label: "SEO data (paid)", choices: [{ value: "c", label: "C (paid)" }] },
  ];
  const fns = (answer: unknown, withGroups: boolean) => {
    const calls: { fn: string; opts: Record<string, unknown> }[] = [];
    const rec = (fn: string) => async (opts: Record<string, unknown>) => (calls.push({ fn, opts }), answer);
    return {
      calls,
      fns: {
        text: rec("text"),
        password: rec("password"),
        confirm: rec("confirm"),
        select: rec("select"),
        multiselect: rec("multiselect"),
        ...(withGroups ? { groupMultiselect: rec("groupMultiselect") } : {}),
        isCancel: (v: unknown) => v === CANCEL,
      } as never,
    };
  };

  it("passes the groups to clack, non-selectable headings, nothing required; Ctrl-C aborts", async () => {
    const { clackPrompter } = await import("../src/setup/ui-clack.js");
    const f = fns(["c"], true);
    expect(await clackPrompter(f.fns).groupMultiselect!("Sections", groups, ["a"])).toEqual(["c"]);
    expect(f.calls[0]).toMatchObject({
      fn: "groupMultiselect",
      opts: { message: "Sections", initialValues: ["a"], required: false, selectableGroups: false, options: { "Search Console": [{ value: "a", label: "A (free)" }], "SEO data (paid)": [{ value: "c", label: "C (paid)" }] } },
    });
    await expect(clackPrompter(fns(CANCEL, true).fns).groupMultiselect!("Sections", groups, [])).rejects.toBeInstanceOf(PromptAbortedError);
  });

  it("falls back to a flat multiselect with the group in each label", async () => {
    const { clackPrompter } = await import("../src/setup/ui-clack.js");
    const f = fns(["a"], false);
    expect(await clackPrompter(f.fns).groupMultiselect!("Sections", groups, [])).toEqual(["a"]);
    expect(f.calls[0]!.fn).toBe("multiselect");
    expect((f.calls[0]!.opts.options as { label: string }[]).map((o) => o.label)).toEqual(["Search Console: A (free)", "SEO data (paid): C (paid)"]);
  });
});
