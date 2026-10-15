import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { detectApps, registerApps, type AppId } from "../src/setup/apps.js";
import { autoPrompter, type Choice, type Prompter } from "../src/setup/prompter.js";
import { recordingUi } from "../src/setup/ui.js";
import type { ExecResult, WizardContext } from "../src/setup/wizard.js";
import { POSIX_MODES } from "./platform.js";

const SENTINEL = "sk-SENTINEL-other-server-9999";

type Answer = boolean | string | AppId[];

function scripted(answers: Answer[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = (q: string): Answer => {
    asked.push(q);
    if (!answers.length) throw new Error(`Unexpected question: ${q}`);
    return answers.shift()!;
  };
  return {
    asked,
    ask: async (q, o = {}) => ((next(q) as string) || o.default) ?? "",
    secret: async (q) => next(q) as string,
    confirm: async (q) => next(q) as boolean,
    choose: async <T extends string>(q: string, _c: readonly Choice<T>[], d: T) => ((next(q) as string) || d) as T,
    multiselect: async <T extends string>(q: string, _c: readonly Choice<T>[], d: readonly T[]) => {
      const a = next(q);
      return (a === "" ? [...d] : a) as T[];
    },
    close() {},
  };
}

interface Opts {
  claude?: boolean;
  claudeGet?: string;
  codex?: boolean;
  codexGet?: string;
  desktopDir?: boolean;
  cursorDir?: boolean;
  codexDir?: boolean;
  cursorOnPath?: boolean;
  dryRun?: boolean;
  homeSource?: "project" | "user";
  prompt?: Prompter;
}

function harness(answers: Answer[], o: Opts = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "crawlmark-apps-")));
  const home = join(base, "home");
  const root = join(base, "root");
  mkdirSync(home);
  mkdirSync(root);
  const desktopDir = join(base, "Claude");
  const cursorDir = join(base, ".cursor");
  const codexDir = join(base, ".codex");
  if (o.desktopDir) mkdirSync(desktopDir);
  if (o.cursorDir) mkdirSync(cursorDir);
  if (o.codexDir) mkdirSync(codexDir);
  const codexConfig = join(codexDir, "config.toml");
  const lines: string[] = [];
  const order: string[] = [];
  const exec = vi.fn(async (cmd: string, args: string[]): Promise<ExecResult> => {
    // The .bak check is logged right after the command it guards: it must already exist when add/remove runs.
    order.push(`${cmd} ${args.slice(0, 3).join(" ")}`);
    if (cmd === "claude") {
      if (o.claude === false) return { code: 127, stdout: "", stderr: "" };
      if (args[1] === "get") return o.claudeGet === undefined ? { code: 1, stdout: "", stderr: "not found" } : { code: 0, stdout: o.claudeGet, stderr: "" };
      return { code: 0, stdout: "2.0.0", stderr: "" };
    }
    if (cmd === "codex") {
      if (!o.codex) return { code: 127, stdout: "", stderr: "" };
      if (args[1] === "get") return o.codexGet === undefined ? { code: 1, stdout: "", stderr: "not found" } : { code: 0, stdout: o.codexGet, stderr: "" };
      if (args[1] === "add" || args[1] === "remove") order.push(`bak-exists=${existsSync(`${codexConfig}.bak`)}`);
      return { code: 0, stdout: "codex 1.0", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const ui = recordingUi();
  const ctx: WizardContext = {
    prompt: o.prompt ?? scripted(answers),
    out: (l = "") => lines.push(l),
    exec,
    cli: vi.fn(),
    fetch: vi.fn() as unknown as typeof fetch,
    status: vi.fn(),
    checkKeyFile: vi.fn(),
    paths: {
      home,
      homeSource: o.homeSource ?? "user",
      projectRoot: root,
      envFile: join(home, ".env"),
      userHome: base,
      cwd: base,
      desktopConfig: join(desktopDir, "claude_desktop_config.json"),
      cursorConfig: join(cursorDir, "mcp.json"),
      codexConfig,
    },
    which: (name) => name === "cursor" && Boolean(o.cursorOnPath),
    ui,
    node: { version: "v24.1.0", execPath: "/usr/local/bin/node" },
    cliDisplay: "npx crawlmark-mcp",
    shellEnvKeys: new Set(),
    dryRun: o.dryRun ?? false,
  };
  const all = () => [...lines, ...ui.events].join("\n");
  return { ctx, lines, ui, exec, order, all, base, home, root, desktop: ctx.paths.desktopConfig!, cursor: ctx.paths.cursorConfig!, codexConfig };
}

const otherServers = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x", env: { TOKEN: SENTINEL } } } }, null, 2) + "\n";
const tomlFixture = `# my codex settings\nmodel = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n# keep me\nenv = { TOKEN = "${SENTINEL}" }\n`;
const mode = (p: string) => statSync(p).mode & 0o777;
const writes = (order: string[]) => order.filter((c) => / (add|remove) /.test(` ${c} `) && !c.includes("--version"));

describe("detectApps", () => {
  it("follows each detection rule and runs only --version and get", async () => {
    const none = harness([]);
    expect((await detectApps(none.ctx)).map((p) => [p.id, p.detected])).toEqual([
      ["claude-code", true],
      ["claude-desktop", false],
      ["cursor", false],
      ["codex", false],
    ]);
    const h = harness([], { claude: false, desktopDir: true, cursorOnPath: true, codexDir: true });
    const probes = await detectApps(h.ctx);
    expect(probes.map((p) => [p.id, p.detected, p.hint])).toEqual([
      ["claude-code", false, undefined],
      ["claude-desktop", true, "found"],
      ["cursor", true, "found"],
      ["codex", true, "found"],
    ]);
    expect(probes.find((p) => p.id === "codex")!.codexCli).toBe(false);
    const cli = harness([], { codex: true });
    expect((await detectApps(cli.ctx)).find((p) => p.id === "codex")).toMatchObject({ detected: true, codexCli: true });
    expect(cli.order).toEqual(["claude --version", "claude mcp get crawlmark", "codex --version", "codex mcp get crawlmark"]);
  });

  it("marks an app with this exact registration as already set up", async () => {
    const h = harness([], { cursorDir: true });
    const first = harness(["", true, true], { claude: false, cursorDir: true });
    first.ctx.paths = h.ctx.paths;
    await registerApps(first.ctx);
    expect((await detectApps(h.ctx)).find((p) => p.id === "cursor")).toMatchObject({ same: true, hint: "already set up" });
  });
});

describe("register: Cursor and Claude Desktop (JSON)", () => {
  it("new: shows the change (names only, env hidden), writes with a 0600 .bak and keeps other servers", async () => {
    const h = harness(["", true, true], { claude: false, desktopDir: true, cursorDir: true });
    writeFileSync(h.cursor, otherServers);
    writeFileSync(h.desktop, otherServers);
    const r = await registerApps(h.ctx);
    expect(r.outcome).toBe("done");
    expect(r.apps).toEqual([
      { id: "claude-desktop", status: "registered" },
      { id: "cursor", status: "registered" },
    ]);
    const cursor = JSON.parse(readFileSync(h.cursor, "utf8"));
    expect(cursor.theme).toBe("dark");
    expect(cursor.mcpServers.other.env.TOKEN).toBe(SENTINEL);
    expect(cursor.mcpServers.crawlmark).toEqual({ type: "stdio", command: "/usr/local/bin/node", args: ["--disable-warning=ExperimentalWarning", join(h.root, "dist", "index.js")], env: { CRAWLMARK_HOME: h.home } });
    expect(JSON.parse(readFileSync(h.desktop, "utf8")).mcpServers.crawlmark.type).toBeUndefined();
    for (const f of [h.cursor, h.desktop]) {
      expect(readFileSync(`${f}.bak`, "utf8")).toBe(otherServers);
      if (POSIX_MODES) expect(mode(`${f}.bak`)).toBe(0o600);
    }
    expect(h.all()).toContain("Other servers kept unchanged: other");
    expect(h.all()).toContain('"CRAWLMARK_HOME": "<hidden>"');
    expect(h.all()).not.toContain(SENTINEL);
  });

  it("identical: nothing asked or written; different: replace defaults to no and --yes never replaces", async () => {
    const h = harness([""], { claude: false, cursorDir: true });
    const entry = { type: "stdio", command: "/usr/local/bin/node", args: ["--disable-warning=ExperimentalWarning", join(h.root, "dist", "index.js")], env: { CRAWLMARK_HOME: h.home } };
    writeFileSync(h.cursor, JSON.stringify({ mcpServers: { crawlmark: entry } }));
    expect((await registerApps(h.ctx)).apps).toEqual([{ id: "cursor", status: "already" }]);
    expect(existsSync(`${h.cursor}.bak`)).toBe(false);

    const yes = harness([], { claude: false, cursorDir: true, prompt: autoPrompter(() => {}) });
    writeFileSync(yes.cursor, JSON.stringify({ mcpServers: { crawlmark: { command: "old" } } }));
    expect((await registerApps(yes.ctx)).apps).toEqual([{ id: "cursor", status: "skipped" }]);
    expect(JSON.parse(readFileSync(yes.cursor, "utf8")).mcpServers.crawlmark).toEqual({ command: "old" });
  });

  it("unreadable: an invalid file is reported, not overwritten", async () => {
    const h = harness([""], { claude: false, cursorDir: true });
    writeFileSync(h.cursor, "{ broken");
    expect((await registerApps(h.ctx)).apps).toEqual([{ id: "cursor", status: "failed" }]);
    expect(readFileSync(h.cursor, "utf8")).toBe("{ broken");
    expect(h.all()).toContain("The Cursor config isn't valid JSON");
  });
});

describe("register: Codex text edit (no working CLI)", () => {
  it("new: appends, keeps comments and the other server byte for byte, 0600 .bak, never shows other values", async () => {
    const h = harness(["", true], { claude: false, codexDir: true });
    writeFileSync(h.codexConfig, tomlFixture);
    const r = await registerApps(h.ctx);
    expect(r.apps).toEqual([{ id: "codex", status: "registered" }]);
    const text = readFileSync(h.codexConfig, "utf8");
    expect(text.startsWith(tomlFixture)).toBe(true);
    // TOML basic strings escape backslashes like JSON does (Windows paths).
    expect(text).toContain(`[mcp_servers.crawlmark.env]\nCRAWLMARK_HOME = ${JSON.stringify(h.home)}`);
    expect(readFileSync(`${h.codexConfig}.bak`, "utf8")).toBe(tomlFixture);
    if (POSIX_MODES) expect(mode(`${h.codexConfig}.bak`)).toBe(0o600);
    expect(h.all()).toContain("CRAWLMARK_HOME = <hidden>");
    expect(h.all()).not.toContain(SENTINEL);
    expect(h.all()).not.toContain(h.home);
  });

  it("identical, different (default no; --yes never replaces) and unreadable", async () => {
    const h = harness(["", true], { claude: false, codexDir: true });
    await registerApps(h.ctx);
    const again = harness([""], { claude: false, codexDir: true });
    again.ctx.paths = h.ctx.paths;
    expect((await registerApps(again.ctx)).apps).toEqual([{ id: "codex", status: "already" }]);

    const diff = harness([], { claude: false, codexDir: true, prompt: autoPrompter(() => {}) });
    const old = '[mcp_servers.crawlmark]\ncommand = "old"\nargs = []\n';
    writeFileSync(diff.codexConfig, old);
    expect((await registerApps(diff.ctx)).apps).toEqual([{ id: "codex", status: "skipped" }]);
    expect(readFileSync(diff.codexConfig, "utf8")).toBe(old);

    const bad = harness([""], { claude: false, codexDir: true });
    writeFileSync(bad.codexConfig, '[mcp_servers]\ncrawlmark = { command = "x" }\n');
    expect((await registerApps(bad.ctx)).apps).toEqual([{ id: "codex", status: "failed" }]);
    expect(bad.all()).toContain("paste this into that file");
  });
});

describe("register: Codex CLI", () => {
  const launchArgs = (h: ReturnType<typeof harness>) => ["--disable-warning=ExperimentalWarning", join(h.root, "dist", "index.js")];

  it("new: shows the command with env hidden, backs up config.toml before add", async () => {
    const h = harness(["", true], { claude: false, codex: true, codexDir: true });
    writeFileSync(h.codexConfig, tomlFixture);
    expect((await registerApps(h.ctx)).apps).toEqual([{ id: "codex", status: "registered" }]);
    expect(h.lines.join("\n")).toContain("--env CRAWLMARK_HOME=<hidden> --");
    expect(h.order).toEqual(["claude --version", "codex --version", "codex mcp get crawlmark", "codex mcp add crawlmark", "bak-exists=true"]);
    const add = h.exec.mock.calls.find((c) => c[1][1] === "add")!;
    expect(add[1]).toEqual(["mcp", "add", "crawlmark", "--env", `CRAWLMARK_HOME=${h.home}`, "--", "/usr/local/bin/node", ...launchArgs(h)]);
    if (POSIX_MODES) expect(mode(`${h.codexConfig}.bak`)).toBe(0o600);
  });

  it("identical, different (default no, then remove+add after yes) and unreadable", async () => {
    const same = harness([""], { claude: false, codex: true });
    same.ctx.paths.homeSource = "project";
    const sameGet = JSON.stringify({ name: "crawlmark", transport: { type: "stdio", command: "/usr/local/bin/node", args: launchArgs(same), env: null } });
    const s2 = harness([""], { claude: false, codex: true, codexGet: sameGet, homeSource: "project" });
    s2.ctx.paths.projectRoot = same.root;
    expect((await registerApps(s2.ctx)).apps).toEqual([{ id: "codex", status: "already" }]);

    const differentGet = JSON.stringify({ transport: { type: "stdio", command: "node", args: ["/old.js"], env: { TOKEN: SENTINEL } } });
    const yes = harness([], { claude: false, codex: true, codexGet: differentGet, prompt: autoPrompter(() => {}) });
    expect((await registerApps(yes.ctx)).apps).toEqual([{ id: "codex", status: "skipped" }]);
    expect(writes(yes.order)).toEqual([]);

    const replace = harness(["", true], { claude: false, codex: true, codexGet: differentGet, codexDir: true });
    writeFileSync(replace.codexConfig, tomlFixture);
    expect((await registerApps(replace.ctx)).apps).toEqual([{ id: "codex", status: "registered" }]);
    expect(replace.order.slice(-4)).toEqual(["codex mcp remove crawlmark", "bak-exists=true", "codex mcp add crawlmark", "bak-exists=true"]);
    expect(replace.all()).not.toContain(SENTINEL);

    const unreadable = harness(["", true], { claude: false, codex: true, codexGet: "crawlmark (http) https://example.com/mcp" });
    expect((await registerApps(unreadable.ctx)).apps).toEqual([{ id: "codex", status: "manual" }]);
    expect(unreadable.all()).toContain("codex mcp remove crawlmark, then codex mcp add crawlmark");
    expect(writes(unreadable.order)).toEqual([]);
  });
});

describe("register: selection", () => {
  it("unticked apps are left alone", async () => {
    const h = harness([["cursor"], true], { desktopDir: true, cursorDir: true });
    writeFileSync(h.desktop, otherServers);
    const r = await registerApps(h.ctx);
    expect(r.apps).toEqual([{ id: "cursor", status: "registered" }]);
    expect(readFileSync(h.desktop, "utf8")).toBe(otherServers);
    expect(writes(h.order)).toEqual([]);
    expect(h.all()).toContain("Left Claude Code alone.");
  });

  it("nothing ticked prints all four snippets", async () => {
    const h = harness([[]], { desktopDir: true, cursorDir: true, codexDir: true });
    const r = await registerApps(h.ctx);
    expect(r.outcome).toBe("skipped");
    const out = h.lines.join("\n");
    expect(out).toContain("claude mcp add crawlmark -s user");
    expect(out).toContain('"mcpServers"');
    expect(out).toContain("[mcp_servers.crawlmark]");
    expect(existsSync(h.cursor)).toBe(false);
    expect(existsSync(h.codexConfig)).toBe(false);
  });

  it("a dry run writes nothing and runs nothing but --version and get", async () => {
    const h = harness(["", true, true, true, true], { codex: true, desktopDir: true, cursorDir: true, codexDir: true, dryRun: true });
    const r = await registerApps(h.ctx);
    expect(r.outcome).toBe("done");
    expect(h.order.every((c) => c.includes("--version") || c.includes(" get "))).toBe(true);
    for (const f of [h.desktop, h.cursor, h.codexConfig]) expect(existsSync(f)).toBe(false);
    expect(r.apps!.map((a) => a.status)).toEqual(["dry-run", "dry-run", "dry-run", "dry-run"]);
  });

  it("the plain multiselect summary names the detected apps", async () => {
    const prompt = scripted([""]);
    const spy = vi.spyOn(prompt, "multiselect");
    const h = harness([], { claude: false, codexDir: true, prompt });
    prompt.confirm = async () => false;
    await registerApps(h.ctx);
    expect(spy.mock.calls[0]![3]).toEqual({ summary: "Register with: Codex (detected). Use these?" });
    expect(spy.mock.calls[0]![2]).toEqual(["codex"]);
  });
});

describe("security: a malformed config never leaks another server's secret", () => {
  it("SEC-1: the JSON parse error shows only the position", async () => {
    const h = harness([""], { claude: false, cursorDir: true });
    writeFileSync(h.cursor, `{ "mcpServers": { "other": { "env": { "TOKEN": '${SENTINEL}' } } } }`);
    expect((await registerApps(h.ctx)).apps).toEqual([{ id: "cursor", status: "failed" }]);
    expect(h.all()).toContain("The Cursor config isn't valid JSON");
    expect(h.all()).not.toContain(SENTINEL);
    expect(h.all()).not.toContain("SENTINEL");
  });
});

describe("R-1: Codex CLI replace keeps the pre-remove backup", () => {
  it("the .bak still holds the old crawlmark entry after remove + add", async () => {
    const differentGet = JSON.stringify({ transport: { type: "stdio", command: "node", args: ["/old.js"] } });
    const h = harness(["", true], { claude: false, codex: true, codexGet: differentGet, codexDir: true });
    const withOld = `${tomlFixture}\n[mcp_servers.crawlmark]\ncommand = "node"\nargs = ["/old.js"]\n`;
    writeFileSync(h.codexConfig, withOld);
    // Like the real CLI, `remove` rewrites config.toml without the entry.
    const exec = h.ctx.exec;
    h.ctx.exec = async (cmd, args, opts) => {
      if (cmd === "codex" && args[1] === "remove") writeFileSync(h.codexConfig, tomlFixture);
      return exec(cmd, args, opts);
    };
    expect((await registerApps(h.ctx)).apps).toEqual([{ id: "codex", status: "registered" }]);
    expect(readFileSync(`${h.codexConfig}.bak`, "utf8")).toBe(withOld);
    expect(h.all()).toContain(`Registered with Codex (backup: ${h.codexConfig}.bak)`);
  });
});

describe("R-4: a failed `codex mcp get` is not proof that crawlmark is absent", () => {
  /** A codex whose `mcp get --json` fails without saying "not found" (e.g. an older CLI without --json). */
  function oldCodex(answers: Answer[], o: Opts = {}) {
    const h = harness(answers, { claude: false, codex: true, codexDir: true, ...o });
    const exec = h.ctx.exec;
    h.ctx.exec = async (cmd, args, opts) => {
      if (cmd === "codex" && args[1] === "get") return { code: 2, stdout: "", stderr: "error: unexpected argument '--json' found" };
      return exec(cmd, args, opts);
    };
    return h;
  }
  const entryToml = (h: ReturnType<typeof harness>) =>
    `[mcp_servers.crawlmark]\ncommand = "/usr/local/bin/node"\nargs = ["--disable-warning=ExperimentalWarning", ${JSON.stringify(join(h.root, "dist", "index.js"))}]\n\n[mcp_servers.crawlmark.env]\nCRAWLMARK_HOME = ${JSON.stringify(h.home)}\n`;

  it("--yes never adds over an existing (different) entry found in config.toml", async () => {
    const h = oldCodex([], { prompt: autoPrompter(() => {}) });
    writeFileSync(h.codexConfig, '[mcp_servers.crawlmark]\ncommand = "old"\nargs = []\n');
    expect((await registerApps(h.ctx)).apps).toEqual([{ id: "codex", status: "skipped" }]);
    expect(writes(h.order)).toEqual([]);
  });

  it("uses config.toml to see the same entry, or no entry", async () => {
    const same = oldCodex([""]);
    writeFileSync(same.codexConfig, entryToml(same));
    expect((await registerApps(same.ctx)).apps).toEqual([{ id: "codex", status: "already" }]);

    const none = oldCodex(["", true]);
    writeFileSync(none.codexConfig, tomlFixture);
    expect((await registerApps(none.ctx)).apps).toEqual([{ id: "codex", status: "registered" }]);
  });

  it("leaves it alone and prints the replace commands when config.toml can't be read either", async () => {
    const h = oldCodex(["", true]);
    writeFileSync(h.codexConfig, "not = = toml");
    expect((await registerApps(h.ctx)).apps).toEqual([{ id: "codex", status: "manual" }]);
    expect(h.all()).toContain("codex mcp remove crawlmark, then codex mcp add crawlmark");
    expect(writes(h.order)).toEqual([]);
  });
});

describe("R-4 follow-up: an unrelated not-found failure doesn't count as absent", () => {
  it("falls through to config.toml and leaves a different entry alone under --yes", async () => {
    const h = harness([], { claude: false, codex: true, codexDir: true, prompt: autoPrompter(() => {}) });
    const exec = h.ctx.exec;
    h.ctx.exec = async (cmd, args, opts) => {
      if (cmd === "codex" && args[1] === "get") return { code: 1, stdout: "", stderr: "Error: profile not found" };
      return exec(cmd, args, opts);
    };
    writeFileSync(h.codexConfig, '[mcp_servers.crawlmark]\ncommand = "old"\nargs = []\n');
    expect((await registerApps(h.ctx)).apps).toEqual([{ id: "codex", status: "skipped" }]);
    expect(writes(h.order)).toEqual([]);
  });

  it("a not-found message that names crawlmark is trusted", async () => {
    const h = harness(["", true], { claude: false, codex: true, codexDir: true });
    const exec = h.ctx.exec;
    h.ctx.exec = async (cmd, args, opts) => {
      if (cmd === "codex" && args[1] === "get") return { code: 1, stdout: "", stderr: "No MCP server named 'crawlmark' found." };
      return exec(cmd, args, opts);
    };
    // config.toml is unparseable, so only the trusted message can say "absent".
    writeFileSync(h.codexConfig, "not = = toml");
    expect((await registerApps(h.ctx)).apps).toEqual([{ id: "codex", status: "registered" }]);
  });
});
