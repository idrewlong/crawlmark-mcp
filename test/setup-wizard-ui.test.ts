import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recordingUi } from "../src/setup/ui.js";
import { appsTally, offerOpen, runWizard, stepDataForSeo, stepDiscovery, stepPsi, summarize, tipFor, type StepResult, type WizardContext } from "../src/setup/wizard.js";
import { tryAskingExamples } from "../src/setup/try-asking.js";

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
      "Change one step: npx crawlmark-mcp setup --step <node|provider|dataforseo|ahrefs|semrush|google|psi|discovery|register>",
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

describe("Phase 10: tips", () => {
  const ctx = { cliDisplay: "npm run cli --" };
  const r = (step: StepResult["step"], outcome: StepResult["outcome"], extra: Partial<StepResult> = {}): StepResult => ({ step, outcome, message: "", ...extra });

  it("one tip per step result, built on the install's command prefix", () => {
    expect(tipFor(ctx, r("google", "done"))).toBe("To switch accounts later: npm run cli -- setup --step google");
    expect(tipFor({ cliDisplay: "npx crawlmark-mcp" }, r("google", "done"))).toBe("To switch accounts later: npx crawlmark-mcp setup --step google");
    expect(tipFor(ctx, r("dataforseo", "done"))).toBe("To switch between sandbox and live later: npm run cli -- setup --step dataforseo");
    expect(tipFor(ctx, r("provider", "done", { defaultProvider: "ahrefs" }))).toBe("To use another provider for one client: npm run cli -- clients set <domain> --provider <name>");
    expect(tipFor(ctx, r("psi", "skipped"))).toBe("To add a PageSpeed key later: npm run cli -- setup --step psi");
    expect(tipFor(ctx, r("discovery", "done"))).toBe("To add a client by hand: npm run cli -- clients add <domain>");
    expect(tipFor(ctx, r("register", "done"))).toBe("To check everything later: npm run cli -- setup status");
    expect(tipFor(ctx, r("google", "failed"))).toBeUndefined();
    expect(tipFor(ctx, r("node", "done"))).toBeUndefined();
  });

  it("the wizard shows tips in fancy mode only", async () => {
    const fancy = ctxWith([false], true);
    await runWizard(fancy.ctx, { step: "psi" });
    expect(fancy.ui.events).toContain("tip: To add a PageSpeed key later: npx crawlmark-mcp setup --step psi");
    const plain = ctxWith([false], false);
    await runWizard(plain.ctx, { step: "psi" });
    expect(plain.ui.events.some((e) => e.startsWith("tip: "))).toBe(false);
  });
});

describe("Phase 10: Try asking Claude", () => {
  it("uses only the user's own clients: Search Console first, ignored skipped, at most three", () => {
    const t = tryAskingExamples(
      [
        { domain: "example.org", name: "Org Example" },
        { domain: "example.com", name: "Example Co", gsc: true },
        { domain: "hidden.example", name: "Hidden", ignore: true, gsc: true },
        { domain: "example.net", name: "example.net", gsc: true },
        { domain: "example.edu", name: "Fourth" },
      ],
      "npx crawlmark-mcp",
    );
    expect(t.prompts).toEqual([
      "Give me the monthly report for Example Co (example.com)",
      "What are the quick wins for example.net?",
      "Run an audit on example.org and tell me what changed since last time",
    ]);
    expect(t.hint).toBeUndefined();
    expect(t.prompts.join(" ")).not.toContain("hidden.example");
    expect(t.prompts.join(" ")).not.toContain("example.edu");
  });

  it("cycles one client over the three prompts; no name or a name equal to the domain shows the domain", () => {
    expect(tryAskingExamples([{ domain: "example.com" }], "x").prompts).toEqual([
      "Give me the monthly report for example.com",
      "What are the quick wins for example.com?",
      "Run an audit on example.com and tell me what changed since last time",
    ]);
    expect(tryAskingExamples([{ domain: "example.com", name: "EXAMPLE.COM" }], "x").prompts[0]).toBe("Give me the monthly report for example.com");
  });

  it("strips control and bidi characters and caps long names", () => {
    const t = tryAskingExamples([{ domain: "example.com", name: "Evil\u001b[2J\u202E Co   with  a very long name that keeps going and going" }], "x");
    expect(t.prompts[0]).not.toMatch(/[\u001b\u202E]/);
    expect(t.prompts[0]).toMatch(/^Give me the monthly report for Evil\[2J Co with a very long name that k… \(example\.com\)$/);
  });

  it("no clients: example.com plus a hint to add one", () => {
    for (const none of [undefined, [], [{ domain: "example.org", ignore: true }]]) {
      const t = tryAskingExamples(none, "npx crawlmark-mcp");
      expect(t.prompts[0]).toBe("Give me the monthly report for example.com");
      expect(t.hint).toBe("Add your own: npx crawlmark-mcp clients add <domain>");
    }
  });

  it("the wizard passes them to the fancy summary only, reading clients through the context", async () => {
    const fancy = ctxWith([false], true);
    fancy.ctx.exampleClients = () => [{ domain: "example.com", name: "Example Co", gsc: true }];
    await runWizard(fancy.ctx, { step: "discovery" });
    expect(fancy.ui.events).toContain(
      "try: Give me the monthly report for Example Co (example.com); What are the quick wins for example.com?; Run an audit on example.com and tell me what changed since last time",
    );
    const broken = ctxWith([false], true);
    broken.ctx.exampleClients = () => {
      throw new Error("bad yaml");
    };
    await runWizard(broken.ctx, { step: "discovery" });
    expect(broken.ui.events.find((e) => e.startsWith("try: "))).toContain("Add your own: npx crawlmark-mcp clients add <domain>");
    const plain = ctxWith([false], false);
    const read = vi.fn(() => [{ domain: "example.com" }]);
    plain.ctx.exampleClients = read;
    await runWizard(plain.ctx, { step: "discovery" });
    expect(plain.ui.events.some((e) => e.startsWith("try: "))).toBe(false);
    expect(read).not.toHaveBeenCalled();
    const oneStep = ctxWith([false], true);
    await runWizard(oneStep.ctx, { step: "psi" });
    expect(oneStep.ui.events.some((e) => e.startsWith("try: "))).toBe(false);
  });
});

describe("Phase 10: Press Enter to open", () => {
  it("Enter opens the page; s skips; a failed opener prints the URL", async () => {
    const { ctx, ui } = ctxWith(["", "s", ""], true);
    ctx.dryRun = false;
    const open = vi.fn(() => true);
    ctx.openUrl = open;
    await offerOpen(ctx, "DataForSEO API access", "https://app.dataforseo.com/api-access");
    expect(open).toHaveBeenCalledWith("https://app.dataforseo.com/api-access");
    await offerOpen(ctx, "DataForSEO API access", "https://app.dataforseo.com/api-access");
    expect(open).toHaveBeenCalledTimes(1);
    ctx.openUrl = () => false;
    await offerOpen(ctx, "Ahrefs API keys", "https://app.ahrefs.com/account/api-keys");
    expect(ui.events).toContain("info: Couldn't open a browser. The page is https://app.ahrefs.com/account/api-keys");
  });

  it("never asks in a dry run, under --yes, in plain mode or without an opener", async () => {
    const ask = vi.fn(async () => "");
    for (const setup of [
      (c: WizardContext) => (c.dryRun = true),
      (c: WizardContext) => ((c.dryRun = false), (c.yes = true)),
      (c: WizardContext) => ((c.dryRun = false), (c.openUrl = undefined)),
    ]) {
      const { ctx } = ctxWith([], true);
      ctx.prompt.ask = ask;
      ctx.openUrl = () => true;
      setup(ctx);
      await offerOpen(ctx, "x", "https://example.com/");
    }
    const plain = ctxWith([], false);
    plain.ctx.dryRun = false;
    plain.ctx.prompt.ask = ask;
    plain.ctx.openUrl = () => true;
    await offerOpen(plain.ctx, "x", "https://example.com/");
    expect(ask).not.toHaveBeenCalled();
  });

  it("the PageSpeed step offers the API page before asking for the key", async () => {
    const { ctx } = ctxWith([true, "s", ""], true);
    ctx.dryRun = false;
    const asked: string[] = [];
    const orig = ctx.prompt.ask;
    ctx.prompt.ask = async (q, o) => (asked.push(q), orig(q, o));
    ctx.openUrl = vi.fn(() => true);
    await stepPsi(ctx);
    expect(asked[0]).toBe("Press Enter to open the PageSpeed Insights API page in your browser (or s to skip)");
    expect(ctx.openUrl).not.toHaveBeenCalled();
  });
});

describe("Phase 10: a step chosen from the menu", () => {
  it("runs without a second intro", async () => {
    const shown = ctxWith([false], true);
    await runWizard(shown.ctx, { step: "psi", introShown: true });
    expect(shown.ui.events.some((e) => e.startsWith("intro: "))).toBe(false);
    const fresh = ctxWith([false], true);
    await runWizard(fresh.ctx, { step: "psi" });
    expect(fresh.ui.events.filter((e) => e.startsWith("intro: "))).toHaveLength(1);
  });
});
