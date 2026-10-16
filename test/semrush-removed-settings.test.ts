/**
 * Things 0.1.0 let a user write that now refer to Semrush Site Audit (removed with Semrush's v3 API): a clients.yaml
 * `semrushProject` and a technical_issues `semrush_site_audit` source. Both must keep loading; neither can be added.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOverrides, SEMRUSH_PROJECT_NOTE } from "../src/lib/clients.js";
import { runTemplate } from "../src/reports/templates/run.js";
import { REMOVED_ISSUE_SOURCE_NOTE, validateTemplateText } from "../src/reports/templates/schema.js";
import { planTemplateWrite, TemplateWriteError } from "../src/reports/templates/write.js";
import { client, fakeDeps } from "./fixtures/reports/deps.js";
import { TECH_ISSUES } from "./fixtures/reports/p13-data.js";

afterEach(() => vi.restoreAllMocks());

describe("clients.yaml semrushProject", () => {
  it("loads, is ignored, and is noted once on stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const raw = { clients: { "a.example.com": { domain: "a.example.com", semrushProject: 7701 }, "b.example.com": { domain: "b.example.com", semrushProject: "8802" } } };
    const out = parseOverrides(raw);
    expect(out.map((o) => o.slug)).toEqual(["a.example.com", "b.example.com"]);
    expect(out[0]).not.toHaveProperty("semrushProject");
    parseOverrides(raw);
    const notes = write.mock.calls.map((c) => String(c[0])).filter((t) => t.includes("semrushProject"));
    expect(notes).toEqual([`${SEMRUSH_PROJECT_NOTE}\n`]);
    expect(SEMRUSH_PROJECT_NOTE).toBe("crawlmark: clients.yaml `semrushProject` is no longer used (Semrush Site Audit needs Semrush's v3 API, which crawlmark no longer supports); you can remove it.");
  });

  it("clients set --semrush-project is a clear usage error, not a silent no-op", async () => {
    const { spawnSync } = await import("node:child_process");
    const home = mkdtempSync(join(tmpdir(), "crawlmark-semrush-removed-"));
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(import.meta.dirname, "..", "src", "cli.ts"), "clients", "set", "example.com", "--semrush-project", "7701"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, CRAWLMARK_HOME: home },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--semrush-project is no longer supported");
  }, 60_000);
});

const today = new Date("2026-10-13T12:00:00Z");
const file = (sections: string) => `version: 1\ntemplates:\n  t:\n    title: T\n    sections:\n${sections}`;

describe("a template naming semrush_site_audit", () => {
  const yaml = file("      - { id: issues, type: technical_issues, paid: true, sources: [semrush_site_audit, ahrefs_site_audit] }\n");

  it("validates, with a warning (not an error)", () => {
    const r = validateTemplateText(yaml, { today });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([{ path: "templates.t.sections[0].sources", message: expect.stringContaining(REMOVED_ISSUE_SOURCE_NOTE) }]);
  });

  it("runs with only Ahrefs and the section carries the note", async () => {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-semrush-removed-"));
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "report-templates.yaml"), yaml, { mode: 0o600 });
    const seen: unknown[] = [];
    const deps = fakeDeps({
      technicalIssues: async (_c, o) => {
        seen.push(o.sources);
        return { ...TECH_ISSUES, snapshotId: null };
      },
    });
    const report = await runTemplate(client, { template: "t", homeDir: home, today, allowPaid: true, store: false }, deps);
    expect(seen).toEqual([["ahrefs_site_audit"]]);
    const section = report.sections.find((s) => s.id === "issues") as { status: string; data?: { notes?: string[] } };
    expect(section.status).toBe("ok");
    expect(section.data?.notes).toEqual([REMOVED_ISSUE_SOURCE_NOTE]);
  });

  it("the 0.1.0 section [audit, semrush_site_audit] with issueUrls: 2 and paid: true loads with warnings and runs with issueUrls 0", async () => {
    const section = "      - { id: issues, type: technical_issues, paid: true, sources: [audit, semrush_site_audit], issueUrls: 2 }\n";
    const v = validateTemplateText(file(section), { today });
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings[0]!.message).toContain("issueUrls has no source left");
    const home = mkdtempSync(join(tmpdir(), "crawlmark-semrush-removed-"));
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "report-templates.yaml"), file(section), { mode: 0o600 });
    const seen: { sources: unknown; issueUrls: unknown }[] = [];
    const deps = fakeDeps({
      technicalIssues: async (_c, o) => {
        seen.push({ sources: o.sources, issueUrls: o.issueUrls });
        return { ...TECH_ISSUES, snapshotId: null };
      },
    });
    const report = await runTemplate(client, { template: "t", homeDir: home, today, allowPaid: true, store: false }, deps);
    expect(seen).toEqual([{ sources: ["audit"], issueUrls: 0 }]);
    expect((report.sections.find((s) => s.id === "issues") as { data?: { notes?: string[] } }).data?.notes).toEqual([REMOVED_ISSUE_SOURCE_NOTE]);
    // With a paid source left, issueUrls is kept.
    const kept = await validateTemplateText(file("      - { id: issues, type: technical_issues, paid: true, sources: [semrush_site_audit, ahrefs_site_audit], issueUrls: 2 }\n"), { today });
    expect(kept.valid).toBe(true);
  });

  it("only the removed source: the free sources run instead, with the note", async () => {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-semrush-removed-"));
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "report-templates.yaml"), file("      - { id: issues, type: technical_issues, sources: [semrush_site_audit] }\n"), { mode: 0o600 });
    const seen: unknown[] = [];
    const deps = fakeDeps({
      technicalIssues: async (_c, o) => {
        seen.push(o.sources);
        return { ...TECH_ISSUES, snapshotId: null };
      },
    });
    const report = await runTemplate(client, { template: "t", homeDir: home, today, store: false }, deps);
    expect(seen).toEqual([undefined]);
    expect((report.sections.find((s) => s.id === "issues") as { data?: { notes?: string[] } }).data?.notes).toEqual([REMOVED_ISSUE_SOURCE_NOTE]);
  });

  it("create_report_template / update_report_template refuse to add it, but an update that leaves an existing one alone is fine", () => {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-semrush-removed-"));
    const tpl = { title: "T", sections: [{ id: "issues", type: "technical_issues", sources: ["semrush_site_audit"] }] };
    let err: unknown;
    try {
      planTemplateWrite({ homeDir: home, file: "global", id: "t", mode: "create", template: tpl, today });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TemplateWriteError);
    expect((err as Error).message).toContain(REMOVED_ISSUE_SOURCE_NOTE);

    // A file that already has it: updating the title keeps the section as it is, so it is allowed (with the warning).
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "report-templates.yaml"), file("      - { id: issues, type: technical_issues, sources: [semrush_site_audit] }\n"), { mode: 0o600 });
    const plan = planTemplateWrite({ homeDir: home, file: "global", id: "t", mode: "update", patch: { set: { title: "Renamed" } }, today });
    expect(plan.warnings.some((w) => w.message.includes(REMOVED_ISSUE_SOURCE_NOTE))).toBe(true);
    // Adding it to another section of that template is refused.
    expect(() =>
      planTemplateWrite({ homeDir: home, file: "global", id: "t", mode: "update", patch: { addSections: [{ id: "more", type: "technical_issues", sources: ["semrush_site_audit"] }] }, today }),
    ).toThrow(TemplateWriteError);
  });
});
