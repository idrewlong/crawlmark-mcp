import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { planCodexVendorTomlEdit, VENDORS } from "../src/lib/vendor-mcp.js";
import type { AppId } from "../src/setup/apps.js";
import { autoPrompter, type Choice, type Prompter } from "../src/setup/prompter.js";
import { recordingUi } from "../src/setup/ui.js";
import { runPlan, type ExecResult, type WizardContext } from "../src/setup/wizard.js";
import { stepVendorMcp as step } from "../src/setup/vendor-mcp-step.js";

const SENTINEL = "sk-SENTINEL-other-server-9999";
const SEMRUSH = VENDORS.semrush;
const AHREFS = VENDORS.ahrefs;

type Answer = boolean | string[];

function scripted(answers: Answer[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = (q: string): Answer => {
    asked.push(q);
    if (!answers.length) throw new Error(`Unexpected question: ${q}`);
    return answers.shift()!;
  };
  return {
    asked,
    ask: async () => "",
    secret: async () => "",
    confirm: async (q) => next(q) as boolean,
    choose: async <T extends string>(_q: string, _c: readonly Choice<T>[], d: T) => d,
    multiselect: async <T extends string>(q: string, _c: readonly Choice<T>[], d: readonly T[]) => {
      const a = next(q);
      return (a === true ? [...d] : (a as unknown as T[]));
    },
    close() {},
  };
}

interface Opts {
  claude?: boolean;
  claudeGet?: string;
  codex?: boolean;
  codexGet?: string;
  codexToml?: string;
  cursorJson?: string;
  desktopDir?: boolean;
  cursorDir?: boolean;
  codexDir?: boolean;
  dryRun?: boolean;
  fancy?: boolean;
  yes?: boolean;
  prompt?: Prompter;
}

function harness(answers: Answer[], o: Opts = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "crawlmark-vendor-")));
  const home = join(base, "home");
  mkdirSync(home);
  const desktopDir = join(base, "Claude");
  const cursorDir = join(base, ".cursor");
  const codexDir = join(base, ".codex");
  if (o.desktopDir) mkdirSync(desktopDir);
  if (o.cursorDir || o.cursorJson !== undefined) mkdirSync(cursorDir);
  if (o.codexDir || o.codexToml !== undefined) mkdirSync(codexDir);
  const cursor = join(cursorDir, "mcp.json");
  const codexConfig = join(codexDir, "config.toml");
  if (o.cursorJson !== undefined) writeFileSync(cursor, o.cursorJson);
  if (o.codexToml !== undefined) writeFileSync(codexConfig, o.codexToml);
  const lines: string[] = [];
  const calls: string[][] = [];
  const exec = vi.fn(async (cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push([cmd, ...args]);
    if (cmd === "claude") {
      if (o.claude === false) return { code: 127, stdout: "", stderr: "" };
      if (args[1] === "get") return args[2] === "crawlmark" || o.claudeGet === undefined ? { code: 1, stdout: "", stderr: "not found" } : { code: 0, stdout: o.claudeGet, stderr: "" };
      return { code: 0, stdout: "2.0.0", stderr: "" };
    }
    if (cmd === "codex") {
      if (!o.codex) return { code: 127, stdout: "", stderr: "" };
      if (args[1] === "get") return args[2] === "crawlmark" || o.codexGet === undefined ? { code: 1, stdout: "", stderr: "not found" } : { code: 0, stdout: o.codexGet, stderr: "" };
      return { code: 0, stdout: "codex 1.0", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const ui = recordingUi({ fancy: o.fancy ?? false });
  const ctx: WizardContext = {
    prompt: o.prompt ?? scripted(answers),
    out: (l = "") => lines.push(l),
    exec,
    cli: vi.fn(),
    fetch: vi.fn() as unknown as typeof fetch,
    status: vi.fn(async () => ({ integrations: [] }) as never),
    checkKeyFile: vi.fn(),
    paths: {
      home,
      homeSource: "user",
      projectRoot: join(base, "root"),
      envFile: join(home, ".env"),
      userHome: base,
      cwd: base,
      desktopConfig: join(desktopDir, "claude_desktop_config.json"),
      cursorConfig: cursor,
      codexConfig,
    },
    which: () => false,
    ui,
    node: { version: "v24.1.0", execPath: "/usr/local/bin/node" },
    cliDisplay: "npx crawlmark-mcp",
    shellEnvKeys: new Set(),
    dryRun: o.dryRun ?? false,
    yes: o.yes ?? false,
  };
  const all = () => [...lines, ...ui.events].join("\n");
  const adds = () => calls.filter((c) => c[2] === "add" || c[2] === "remove");
  return { ctx, lines, ui, calls, adds, all, base, cursor, codexConfig, desktop: ctx.paths.desktopConfig! };
}

/** Every file under the temp base, to prove no key was written anywhere. */
function allText(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? allText(join(dir, e.name)) : readFileSync(join(dir, e.name), "utf8")))
    .join("\n");
}

const claudeGetFor = (url: string, scope = "User config (available in all your projects)") => `semrush:\n  Scope: ${scope}\n  Status: connected\n  Type: http\n  URL: ${url}\n`;
const otherJson = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x", env: { TOKEN: SENTINEL } } } }, null, 2) + "\n";
const asked = { asked: true } as const;

describe("vendor-mcp: Cursor", () => {
  it("adds both entries as url-only, keeps other servers, makes a .bak, and never shows other servers' secrets", async () => {
    const h = harness([["semrush", "ahrefs"], ["cursor"], true, true], { cursorJson: otherJson });
    const r = await step(h.ctx, asked);
    expect(r.outcome).toBe("done");
    const written = JSON.parse(readFileSync(h.cursor, "utf8"));
    expect(written.theme).toBe("dark");
    expect(written.mcpServers.other).toEqual({ command: "x", env: { TOKEN: SENTINEL } });
    expect(written.mcpServers.semrush).toEqual({ url: "https://mcp.semrush.com/v2/mcp" });
    expect(written.mcpServers.ahrefs).toEqual({ url: "https://api.ahrefs.com/mcp/mcp" });
    // The .bak is the file as it was before the last write: the other server and semrush, not yet ahrefs.
    const bak = JSON.parse(readFileSync(`${h.cursor}.bak`, "utf8"));
    expect(Object.keys(bak.mcpServers)).toEqual(["other", "semrush"]);
    expect(h.all()).not.toContain(SENTINEL);
    // The plain statement about OAuth and units comes before the confirm.
    expect(h.all()).toContain("This adds Semrush's own MCP server to your AI app. You sign in to Semrush in the app (OAuth). Its calls spend your Semrush API units directly; crawlmark's caps, cache and reports don't cover them.");
    expect(h.all()).toContain("This adds Ahrefs' own MCP server to your AI app. You sign in to Ahrefs in the app (OAuth).");
  });

  it("a re-run changes nothing and asks nothing: already", async () => {
    const h = harness([["semrush"], ["cursor"], true], { cursorJson: otherJson });
    await step(h.ctx, asked);
    const first = readFileSync(h.cursor, "utf8");
    const again = harness([["semrush"], ["cursor"]], { cursorJson: first });
    const r = await step(again.ctx, asked);
    expect(r).toMatchObject({ outcome: "done", message: "Semrush in Cursor: already." });
    expect(readFileSync(again.cursor, "utf8")).toBe(first);
    expect(existsSync(`${again.cursor}.bak`)).toBe(false);
  });

  it("a different semrush entry is replaced only on yes (the prompt defaults to no, and its headers are never printed)", async () => {
    const conflict = JSON.stringify({ mcpServers: { semrush: { url: "https://example.com/mcp", headers: { Authorization: `Apikey ${SENTINEL}` } } } });
    const no = harness([["semrush"], ["cursor"], false], { cursorJson: conflict });
    expect((await step(no.ctx, asked)).outcome).toBe("skipped");
    expect(readFileSync(no.cursor, "utf8")).toBe(conflict);
    expect(no.all()).toContain("https://example.com/mcp");
    expect(no.all()).not.toContain(SENTINEL);
    const yes = harness([["semrush"], ["cursor"], true], { cursorJson: conflict });
    expect((await step(yes.ctx, asked)).outcome).toBe("done");
    expect(JSON.parse(readFileSync(yes.cursor, "utf8")).mcpServers.semrush).toEqual({ url: SEMRUSH.url });
    expect(readFileSync(`${yes.cursor}.bak`, "utf8")).toBe(conflict);
    // Under --yes the replace question's default is no.
    const base = autoPrompter(() => {});
    const auto = harness([], { cursorJson: conflict, prompt: { ...base, multiselect: async <T extends string>(_q: string, c: readonly Choice<T>[]) => [c[0]!.value] } });
    await step(auto.ctx, asked);
    expect(readFileSync(auto.cursor, "utf8")).toBe(conflict);
  });

  it("a dry run writes nothing", async () => {
    const h = harness([["semrush"], ["cursor"], true], { cursorJson: otherJson, dryRun: true });
    expect((await step(h.ctx, asked)).outcome).toBe("skipped");
    expect(readFileSync(h.cursor, "utf8")).toBe(otherJson);
  });
});

describe("vendor-mcp: Claude Code", () => {
  it("runs claude mcp add --transport http -s user <name> <url> after previewing it", async () => {
    const h = harness([["semrush", "ahrefs"], ["claude-code"], true, true]);
    const r = await step(h.ctx, asked);
    expect(r.outcome).toBe("done");
    expect(h.adds()).toEqual([
      ["claude", "mcp", "add", "--transport", "http", "-s", "user", "semrush", "https://mcp.semrush.com/v2/mcp"],
      ["claude", "mcp", "add", "--transport", "http", "-s", "user", "ahrefs", "https://api.ahrefs.com/mcp/mcp"],
    ]);
    expect(h.all()).toContain("claude mcp add --transport http -s user semrush https://mcp.semrush.com/v2/mcp");
  });

  it("an entry with the same URL is already; a different one is replaced only on yes", async () => {
    const same = harness([["semrush"], ["claude-code"]], { claudeGet: claudeGetFor(SEMRUSH.url) });
    expect((await step(same.ctx, asked)).message).toBe("Semrush in Claude Code: already.");
    expect(same.adds()).toEqual([]);
    const diff = harness([["semrush"], ["claude-code"], false], { claudeGet: claudeGetFor("https://example.com/mcp", "Local config") });
    expect((await step(diff.ctx, asked)).outcome).toBe("skipped");
    expect(diff.adds()).toEqual([]);
    const yes = harness([["semrush"], ["claude-code"], true], { claudeGet: claudeGetFor("https://example.com/mcp", "Local config") });
    await step(yes.ctx, asked);
    expect(yes.adds()).toEqual([
      ["claude", "mcp", "remove", "semrush", "-s", "local"],
      ["claude", "mcp", "add", "--transport", "http", "-s", "user", "semrush", "https://mcp.semrush.com/v2/mcp"],
    ]);
  });
});

describe("vendor-mcp: Codex", () => {
  it("through the CLI: codex mcp add <name> --url <url>, with a .bak and the login hint", async () => {
    const h = harness([["semrush"], ["codex"], true], { codex: true, codexToml: 'model = "o4"\n' });
    const r = await step(h.ctx, asked);
    expect(r.outcome).toBe("done");
    expect(h.adds()).toEqual([["codex", "mcp", "add", "semrush", "--url", "https://mcp.semrush.com/v2/mcp"]]);
    expect(readFileSync(`${h.codexConfig}.bak`, "utf8")).toBe('model = "o4"\n');
    expect(h.all()).toContain("codex mcp login semrush");
  });

  it("CLI: the same URL is already; a different one is replaced only on yes", async () => {
    const same = harness([["ahrefs"], ["codex"]], { codex: true, codexGet: JSON.stringify({ name: "ahrefs", transport: { type: "streamable_http", url: AHREFS.url } }) });
    expect((await step(same.ctx, asked)).message).toBe("Ahrefs in Codex: already.");
    const diff = harness([["ahrefs"], ["codex"], false], { codex: true, codexGet: JSON.stringify({ transport: { type: "streamable_http", url: "https://example.com/mcp" } }) });
    await step(diff.ctx, asked);
    expect(diff.adds()).toEqual([]);
    const yes = harness([["ahrefs"], ["codex"], true], { codex: true, codexGet: JSON.stringify({ transport: { type: "streamable_http", url: "https://example.com/mcp" } }) });
    await step(yes.ctx, asked);
    expect(yes.adds()).toEqual([
      ["codex", "mcp", "remove", "ahrefs"],
      ["codex", "mcp", "add", "ahrefs", "--url", "https://api.ahrefs.com/mcp/mcp"],
    ]);
  });

  it("without the CLI: appends a url-only table to config.toml, leaving every other byte, then is idempotent", async () => {
    const toml = `# my codex settings\nmodel = "o4"\n\n[mcp_servers.other]\ncommand = "other"\nenv = { TOKEN = "${SENTINEL}" }\n`;
    const h = harness([["semrush"], ["codex"], true], { codexToml: toml });
    expect((await step(h.ctx, asked)).outcome).toBe("done");
    const after = readFileSync(h.codexConfig, "utf8");
    expect(after.startsWith(toml + "\n")).toBe(true);
    expect(after).toContain('[mcp_servers.semrush]\nurl = "https://mcp.semrush.com/v2/mcp"');
    expect(readFileSync(`${h.codexConfig}.bak`, "utf8")).toBe(toml);
    expect(h.all()).not.toContain(SENTINEL);
    const again = harness([["semrush"], ["codex"]], { codexToml: after });
    expect((await step(again.ctx, asked)).message).toBe("Semrush in Codex: already.");
    expect(readFileSync(again.codexConfig, "utf8")).toBe(after);
  });

  it("without the CLI: a different entry is left alone and the snippet is printed", async () => {
    const toml = '[mcp_servers.semrush]\nurl = "https://example.com/mcp"\n';
    const h = harness([["semrush"], ["codex"]], { codexToml: toml });
    expect((await step(h.ctx, asked)).outcome).toBe("skipped");
    expect(readFileSync(h.codexConfig, "utf8")).toBe(toml);
    expect(h.all()).toContain('url = "https://mcp.semrush.com/v2/mcp"');
  });

  it("planCodexVendorTomlEdit appends to a file with no trailing newline and refuses invalid TOML", () => {
    const plan = planCodexVendorTomlEdit('model = "o4"', SEMRUSH);
    expect(plan).toMatchObject({ ok: true, changed: true });
    if (plan.ok) expect(plan.text).toBe('model = "o4"\n\n[mcp_servers.semrush]\nurl = "https://mcp.semrush.com/v2/mcp"\n');
    expect(planCodexVendorTomlEdit("= nope", SEMRUSH)).toMatchObject({ ok: false });
  });
});

describe("vendor-mcp: Claude Desktop", () => {
  it("prints the Connectors steps and the URL, and writes nothing", async () => {
    const h = harness([["semrush"], ["claude-desktop"]], { desktopDir: true });
    const r = await step(h.ctx, asked);
    expect(r.outcome).toBe("skipped");
    expect(r.message).toBe("Semrush in Claude Desktop: manual.");
    const out = h.all();
    expect(out).toContain("Settings > Connectors");
    expect(out).toContain('Choose "Add custom connector"');
    expect(out).toContain("URL: https://mcp.semrush.com/v2/mcp");
    expect(existsSync(h.desktop)).toBe(false);
  });
});

describe("vendor-mcp: choosing and --yes", () => {
  it("pre-ticks the vendors picked as data providers", async () => {
    const h = harness([true, ["cursor"], true]);
    h.ctx.providers = { selected: new Set(["ahrefs"]), working: new Set() };
    const p = h.ctx.prompt as ReturnType<typeof scripted>;
    mkdirSync(join(h.base, ".cursor"), { recursive: true });
    const r = await step(h.ctx, asked);
    // `true` on the vendor pick means "keep the defaults".
    expect(r.message).toBe("Ahrefs in Cursor: registered.");
    expect(p.asked[0]).toBe("Add which vendor MCP servers?");
  });

  it("pre-ticks vendors whose crawlmark integration works when nothing was picked in this run", async () => {
    const h = harness([true, ["cursor"], true], { cursorDir: true });
    h.ctx.status = vi.fn(async () => ({ integrations: [{ id: "semrush", state: "working" }] }) as never);
    expect((await step(h.ctx, asked)).message).toBe("Semrush in Cursor: registered.");
  });

  it("--step with --yes adds nothing and asks nothing", async () => {
    const h = harness([], { yes: true, cursorDir: true, prompt: autoPrompter(() => {}) });
    const r = await step(h.ctx, asked);
    expect(r.outcome).toBe("skipped");
    expect(existsSync(h.cursor)).toBe(false);
    expect(h.adds()).toEqual([]);
  });

  it("the init question defaults to no, is skipped under --yes and in plain mode, and is not in their plan", async () => {
    const yes = harness([], { yes: true, fancy: true, prompt: autoPrompter(() => {}) });
    yes.ctx.providers = { selected: new Set(["semrush"]), working: new Set() };
    expect((await step(yes.ctx)).outcome).toBe("skipped");
    const plain = harness([]);
    plain.ctx.providers = { selected: new Set(["semrush"]), working: new Set() };
    expect((await step(plain.ctx)).message).toContain("setup --step vendor-mcp");
    const none = harness([], { fancy: true });
    expect((await step(none.ctx)).message).toBe("Not needed (no Semrush or Ahrefs picked).");
    const ask = harness([false], { fancy: true });
    ask.ctx.providers = { selected: new Set(["semrush", "ahrefs"]), working: new Set() };
    const p = ask.ctx.prompt as ReturnType<typeof scripted>;
    expect((await step(ask.ctx)).outcome).toBe("skipped");
    expect(p.asked).toEqual(["Also add Semrush and Ahrefs's own MCP server to these apps? (optional)"]);
    expect(runPlan()).toContain("vendor-mcp");
    expect(runPlan("vendor-mcp")).toEqual(["vendor-mcp"]);
  });

  it("the init question isn't asked when register set up no apps", async () => {
    const h = harness([], { fancy: true });
    h.ctx.providers = { selected: new Set(["semrush"]), working: new Set() };
    const r = await step(h.ctx, { apps: [] });
    expect(r).toMatchObject({ outcome: "skipped", message: expect.stringContaining("No apps were set up") });
    expect((h.ctx.prompt as ReturnType<typeof scripted>).asked).toEqual([]);
  });

  it("the init question, answered yes, adds to the apps the register step set up (Cursor here) and no others", async () => {
    const h = harness([true, true], { fancy: true, cursorDir: true, desktopDir: true });
    h.ctx.providers = { selected: new Set(["semrush"]), working: new Set() };
    const apps: AppId[] = ["cursor"];
    expect((await step(h.ctx, { apps })).outcome).toBe("done");
    expect(JSON.parse(readFileSync(h.cursor, "utf8")).mcpServers.semrush).toEqual({ url: SEMRUSH.url });
    expect(h.all()).not.toContain("Connectors");
  });
});

describe("vendor-mcp: no key is ever written", () => {
  it("leaves no API key or Authorization header in any config or backup", async () => {
    const h = harness([["semrush", "ahrefs"], ["cursor", "codex"], true, true, true, true], { cursorJson: otherJson, codexToml: 'model = "o4"\n' });
    await step(h.ctx, asked);
    const text = allText(h.base);
    expect(text).not.toMatch(/Apikey|Authorization|headers|api[_-]?key/i);
    expect(JSON.parse(readFileSync(h.cursor, "utf8")).mcpServers.semrush).toEqual({ url: SEMRUSH.url });
  });
});
