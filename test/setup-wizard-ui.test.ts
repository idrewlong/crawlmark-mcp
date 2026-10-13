import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recordingUi } from "../src/setup/ui.js";
import { appsTally, stepDataForSeo, stepDiscovery, summarize, type StepResult, type WizardContext } from "../src/setup/wizard.js";

describe("summarize (the fancy summary box)", () => {
  const ctx = { cliDisplay: "npx crawlmark-mcp", dryRun: false };

  it("one cell per step and app, restart hints for apps whose config changed, then the next steps", () => {
    const results: StepResult[] = [
      { step: "node", outcome: "done", message: "" },
      { step: "dataforseo", outcome: "failed", message: "" },
      { step: "google", outcome: "done", message: "" },
      { step: "psi", outcome: "skipped", message: "" },
      { step: "discovery", outcome: "done", message: "" },
      {
        step: "register",
        outcome: "done",
        message: "",
        apps: [
          { id: "claude-code", status: "already" },
          { id: "claude-desktop", status: "registered" },
          { id: "codex", status: "dry-run" },
        ],
      },
    ];
    const s = summarize(ctx, results);
    expect(s.rows.map((r) => `${r.label}:${r.outcome}${r.note ? ` ${r.note}` : ""}`)).toEqual([
      "Node:done",
      "DataForSEO:failed",
      "Google:done",
      "PageSpeed:skipped (skipped)",
      "Clients:done",
      "Claude Code:done",
      "Claude Desktop:done",
      "Codex:skipped (dry run)",
    ]);
    expect(s.next).toEqual([
      "Fix DataForSEO: npx crawlmark-mcp setup --step dataforseo",
      "Restart Claude Desktop",
      "In Claude, run the getting-started prompt",
      "Change one step: npx crawlmark-mcp setup --step <node|dataforseo|google|psi|discovery|register>",
    ]);
  });
});

function ctxWith(answers: (string | boolean)[], fancy: boolean) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "crawlmark-wizui-")));
  const ui = recordingUi({ fancy });
  const lines: string[] = [];
  const next = () => answers.shift()!;
  const ctx: WizardContext = {
    prompt: { ask: async () => next() as string, secret: async () => next() as string, confirm: async () => next() as boolean, choose: async (_q, _c, d) => d, close() {} },
    out: (l = "") => lines.push(l),
    exec: vi.fn(),
    cli: vi.fn(async () => ({ code: 0, stdout: "3 clients\nexample.com", stderr: "" })),
    fetch: vi.fn(async () => new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ money: { balance: 1, total: 5 } }] }] }))) as unknown as typeof fetch,
    status: async (only) => ({
      home: { dir: base, source: "user", reason: "", envFile: join(base, ".env"), envFileExists: false },
      cli: "x",
      integrations: only.map((id) => ({ id, label: id, state: id === "google" ? "working" : "missing", detail: "", next: null })),
      summary: { working: 0, configured: 0, missing: 0, error: 0 },
      checkedAt: "",
      fromCache: false,
      costUsd: 0,
    }),
    checkKeyFile: vi.fn(),
    paths: { home: base, homeSource: "user", projectRoot: base, envFile: join(base, ".env"), userHome: base, cwd: base, desktopConfig: undefined },
    ui,
    node: { version: "v24.1.0", execPath: "/usr/local/bin/node" },
    cliDisplay: "npx crawlmark-mcp",
    shellEnvKeys: new Set(),
    dryRun: true,
  };
  return { ctx, ui, lines };
}

describe("wizard steps report through the Ui", () => {
  it("DataForSEO: a spinner around the status and the live check, then a success line", async () => {
    const { ctx, ui } = ctxWith([true, "you@example.com", "pw"], true);
    expect(await stepDataForSeo(ctx)).toMatchObject({ outcome: "done" });
    expect(ui.events).toContain("spin: Checking the current status...");
    expect(ui.events).toContain("spin: Checking with DataForSEO's free account call (sandbox.dataforseo.com)...");
    expect(ui.events.some((e) => e.startsWith("success: Credentials work. Mode: sandbox"))).toBe(true);
    expect(ui.events.join("\n")).not.toContain("pw\n");
  });

  it("discovery in fancy mode captures the child's output behind a spinner", async () => {
    const { ctx, ui, lines } = ctxWith([true, false], true);
    ctx.dryRun = false;
    expect(await stepDiscovery(ctx)).toMatchObject({ outcome: "done" });
    expect(ui.events).toContain("spin: Discovering clients...");
    expect(ctx.cli).toHaveBeenCalledWith(["clients", "list", "--refresh"]);
    expect(lines.slice(-2)).toEqual(["3 clients", "example.com"]);
  });

  it("discovery in plain mode gives the child the terminal, as before", async () => {
    const { ctx } = ctxWith([true, false], false);
    ctx.dryRun = false;
    await stepDiscovery(ctx);
    expect(ctx.cli).toHaveBeenCalledWith(["clients", "list", "--refresh"], { inherit: true });
  });
});

describe("appsTally", () => {
  it("groups apps by what happened", () => {
    expect(appsTally([{ id: "claude-code", status: "registered" }, { id: "cursor", status: "already" }, { id: "codex", status: "registered" }, { id: "claude-desktop", status: "failed" }])).toBe(
      "Registered: Claude Code, Codex. Already set up: Cursor. Failed: Claude Desktop.",
    );
    expect(appsTally([])).toContain("No apps picked");
  });
});
