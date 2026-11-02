/** Release 0.4.0 T4: `theme` in the template write tools (patch.set.theme, create_report_template). Temp homes, example.com only. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Client } from "../src/lib/clients.js";
import { loadTemplates } from "../src/reports/templates/load.js";
import { applyTemplateWrite, planTemplateWrite, TemplateWriteError } from "../src/reports/templates/write.js";
import { templateWriteCall, type TemplateWriteDeps } from "../src/tools/report-template-write.js";

const today = new Date("2026-11-02T12:00:00Z");
const FILE = `# keep me
version: 1
templates:
  short:
    title: Short
    sections:
      - { id: search, type: search_overview }
`;
const homeWith = () => {
  const h = mkdtempSync(join(tmpdir(), "crawlmark-t4-write-"));
  mkdirSync(join(h, "config"), { recursive: true });
  writeFileSync(join(h, "config", "report-templates.yaml"), FILE, { mode: 0o600 });
  return h;
};
const file = (h: string) => join(h, "config", "report-templates.yaml");
const exampleClient = { slug: "example.com", domain: "example.com", name: "Example" } as unknown as Client;
const deps = (home: string, extra: Partial<TemplateWriteDeps> = {}): TemplateWriteDeps => ({ homeDir: home, today, resolveClient: async () => exampleClient, estimate: async () => new Map(), ...extra });
type Proposal = { proposal: true; valid: boolean; confirmToken: string; diff: string; errors?: { path: string; message: string }[] };

describe("patch.set.theme", () => {
  it("shows a diff, keeps comments, and writes only on save", async () => {
    const home = homeWith();
    const args = { id: "short", patch: { set: { theme: "consulting" } } };
    const p = (await templateWriteCall("update_report_template", args, deps(home))) as Proposal;
    expect(p.valid).toBe(true);
    expect(p.diff).toContain("+    theme: consulting");
    expect(readFileSync(file(home), "utf8")).toBe(FILE);
    const saved = (await templateWriteCall("update_report_template", { ...args, confirmToken: p.confirmToken }, deps(home, { elicit: async () => true }))) as { saved: boolean };
    expect(saved.saved).toBe(true);
    expect(readFileSync(file(home), "utf8")).toContain("# keep me");
    expect(loadTemplates({ homeDir: home, today }).templates.get("short")!.spec.theme).toBe("consulting");
  });

  it("null removes the theme again", () => {
    const home = homeWith();
    applyTemplateWrite(planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { set: { theme: "bold" } }, today }), home, today);
    const cleared = planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { set: { theme: null } }, today });
    expect(cleared.template.theme).toBeUndefined();
    expect(cleared.after).not.toContain("theme:");
  });

  it("an invalid id is rejected with the field path, and nothing is written", async () => {
    const home = homeWith();
    const p = (await templateWriteCall("update_report_template", { id: "short", patch: { set: { theme: "neon" } } }, deps(home))) as Proposal;
    expect(p.valid).toBe(false);
    expect(p.errors!.map((e) => e.path)).toContain("templates.short.theme");
    expect(readFileSync(file(home), "utf8")).toBe(FILE);
    let err: unknown;
    try {
      planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { set: { theme: "neon" } }, today });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TemplateWriteError);
  });

  it("other unknown set fields are still refused, and the message lists theme", () => {
    const home = homeWith();
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { set: { branding: "x" } as never }, today })).toThrow(TemplateWriteError);
    try {
      planTemplateWrite({ homeDir: home, file: "global", id: "short", mode: "update", patch: { set: { branding: "x" } as never }, today });
    } catch (e) {
      expect((e as TemplateWriteError).errors[0]!.message).toContain("theme");
    }
  });
});

describe("create_report_template with theme", () => {
  const template = (theme: unknown) => ({ title: "Board pack", ...(theme === undefined ? {} : { theme }), sections: [{ id: "search", type: "search_overview" }] });

  it("accepts a theme in the whole template and shows it in the YAML", async () => {
    const home = homeWith();
    const p = (await templateWriteCall("create_report_template", { id: "board", template: template("editorial") }, deps(home))) as Proposal & { yaml: string };
    expect(p.valid).toBe(true);
    expect(p.yaml).toContain("theme: editorial");
    expect(readFileSync(file(home), "utf8")).toBe(FILE);
  });

  it("rejects an invalid theme with the field path", async () => {
    const home = homeWith();
    const p = (await templateWriteCall("create_report_template", { id: "board", template: template("loud") }, deps(home))) as Proposal;
    expect(p.valid).toBe(false);
    expect(p.errors!.map((e) => e.path)).toContain("templates.board.theme");
  });
});

describe("tool descriptions", () => {
  it("name the theme field", () => {
    const src = readFileSync(new URL("../src/tools/report-template-write.ts", import.meta.url), "utf8");
    expect(src).toContain("layout/cover/contents/theme");
    expect(src).toContain("theme?: cards | minimal | editorial | bold | consulting | friendly");
  });
});
