/**
 * The wizard's register step: find the AI apps on this machine, let the user
 * pick which ones get crawlmark, and register it with each. Claude Code and
 * Codex go through their own CLIs (`claude mcp …`, `codex mcp …`); Claude
 * Desktop and Cursor get a merged `mcpServers` JSON entry; Codex without a
 * working CLI gets a guarded config.toml text edit. Every change is shown
 * first (env values hidden, other servers by name only), asked about, and
 * written with a 0600 `.bak`. Detection only decides what's pre-ticked; it
 * never writes. All I/O goes through WizardContext, so tests use temp files
 * and fake binaries.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  backupFile,
  claudeCodeAddArgs,
  cursorEntry,
  describeDesktopChange,
  describeRegistration,
  desktopEntry,
  mergeMcpServersJson,
  parseClaudeMcpGet,
  readIfExists,
  sameRegistration,
  SERVER_NAME,
  shellQuote,
  writeConfigWithBackup,
  type DesktopMerge,
  type ServerLaunch,
} from "../lib/claude-config.js";
import {
  codexAddArgs,
  codexAddDisplay,
  codexEntry,
  codexGetSaysNotFound,
  codexTomlSnippet,
  describeCodexChange,
  parseCodexMcpGet,
  planCodexTomlEdit,
  readCodexTomlEntry,
  sameCodexEntry,
  type CodexRegistration,
} from "../lib/codex-config.js";
import type { Choice } from "./prompter.js";
import { uiFor } from "./ui.js";
import type { ExecResult, StepResult, WizardContext } from "./wizard.js";

export const APP_IDS = ["claude-code", "claude-desktop", "cursor", "codex"] as const;
export type AppId = (typeof APP_IDS)[number];

export const APP_LABELS: Record<AppId, string> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  codex: "Codex",
};

export function cmdLine(cmd: string, args: string[]): string {
  return [cmd, ...args].map(shellQuote).join(" ");
}

/** Running from an npx cache (`.../_npx/<hash>/node_modules/...`): that path is temporary and must not be registered. */
export function isNpxCache(projectRoot: string): boolean {
  return projectRoot.split(/[\\/]/).includes("_npx");
}

/**
 * How an app should start the server. CRAWLMARK_HOME is passed when the home isn't
 * the project root. From an npx cache, `npx -y crawlmark-mcp` is registered instead
 * of the cache path. `nodeCommand` is `node` (Claude Code, which inherits the shell
 * PATH) or an absolute path (Claude Desktop, Cursor and Codex, which may not).
 */
export function serverLaunch(ctx: WizardContext, nodeCommand: string): ServerLaunch {
  const env = ctx.paths.homeSource === "project" ? undefined : { CRAWLMARK_HOME: ctx.paths.home };
  if (isNpxCache(ctx.paths.projectRoot)) {
    const npx = nodeCommand === "node" ? "npx" : join(dirname(nodeCommand), process.platform === "win32" ? "npx.cmd" : "npx");
    return { command: npx, args: ["-y", "crawlmark-mcp"], ...(env ? { env } : {}) };
  }
  return { command: nodeCommand, args: ["--disable-warning=ExperimentalWarning", join(ctx.paths.projectRoot, "dist", "index.js")], ...(env ? { env } : {}) };
}

/** What detection found for one app. */
export interface AppProbe {
  id: AppId;
  label: string;
  /** Pre-ticked in the multi-select. */
  detected: boolean;
  /** Already registered with exactly this command. */
  same: boolean;
  /** Shown next to the label: "found", "already set up". */
  hint?: string;
  /** Claude Code: the `claude mcp get` result (read once). */
  claudeGet?: ExecResult;
  /** Codex: the CLI works (else the config.toml text edit). */
  codexCli?: boolean;
  codexGet?: ExecResult;
}

export type AppStatus = "registered" | "already" | "skipped" | "failed" | "dry-run" | "manual";

export interface AppOutcome {
  id: AppId;
  status: AppStatus;
}

/** A message for the end of the step, with how the fancy renderer should show it. */
interface Note {
  kind: "success" | "info" | "warn" | "fail";
  text: string;
}

/** The JSON-config apps (Claude Desktop, Cursor): path and entry. */
function jsonApp(ctx: WizardContext, id: "claude-desktop" | "cursor"): { path: string | undefined; entry: Record<string, unknown> } {
  const launch = serverLaunch(ctx, ctx.node.execPath);
  return id === "claude-desktop" ? { path: ctx.paths.desktopConfig, entry: desktopEntry(launch) } : { path: ctx.paths.cursorConfig, entry: cursorEntry(launch) };
}

function jsonSame(path: string, entry: Record<string, unknown>, app: string): boolean {
  try {
    return !mergeMcpServersJson(readIfExists(path), entry, { app }).changed;
  } catch {
    return false;
  }
}

/**
 * Which apps are installed, and which already have this exact registration
 * (decision 7). Runs only `--version` and `get` commands; writes nothing.
 * Cursor and Codex are offered only when the context knows their config paths.
 */
export async function detectApps(ctx: WizardContext): Promise<AppProbe[]> {
  const probes: AppProbe[] = [];

  const claude: AppProbe = { id: "claude-code", label: APP_LABELS["claude-code"], detected: false, same: false };
  if ((await ctx.exec("claude", ["--version"])).code === 0) {
    claude.detected = true;
    claude.claudeGet = await ctx.exec("claude", ["mcp", "get", SERVER_NAME]);
    const current = claude.claudeGet.code === 0 ? parseClaudeMcpGet(claude.claudeGet.stdout) : undefined;
    claude.same = Boolean(current && sameRegistration(current, serverLaunch(ctx, "node")));
  }
  probes.push(claude);

  for (const id of ["claude-desktop", "cursor"] as const) {
    const { path, entry } = jsonApp(ctx, id);
    if (path === undefined) continue;
    const onPath = id === "cursor" && Boolean(ctx.which?.("cursor"));
    const detected = existsSync(path) || existsSync(dirname(path)) || onPath;
    probes.push({ id, label: APP_LABELS[id], detected, same: detected && existsSync(path) && jsonSame(path, entry, APP_LABELS[id]) });
  }

  const codexPath = ctx.paths.codexConfig;
  if (codexPath !== undefined) {
    const codex: AppProbe = { id: "codex", label: APP_LABELS.codex, detected: false, same: false };
    const want = codexEntry(serverLaunch(ctx, ctx.node.execPath));
    if ((await ctx.exec("codex", ["--version"])).code === 0) {
      codex.detected = true;
      codex.codexCli = true;
      codex.codexGet = await ctx.exec("codex", ["mcp", "get", SERVER_NAME, "--json"]);
      const current = codexRegistration(ctx, codex.codexGet);
      codex.same = current.kind === "entry" && sameCodexEntry(current.entry, want);
    } else if (existsSync(dirname(codexPath))) {
      codex.detected = true;
      codex.codexCli = false;
      const plan = planCodexTomlEdit(readIfExists(codexPath), want);
      codex.same = plan.ok && !plan.changed;
    }
    probes.push(codex);
  }

  for (const p of probes) if (p.detected) p.hint = p.same ? "already set up" : "found";
  return probes;
}

// ------------------------------------------------------------------ per-app flows

/**
 * Run an app's CLI to change its registration. Plain mode gives it the terminal,
 * as before; fancy mode captures its output and prints it inside the frame.
 */
async function runApp(ctx: WizardContext, cmd: string, args: string[]): Promise<ExecResult> {
  if (!uiFor(ctx).fancy) return ctx.exec(cmd, args, { inherit: true });
  const r = await ctx.exec(cmd, args);
  const text = `${r.stdout}\n${r.code === 0 ? "" : r.stderr}`.trim();
  for (const line of text ? text.split(/\r?\n/) : []) ctx.out(`  ${line}`);
  return r;
}

/** Claude Code: register, or replace a different existing registration after showing both. */
async function registerClaudeCode(ctx: WizardContext, probe: AppProbe, notes: Note[]): Promise<AppStatus> {
  const launch = serverLaunch(ctx, "node");
  const addArgs = claudeCodeAddArgs(launch);
  if (!probe.detected) {
    notes.push({ kind: "warn", text: `Claude Code isn't installed (no working \`claude\` command). To register later: ${cmdLine("claude", addArgs)}` });
    return "manual";
  }
  const existing = probe.claudeGet ?? (await ctx.exec("claude", ["mcp", "get", SERVER_NAME]));
  if (existing.code !== 0) {
    ctx.out("Claude Code is installed. This registers crawlmark for all your projects:");
    ctx.out(`  ${cmdLine("claude", addArgs)}`);
    if (!(await ctx.prompt.confirm("Register crawlmark with Claude Code?", true))) {
      notes.push({ kind: "info", text: "Skipped Claude Code." });
      return "skipped";
    }
    if (ctx.dryRun) {
      notes.push({ kind: "info", text: "Dry run: Claude Code registration not run." });
      return "dry-run";
    }
    const r = await runApp(ctx, "claude", addArgs);
    notes.push(r.code === 0 ? { kind: "success", text: "Registered with Claude Code." } : { kind: "fail", text: `\`claude mcp add\` failed (exit ${r.code}).` });
    return r.code === 0 ? "registered" : "failed";
  }

  const current = parseClaudeMcpGet(existing.stdout);
  if (current && sameRegistration(current, launch)) {
    notes.push({ kind: "success", text: `Claude Code: crawlmark is already registered with this command${current.scope ? ` (${current.scope} scope)` : ""}.` });
    return "already";
  }
  if (!current) {
    // Never remove a registration we couldn't read, not even under --yes.
    ctx.out("Claude Code has a crawlmark entry the wizard can't read; leaving it alone.");
    notes.push({ kind: "warn", text: `To replace it yourself: claude mcp remove ${SERVER_NAME} -s <scope>, then ${cmdLine("claude", addArgs)}` });
    return "manual";
  }
  const scope = current.scope ?? "user";
  ctx.out("Claude Code already has a crawlmark server, with a different command:");
  ctx.out(`  current: ${describeRegistration(current)}`);
  ctx.out(`  new:     ${describeRegistration({ ...launch, scope: "user" })}`);
  // Default no, so --yes never removes an existing registration.
  if (!(await ctx.prompt.confirm(`Replace it (claude mcp remove ${SERVER_NAME} -s ${scope}, then add)?`, false))) {
    notes.push({ kind: "info", text: "Kept the existing Claude Code registration." });
    return "skipped";
  }
  if (ctx.dryRun) {
    notes.push({ kind: "info", text: "Dry run: Claude Code registration not replaced." });
    return "dry-run";
  }
  const removed = await runApp(ctx, "claude", ["mcp", "remove", SERVER_NAME, "-s", scope]);
  if (removed.code !== 0) {
    notes.push({ kind: "fail", text: `\`claude mcp remove ${SERVER_NAME} -s ${scope}\` failed (exit ${removed.code}); nothing was added.` });
    return "failed";
  }
  const r = await runApp(ctx, "claude", addArgs);
  notes.push(
    r.code === 0
      ? { kind: "success", text: "Replaced the Claude Code registration." }
      : { kind: "fail", text: `Removed the old registration, but \`claude mcp add\` failed (exit ${r.code}). Run: ${cmdLine("claude", addArgs)}` },
  );
  return r.code === 0 ? "registered" : "failed";
}

const RESTART: Record<"claude-desktop" | "cursor", string> = {
  "claude-desktop": "Restart Claude Desktop to load crawlmark.",
  cursor: "Restart Cursor (or reload its MCP servers) to load crawlmark.",
};

/** Claude Desktop and Cursor: merge `mcpServers.crawlmark`, show the change, ask, write with a .bak. */
async function registerJsonApp(ctx: WizardContext, id: "claude-desktop" | "cursor", notes: Note[]): Promise<AppStatus> {
  const app = APP_LABELS[id];
  const { path, entry } = jsonApp(ctx, id);
  if (!path) return "manual";
  try {
    const before = readIfExists(path);
    const merge: DesktopMerge = mergeMcpServersJson(before, entry, { app });
    if (!merge.changed) {
      notes.push({ kind: "success", text: `${app} already has this crawlmark entry (${path}).` });
      return "already";
    }
    uiFor(ctx).preview(`${app} config: ${path}`, describeDesktopChange(merge, entry));
    // Replacing a different crawlmark entry defaults to no, so --yes never replaces one.
    const question = merge.replaced ? "Replace the existing crawlmark entry? (the current file is kept as .bak)" : "Write this change? (the current file is kept as .bak)";
    if (!(await ctx.prompt.confirm(question, !merge.replaced))) {
      notes.push({ kind: "info", text: `Skipped ${app}.` });
      return "skipped";
    }
    if (ctx.dryRun) {
      notes.push({ kind: "info", text: `Dry run: ${app} config not written.` });
      return "dry-run";
    }
    const backup = writeConfigWithBackup(path, merge.text);
    notes.push({ kind: "success", text: `Updated ${app}'s config${backup ? ` (backup: ${backup})` : ""}. ${RESTART[id]}` });
    return "registered";
  } catch (err) {
    notes.push({ kind: "fail", text: `Couldn't update ${app}'s config: ${(err as Error).message}` });
    return "failed";
  }
}

/** Copy config.toml to config.toml.bak (0600) before the Codex CLI changes it. */
function backupCodexConfig(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  // Next to the configured path, even when it's a symlink into a dotfiles repo.
  return backupFile(path);
}

/**
 * What Codex has under crawlmark, from `codex mcp get --json`. A failed or
 * unreadable `get` (an older codex without --json, say) only means "absent" when
 * it clearly says the server isn't found; otherwise config.toml is read (never
 * written) to decide, and anything still unclear is "unreadable": left alone.
 */
export function codexRegistration(ctx: WizardContext, get: ExecResult): CodexRegistration {
  if (get.code === 0) {
    const parsed = parseCodexMcpGet(get.stdout);
    if (parsed) return { kind: "entry", entry: parsed };
  } else if (codexGetSaysNotFound(`${get.stdout}\n${get.stderr}`)) {
    return { kind: "absent" };
  }
  let text: string | undefined;
  try {
    text = ctx.paths.codexConfig ? readIfExists(ctx.paths.codexConfig) : undefined;
  } catch {
    return { kind: "unreadable" };
  }
  const fromToml = readCodexTomlEntry(text);
  // A successful get we couldn't parse means something is registered: never call that absent.
  return get.code === 0 && fromToml.kind === "absent" ? { kind: "unreadable" } : fromToml;
}

/** Codex through its CLI: show the command, compare with `codex mcp get --json`, ask, back up config.toml, run. */
async function registerCodexCli(ctx: WizardContext, probe: AppProbe, notes: Note[]): Promise<AppStatus> {
  const launch = serverLaunch(ctx, ctx.node.execPath);
  const want = codexEntry(launch);
  const display = codexAddDisplay(launch);
  const existing = probe.codexGet ?? (await ctx.exec("codex", ["mcp", "get", SERVER_NAME, "--json"]));
  /** `existingBackup`: the .bak already taken before `remove`; taking another would overwrite it with the post-remove file. */
  const runAdd = async (existingBackup?: string): Promise<AppStatus> => {
    const backup = existingBackup ?? backupCodexConfig(ctx.paths.codexConfig);
    const r = await runApp(ctx, "codex", codexAddArgs(launch));
    notes.push(
      r.code === 0
        ? { kind: "success", text: `Registered with Codex${backup ? ` (backup: ${backup})` : ""}.` }
        : { kind: "fail", text: `\`codex mcp add\` failed (exit ${r.code}).` },
    );
    return r.code === 0 ? "registered" : "failed";
  };

  const state = codexRegistration(ctx, existing);
  if (state.kind === "absent") {
    ctx.out("Codex is installed. This registers crawlmark with it:");
    ctx.out(`  ${display}`);
    if (!(await ctx.prompt.confirm("Register crawlmark with Codex?", true))) {
      notes.push({ kind: "info", text: "Skipped Codex." });
      return "skipped";
    }
    if (ctx.dryRun) {
      notes.push({ kind: "info", text: "Dry run: Codex registration not run." });
      return "dry-run";
    }
    return runAdd();
  }
  if (state.kind === "entry" && sameCodexEntry(state.entry, want)) {
    notes.push({ kind: "success", text: "Codex: crawlmark is already registered with this command." });
    return "already";
  }
  if (state.kind === "unreadable") {
    ctx.out("Codex has a crawlmark entry the wizard can't read; leaving it alone.");
    notes.push({ kind: "warn", text: `To replace it yourself: codex mcp remove ${SERVER_NAME}, then ${display}` });
    return "manual";
  }
  ctx.out("Codex already has a crawlmark server, with a different command:");
  ctx.out(`  current: ${describeRegistration(state.entry)}`);
  ctx.out(`  new:     ${describeRegistration(want)}`);
  if (!(await ctx.prompt.confirm(`Replace it (codex mcp remove ${SERVER_NAME}, then add)?`, false))) {
    notes.push({ kind: "info", text: "Kept the existing Codex registration." });
    return "skipped";
  }
  if (ctx.dryRun) {
    notes.push({ kind: "info", text: "Dry run: Codex registration not replaced." });
    return "dry-run";
  }
  const backup = backupCodexConfig(ctx.paths.codexConfig);
  const removed = await runApp(ctx, "codex", ["mcp", "remove", SERVER_NAME]);
  if (removed.code !== 0) {
    notes.push({ kind: "fail", text: `\`codex mcp remove ${SERVER_NAME}\` failed (exit ${removed.code}); nothing was added.` });
    return "failed";
  }
  return runAdd(backup);
}

/** Codex without a working CLI: a guarded text edit of config.toml (src/lib/codex-config.ts). */
async function registerCodexToml(ctx: WizardContext, notes: Note[]): Promise<AppStatus> {
  const path = ctx.paths.codexConfig;
  if (!path) return "manual";
  const entry = codexEntry(serverLaunch(ctx, ctx.node.execPath));
  let before: string | undefined;
  try {
    before = readIfExists(path);
  } catch (err) {
    notes.push({ kind: "fail", text: `Couldn't read Codex's config: ${(err as Error).message}` });
    return "failed";
  }
  const plan = planCodexTomlEdit(before, entry);
  if (!plan.ok) {
    notes.push({ kind: "fail", text: `Couldn't update Codex's config (${path}): ${plan.reason} To add it yourself, paste this into that file:\n${codexTomlSnippet(entry).split("\n").map((l) => `    ${l}`).join("\n")}` });
    return "failed";
  }
  if (!plan.changed) {
    notes.push({ kind: "success", text: `Codex already has this crawlmark entry (${path}).` });
    return "already";
  }
  uiFor(ctx).preview(`Codex config: ${path}`, describeCodexChange(plan, entry));
  const question = plan.replaced ? "Replace the existing crawlmark entry? (the current file is kept as .bak)" : "Write this change? (the current file is kept as .bak)";
  if (!(await ctx.prompt.confirm(question, !plan.replaced))) {
    notes.push({ kind: "info", text: "Skipped Codex." });
    return "skipped";
  }
  if (ctx.dryRun) {
    notes.push({ kind: "info", text: "Dry run: Codex config not written." });
    return "dry-run";
  }
  try {
    const backup = writeConfigWithBackup(path, plan.text);
    notes.push({ kind: "success", text: `Updated Codex's config${backup ? ` (backup: ${backup})` : ""}. Restart Codex to load crawlmark.` });
    return "registered";
  } catch (err) {
    notes.push({ kind: "fail", text: `Couldn't write Codex's config: ${(err as Error).message}` });
    return "failed";
  }
}

/** The snippets for registering by hand: the Claude Code command, the mcpServers JSON (Claude Desktop, Cursor) and the Codex TOML block. */
export function printSnippets(ctx: WizardContext): void {
  const addArgs = claudeCodeAddArgs(serverLaunch(ctx, "node"));
  const json = desktopEntry(serverLaunch(ctx, ctx.node.execPath));
  ctx.out("");
  ctx.out("To add crawlmark to a client yourself:");
  ctx.out(`  Claude Code:    ${cmdLine("claude", addArgs)}`);
  ctx.out("  Claude Desktop and other MCP clients (mcpServers config):");
  ctx.out(JSON.stringify({ mcpServers: { [SERVER_NAME]: json } }, null, 2).split("\n").map((l) => `    ${l}`).join("\n"));
  // Like detection, Codex is included only when the context knows its config path.
  if (ctx.paths.codexConfig !== undefined) {
    ctx.out(`  Codex (${ctx.paths.codexConfig}):`);
    ctx.out(codexTomlSnippet(codexEntry(serverLaunch(ctx, ctx.node.execPath))).split("\n").map((l) => `    ${l}`).join("\n"));
  }
}

/** The register step: detect, pick, register each picked app, report. */
export async function registerApps(ctx: WizardContext): Promise<StepResult & { apps: AppOutcome[] }> {
  const step = "register" as const;
  const ui = uiFor(ctx);
  const notes: Note[] = [];
  if (isNpxCache(ctx.paths.projectRoot)) {
    ctx.out("crawlmark is running from a temporary npx cache, so Claude will start it with `npx -y crawlmark-mcp` instead of this path.");
  }

  const probes = await ui.spin("Looking for AI apps...", () => detectApps(ctx), { plain: false });
  const defaults = probes.filter((p) => p.detected).map((p) => p.id);
  const choices: Choice<AppId>[] = probes.map((p) => ({ value: p.id, label: p.label, ...(p.hint ? { hint: p.hint } : {}) }));
  const detectedLabels = probes.filter((p) => p.detected).map((p) => p.label);
  const selected: AppId[] = ctx.prompt.multiselect
    ? await ctx.prompt.multiselect("Add crawlmark to which apps?", choices, defaults, { summary: `Register with: ${detectedLabels.join(", ")} (detected). Use these?` })
    : defaults;

  const apps: AppOutcome[] = [];
  for (const probe of probes) {
    if (!selected.includes(probe.id)) {
      // Unticked apps are left alone.
      if (probe.detected && ctx.prompt.multiselect) notes.push({ kind: "info", text: `Left ${probe.label} alone.` });
      continue;
    }
    let status: AppStatus;
    if (probe.id === "claude-code") status = await registerClaudeCode(ctx, probe, notes);
    else if (probe.id === "codex") status = probe.codexCli ? await registerCodexCli(ctx, probe, notes) : await registerCodexToml(ctx, notes);
    else status = await registerJsonApp(ctx, probe.id, notes);
    apps.push({ id: probe.id, status });
  }

  const registered = apps.some((a) => a.status === "registered" || a.status === "already");
  if (!registered) printSnippets(ctx);
  for (const n of notes) {
    if (!ui.fancy) ctx.out(n.text);
    else ui[n.kind](n.text);
  }
  return {
    step,
    outcome: registered || ctx.dryRun ? "done" : "skipped",
    message: notes.map((n) => n.text).join(" ") || "Printed the config snippet.",
    apps,
  };
}
