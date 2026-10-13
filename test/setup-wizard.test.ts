import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readEnvFile } from "../src/lib/env-file.js";
import { autoPrompter, type Choice, type Prompter } from "../src/setup/prompter.js";
import type { IntegrationId, IntegrationStatus, SetupStatusReport } from "../src/setup/status.js";
import {
  buildState,
  runPlan,
  runWizard,
  STEP_NAMES,
  stepBing,
  stepCrux,
  stepDataForSeo,
  stepDiscovery,
  stepGoogle,
  stepNode,
  stepPsi,
  stepRegister,
  type ExecResult,
  type WizardContext,
} from "../src/setup/wizard.js";

type Answer = string | boolean;

/** Answers are consumed in order; every question is recorded. Running out of answers fails the test. */
function scriptedPrompter(answers: Answer[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = (q: string): Answer => {
    asked.push(q);
    if (!answers.length) throw new Error(`Unexpected question: ${q}`);
    return answers.shift()!;
  };
  return {
    asked,
    ask: async (q, o = {}) => {
      const a = next(q) as string;
      return a === "" ? (o.default ?? "") : a;
    },
    secret: async (q) => next(q) as string,
    confirm: async (q) => next(q) as boolean,
    choose: async <T extends string>(q: string, _c: readonly Choice<T>[], d: T) => ((next(q) as string) || d) as T,
    close() {},
  };
}

function item(id: IntegrationId, state: IntegrationStatus["state"], data?: Record<string, unknown>): IntegrationStatus {
  return { id, label: id, state, detail: `${id} is ${state}`, next: state === "working" ? null : "crawlmark-cli setup", ...(data ? { data } : {}) };
}

interface Fake {
  ctx: WizardContext;
  lines: string[];
  exec: ReturnType<typeof vi.fn>;
  cli: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  states: Map<IntegrationId, IntegrationStatus>;
  home: string;
  root: string;
}

function fake(answers: Answer[], opts: { dryRun?: boolean; homeSource?: "project" | "env" | "user"; prompt?: Prompter; claude?: boolean; desktop?: boolean; mcpGet?: string } = {}): Fake {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "crawlmark-wizard-")));
  const home = join(base, "home");
  const root = join(base, "root");
  mkdirSync(home);
  mkdirSync(root);
  const lines: string[] = [];
  const states = new Map<IntegrationId, IntegrationStatus>();
  const exec = vi.fn(async (cmd: string, args: string[]): Promise<ExecResult> => {
    if (cmd === "claude" && args[0] === "--version") return { code: opts.claude === false ? 127 : 0, stdout: "2.0.0", stderr: "" };
    if (cmd === "claude" && args[1] === "get") return opts.mcpGet === undefined ? { code: 1, stdout: "", stderr: "No MCP server found" } : { code: 0, stdout: opts.mcpGet, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const cli = vi.fn(async (): Promise<ExecResult> => ({ code: 0, stdout: "", stderr: "" }));
  const fetch = vi.fn();
  const desktopDir = join(base, "Claude");
  if (opts.desktop !== false) mkdirSync(desktopDir);
  const ctx: WizardContext = {
    prompt: opts.prompt ?? scriptedPrompter(answers),
    out: (l = "") => lines.push(l),
    exec,
    cli,
    fetch: fetch as unknown as typeof globalThis.fetch,
    status: async (only: IntegrationId[]): Promise<SetupStatusReport> => ({
      home: { dir: home, source: "project", reason: "test", envFile: join(home, ".env"), envFileExists: true },
      cli: "crawlmark-cli",
      integrations: only.map((id) => states.get(id) ?? item(id, "missing")),
      summary: { working: 0, configured: 0, missing: 0, error: 0 },
      checkedAt: "",
      fromCache: false,
      costUsd: 0,
    }),
    checkKeyFile: async (p: string) => {
      const text = readFileSync(p, "utf8");
      return text.includes("good") ? { ok: true as const, email: "svc@proj.iam.gserviceaccount.com" } : { ok: false as const, problem: "The file isn't valid JSON." };
    },
    paths: { home, homeSource: opts.homeSource ?? "project", projectRoot: root, envFile: join(home, ".env"), userHome: base, cwd: base, desktopConfig: join(desktopDir, "claude_desktop_config.json") },
    node: { version: "v24.1.0", execPath: "/usr/local/bin/node" },
    cliDisplay: "crawlmark-cli",
    shellEnvKeys: new Set(),
    dryRun: opts.dryRun ?? false,
  };
  return { ctx, lines, exec, cli, fetch, states, home, root };
}

const dfsResponse = (status: number, balance = 1.25) =>
  status === 200
    ? new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", cost: 0, tasks: [{ id: "1", status_code: 20000, status_message: "Ok.", cost: 0, result: [{ money: { balance, total: 5 } }] }] }), { status: 200 })
    : new Response("Unauthorized", { status });

const mode = (path: string) => statSync(path).mode & 0o777;

describe("wizard: node step", () => {
  it("fails on an old Node", async () => {
    const f = fake([]);
    f.ctx.node.version = "v20.11.0";
    expect(await stepNode(f.ctx)).toMatchObject({ outcome: "failed", message: expect.stringContaining("22.13") });
  });

  it("nothing to build for an installed package, even one that ships src/", async () => {
    const f = fake([]);
    expect(await stepNode(f.ctx)).toMatchObject({ outcome: "done", message: expect.stringContaining("installed package") });
    const pkg = join(f.root, "node_modules", "crawlmark-mcp");
    mkdirSync(join(pkg, "src"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), "{}");
    expect(buildState(pkg)).toBeUndefined();
  });

  it("builds a source checkout whose dist/ is missing or stale, unless declined or a dry run", async () => {
    const f = fake([true]);
    mkdirSync(join(f.root, ".git"));
    mkdirSync(join(f.root, "src"));
    mkdirSync(join(f.root, "node_modules"));
    writeFileSync(join(f.root, "package.json"), "{}");
    writeFileSync(join(f.root, "src", "index.ts"), "");
    expect(buildState(f.root)).toBe("missing");
    expect(await stepNode(f.ctx)).toMatchObject({ outcome: "done", message: "Built dist/." });
    expect(f.exec).toHaveBeenCalledWith("npm", ["run", "build"], { inherit: true, cwd: f.root });

    mkdirSync(join(f.root, "dist"));
    for (const e of ["index.js", "cli.js"]) writeFileSync(join(f.root, "dist", e), "");
    const old = new Date(Date.now() - 60_000);
    for (const e of ["index.js", "cli.js"]) utimesSync(join(f.root, "dist", e), old, old);
    expect(buildState(f.root)).toBe("stale");
    const declined = fake([false]);
    declined.ctx.paths.projectRoot = f.root;
    expect(await stepNode(declined.ctx)).toMatchObject({ outcome: "skipped" });
    const dry = fake([true], { dryRun: true });
    dry.ctx.paths.projectRoot = f.root;
    expect(await stepNode(dry.ctx)).toMatchObject({ outcome: "done", message: expect.stringContaining("Dry run") });
    expect(declined.exec).not.toHaveBeenCalled();
    expect(dry.exec).not.toHaveBeenCalled();

    const future = new Date(Date.now() + 60_000);
    for (const e of ["index.js", "cli.js"]) utimesSync(join(f.root, "dist", e), future, future);
    expect(buildState(f.root)).toBe("fresh");
  });
});

describe("wizard: DataForSEO step", () => {
  it("checks the credentials live and writes them to <home>/.env with mode 0600", async () => {
    const f = fake([true, "sandbox", "me@example.com", "api-pass"]);
    f.fetch.mockResolvedValueOnce(dfsResponse(200, 7.5));
    const r = await stepDataForSeo(f.ctx);
    expect(r).toMatchObject({ outcome: "done", message: expect.stringContaining("$7.50") });
    const env = readEnvFile(join(f.home, ".env"));
    expect(env).toEqual({ DATAFORSEO_LOGIN: "me@example.com", DATAFORSEO_PASSWORD: "api-pass", DATAFORSEO_BASE_URL: "https://sandbox.dataforseo.com/v3" });
    expect(mode(join(f.home, ".env"))).toBe(0o600);
    expect(f.lines.join("\n")).toContain("NOT the password you use to log in");
    expect(f.lines.join("\n")).not.toContain("api-pass");
  });

  it("invalid credentials: retries, then fails without writing anything", async () => {
    const f = fake([true, "sandbox", "me@example.com", "wrong1", "me@example.com", "wrong2", "me@example.com", "wrong3"]);
    f.fetch.mockImplementation(async () => dfsResponse(401));
    expect(await stepDataForSeo(f.ctx)).toMatchObject({ outcome: "failed" });
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(existsSync(join(f.home, ".env"))).toBe(false);
    expect(f.lines.filter((l) => l.includes("rejected"))).toHaveLength(3);
  });

  it("Enter keeps the existing password; live mode warns and needs a second yes", async () => {
    const f = fake([true, "live", true, "", ""]);
    writeFileSync(join(f.home, ".env"), "# keep me\nDATAFORSEO_LOGIN=old@example.com\nDATAFORSEO_PASSWORD=oldpass\n");
    f.fetch.mockResolvedValueOnce(dfsResponse(200));
    expect(await stepDataForSeo(f.ctx)).toMatchObject({ outcome: "done" });
    const text = readFileSync(join(f.home, ".env"), "utf8");
    expect(text).toBe("# keep me\nDATAFORSEO_LOGIN=old@example.com\nDATAFORSEO_PASSWORD=oldpass\nDATAFORSEO_BASE_URL=https://api.dataforseo.com/v3\n");
    expect(f.lines.join("\n")).toContain("live mode costs money");

    const declined = fake([true, "live", false]);
    expect(await stepDataForSeo(declined.ctx)).toMatchObject({ outcome: "skipped" });
    expect(declined.fetch).not.toHaveBeenCalled();
  });

  it("shows the status first and offers to skip when it already works", async () => {
    const f = fake([false]);
    f.states.set("dataforseo", item("dataforseo", "working"));
    expect(await stepDataForSeo(f.ctx)).toMatchObject({ outcome: "skipped" });
    expect(f.lines[0]).toContain("[OK] dataforseo");
    expect((f.ctx.prompt as ReturnType<typeof scriptedPrompter>).asked).toEqual(["Change the DataForSEO credentials?"]);
  });

  it("dry run checks but writes nothing", async () => {
    const f = fake([true, "sandbox", "me@example.com", "pw"], { dryRun: true });
    f.fetch.mockResolvedValueOnce(dfsResponse(200));
    expect(await stepDataForSeo(f.ctx)).toMatchObject({ outcome: "done" });
    expect(existsSync(join(f.home, ".env"))).toBe(false);
    expect(f.lines.join("\n")).toContain("Dry run: would set DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD, DATAFORSEO_BASE_URL");
  });

  it("warns when the shell overrides a key it writes", async () => {
    const f = fake([true, "sandbox", "me@example.com", "pw"]);
    f.ctx.shellEnvKeys = new Set(["DATAFORSEO_PASSWORD"]);
    f.fetch.mockResolvedValueOnce(dfsResponse(200));
    await stepDataForSeo(f.ctx);
    expect(f.lines.join("\n")).toContain("also sets DATAFORSEO_PASSWORD");
  });
});

describe("wizard: Google step", () => {
  it("option C: a bad key file is refused, a good one is copied to secrets/ with 0600 and saved; properties are listed", async () => {
    const f = fake([true, "C", "missing.json", "bad.json", "good.json"]);
    writeFileSync(join(f.ctx.paths.cwd, "bad.json"), "{ nope");
    writeFileSync(join(f.ctx.paths.cwd, "good.json"), '{"good":true}');
    f.states.set("gsc", item("gsc", "working", { count: 1, sample: ["sc-domain:example.com"] }));
    f.states.set("ga4", item("ga4", "working", { count: 1, sample: [{ id: "123", name: "Example" }] }));
    const r = await stepGoogle(f.ctx);
    expect(r).toMatchObject({ outcome: "done", message: expect.stringContaining("svc@proj.iam.gserviceaccount.com") });
    const dest = join(f.home, "secrets", "google-service-account.json");
    expect(mode(dest)).toBe(0o600);
    expect(readEnvFile(join(f.home, ".env"))).toEqual({ GOOGLE_AUTH_MODE: "service_account", GOOGLE_APPLICATION_CREDENTIALS: "./secrets/google-service-account.json" });
    const out = f.lines.join("\n");
    expect(out).toContain("No file at");
    expect(out).toContain("That key didn't work: The file isn't valid JSON.");
    expect(out).toContain("tagmanager.googleapis.com");
    expect(out).toContain("  - sc-domain:example.com");
    expect(out).toContain("  - Example  123");
  });

  it("option C: three bad key files fail without saving", async () => {
    const f = fake([true, "C", "bad.json", "bad.json", "bad.json"]);
    writeFileSync(join(f.ctx.paths.cwd, "bad.json"), "{}");
    expect(await stepGoogle(f.ctx)).toMatchObject({ outcome: "failed" });
    expect(existsSync(join(f.home, ".env"))).toBe(false);
    expect(existsSync(join(f.home, "secrets"))).toBe(false);
  });

  it("options A/B: validates the client ID, saves the OAuth client and runs auth login when asked", async () => {
    const f = fake([true, "B", "not-an-id", "123-abc.apps.googleusercontent.com", "client-secret", true]);
    expect(await stepGoogle(f.ctx)).toMatchObject({ outcome: "done", message: "Signed in to Google." });
    expect(readEnvFile(join(f.home, ".env"))).toEqual({ GOOGLE_AUTH_MODE: "oauth", GOOGLE_OAUTH_CLIENT_ID: "123-abc.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET: "client-secret" });
    expect(f.cli).toHaveBeenCalledWith(["auth", "login"], { inherit: true });
    expect(f.lines.join("\n")).toContain("Testing sign-ins expire after 7 days");
  });

  it("dry run never starts a sign-in", async () => {
    const f = fake([true, "A", "123-abc.apps.googleusercontent.com", "s", true], { dryRun: true });
    expect(await stepGoogle(f.ctx)).toMatchObject({ outcome: "done" });
    expect(f.cli).not.toHaveBeenCalled();
    expect(existsSync(join(f.home, ".env"))).toBe(false);
  });
});

describe("wizard: PSI step", () => {
  it("rejects an invalid key and saves a working one", async () => {
    const f = fake([true, "bad", "good"]);
    f.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] } }), { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await stepPsi(f.ctx)).toMatchObject({ outcome: "done" });
    expect(readEnvFile(join(f.home, ".env"))).toEqual({ PSI_API_KEY: "good" });
    expect(f.lines.join("\n")).toContain("isn't valid");
  });

  it("is optional: the default is to skip", async () => {
    const f = fake([false]);
    expect(await stepPsi(f.ctx)).toMatchObject({ outcome: "skipped" });
  });
});

describe("wizard: discovery step", () => {
  it("skips when Google isn't working", async () => {
    const f = fake([]);
    expect(await stepDiscovery(f.ctx)).toMatchObject({ outcome: "skipped", message: expect.stringContaining("clients add") });
  });

  it("runs discovery, then brand-term inference with Search Console only", async () => {
    const f = fake([true, true]);
    f.states.set("google", item("google", "working"));
    expect(await stepDiscovery(f.ctx)).toMatchObject({ outcome: "done" });
    expect(f.cli.mock.calls).toEqual([
      [["clients", "list", "--refresh"], { inherit: true }],
      [["brand", "suggest", "--all", "--no-paid", "--apply"], { inherit: true }],
    ]);
  });

  it("dry run prints the commands instead", async () => {
    const f = fake([true, true], { dryRun: true });
    f.states.set("google", item("google", "working"));
    await stepDiscovery(f.ctx);
    expect(f.cli).not.toHaveBeenCalled();
    expect(f.lines.join("\n")).toContain("--no-paid");
  });
});

describe("wizard: register step", () => {
  it("runs claude mcp add (with CRAWLMARK_HOME when the home isn't the project root) and merges Claude Desktop's config with a .bak", async () => {
    const f = fake([true, true], { homeSource: "user" });
    const desktop = f.ctx.paths.desktopConfig!;
    writeFileSync(desktop, JSON.stringify({ mcpServers: { other: { command: "other" } } }, null, 2));
    const r = await stepRegister(f.ctx);
    expect(r.outcome).toBe("done");
    const add = f.exec.mock.calls.find((c) => c[1][1] === "add")!;
    expect(add[0]).toBe("claude");
    expect(add[1]).toEqual(["mcp", "add", "crawlmark", "-s", "user", "-e", `CRAWLMARK_HOME=${f.home}`, "--", "node", "--disable-warning=ExperimentalWarning", join(f.root, "dist", "index.js")]);
    const written = JSON.parse(readFileSync(desktop, "utf8"));
    expect(written.mcpServers.other).toEqual({ command: "other" });
    expect(written.mcpServers.crawlmark).toEqual({ command: "/usr/local/bin/node", args: ["--disable-warning=ExperimentalWarning", join(f.root, "dist", "index.js")], env: { CRAWLMARK_HOME: f.home } });
    expect(JSON.parse(readFileSync(`${desktop}.bak`, "utf8"))).toEqual({ mcpServers: { other: { command: "other" } } });
    expect(statSync(`${desktop}.bak`).mode & 0o777).toBe(0o600);
    const out = f.lines.join("\n");
    expect(out).toContain("Other servers kept unchanged: other");
    expect(out).toContain('"CRAWLMARK_HOME": "<hidden>"');
  });

  it("never prints other servers' secrets from the Desktop config", async () => {
    const f = fake([false, true], { homeSource: "user" });
    const desktop = f.ctx.paths.desktopConfig!;
    writeFileSync(
      desktop,
      JSON.stringify({ mcpServers: { github: { command: "gh", env: { GITHUB_TOKEN: "ghp_TOPSECRET" } }, crawlmark: { command: "node", args: ["x"], env: { API_KEY: "sk-TOPSECRET" } } } }),
    );
    await stepRegister(f.ctx);
    const out = f.lines.join("\n");
    expect(out).not.toContain("TOPSECRET");
    expect(out).toContain("Other servers kept unchanged: github");
    expect(out).toContain("env key API_KEY will be removed");
    // Written in full, and the .bak keeps the old secrets for the user.
    expect(JSON.parse(readFileSync(desktop, "utf8")).mcpServers.github.env.GITHUB_TOKEN).toBe("ghp_TOPSECRET");
    expect(readFileSync(`${desktop}.bak`, "utf8")).toContain("sk-TOPSECRET");
  });

  it("Claude Code: an identical registration is left alone", async () => {
    const f = fake([], { desktop: false });
    f.exec.mockImplementation(async (_cmd: string, args: string[]): Promise<ExecResult> => ({
      code: 0,
      stdout: args[1] === "get" ? `crawlmark:\n  Scope: User config\n  Command: node\n  Args: --disable-warning=ExperimentalWarning ${join(f.root, "dist", "index.js")}\n` : "",
      stderr: "",
    }));
    const r = await stepRegister(f.ctx);
    expect(r).toMatchObject({ outcome: "done", message: expect.stringContaining("already registered") });
    expect(f.exec.mock.calls.filter((c) => c[1][1] === "add" || c[1][1] === "remove")).toEqual([]);
  });

  it("Claude Code: a different registration is shown (env values hidden) and replaced only after confirming", async () => {
    const existing = "crawlmark:\n  Scope: Local config (private to you in this project)\n  Command: node\n  Args: /old/dist/index.js\n  Environment:\n    TOKEN=SECRET123\n";
    const f = fake([true], { desktop: false, mcpGet: existing });
    const r = await stepRegister(f.ctx);
    expect(r.outcome).toBe("done");
    const out = f.lines.join("\n");
    expect(out).toContain("current: node /old/dist/index.js  (env: TOKEN=<hidden>)  [scope: local]");
    expect(out).not.toContain("SECRET123");
    const calls = f.exec.mock.calls.map((c) => c[1].slice(0, 5).join(" "));
    expect(calls).toEqual(["--version", "mcp get crawlmark", "mcp remove crawlmark -s local", "mcp add crawlmark -s user"]);

    const declined = fake([false], { desktop: false, mcpGet: existing });
    expect(await stepRegister(declined.ctx)).toMatchObject({ outcome: "skipped" });
    expect(declined.exec.mock.calls.filter((c) => c[1][1] === "remove" || c[1][1] === "add")).toEqual([]);

    const dry = fake([true], { desktop: false, mcpGet: existing, dryRun: true });
    await stepRegister(dry.ctx);
    expect(dry.exec.mock.calls.filter((c) => c[1][1] === "remove" || c[1][1] === "add")).toEqual([]);
  });

  it("Claude Code: --yes never removes an existing registration", async () => {
    const existing = "crawlmark:\n  Scope: User config\n  Command: node\n  Args: /old/dist/index.js\n";
    const f = fake([], { desktop: false, mcpGet: existing, prompt: autoPrompter(() => {}) });
    expect(await stepRegister(f.ctx)).toMatchObject({ outcome: "skipped" });
    expect(f.exec.mock.calls.filter((c) => c[1][1] === "remove" || c[1][1] === "add")).toEqual([]);
  });

  it("Claude Code: an entry it can't read is left alone, even after a yes", async () => {
    const f = fake([true, true], { desktop: false, mcpGet: "crawlmark:\n  Type: http\n  URL: https://example.com/mcp\n" });
    await stepRegister(f.ctx);
    expect(f.lines.join("\n")).toContain("can't read; leaving it alone");
    expect(f.exec.mock.calls.filter((c) => c[1][1] === "remove" || c[1][1] === "add")).toEqual([]);
  });

  it("from an npx cache, registers `npx -y crawlmark-mcp` instead of the cache path", async () => {
    const f = fake([true], { desktop: false, homeSource: "user" });
    f.ctx.paths.projectRoot = join(f.root, "_npx", "abc123", "node_modules", "crawlmark-mcp");
    await stepRegister(f.ctx);
    const add = f.exec.mock.calls.find((c) => c[1][1] === "add")!;
    expect(add[1]).toEqual(["mcp", "add", "crawlmark", "-s", "user", "-e", `CRAWLMARK_HOME=${f.home}`, "--", "npx", "-y", "crawlmark-mcp"]);
    expect(f.lines.join("\n")).toContain("temporary npx cache");
  });

  it("declined registration runs nothing, writes nothing and prints the snippet", async () => {
    const f = fake([false, false]);
    const desktop = f.ctx.paths.desktopConfig!;
    writeFileSync(desktop, "{}\n");
    const r = await stepRegister(f.ctx);
    expect(r.outcome).toBe("skipped");
    expect(f.exec.mock.calls.every((c) => c[1][0] === "--version" || c[1][1] === "get")).toBe(true);
    expect(readFileSync(desktop, "utf8")).toBe("{}\n");
    expect(existsSync(`${desktop}.bak`)).toBe(false);
    const out = f.lines.join("\n");
    expect(out).toContain("claude mcp add crawlmark -s user -- node");
    expect(out).toContain('"mcpServers"');
    // Project-root home: no CRAWLMARK_HOME in the snippet.
    expect(out).not.toContain("CRAWLMARK_HOME");
  });

  it("dry run shows the command and the diff without running or writing", async () => {
    const f = fake([true, true], { dryRun: true });
    const r = await stepRegister(f.ctx);
    expect(r.outcome).toBe("done");
    expect(f.exec.mock.calls.filter((c) => c[1][1] === "add" || c[1][1] === "remove")).toEqual([]);
    expect(existsSync(f.ctx.paths.desktopConfig!)).toBe(false);
    expect(f.lines.join("\n")).toContain("Dry run: Claude Desktop config not written.");
  });

  it("no Claude Code and no Claude Desktop: prints the snippet", async () => {
    const f = fake([], { claude: false, desktop: false });
    expect(await stepRegister(f.ctx)).toMatchObject({ outcome: "skipped" });
    expect(f.lines.join("\n")).toContain("To add crawlmark to a client yourself");
  });

  it("an invalid Claude Desktop config is reported, not overwritten", async () => {
    const f = fake([false], {});
    writeFileSync(f.ctx.paths.desktopConfig!, "{ broken");
    await stepRegister(f.ctx);
    expect(readFileSync(f.ctx.paths.desktopConfig!, "utf8")).toBe("{ broken");
    expect(f.lines.join("\n")).toContain("isn't valid JSON");
  });
});

describe("runWizard", () => {
  it("--step runs one step; --yes skips steps that need input instead of failing", async () => {
    const lines: string[] = [];
    const f = fake([], { prompt: autoPrompter((l) => lines.push(l)) });
    const results = await runWizard(f.ctx, { step: "dataforseo" });
    // Phase 9: --step dataforseo is followed by the provider default phase (nothing works yet, so it writes nothing).
    expect(results).toEqual([
      { step: "dataforseo", outcome: "needs-input", message: expect.stringContaining("run without --yes") },
      { step: "provider", outcome: "skipped", message: "No working provider yet; paid tools stay unavailable." },
    ]);
  });

  it("runs every step in order with --yes and a dry run, and stops after a failed Node check", async () => {
    const f = fake([], { dryRun: true, prompt: autoPrompter(() => {}) });
    const results = await runWizard(f.ctx);
    // Phase 9: the provider credential steps, then the provider default, before Google.
    expect(results.map((r) => r.step)).toEqual(["node", "dataforseo", "ahrefs", "semrush", "provider", "google", "psi", "discovery", "register"]);
    expect(existsSync(join(f.home, ".env"))).toBe(false);
    expect(f.exec.mock.calls.filter((c) => c[1][1] === "add" || c[1][1] === "remove")).toEqual([]);

    const old = fake([]);
    old.ctx.node.version = "v18.0.0";
    expect((await runWizard(old.ctx)).map((r) => r.step)).toEqual(["node"]);
  });
});

describe("wizard: crux step (Phase 12, --step crux only)", () => {
  const cruxOk = () => new Response('{"record":{}}', { status: 200 });

  it("checks a new key with one free query for a public origin and saves it to .env (0600)", async () => {
    const f = fake([true, "AIza-new-crux-key"]);
    f.fetch.mockResolvedValue(cruxOk());
    expect(await stepCrux(f.ctx)).toMatchObject({ step: "crux", outcome: "done", message: "CrUX History key works." });
    const [url, init] = f.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("records:queryHistoryRecord");
    expect(JSON.parse(String(init.body))).toMatchObject({ origin: "https://developer.chrome.com" });
    expect(readEnvFile(join(f.home, ".env")).CRUX_API_KEY).toBe("AIza-new-crux-key");
    expect(mode(join(f.home, ".env"))).toBe(0o600);
    expect(f.lines.join("\n")).not.toContain("AIza-new-crux-key");
  });

  it("blank uses PSI_API_KEY when it works for CrUX, saving nothing; declining skips", async () => {
    const f = fake([true, ""]);
    writeFileSync(join(f.home, ".env"), "PSI_API_KEY=AIza-psi\n", { mode: 0o600 });
    f.fetch.mockResolvedValue(cruxOk());
    expect(await stepCrux(f.ctx)).toMatchObject({ outcome: "done", message: expect.stringContaining("PSI_API_KEY works") });
    expect(readEnvFile(join(f.home, ".env")).CRUX_API_KEY).toBeUndefined();
    const g = fake([false]);
    expect(await stepCrux(g.ctx)).toMatchObject({ outcome: "skipped" });
  });

  it("is not in the default plan or the printed step list", () => {
    expect(runPlan()).not.toContain("crux");
    expect(runPlan("crux")).toEqual(["crux"]);
    expect(STEP_NAMES).not.toContain("crux");
  });
});

describe("wizard: bing step (Phase 12 C3, --step bing only)", () => {
  const sites = () => new Response('{"d":[{"Url":"https://www.example.com/","IsVerified":true},{"Url":"https://example.org/","IsVerified":false}]}', { status: 200 });

  it("checks a new key with one free GetUserSites call and saves it to .env (0600), never printing it", async () => {
    const f = fake([true, "SENTINEL-bing-wizard-key-123"]);
    f.fetch.mockResolvedValue(sites());
    expect(await stepBing(f.ctx)).toMatchObject({ step: "bing", outcome: "done", message: "Bing Webmaster key works (1 verified site(s))." });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const [url] = f.fetch.mock.calls[0] as [string];
    expect(new URL(url).pathname).toMatch(/\/GetUserSites$/);
    expect(new URL(url).searchParams.has("siteUrl")).toBe(false);
    expect(readEnvFile(join(f.home, ".env")).BING_WEBMASTER_API_KEY).toBe("SENTINEL-bing-wizard-key-123");
    expect(mode(join(f.home, ".env"))).toBe(0o600);
    expect(f.lines.join("\n")).not.toContain("SENTINEL-bing-wizard-key-123");
    expect(f.lines.join("\n")).toMatch(/Settings \(top right\) > API Access/);
  });

  it("a rejected key is retried with Bing's message (never the key); declining skips", async () => {
    const f = fake([true, "bad-key-0001", "bad-key-0002", "bad-key-0003"]);
    f.fetch.mockImplementation(async () => new Response('{"ErrorCode":3,"Message":"InvalidApiKey"}', { status: 400 }));
    const r = await stepBing(f.ctx);
    expect(r).toMatchObject({ outcome: "failed" });
    expect(f.lines.join("\n")).not.toContain("bad-key-000");
    expect(existsSync(join(f.home, ".env"))).toBe(false);
    const g = fake([false]);
    expect(await stepBing(g.ctx)).toMatchObject({ outcome: "skipped" });
  });

  it("is not in the default plan or the printed step list", () => {
    expect(runPlan()).not.toContain("bing");
    expect(runPlan("bing")).toEqual(["bing"]);
    expect(STEP_NAMES).not.toContain("bing");
  });
});
