/**
 * `crawlmark-cli setup ...`: wires the wizard, `setup status` and `setup migrate`
 * to the real terminal, filesystem, child processes and network.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { ENV_FILE, ENV_FILE_KEYS, HOME, PROJECT_ROOT } from "../config.js";
import { claudeDesktopConfigPath, cursorConfigPath, shellQuote } from "../lib/claude-config.js";
import { codexConfigPath } from "../lib/codex-config.js";
import { formatTable } from "../lib/clients.js";
import { closeEgressProxy } from "../lib/egress-proxy.js";
import { expandPath } from "../lib/home.js";
import { winCmdArgs } from "../lib/win-quote.js";
import { executeMigration, planMigration } from "../lib/migrate.js";
import { checkServiceAccountKeyFile } from "../providers/google.js";
import { packageVersion } from "../lib/entry.js";
import { stripControl } from "../lib/terminal-text.js";
import { autoPrompter, PromptAbortedError, terminalPrompter, type Prompter } from "./prompter.js";
import { chooseRenderer, plainUi, type Ui } from "./ui.js";
import { INTEGRATIONS, type IntegrationId, type SetupStatusReport } from "./status.js";
import { cliPrefix, isCheckout, onPath, setupStatus } from "./status-providers.js";
import { renderStatus, statusWidth, supportsColor, supportsUnicode } from "./status-render.js";
import { runWizard, STEP_NAMES, type ExecResult, type StepName, type WizardContext } from "./wizard.js";

export interface SetupFlags {
  step?: string | undefined;
  "dry-run": boolean;
  yes: boolean;
  json: boolean;
  only?: string | undefined;
  refresh: boolean;
  to?: string | undefined;
  force: boolean;
}

const out = (line = "") => process.stdout.write(line + "\n");
/** The wizard's own output: control characters stripped (it prints other apps' server names and child output). */
const wizardOut = (line = "") => out(stripControl(line));
const warn = (line: string) => process.stderr.write(line + "\n");

/**
 * Env for child processes (pure): the shell's variables without the ones loaded
 * from .env (so the child re-reads the edited file). CRAWLMARK_HOME is passed only
 * when the home didn't come from the project root, so a child of a source checkout
 * resolves the same way and doesn't print commands with a needless prefix.
 */
export function buildChildEnv(processEnv: NodeJS.ProcessEnv, envFileKeys: ReadonlySet<string>, home: { dir: string; source: string }): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(processEnv)) if (!envFileKeys.has(k)) e[k] = v;
  if (home.source === "project") delete e.CRAWLMARK_HOME;
  else e.CRAWLMARK_HOME = home.dir;
  return e;
}

export const childEnv = () => buildChildEnv(process.env, ENV_FILE_KEYS, HOME);

/** A program name cmd.exe has to run (a bare name or a .cmd/.bat shim); an absolute .exe is spawned directly. */
function needsCmdExe(cmd: string): boolean {
  return !/[\\/]/.test(cmd) || /\.(cmd|bat)$/i.test(cmd);
}

/**
 * Run a program without a shell; on Windows, shims go through `cmd.exe /d /s /c`
 * with every argument quoted and escaped (src/lib/win-quote.ts). The working
 * directory defaults to the user's home directory, so a program is never picked
 * up from the current directory. Never rejects.
 */
export function run(cmd: string, args: string[], opts: { inherit?: boolean; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const viaCmd = process.platform === "win32" && needsCmdExe(cmd);
    const child = spawn(viaCmd ? process.env.ComSpec || "cmd.exe" : cmd, viaCmd ? winCmdArgs(cmd, args) : args, {
      cwd: opts.cwd ?? homedir(),
      env: opts.env ?? childEnv(),
      stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      shell: false,
      windowsVerbatimArguments: viaCmd,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err: NodeJS.ErrnoException) => resolve({ code: err.code === "ENOENT" ? 127 : 1, stdout, stderr: stderr + err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** This CLI, re-run in a fresh process with the same node flags. */
function runSelf(args: string[], opts: { inherit?: boolean } = {}): Promise<ExecResult> {
  return run(process.execPath, [...process.execArgv, process.argv[1]!, ...args], opts);
}

async function childStatus(only: IntegrationId[], opts: { refresh?: boolean } = {}): Promise<SetupStatusReport> {
  const r = await runSelf(["setup", "status", "--json", "--only", only.join(","), ...(opts.refresh ? ["--refresh"] : [])]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
  return JSON.parse(r.stdout) as SetupStatusReport;
}

/** The shell's environment without the keys loaded from the home's .env (pure). */
export function shellOnlyEnv(processEnv: NodeJS.ProcessEnv, envFileKeys: ReadonlySet<string>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(processEnv).filter(([k]) => !envFileKeys.has(k)));
}

/**
 * Which app config files the register step reads, edits and backs up (pure).
 * Built from the shell env only: a CODEX_HOME, XDG_CONFIG_HOME or APPDATA in the
 * home's .env must not redirect the edit, and child processes (which never see
 * .env keys) must agree on the file. The CRAWLMARK_* overrides are test-only.
 */
export function appConfigPaths(shell: Record<string, string | undefined>, userHome: string, platform: NodeJS.Platform): { desktopConfig: string | undefined; cursorConfig: string; codexConfig: string } {
  const pick = (k: string) => shell[k] || undefined;
  return {
    desktopConfig: pick("CRAWLMARK_CLAUDE_DESKTOP_CONFIG") ?? claudeDesktopConfigPath(platform, userHome, shell),
    cursorConfig: pick("CRAWLMARK_CURSOR_CONFIG") ?? cursorConfigPath(userHome),
    codexConfig: pick("CRAWLMARK_CODEX_CONFIG") ?? codexConfigPath(shell, userHome),
  };
}

export function realWizardContext(prompt: Prompter, dryRun: boolean): WizardContext {
  const shellEnvKeys = new Set(Object.keys(process.env).filter((k) => !ENV_FILE_KEYS.has(k) && k !== "CRAWLMARK_HOME"));
  // Overrides for testing the wizard against fake apps (never needed in normal use; see docs/development.md).
  // Honoured only from the shell, never from the home's .env.
  const fromShell = (k: string) => (ENV_FILE_KEYS.has(k) ? undefined : process.env[k]) || undefined;
  const bins: Record<string, string> = {
    claude: fromShell("CRAWLMARK_CLAUDE_BIN") ?? "claude",
    codex: fromShell("CRAWLMARK_CODEX_BIN") ?? "codex",
  };
  return {
    prompt,
    out: wizardOut,
    exec: (cmd, args, opts = {}) => run(bins[cmd] ?? cmd, args, opts),
    cli: runSelf,
    fetch: (...a) => fetch(...a),
    status: childStatus,
    checkKeyFile: checkServiceAccountKeyFile,
    paths: {
      home: HOME.dir,
      homeSource: HOME.source,
      projectRoot: PROJECT_ROOT,
      envFile: ENV_FILE,
      userHome: homedir(),
      cwd: process.cwd(),
      ...appConfigPaths(shellOnlyEnv(process.env, ENV_FILE_KEYS), homedir(), process.platform),
    },
    which: (name) => onPath(name),
    node: { version: process.version, execPath: process.execPath },
    cliDisplay: cliPrefix(),
    shellEnvKeys,
    dryRun,
  };
}

function parseOnly(only: string | undefined): IntegrationId[] | undefined {
  if (only === undefined) return undefined;
  const ids = only.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = ids.filter((i) => !(INTEGRATIONS as readonly string[]).includes(i));
  if (bad.length) throw new Error(`Unknown integration(s): ${bad.join(", ")}. Use: ${INTEGRATIONS.join(", ")}.`);
  return ids as IntegrationId[];
}

async function statusCommand(flags: SetupFlags): Promise<number> {
  const only = parseOnly(flags.only);
  let report: SetupStatusReport;
  try {
    report = await setupStatus({ ...(only ? { only } : {}), refresh: flags.refresh });
  } finally {
    // The Chrome check starts the egress proxy; its sockets would keep the CLI alive.
    await closeEgressProxy();
  }
  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }
  const lines = renderStatus(report, {
    width: statusWidth(process.stdout.columns, process.stdout.isTTY),
    color: supportsColor(process.env, process.stdout.isTTY),
    unicode: supportsUnicode(process.env),
    userHome: homedir(),
    checkoutRoot: isCheckout() ? PROJECT_ROOT : undefined,
  });
  for (const line of lines) out(line);
  return 0;
}

async function migrateCommand(flags: SetupFlags): Promise<number> {
  if (!flags.to) {
    warn("setup migrate needs --to <dir>.");
    return 2;
  }
  const target = expandPath(flags.to, homedir(), process.cwd());
  const plan = planMigration(HOME.dir, target, { force: flags.force });
  out(`Copy from ${plan.from} (current home) to ${plan.to}. Nothing is moved or deleted.`);
  if (plan.files.length) out(formatTable(["FILE", "ACTION", "MODE"], plan.files.map((f) => [f.rel, f.action, f.secret ? "0600" : "as source"])));
  if (plan.missing.length) out(`Not present (nothing to copy): ${plan.missing.join(", ")}`);
  for (const w of plan.absolutePathWarnings) out(`Warning: ${w}`);
  const toCopy = plan.files.filter((f) => f.action !== "skip-exists").length;
  const skipping = plan.files.length - toCopy;
  if (skipping && !flags.force) out(`${skipping} file(s) already exist at the target and will be skipped; --force overwrites them.`);
  if (toCopy === 0) {
    out("Nothing to copy.");
    return 0;
  }
  if (flags["dry-run"]) {
    out(`Dry run: would copy ${toCopy} file(s).`);
    return 0;
  }
  if (!flags.yes) {
    const prompt = terminalPrompter();
    try {
      if (!(await prompt.confirm(`Copy ${toCopy} file(s) to ${plan.to}?`, false))) {
        out("Nothing copied.");
        return 1;
      }
    } finally {
      prompt.close();
    }
  }
  const r = executeMigration(plan);
  out(`Copied ${r.copied} file(s)${r.skipped ? `, skipped ${r.skipped} existing` : ""}. The originals in ${plan.from} are unchanged.`);
  const home = `CRAWLMARK_HOME=${shellQuote(plan.to)}`;
  out(`To use it, add \`export ${home}\` to your shell profile, then point Claude at it: \`${home} ${cliPrefix({ withHome: false })} setup --step register\`.`);
  return 0;
}

async function wizardCommand(flags: SetupFlags, args: string[], invokedAs: "setup" | "init"): Promise<number> {
  if (args.length) {
    warn(`Unexpected argument(s): ${args.join(" ")}`);
    return 2;
  }
  const step = flags.step;
  if (step !== undefined && !(STEP_NAMES as readonly string[]).includes(step)) {
    warn(`Unknown step: ${step}. Steps: ${STEP_NAMES.join(", ")}.`);
    return 2;
  }
  const renderer = chooseRenderer({ stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, env: process.env, yes: flags.yes });
  let ui: Ui;
  let prompt: Prompter;
  if (renderer === "fancy") {
    // Loaded only here, so the plain path never loads @clack/prompts.
    const clack = await import("./ui-clack.js");
    ui = clack.clackUi();
    prompt = clack.clackPrompter();
  } else {
    ui = plainUi(out);
    prompt = flags.yes ? autoPrompter(wizardOut) : terminalPrompter();
  }
  const ctx = realWizardContext(prompt, flags["dry-run"]);
  ctx.ui = ui;
  ctx.command = invokedAs;
  // packageVersion expects a module directly under src/ or dist/; this one is a level deeper.
  ctx.version = packageVersion(new URL("../index.js", import.meta.url).href);
  if (ui.fancy) ctx.out = (line = "") => ui.line(line);
  try {
    const results = await runWizard(ctx, step ? { step: step as StepName } : {});
    if (isCheckout()) out(`Run commands from ${PROJECT_ROOT}`);
    return results.some((r) => r.outcome === "failed") ? 1 : 0;
  } catch (err) {
    if (err instanceof PromptAbortedError) {
      out("\nSetup cancelled. Anything already saved stays saved; re-run setup any time.");
      return 130;
    }
    throw err;
  } finally {
    prompt.close();
  }
}

/** `setup`, `setup status`, `setup migrate`, and `init` (the wizard, worded as init). */
export async function setupCommand(command: string | undefined, args: string[], flags: SetupFlags, invokedAs: "setup" | "init" = "setup"): Promise<number> {
  if (invokedAs === "init") {
    const extra = [command, ...args].filter((a): a is string => a !== undefined);
    return wizardCommand(flags, extra, "init");
  }
  if (command === "status") return args.length ? (warn(`Unexpected argument(s): ${args.join(" ")}`), 2) : statusCommand(flags);
  if (command === "migrate") return args.length ? (warn(`Unexpected argument(s): ${args.join(" ")}`), 2) : migrateCommand(flags);
  if (command !== undefined) {
    warn(`Unknown command: setup ${command}. Use setup, setup status or setup migrate.`);
    return 2;
  }
  return wizardCommand(flags, args, "setup");
}
