import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_FILE, HOME, env } from "../src/config.js";
import { MENU_QUESTION } from "../src/setup/menu.js";
import { run, setupCommand, type SetupFlags } from "../src/setup/cli-setup.js";
import type { IntegrationId, IntegrationStatus } from "../src/setup/status.js";
import { ABORT, a, script, type Script, type Step } from "./helpers/scripted-ui.js";
import { POSIX_MODES } from "./platform.js";

/**
 * `crawlmark-cli init` / `setup` end to end through src/setup/cli-setup.ts, with no terminal, no child
 * processes and no network:
 *  - the renderer and prompts are a scripted fake (ui-clack.js and the line prompter are replaced by it),
 *  - node:child_process.spawn is a fake that answers the `claude` binary and crawlmark's own `setup status`
 *    child, and refuses everything else,
 *  - global fetch is a fake (DataForSEO, PageSpeed),
 *  - HOME, CRAWLMARK_HOME, DATA_DIR, the app config paths and the claude/codex binaries are the temp
 *    locations test/setup.ts points them at; a guard below refuses to run if any is not.
 */

const h = vi.hoisted(() => ({
  renderer: "fancy" as "fancy" | "plain",
  current: undefined as undefined | { ui: unknown; prompt: unknown },
  /** spawn calls, for assertions. */
  spawned: [] as { cmd: string; args: string[] }[],
  /** Status rows the fake `setup status --json` child returns, by integration id (others are "missing"). */
  rows: {} as Record<string, { state: string; detail?: string; data?: Record<string, unknown> }>,
  claudeInstalled: true,
  claudeGetStdout: undefined as string | undefined,
  /** Let the next spawn calls reach the real spawn (only the `run` tests). */
  real: false,
}));

vi.mock("../src/setup/ui-clack.js", () => ({
  clackUi: () => h.current!.ui,
  clackPrompter: () => h.current!.prompt,
}));
vi.mock("../src/setup/ui.js", async (importActual) => ({ ...(await importActual<typeof import("../src/setup/ui.js")>()), chooseRenderer: () => h.renderer }));
vi.mock("../src/setup/prompter.js", async (importActual) => ({ ...(await importActual<typeof import("../src/setup/prompter.js")>()), terminalPrompter: () => h.current!.prompt }));

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  const fakeSpawn = (cmd: string, args: readonly string[] = [], opts?: unknown) => {
    if (h.real) return (actual.spawn as (...a: unknown[]) => unknown)(cmd, args, opts);
    h.spawned.push({ cmd, args: [...args] });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let code = 127;
    let stdout = "";
    let stderr = "";
    const claudeBin = process.env.CRAWLMARK_CLAUDE_BIN;
    if (cmd === claudeBin && h.claudeInstalled) {
      code = 0;
      if (args[0] === "--version") stdout = "2.0.0";
      else if (args[0] === "mcp" && args[1] === "get") {
        if (h.claudeGetStdout === undefined) (code = 1), (stderr = "No MCP server found");
        else stdout = h.claudeGetStdout;
      }
    } else if (cmd === process.execPath && args.includes(process.argv[1] as string)) {
      // crawlmark running itself: `setup status --json --only a,b`; anything else (clients list, brand suggest) succeeds.
      code = 0;
      const iStatus = args.indexOf("status");
      if (iStatus >= 0) {
        const only = (args[args.indexOf("--only") + 1] ?? "").split(",").filter(Boolean) as IntegrationId[];
        const integrations: IntegrationStatus[] = only.map((id) => {
          const r = h.rows[id];
          return { id, label: id, state: (r?.state ?? "missing") as IntegrationStatus["state"], detail: r?.detail ?? `${id} ${r?.state ?? "missing"}`, next: null, ...(r?.data ? { data: r.data } : {}) };
        });
        stdout = JSON.stringify({
          home: { dir: HOME.dir, source: HOME.source, reason: "test", envFile: ENV_FILE, envFileExists: existsSync(ENV_FILE) },
          cli: "crawlmark-cli",
          integrations,
          summary: { working: 0, configured: 0, missing: 0, error: 0 },
          checkedAt: "",
          fromCache: false,
          costUsd: 0,
        });
      }
    }
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      if (code === 127) child.emit("error", Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" }));
      else child.emit("close", code);
    });
    return child;
  };
  return { ...actual, spawn: fakeSpawn, default: { ...actual, spawn: fakeSpawn } };
});

const flags = (over: Partial<SetupFlags> = {}): SetupFlags => ({ "dry-run": false, yes: false, json: false, refresh: false, force: false, ...over });

// ------------------------------------------------------------------ fake world

let stdout: string[];
let stderr: string[];
let fetchCalls: { url: string; headers: Record<string, string> }[];
let fetchPlan: (url: string) => Response;

const dfsResponse = (status: number) =>
  status === 200
    ? new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", cost: 0, tasks: [{ id: "1", status_code: 20000, status_message: "Ok.", cost: 0, result: [{ money: { balance: 1.25, total: 5 } }] }] }), { status: 200 })
    : new Response("Unauthorized", { status });

const userHome = () => homedir();
const desktopConfig = () => process.env.CRAWLMARK_CLAUDE_DESKTOP_CONFIG!;
const cursorConfig = () => process.env.CRAWLMARK_CURSOR_CONFIG!;
const codexConfig = () => process.env.CRAWLMARK_CODEX_CONFIG!;
const mode = (p: string) => statSync(p).mode & 0o777;

/** Run setupCommand with the script as the terminal; returns the exit code. */
async function runSetup(s: Script, cmd: string | undefined, args: string[], f: SetupFlags, invokedAs: "setup" | "init" = "setup"): Promise<number> {
  h.current = s;
  return setupCommand(cmd, args, f, invokedAs);
}

const say = () => stdout.join("");

beforeAll(() => {
  // The safety net: every location this suite can write is inside the temp dir from test/setup.ts.
  for (const p of [HOME.dir, userHome(), env.DATA_DIR, env.CLIENTS_FILE, desktopConfig(), cursorConfig(), codexConfig(), process.env.CRAWLMARK_CLAUDE_BIN!, process.env.CRAWLMARK_CODEX_BIN!]) {
    if (!p.includes("crawlmark-test-")) throw new Error(`Refusing to run: ${p} is not under the temp dir`);
  }
  for (const k of ["HOME", "USERPROFILE", "CRAWLMARK_HOME", "DATA_DIR"]) {
    if (!process.env[k]?.includes("crawlmark-test-")) throw new Error(`Refusing to run: ${k}=${process.env[k]} is not a temp dir`);
  }
});

beforeEach(() => {
  stdout = [];
  stderr = [];
  fetchCalls = [];
  fetchPlan = (url) => {
    if (url.includes("dataforseo")) return dfsResponse(200);
    if (url.includes("pagespeedonline")) return new Response("{}", { status: 200 });
    return new Response("unexpected", { status: 500 });
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!/^https?:\/\/(127\.0\.0\.1|[a-z0-9.-]*(dataforseo|googleapis)[a-z0-9.-]*)(:\d+)?\//.test(url)) throw new Error(`Unexpected fetch ${url}`);
    fetchCalls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return fetchPlan(url);
  });
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => (stdout.push(String(chunk)), true)) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write);
  h.renderer = "fancy";
  h.spawned = [];
  h.rows = {};
  h.claudeInstalled = true;
  h.claudeGetStdout = undefined;
  h.real = false;
  // Start every test from an empty home and empty app folders.
  for (const p of [HOME.dir, join(userHome(), ".cursor"), join(userHome(), ".codex"), join(desktopConfig(), ".."), env.CLIENTS_FILE]) rmSync(p, { recursive: true, force: true });
  mkdirSync(HOME.dir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(HOME.dir, { recursive: true, force: true });
});

afterAll(() => {
  for (const p of [join(userHome(), ".cursor"), join(userHome(), ".codex"), join(desktopConfig(), "..")]) rmSync(p, { recursive: true, force: true });
});

/** Make the apps look installed: their config folders exist under the temp HOME. */
function installApps(which: ("desktop" | "cursor" | "codex")[] = ["desktop", "cursor", "codex"]) {
  if (which.includes("desktop")) mkdirSync(join(desktopConfig(), ".."), { recursive: true });
  if (which.includes("cursor")) mkdirSync(join(cursorConfig(), ".."), { recursive: true });
  if (which.includes("codex")) mkdirSync(join(codexConfig(), ".."), { recursive: true });
}

// ------------------------------------------------------------------ the first run

/** The node step asks to build only on a checkout whose dist/ is missing or stale; say no either way. */
const buildNo = a("Build now", false, true);

describe("crawlmark-cli init, first run (DataForSEO sandbox typed in, Google skipped, all four apps registered)", () => {
  const firstRun = (extra: Step[] = []): Step[] => [
    buildNo,
    a("Which SEO data providers do you have?", ["dataforseo"]),
    a("Press Enter to open DataForSEO API access", "s"),
    a("Which DataForSEO API?", "sandbox"),
    a("API login", "sandbox-login@example.com"),
    a("API password", "dfs-api-password-123"),
    a("Set up Google", false),
    a("PageSpeed Insights API key", false),
    a("Add crawlmark to which apps?", ""),
    a("Register crawlmark with Claude Code?", true),
    a("Write this change?", true), // Claude Desktop
    a("Write this change?", true), // Cursor
    a("Write this change?", true), // Codex (config.toml edit: its binary isn't on this machine)
    ...extra,
  ];

  it("asks exactly these questions, checks the credentials live (faked), saves .env 0600 and registers every app under the temp home", async () => {
    installApps();
    const s = script(firstRun());

    const code = await runSetup(s, undefined, [], flags(), "init");

    expect(code, say() + stderr.join("")).toBe(0);
    s.assertDrained();

    // The questions, in order.
    const prompts = s.asked.filter((q) => !q.question.includes("Build now")).map((q) => [q.kind, q.question] as const);
    const expected = [
      ["multiselect", "Which SEO data providers"],
      ["ask", "Press Enter to open DataForSEO"],
      ["choose", "Which DataForSEO API?"],
      ["ask", "API login"],
      ["secret", "API password"],
      ["confirm", "Set up Google"],
      ["confirm", "Add a PageSpeed Insights API key"],
      ["multiselect", "Add crawlmark to which apps?"],
      ["confirm", "Register crawlmark with Claude Code?"],
      ["confirm", "Write this change?"],
      ["confirm", "Write this change?"],
      ["confirm", "Write this change?"],
    ] as const;
    expect(prompts.map(([k]) => k)).toEqual(expected.map(([k]) => k));
    expected.forEach(([, text], i) => expect(prompts[i]![1]).toContain(text));
    const providerQ = s.asked.find((q) => q.kind === "multiselect" && q.question.startsWith("Which SEO"))!;
    expect(providerQ.options).toEqual(["dataforseo", "ahrefs", "semrush"]);
    expect(providerQ.def).toEqual(["dataforseo"]); // a fresh home pre-ticks DataForSEO only
    expect(s.asked.find((q) => q.kind === "choose" && q.question === "Which DataForSEO API?")!.def).toBe("sandbox");

    // The credentials went to the DataForSEO sandbox with Basic auth, through the faked fetch.
    const dfs = fetchCalls.find((c) => c.url.includes("dataforseo"))!;
    expect(dfs.url).toContain("sandbox");
    expect(dfs.headers.authorization).toBe(`Basic ${Buffer.from("sandbox-login@example.com:dfs-api-password-123").toString("base64")}`);
    expect(fetchCalls.every((c) => /127\.0\.0\.1|dataforseo/.test(c.url))).toBe(true);

    // .env in the temp home: login, password, sandbox URL. 0600.
    const dotenv = readFileSync(ENV_FILE, "utf8");
    expect(dotenv).toContain("DATAFORSEO_LOGIN=sandbox-login@example.com");
    expect(dotenv).toContain("DATAFORSEO_PASSWORD=dfs-api-password-123");
    expect(dotenv).toMatch(/DATAFORSEO_BASE_URL=.*sandbox/);
    expect(ENV_FILE.startsWith(HOME.dir)).toBe(true);
    if (POSIX_MODES) expect(mode(ENV_FILE)).toBe(0o600);

    // The password is never shown anywhere: not in the Ui, not on stdout/stderr.
    const shown = s.ui.events.join("\n") + say() + stderr.join("");
    expect(shown).not.toContain("dfs-api-password-123");
    expect(shown).toContain("Credentials work");

    // Claude Code through its CLI (faked binary); the others by editing the files under the temp HOME.
    expect(h.spawned.some((c) => c.cmd === process.env.CRAWLMARK_CLAUDE_BIN && c.args[0] === "mcp" && c.args[1] === "add")).toBe(true);
    const desktop = JSON.parse(readFileSync(desktopConfig(), "utf8")) as { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> };
    expect(desktop.mcpServers.crawlmark!.command).toBe(process.execPath);
    expect(desktop.mcpServers.crawlmark!.args.at(-1)).toMatch(/dist[\\/]index\.js$/);
    // The home isn't the project root, so the app is told where it is.
    expect(desktop.mcpServers.crawlmark!.env?.CRAWLMARK_HOME).toBe(HOME.dir);
    const cursor = JSON.parse(readFileSync(cursorConfig(), "utf8")) as { mcpServers: Record<string, { command: string }> };
    expect(cursor.mcpServers.crawlmark!.command).toBe(process.execPath);
    const codex = readFileSync(codexConfig(), "utf8");
    expect(codex).toContain("[mcp_servers.crawlmark]");
    expect(codex).toContain(JSON.stringify(process.execPath).slice(1, -1));
    if (POSIX_MODES) for (const p of [desktopConfig(), cursorConfig(), codexConfig()]) expect(mode(p) & 0o077).toBe(0);

    // Nothing was written outside the temp home.
    for (const p of [ENV_FILE, desktopConfig(), cursorConfig(), codexConfig()]) expect(p.includes("crawlmark-test-")).toBe(true);
    expect(s.prompt.closed).toBe(true);

    // The fancy run ends with the summary and an outro.
    expect(s.ui.events.some((e) => e.startsWith("summary:") && e.includes("DataForSEO=done") && e.includes("Claude Code=done"))).toBe(true);
    expect(s.ui.events.at(-1)).toBe("outro: Done");
  });

  it("Try asking Claude uses example.com, with a hint, when there are no clients", async () => {
    installApps();
    const s = script(firstRun());
    await runSetup(s, undefined, [], flags(), "init");
    const tryLine = s.ui.events.find((e) => e.startsWith("try:"))!;
    expect(tryLine).toContain("Give me the monthly report for example.com");
    expect(tryLine).toContain("What are the quick wins for example.com?");
    expect(tryLine).toMatch(/Add your own: .* clients add <domain>/);
  });

  it("Try asking Claude uses the names from the home's clients.yaml (Search Console clients first, ignored ones left out)", async () => {
    installApps();
    writeFileSync(
      env.CLIENTS_FILE,
      [
        "clients:",
        "  plain:",
        "    domain: plain.example.com",
        "  hidden:",
        "    domain: hidden.example.com",
        "    ignore: true",
        "  acme:",
        "    domain: acme.example.com",
        "    name: Acme Widgets",
        '    gscProperty: "sc-domain:acme.example.com"',
        "",
      ].join("\n"),
    );
    const s = script(firstRun());
    await runSetup(s, undefined, [], flags(), "init");
    const tryLine = s.ui.events.find((e) => e.startsWith("try:"))!;
    expect(tryLine).toContain("Give me the monthly report for Acme Widgets (acme.example.com)");
    expect(tryLine).toContain("What are the quick wins for plain.example.com?");
    expect(tryLine).not.toContain("hidden.example.com");
    expect(tryLine).not.toContain("Add your own");
  });

  it("a dry run writes and registers nothing", async () => {
    installApps();
    // A dry run never offers to open the browser, so that question isn't asked.
    const s = script(firstRun().filter((st) => !String(st.q).startsWith("Press Enter")));
    const code = await runSetup(s, undefined, [], flags({ "dry-run": true }), "init");
    expect(code, s.ui.events.filter((e) => /^result|^fail/.test(e)).join("\n")).toBe(0);
    expect(existsSync(ENV_FILE)).toBe(false);
    expect(existsSync(desktopConfig())).toBe(false);
    expect(existsSync(cursorConfig())).toBe(false);
    expect(existsSync(codexConfig())).toBe(false);
    expect(h.spawned.some((c) => c.args[0] === "mcp" && c.args[1] === "add")).toBe(false);
    expect(s.ui.events.some((e) => e.includes("Dry run: would set DATAFORSEO_LOGIN"))).toBe(true);
  });
});

describe("DataForSEO credentials", () => {
  it("rejected three times: exit 1, nothing saved", async () => {
    fetchPlan = () => dfsResponse(401);
    const s = script([
      a("Set up DataForSEO now?", true),
      a("Press Enter to open DataForSEO API access", "s"),
      a("Which DataForSEO API?", "sandbox"),
      ...[1, 2, 3].flatMap(() => [a("API login", "me@example.com"), a("API password", "wrong-pw")]),
    ]);
    const code = await runSetup(s, undefined, [], flags({ step: "dataforseo" }));
    expect(code).toBe(1);
    s.assertDrained();
    expect(existsSync(ENV_FILE)).toBe(false);
    expect(s.ui.events.filter((e) => e.startsWith("fail:") && e.includes("rejected that login"))).toHaveLength(3);
    expect(s.ui.events.some((e) => e.startsWith("result: failed:"))).toBe(true);
    expect(s.ui.events.join("\n")).not.toContain("wrong-pw");
  });

  it("live mode needs a second yes; declining leaves everything unchanged", async () => {
    const s = script([a("Set up DataForSEO now?", true), a("Press Enter to open", "s"), a("Which DataForSEO API?", "live"), a("Use the live API?", false)]);
    const code = await runSetup(s, undefined, [], flags({ step: "dataforseo" }));
    expect(code).toBe(0);
    s.assertDrained();
    expect(existsSync(ENV_FILE)).toBe(false);
    expect(fetchCalls).toHaveLength(0);
    expect(s.ui.events.some((e) => e.includes("result: skipped: Left DataForSEO unchanged."))).toBe(true);
  });
});

// ------------------------------------------------------------------ --step

describe("setup --step", () => {
  it("--step google: declining skips it and exits 0 without touching the home", async () => {
    const s = script([a("Set up Google", false)]);
    const code = await runSetup(s, undefined, [], flags({ step: "google" }));
    expect(code).toBe(0);
    s.assertDrained();
    expect(s.asked).toHaveLength(1);
    expect(existsSync(ENV_FILE)).toBe(false);
    expect(s.ui.events.some((e) => e.startsWith("step: Google"))).toBe(true);
    expect(s.ui.events.some((e) => e.startsWith("result: skipped:"))).toBe(true);
    // A single step prints no "Try asking Claude" box.
    expect(s.ui.events.some((e) => e.startsWith("try:"))).toBe(false);
  });

  it("--step psi: a key that works is saved to .env (0600)", async () => {
    const s = script([a("Add a PageSpeed Insights API key", true), a("Press Enter to open", "s"), a("PageSpeed Insights API key", "psi-key-abc")]);
    const code = await runSetup(s, undefined, [], flags({ step: "psi" }));
    expect(code).toBe(0);
    s.assertDrained();
    expect(readFileSync(ENV_FILE, "utf8")).toContain("PSI_API_KEY=psi-key-abc");
    if (POSIX_MODES) expect(mode(ENV_FILE)).toBe(0o600);
    expect(fetchCalls[0]!.url).toContain("pagespeedonline");
    expect(fetchCalls[0]!.url).toContain("example.com");
    expect(s.ui.events.join("\n")).not.toContain("psi-key-abc");
  });

  it("--step register in a dry run shows the change and writes nothing", async () => {
    installApps(["desktop"]);
    const s = script([a("Add crawlmark to which apps?", ""), a("Register crawlmark with Claude Code?", true), a("Write this change?", true)]);
    const code = await runSetup(s, undefined, [], flags({ step: "register", "dry-run": true }));
    expect(code).toBe(0);
    s.assertDrained();
    expect(existsSync(desktopConfig())).toBe(false);
    expect(s.ui.events.some((e) => e.startsWith("preview: Claude Desktop config:"))).toBe(true);
    expect(h.spawned.some((c) => c.args[1] === "add")).toBe(false);
  });

  it("--step register leaves unticked apps alone and keeps other servers in an existing config", async () => {
    installApps(["desktop", "cursor"]);
    writeFileSync(desktopConfig(), JSON.stringify({ mcpServers: { other: { command: "other-server" } }, theme: "dark" }));
    const s = script([a("Add crawlmark to which apps?", ["claude-desktop"]), a("Write this change?", true)]);
    const code = await runSetup(s, undefined, [], flags({ step: "register" }));
    expect(code).toBe(0);
    s.assertDrained();
    const desktop = JSON.parse(readFileSync(desktopConfig(), "utf8")) as { mcpServers: Record<string, unknown>; theme: string };
    expect(Object.keys(desktop.mcpServers).sort()).toEqual(["crawlmark", "other"]);
    expect(desktop.theme).toBe("dark");
    expect(existsSync(`${desktopConfig()}.bak`)).toBe(true); // the previous file is kept
    expect(existsSync(cursorConfig())).toBe(false);
    expect(existsSync(codexConfig())).toBe(false);
    expect(h.spawned.some((c) => c.args[1] === "add")).toBe(false);
    expect(s.ui.events.some((e) => e.includes("Left Claude Code alone"))).toBe(true);
  });

  it("--step register is idempotent: a second run reports each app as already set up", async () => {
    installApps();
    const answers = (): Step[] => [a("Add crawlmark to which apps?", ""), a("Register crawlmark with Claude Code?", true), a("Write this change?", true), a("Write this change?", true), a("Write this change?", true)];
    await runSetup(script(answers()), undefined, [], flags({ step: "register" }));
    const before = [desktopConfig(), cursorConfig(), codexConfig()].map((p) => readFileSync(p, "utf8"));
    // Claude Code now has the same registration.
    const claudeAdd = h.spawned.find((c) => c.args[1] === "add")!;
    h.claudeGetStdout = `crawlmark:\n  Scope: User config\n  Type: stdio\n  Command: ${claudeAdd.args[claudeAdd.args.indexOf("--") + 1]}\n  Args: ${claudeAdd.args.slice(claudeAdd.args.indexOf("--") + 2).join(" ")}\n  Environment:\n    CRAWLMARK_HOME=${HOME.dir}\n`;
    const s2 = script([a("Add crawlmark to which apps?", "")]);
    const code = await runSetup(s2, undefined, [], flags({ step: "register" }));
    expect(code).toBe(0);
    s2.assertDrained();
    expect([desktopConfig(), cursorConfig(), codexConfig()].map((p) => readFileSync(p, "utf8"))).toEqual(before);
    expect(s2.ui.events.some((e) => e.startsWith("success:") && e.includes("already has this crawlmark entry"))).toBe(true);
  });

  it("an unknown step, a stray argument, --client without branding, and an unknown command exit 2 with a message and no prompts", async () => {
    const s = script([]);
    expect(await runSetup(s, undefined, [], flags({ step: "nope" }))).toBe(2);
    expect(stderr.join("")).toMatch(/Unknown step: nope\. Steps: node, provider/);
    stderr.length = 0;
    expect(await runSetup(s, undefined, ["extra"], flags())).toBe(2);
    expect(stderr.join("")).toContain("Unexpected argument(s): extra");
    stderr.length = 0;
    expect(await runSetup(s, undefined, [], flags({ step: "google", client: "example.com" }))).toBe(2);
    expect(stderr.join("")).toContain("--client goes with --step branding");
    stderr.length = 0;
    expect(await runSetup(s, "bogus", [], flags())).toBe(2);
    expect(stderr.join("")).toContain("Unknown command: setup bogus");
    expect(s.asked).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ the returning-user menu

describe("re-run: the 'already set up' menu", () => {
  const setUp = () => {
    writeFileSync(ENV_FILE, "DATAFORSEO_LOGIN=me@example.com\nDATAFORSEO_PASSWORD=pw\n", { mode: 0o600 });
    h.rows = { dataforseo: { state: "working", detail: "DataForSEO works" }, google: { state: "missing" }, clients: { state: "working", data: { count: 3 } } };
  };

  it("offers the menu with a one-line status, and Exit changes nothing", async () => {
    setUp();
    const before = readFileSync(ENV_FILE, "utf8");
    const s = script([a(MENU_QUESTION, "exit")]);
    const code = await runSetup(s, undefined, [], flags());
    expect(code).toBe(0);
    s.assertDrained();
    const menu = s.asked[0]!;
    expect(menu.kind).toBe("choose");
    expect(menu.options).toEqual(["provider", "google", "register", "vendor-mcp", "discovery", "branding", "status", "full", "exit"]);
    expect(menu.def).toBe("provider");
    expect(s.ui.events).toContain("line: ✔ DataForSEO   ○ Google   ○ Ahrefs   ○ Semrush   ✔ Clients 3");
    expect(s.ui.events).toContain("outro: Nothing changed");
    expect(s.ui.events.some((e) => e.startsWith("step:"))).toBe(false);
    expect(readFileSync(ENV_FILE, "utf8")).toBe(before);
    expect(existsSync(desktopConfig())).toBe(false);
  });

  it("picking 'Re-register AI apps' runs only the register step", async () => {
    setUp();
    installApps(["desktop"]);
    const s = script([a(MENU_QUESTION, "register"), a("Add crawlmark to which apps?", ["claude-desktop"]), a("Write this change?", true)]);
    const code = await runSetup(s, undefined, [], flags());
    expect(code).toBe(0);
    s.assertDrained();
    expect(s.ui.events.filter((e) => e.startsWith("step:"))).toEqual(["step: Register with Claude"]);
    expect(existsSync(desktopConfig())).toBe(true);
  });

  it("'Change Google sign-in' runs only the Google step", async () => {
    setUp();
    const s = script([a(MENU_QUESTION, "google"), a("Set up Google", false)]);
    expect(await runSetup(s, undefined, [], flags())).toBe(0);
    s.assertDrained();
    expect(s.ui.events.filter((e) => e.startsWith("step:"))).toEqual(["step: Google"]);
  });

  it("no menu when nothing works yet (the full wizard runs), and none with --step", async () => {
    writeFileSync(ENV_FILE, "FOO=bar\n", { mode: 0o600 });
    const s = script([buildNo, a("Which SEO data providers do you have?", []), a("Set up Google", false), a("PageSpeed Insights API key", false), a("Add crawlmark to which apps?", [])]);
    const code = await runSetup(s, undefined, [], flags());
    expect(code).toBe(0);
    expect(s.asked.some((q) => q.question === MENU_QUESTION)).toBe(false);
    expect(s.ui.events.filter((e) => e.startsWith("step:")).length).toBeGreaterThan(3);
  });
});

// ------------------------------------------------------------------ Ctrl-C

describe("Ctrl-C (PromptAbortedError)", () => {
  it("while typing the DataForSEO login: exits 130 with a calm message, closes the prompt, writes nothing", async () => {
    installApps();
    const s = script([buildNo, a("Which SEO data providers do you have?", ["dataforseo"]), a("Press Enter to open", "s"), a("Which DataForSEO API?", "sandbox"), a("API login", ABORT)]);
    const code = await runSetup(s, undefined, [], flags(), "init");
    expect(code).toBe(130);
    expect(say()).toContain("Setup cancelled. Anything already saved stays saved; re-run setup any time.");
    expect(stderr.join("")).not.toMatch(/PromptAbortedError|at .*\.ts/);
    expect(s.prompt.closed).toBe(true);
    expect(existsSync(ENV_FILE)).toBe(false);
    expect(existsSync(desktopConfig())).toBe(false);
    expect(existsSync(cursorConfig())).toBe(false);
    expect(existsSync(codexConfig())).toBe(false);
    expect(fetchCalls).toHaveLength(0);
    // No summary and no outro: the run stopped.
    expect(s.ui.events.some((e) => e.startsWith("summary:") || e.startsWith("outro:"))).toBe(false);
  });

  it("at the Claude Code confirmation: what was saved stays, no app was touched, no temp files are left", async () => {
    installApps();
    const s = script([
      buildNo,
      a("Which SEO data providers do you have?", ["dataforseo"]),
      a("Press Enter to open", "s"),
      a("Which DataForSEO API?", "sandbox"),
      a("API login", "me@example.com"),
      a("API password", "pw-123"),
      a("Set up Google", false),
      a("PageSpeed Insights API key", false),
      a("Add crawlmark to which apps?", ""),
      a("Register crawlmark with Claude Code?", ABORT),
    ]);
    const code = await runSetup(s, undefined, [], flags(), "init");
    expect(code).toBe(130);
    expect(readFileSync(ENV_FILE, "utf8")).toContain("DATAFORSEO_PASSWORD=pw-123");
    expect(h.spawned.some((c) => c.args[1] === "add")).toBe(false);
    for (const p of [desktopConfig(), cursorConfig(), codexConfig()]) expect(existsSync(p)).toBe(false);
    expect(readdirSync(HOME.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(s.prompt.closed).toBe(true);
  });

  // registerJsonApp's try/catch wraps the confirm prompt; it must rethrow PromptAbortedError so Ctrl-C cancels the run.
  it("at the Claude Desktop confirmation: the run is cancelled (exit 130) and the other apps are not asked about", async () => {
    installApps();
    const s = script([
      buildNo,
      a("Which SEO data providers do you have?", ["dataforseo"]),
      a("Press Enter to open", "s"),
      a("Which DataForSEO API?", "sandbox"),
      a("API login", "me@example.com"),
      a("API password", "pw-123"),
      a("Set up Google", false),
      a("PageSpeed Insights API key", false),
      a("Add crawlmark to which apps?", ""),
      a("Register crawlmark with Claude Code?", true),
      a("Write this change?", ABORT), // Claude Desktop, at the confirmation
    ]);
    const code = await runSetup(s, undefined, [], flags(), "init");
    expect(code, s.ui.events.filter((e) => /^result|^fail/.test(e)).join("\n")).toBe(130);
    expect(readFileSync(ENV_FILE, "utf8")).toContain("DATAFORSEO_PASSWORD=pw-123");
    // Claude Code was registered before the abort; Desktop, Cursor and Codex files were never created.
    expect(h.spawned.some((c) => c.args[1] === "add")).toBe(true);
    expect(existsSync(desktopConfig())).toBe(false);
    expect(existsSync(cursorConfig())).toBe(false);
    expect(existsSync(codexConfig())).toBe(false);
    // No temp files left beside .env or the app configs.
    expect(readdirSync(HOME.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("plain renderer: the same clean exit", async () => {
    h.renderer = "plain";
    const s = script([buildNo, a("Which SEO data providers do you have?", ABORT)], { fancy: false });
    const code = await runSetup(s, undefined, [], flags());
    expect(code).toBe(130);
    expect(say()).toContain("Setup cancelled.");
    expect(s.prompt.closed).toBe(true);
  });
});

// ------------------------------------------------------------------ plain renderer and --yes

describe("plain renderer", () => {
  it("--yes registers with the defaults and prints the plain, line-by-line text", async () => {
    h.renderer = "plain";
    installApps(["desktop"]);
    h.claudeInstalled = false;
    const s = script([]);
    const code = await runSetup(s, undefined, [], flags({ step: "register", yes: true }));
    expect(code).toBe(0);
    const text = say();
    expect(text).toContain("crawlmark setup. Config home: " + HOME.dir);
    expect(text).toContain("== Register with Claude ==");
    expect(text).toMatch(/-> done: .*Claude Desktop/);
    expect(text).toContain("Summary:");
    expect(text).not.toContain("Try asking");
    expect(existsSync(desktopConfig())).toBe(true);
    expect(s.asked).toHaveLength(0); // --yes never reads a terminal
  });

  it("--yes leaves a credential step needing a key as skipped, not hung", async () => {
    h.renderer = "plain";
    const s = script([]);
    const code = await runSetup(s, undefined, [], flags({ step: "psi", yes: true }));
    expect(code).toBe(0);
    expect(existsSync(ENV_FILE)).toBe(false);
  });
});

// ------------------------------------------------------------------ migrate

describe("setup migrate", () => {
  const target = () => join(mkdtempSync(join(tmpdir(), "crawlmark-test-migrate-")), "new-home");

  it("needs --to", async () => {
    expect(await runSetup(script([]), "migrate", [], flags())).toBe(2);
    expect(stderr.join("")).toContain("setup migrate needs --to <dir>.");
  });

  it("a dry run lists what would be copied and copies nothing", async () => {
    writeFileSync(ENV_FILE, "DATAFORSEO_LOGIN=me@example.com\n", { mode: 0o600 });
    const to = target();
    const code = await runSetup(script([]), "migrate", [], flags({ to, "dry-run": true }));
    expect(code).toBe(0);
    expect(say()).toContain("Dry run: would copy 1 file(s).");
    expect(existsSync(to)).toBe(false);
    rmSync(join(to, ".."), { recursive: true, force: true });
  });

  it("declining the confirmation copies nothing (exit 1); --yes copies .env as 0600 and leaves the original", async () => {
    writeFileSync(ENV_FILE, "DATAFORSEO_LOGIN=me@example.com\n", { mode: 0o600 });
    const to = target();
    const no = script([a("Copy 1 file(s)", false)]);
    expect(await runSetup(no, "migrate", [], flags({ to }))).toBe(1);
    no.assertDrained();
    expect(existsSync(join(to, ".env"))).toBe(false);

    const code = await runSetup(script([]), "migrate", [], flags({ to, yes: true }));
    expect(code).toBe(0);
    expect(readFileSync(join(to, ".env"), "utf8")).toContain("DATAFORSEO_LOGIN=me@example.com");
    if (POSIX_MODES) expect(mode(join(to, ".env"))).toBe(0o600);
    expect(existsSync(ENV_FILE)).toBe(true);
    expect(say()).toContain("Copied 1 file(s)");
    rmSync(join(to, ".."), { recursive: true, force: true });
  });

  it("nothing to copy from an empty home", async () => {
    const to = target();
    expect(await runSetup(script([]), "migrate", [], flags({ to, yes: true }))).toBe(0);
    expect(say()).toContain("Nothing to copy.");
    rmSync(join(to, ".."), { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ run()

describe("run(): the child-process helper", () => {
  it("captures stdout and the exit code of a real program", async () => {
    h.real = true;
    const r = await run(process.execPath, ["-e", "process.stdout.write('hello'); process.stderr.write('warn'); process.exit(3)"]);
    expect(r).toEqual({ code: 3, stdout: "hello", stderr: "warn" });
  });

  it("a missing program resolves with code 127, never rejects", async () => {
    h.real = true;
    const r = await run(join(tmpdir(), "crawlmark-test-no-such-program"), []);
    expect(r.code).toBe(127);
  });
});
