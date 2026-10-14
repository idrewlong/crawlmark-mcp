/** Phase 13 C: template file writes (write.ts): comment-preserving edits, validation, path and symlink safety, .bak, 0600. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STARTER_YAML } from "../src/reports/templates/builtin.js";
import { loadTemplates } from "../src/reports/templates/load.js";
import { defaultSection, templateCatalogue, costLabel } from "../src/reports/templates/builder.js";
import { SECTION_TYPES, validateTemplateText } from "../src/reports/templates/schema.js";
import { applyTemplateWrite, assertSafeTarget, planTemplateWrite, TemplateFileChangedError, TemplateWriteError, unifiedDiff } from "../src/reports/templates/write.js";

const today = new Date("2026-10-13T12:00:00Z");
const newHome = () => mkdtempSync(join(tmpdir(), "crawlmark-p13c-"));
const globalFile = (home: string) => join(home, "config", "report-templates.yaml");
const board = { title: "Quarterly board pack", period: { range: "last_quarter" }, sections: [{ id: "search", type: "search_overview" }, { id: "issues", type: "technical_issues" }] };

function withFile(text: string) {
  const home = newHome();
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(globalFile(home), text, { mode: 0o600 });
  return home;
}

const COMMENTED = `# My agency's templates. Keep this comment.
version: 1
branding:
  agencyName: Example Agency # inline comment stays
defaults:
  template: monthly
templates:
  # The short one
  short:
    title: Short report
    sections:
      - { id: search, type: search_overview } # first section
      - { id: queries, type: top_queries, limit: 10 }
`;

describe("planTemplateWrite / applyTemplateWrite", () => {
  it("adds a template while keeping comments, key order and the other templates; the diff only adds lines", () => {
    const home = withFile(COMMENTED);
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: board, today });
    expect(plan.exists).toBe(true);
    expect(plan.replaces).toBe(false);
    expect(plan.after.startsWith(COMMENTED.trimEnd())).toBe(true);
    for (const c of ["# My agency's templates. Keep this comment.", "# inline comment stays", "# The short one", "# first section"]) expect(plan.after).toContain(c);
    const changed = plan.diff.split("\n").filter((l) => /^[-+](?![-+]{2} )/.test(l));
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((l) => l.startsWith("+"))).toBe(true);
    expect(plan.diff).toContain("--- a/report-templates.yaml");
    expect(plan.yaml).toContain("board:");
    expect(plan.yaml).toContain("- { id: search, type: search_overview }");
    expect(plan.paidSections).toEqual([]);
    // Nothing written by planning.
    expect(readFileSync(globalFile(home), "utf8")).toBe(COMMENTED);
    const r = applyTemplateWrite(plan, home, today);
    expect(r.backup).toBe(`${globalFile(home)}.bak`);
    expect(readFileSync(r.backup!, "utf8")).toBe(COMMENTED);
    expect(readFileSync(globalFile(home), "utf8")).toBe(plan.after);
    expect(statSync(globalFile(home)).mode & 0o777).toBe(0o600);
    expect(statSync(r.backup!).mode & 0o777).toBe(0o600);
    expect(validateTemplateText(plan.after, { today }).valid).toBe(true);
  });

  it("keeps the starter file's comments too", () => {
    const home = withFile(STARTER_YAML);
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: board, today });
    expect(plan.after.startsWith(STARTER_YAML.trimEnd())).toBe(true);
  });

  it("starts a new file as version: 1 + templates: (not the starter), with no backup", () => {
    const home = newHome();
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: board, today });
    expect(plan.exists).toBe(false);
    expect(plan.beforeHash).toBeNull();
    expect(plan.after.startsWith("version: 1\ntemplates:\n  board:\n")).toBe(true);
    expect(plan.diff.startsWith("--- /dev/null\n+++ b/report-templates.yaml\n@@ -0,0 +1,")).toBe(true);
    const r = applyTemplateWrite(plan, home, today);
    expect(r.backup).toBeNull();
    expect(statSync(join(home, "config")).mode & 0o777).toBe(0o700);
    expect(statSync(globalFile(home)).mode & 0o777).toBe(0o600);
  });

  it("writes a client's file under config/report-templates/", () => {
    const home = newHome();
    const plan = planTemplateWrite({ homeDir: home, file: "client", clientSlug: "example.com", id: "board", mode: "create", template: board, today });
    expect(plan.path).toBe(join(home, "config", "report-templates", "example.com.yaml"));
    applyTemplateWrite(plan, home, today);
    expect(statSync(join(home, "config", "report-templates")).mode & 0o777).toBe(0o700);
    expect(() => planTemplateWrite({ homeDir: home, file: "client", id: "board", mode: "create", template: board, today })).toThrow(/needs a client/);
  });

  it("refuses an invalid result before writing, with YAML paths", () => {
    const home = withFile(COMMENTED);
    let err: unknown;
    try {
      planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: { title: "X", sections: [{ id: "b", type: "backlinks" }, { id: "x", type: "nope" }] }, today });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TemplateWriteError);
    const paths = (err as TemplateWriteError).errors.map((e) => e.path);
    expect(paths).toContain("templates.board.sections[1].type");
    // Unknown fields (branding inside a template, say) are refused by the strict schema.
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "b2", mode: "create", template: { ...board, branding: { agencyName: "X" } }, today })).toThrow(TemplateWriteError);
    expect(readFileSync(globalFile(home), "utf8")).toBe(COMMENTED);
    expect(existsSync(`${globalFile(home)}.bak`)).toBe(false);
  });

  it("paid sections need paid: true and are listed", () => {
    const home = newHome();
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "p", mode: "create", template: { title: "P", sections: [{ id: "backlinks", type: "backlinks" }] }, today })).toThrow(/paid: true/);
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "p", mode: "create", template: { title: "P", sections: [{ id: "backlinks", type: "backlinks", paid: true, optional: true }] }, today });
    expect(plan.paidSections).toEqual([{ id: "backlinks", type: "backlinks" }]);
  });

  it("an existing id needs replace; a builtin id needs replace and warns", () => {
    const home = withFile(COMMENTED);
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "create", template: board, today })).toThrow(/already in the global template file/);
    const re = planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "create", template: board, replace: true, today });
    expect(re.replaces).toBe(true);
    expect(re.after).toContain("# My agency's templates.");
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "monthly", mode: "create", template: board, today })).toThrow(/builtin template/);
    const shadow = planTemplateWrite({ homeDir: home, file: "global", id: "monthly", mode: "create", template: board, replace: true, today });
    expect(shadow.shadowsBuiltin).toBe(true);
    expect(shadow.warnings.map((w) => w.message).join(" ")).toMatch(/hides the builtin "monthly"/);
  });

  it("update: patch adds and removes sections and sets fields, keeping comments; the id must exist in the file", () => {
    const home = withFile(COMMENTED);
    const plan = planTemplateWrite({
      homeDir: home,
      file: "global",
      id: "short",
      mode: "update",
      patch: { addSections: [{ id: "issues", type: "technical_issues", optional: true }], removeSectionIds: ["queries"], set: { title: "Short monthly", layout: "onepage" } },
      today,
    });
    expect(plan.template.sections.map((s) => s.id)).toEqual(["search", "issues"]);
    expect(plan.template.title).toBe("Short monthly");
    expect(plan.template.layout).toBe("onepage");
    expect(plan.after).toContain("# first section");
    expect(plan.after).toContain("# The short one");
    // Only the touched lines change.
    expect(plan.diff).toContain("-    title: Short report\n+    title: Short monthly\n+    layout: onepage\n");
    expect(plan.diff).toContain("-      - { id: queries, type: top_queries, limit: 10 }\n+      - { id: issues, type: technical_issues, optional: true }\n");
    expect(plan.warnings).toEqual([]);
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "monthly", mode: "update", patch: { set: { title: "x" } }, today })).toThrow(/no template "monthly".*builtin/);
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { removeSectionIds: ["nope"] }, today })).toThrow(/no section "nope"/);
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { set: { branding: {} } as never }, today })).toThrow(/can't change "branding"/);
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { addSections: [{ id: "x", type: "bogus" }] }, today })).toThrow(/addSections\[0\]/);
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: {}, today })).toThrow(/changes nothing/);
  });

  it("sets defaults.formats only when the file has none", () => {
    const home = withFile(COMMENTED);
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: board, defaultFormats: ["pdf", "docx"], today });
    expect(plan.after).toMatch(/defaults:\n  template: monthly\n  formats: \[ pdf, docx \]/);
    const starter = withFile(STARTER_YAML);
    const kept = planTemplateWrite({ homeDir: starter, file: "global", id: "board", mode: "create", template: board, defaultFormats: ["docx"], today });
    expect(kept.after).toContain("formats: [pdf]");
    expect(kept.after).not.toContain("docx ]");
  });

  it("refuses a symlinked file or folder and paths outside the config home", () => {
    const home = newHome();
    const elsewhere = newHome();
    writeFileSync(join(elsewhere, "target.yaml"), "version: 1\n");
    mkdirSync(join(home, "config"), { recursive: true });
    symlinkSync(join(elsewhere, "target.yaml"), globalFile(home));
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: board, today })).toThrow(/symlink/);

    const home2 = newHome();
    mkdirSync(join(home2, "config"), { recursive: true });
    symlinkSync(elsewhere, join(home2, "config", "report-templates"));
    expect(() => planTemplateWrite({ homeDir: home2, file: "client", clientSlug: "example.com", id: "board", mode: "create", template: board, today })).toThrow(/symlink/);

    const home3 = newHome();
    symlinkSync(elsewhere, join(home3, "config"));
    expect(() => planTemplateWrite({ homeDir: home3, file: "global", id: "board", mode: "create", template: board, today })).toThrow(/symlink/);

    expect(() => assertSafeTarget(home, join(home, "config", "clients.yaml"))).toThrow(/only/);
    expect(() => assertSafeTarget(home, join(home, ".env"))).toThrow(/live under/);
    expect(() => assertSafeTarget(home, join(home, "config", "report-templates", "..", "..", "x.yaml"))).toThrow();
    expect(readFileSync(join(elsewhere, "target.yaml"), "utf8")).toBe("version: 1\n");
  });

  it("apply refuses when the file changed, appeared or went since the plan", () => {
    const home = withFile(COMMENTED);
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: board, today });
    writeFileSync(globalFile(home), `${COMMENTED}# hand edit\n`);
    expect(() => applyTemplateWrite(plan, home, today)).toThrow(TemplateFileChangedError);
    expect(readFileSync(globalFile(home), "utf8")).toContain("# hand edit");

    const fresh = newHome();
    const p2 = planTemplateWrite({ homeDir: fresh, file: "global", id: "board", mode: "create", template: board, today });
    mkdirSync(join(fresh, "config"), { recursive: true });
    writeFileSync(globalFile(fresh), "version: 1\n");
    expect(() => applyTemplateWrite(p2, fresh, today)).toThrow(/was created/);
  });

  it("falls back to a standard layout (comments kept, with a warning) when the file can't be edited line by line", () => {
    const home = withFile("# flow style\nversion: 1\ntemplates: { short: { title: S, sections: [{ id: search, type: search_overview }] } }\n");
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: board, today });
    expect(plan.after).toContain("# flow style");
    expect(plan.template.title).toBe("Quarterly board pack");
    expect(plan.warnings.map((w) => w.message).join(" ")).toMatch(/standard layout/);
  });

  it("refuses an invalid existing file rather than editing around it", () => {
    const home = withFile("version: 1\ntemplates:\n  bad: { title: B, sections: [] }\n");
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: board, today })).toThrow(TemplateWriteError);
    const broken = withFile("version: 1\ntemplates: [\n");
    expect(() => planTemplateWrite({ homeDir: broken, file: "global", id: "board", mode: "create", template: board, today })).toThrow(/isn't valid YAML/);
  });
});

describe("in-place edits: line endings, comments, aliases, version (review)", () => {
  it("a CRLF file stays CRLF and only gains lines", () => {
    const crlf = COMMENTED.replace(/\n/g, "\r\n");
    const home = withFile(crlf);
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: board, today });
    expect(plan.warnings).toEqual([]);
    expect(plan.after.startsWith(crlf)).toBe(true);
    expect(plan.after.replace(/\r\n/g, "")).not.toContain("\n");
    expect(plan.after.slice(crlf.length)).toContain("  board:\r\n    title: Quarterly board pack\r\n");
  });

  it("patch.set keeps a trailing comment on the replaced line", () => {
    const home = withFile("version: 1\ntemplates:\n  short:\n    title: Short report # client asked for this name\n    sections:\n      - { id: search, type: search_overview }\n");
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { set: { title: "Short monthly" } }, today });
    expect(plan.warnings).toEqual([]);
    expect(plan.after).toContain("    title: Short monthly # client asked for this name\n");
  });

  it("replacing a template that other templates use through an alias is refused with a clear error", () => {
    const text = "version: 1\ntemplates:\n  base: &base\n    title: Base\n    sections:\n      - { id: search, type: search_overview }\n  copy: *base\n";
    const home = withFile(text);
    let err: unknown;
    try {
      planTemplateWrite({ homeDir: home, file: "global", id: "base", mode: "create", template: board, replace: true, today });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TemplateWriteError);
    expect((err as Error).message).toBe("templates.base is used through an alias elsewhere in this file; fix it by hand first.");
    expect(readFileSync(globalFile(home), "utf8")).toBe(text);
  });

  it("a file without version: gets it at the top and is still edited line by line", () => {
    const text = "templates:\n  short:\n    title: Short\n    sections:\n      - { id: search, type: search_overview } # mine\n";
    const home = withFile(text);
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: board, today });
    expect(plan.warnings).toEqual([]);
    expect(plan.after.startsWith(`version: 1\n${text}`)).toBe(true);
  });
});

describe("text fields refuse control and invisible characters (SEC-3)", () => {
  const ch = (...codes: number[]) => String.fromCharCode(...codes);
  const ESC = ch(0x1b);
  const BEL = ch(0x07);
  const RLO = ch(0x202e);
  const ZWSP = ch(0x200b);
  const bad = [`Board ${ESC}[31mred`, `${ESC}]8;;https://evil.example${BEL}Click${ESC}]8;;${BEL}`, `Bell${BEL}`, `Board ${RLO}kcap`, `Zero${ZWSP}width`, `Two\nlines ${ESC}[0m`];
  const yamlOf = (t: object) => `version: 1\ntemplates:\n  t: ${JSON.stringify(t)}\n`;
  const errs = (t: object) => validateTemplateText(yamlOf(t), { today }).errors;

  it("template title, description and section title", () => {
    for (const s of bad) {
      expect(errs({ title: s, sections: [{ id: "a", type: "search_overview" }] }).map((e) => e.path), JSON.stringify(s)).toContain("templates.t.title");
      expect(errs({ title: "T", description: s, sections: [{ id: "a", type: "search_overview" }] }).map((e) => e.path), JSON.stringify(s)).toContain("templates.t.description");
      expect(errs({ title: "T", sections: [{ id: "a", type: "search_overview", title: s }] }).map((e) => e.path), JSON.stringify(s)).toContain("templates.t.sections[0].title");
    }
    expect(errs({ title: "Caf\u00e9 board \u2013 Q3", description: "Plain text, accents and dashes are fine", sections: [{ id: "a", type: "search_overview", title: "Search" }] })).toEqual([]);
  });

  it("one-line fields collapse line breaks and tabs instead of refusing them", () => {
    const r = validateTemplateText(yamlOf({ title: "Two\nlines", description: "Tab\there", sections: [{ id: "a", type: "search_overview", title: " Search\n" }] }), { today });
    expect(r.errors).toEqual([]);
    expect(r.value!.templates!.t).toMatchObject({ title: "Two lines", description: "Tab here", sections: [{ title: "Search" }] });
  });

  it("folded (>) and literal (|) blocks for description and title validate and load", () => {
    for (const style of [">", "|"]) {
      const text = `version: 1\ntemplates:\n  t:\n    title: ${style}\n      Quarterly\n      board pack\n    description: ${style}\n      For the board,\n      every quarter.\n    sections:\n      - id: a\n        type: search_overview\n        title: ${style}\n          Search\n`;
      const r = validateTemplateText(text, { today });
      expect(r.errors, style).toEqual([]);
      expect(r.value!.templates!.t, style).toMatchObject({ title: "Quarterly board pack", description: "For the board, every quarter.", sections: [{ title: "Search" }] });
      const home = withFile(text);
      const loaded = loadTemplates({ homeDir: home, today });
      expect(loaded.files.global.valid, style).toBe(true);
      expect(loaded.templates.get("t")?.spec.title, style).toBe("Quarterly board pack");
    }
  });

  it("the text section allows newlines and tabs only", () => {
    expect(errs({ title: "T", sections: [{ id: "n", type: "text", text: "Line one\n\tLine two" }] })).toEqual([]);
    for (const s of bad.slice(0, 5)) expect(errs({ title: "T", sections: [{ id: "n", type: "text", text: s }] }).map((e) => e.path), JSON.stringify(s)).toContain("templates.t.sections[0].text");
  });

  it("a proposal with an escape in the title is refused before anything is written", () => {
    const home = newHome();
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: { ...board, title: `X${ESC}]8;;https://evil.example${BEL}` }, today })).toThrow(/control or invisible/);
    expect(existsSync(globalFile(home))).toBe(false);
  });
});

describe("unifiedDiff", () => {
  it("gives standard hunks with context, and nothing for equal text", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toBe("");
    const d = unifiedDiff("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "1\n2\n3\n4\nfive\n6\n7\n8\n9\n10\n");
    expect(d).toBe("--- a\n+++ b\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n");
  });

  it("is capped at 20,000 characters", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const d = unifiedDiff("", big);
    expect(d.length).toBeLessThanOrEqual(20_000);
    expect(d).toMatch(/diff truncated/);
  });
});

describe("builder catalogue", () => {
  it("covers every section type, grouped, with default ids that are valid and unique", () => {
    const cat = templateCatalogue();
    expect(cat.map((c) => c.type).sort()).toEqual([...SECTION_TYPES].sort());
    expect(new Set(cat.map((c) => c.defaultId)).size).toBe(cat.length);
    expect(cat.filter((c) => c.paid).map((c) => c.type).sort()).toEqual(["ai_visibility", "backlinks", "competitor_overview", "keyword_gap", "local_profile", "organic_visibility"]);
    // Every default section is valid on its own (paid ones carry paid: true; tag_manager is optional).
    for (const c of cat) {
      const yaml = `version: 1\ntemplates:\n  t: ${JSON.stringify({ title: "T", sections: [defaultSection(c.type)] })}\n`;
      expect(validateTemplateText(yaml, { today }).errors, c.type).toEqual([]);
    }
  });

  it("labels free, free-with-key and paid sections, with a per-client number when there is one", () => {
    const cat = Object.fromEntries(templateCatalogue().map((c) => [c.type, c]));
    expect(costLabel(cat.search_overview!, undefined, "example.com")).toBe("(free)");
    expect(costLabel(cat.bing_overview!, undefined, "example.com")).toBe("(free \u00b7 needs BING_WEBMASTER_API_KEY)");
    expect(costLabel(cat.backlinks!, undefined, undefined)).toBe("(paid)");
    const e = (x: object) => [{ id: "backlinks", type: "backlinks", provider: "dataforseo" as const, usd: 0.025, units: 0, requests: 1, reused: false, ...x }];
    expect(costLabel(cat.backlinks!, e({}), "example.com")).toBe("(paid \u00b7 DataForSEO \u00b7 ~$0.025 per run for example.com)");
    expect(costLabel(cat.backlinks!, e({ provider: "ahrefs", usd: 0, units: 250 }), "example.com")).toBe("(paid \u00b7 ~250 Ahrefs units per run for example.com)");
    expect(costLabel(cat.backlinks!, e({ provider: null, usd: 0 }), "example.com")).toBe("(paid \u00b7 can't run for example.com yet)");
  });
});

describe("SEC-5 and SEC-6", () => {
  it("a long run of spaces after a field doesn't stall the comment scan", () => {
    const home = withFile(`version: 1\ntemplates:\n  short:\n    title: Board${" ".repeat(200_000)}\n    sections:\n      - { id: search, type: search_overview }\n`);
    const t0 = performance.now();
    planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { set: { layout: "onepage" } }, today });
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { set: { title: "Short" } }, today });
    expect(performance.now() - t0).toBeLessThan(200);
    expect(plan.after).toContain("    title: Short\n");
  });

  it("titles refuse stacked combining marks and blank fillers; ordinary accents pass", () => {
    const ch = (...c: number[]) => String.fromCharCode(...c);
    const yamlOf = (t: object) => `version: 1\ntemplates:\n  t: ${JSON.stringify(t)}\n`;
    const errs = (t: object) => validateTemplateText(yamlOf(t), { today }).errors.map((e) => e.path);
    const bad = [`Z${ch(0x0300, 0x0301, 0x0302)}algo`, ch(0x115f), ch(0x1160), ch(0x3164), ch(0xffa0), ch(0x2800), `Board ${ch(0x3164)}`, "   "];
    for (const b of bad) {
      expect(errs({ title: b, sections: [{ id: "a", type: "search_overview" }] }), JSON.stringify(b)).toContain("templates.t.title");
      expect(errs({ title: "T", sections: [{ id: "a", type: "search_overview", title: b }] }), JSON.stringify(b)).toContain("templates.t.sections[0].title");
    }
    for (const b of bad.slice(0, 7)) expect(errs({ title: "T", description: b, sections: [{ id: "a", type: "search_overview" }] }), JSON.stringify(b)).toContain("templates.t.description");
    const ok = `Caf${ch(0xe9)} Espa${ch(0xf1)}a M${ch(0xfc)}nchen e${ch(0x0301)}`;
    expect(errs({ title: ok, description: ok, sections: [{ id: "a", type: "search_overview", title: ok }] })).toEqual([]);
  });
});
