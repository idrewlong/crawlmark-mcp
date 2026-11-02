/** Release 0.4.0 T0: `crawlmark-cli report --theme` and `--format pptx` at the CLI boundary. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FORMAT_CHOICES, reportCommand, type ReportCliDeps, type ReportFlags } from "../src/report-cli.js";
import { client, fakeDeps } from "./fixtures/reports/deps.js";

const flags = (f: Partial<ReportFlags>): ReportFlags => ({ all: false, paid: false, "dry-run": false, ...f });

function harness() {
  const home = mkdtempSync(join(tmpdir(), "crawlmark-cli-theme-"));
  const lines: string[] = [];
  const errs: string[] = [];
  const deps: ReportCliDeps = {
    loadClients: async () => ({ clients: [client], skipped: [] }),
    runDeps: async () => fakeDeps(),
    printer: vi.fn(async () => Buffer.from("%PDF-1.7 fake")),
    reportsDir: join(home, "reports"),
    version: "0.4.0",
  };
  const io = { out: (l = "") => lines.push(l), warn: (l: string) => errs.push(l), homeDir: home, cwd: home, today: new Date("2026-10-13T12:00:00Z") };
  return { deps, io, errs };
}

describe("report --theme and --format pptx", () => {
  it("rejects an unknown theme as a usage error", async () => {
    const h = harness();
    expect(await reportCommand([], flags({ client: "example.com", month: "2026-09", theme: "dark" }), h.io, h.deps)).toBe(1);
    expect(h.errs.join("\n")).toMatch(/--theme takes one of cards, minimal, editorial, bold, consulting, friendly/);
  });

  it("accepts every theme id", async () => {
    for (const theme of ["cards", "bold"]) {
      const h = harness();
      expect(await reportCommand([], flags({ client: "example.com", month: "2026-09", theme, format: "md" }), h.io, h.deps), theme).toBe(0);
    }
  });

  it("--format accepts gdocs", async () => {
    const h = harness();
    const code = await reportCommand([], flags({ client: "example.com", month: "2026-09", format: "gdocs" }), h.io, h.deps);
    expect(h.errs.join("\n")).not.toMatch(/--format takes/);
    expect(code).not.toBe(1);
  });

  it("--format accepts pptx", async () => {
    const h = harness();
    const code = await reportCommand([], flags({ client: "example.com", month: "2026-09", format: "md,pptx" }), h.io, h.deps);
    expect(h.errs.join("\n")).not.toMatch(/--format takes/);
    expect(code).not.toBe(1);
  });

  it("the picker lists PDF first, then the Word copy for Google Docs last (pptx and gdocs are never a default)", () => {
    expect(FORMAT_CHOICES.map((c) => c.value)).toEqual(["pdf", "docx", "html", "md", "pptx", "gdocs"]);
  });
});
