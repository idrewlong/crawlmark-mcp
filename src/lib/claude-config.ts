import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";

/**
 * Registering crawlmark with Claude Code (its command line), and with Claude
 * Desktop and Cursor (an `mcpServers` entry in their JSON config). Path, merge and the printable change summary are
 * pure; the write is atomic and keeps a 0600 `.bak` of the previous file.
 */

export const SERVER_NAME = "crawlmark";

export interface ServerLaunch {
  /** Executable for Claude Desktop (absolute node path) and Claude Code (`node`). */
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Claude Desktop's config file for this OS, or undefined when the OS has none. */
export function claudeDesktopConfigPath(platform: NodeJS.Platform, userHome: string, env: Record<string, string | undefined>): string | undefined {
  // Join with the target platform's separator, not the host's, so the answer for each OS is the same wherever it runs.
  if (platform === "darwin") return posix.join(userHome, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") {
    const appData = env.APPDATA ?? win32.join(userHome, "AppData", "Roaming");
    return win32.join(appData, "Claude", "claude_desktop_config.json");
  }
  if (platform === "linux") return posix.join(env.XDG_CONFIG_HOME ?? posix.join(userHome, ".config"), "Claude", "claude_desktop_config.json");
  return undefined;
}

/** POSIX-shell quoting for printing a command the user can paste. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** argv for `claude mcp add` (user scope, so it works in every project). */
export function claudeCodeAddArgs(launch: ServerLaunch): string[] {
  const envArgs = Object.entries(launch.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  // The name goes first: -e takes several values and would swallow it.
  return ["mcp", "add", SERVER_NAME, "-s", "user", ...envArgs, "--", launch.command, ...launch.args];
}

export interface ClaudeCodeRegistration {
  scope?: "user" | "local" | "project";
  command?: string;
  /** Arguments as `claude mcp get` prints them (space-joined). */
  args?: string;
  env: Record<string, string>;
}

/**
 * Parse `claude mcp get <name>` output (Scope, Command, Args and Environment
 * lines). Returns undefined when there's no Command line to compare against.
 */
export function parseClaudeMcpGet(stdout: string): ClaudeCodeRegistration | undefined {
  const lines = stdout.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const reg: ClaudeCodeRegistration = { env: {} };
  let inEnv = false;
  for (const raw of lines) {
    const line = raw.trim();
    const field = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
    if (field && !(inEnv && /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))) {
      const [, key, value] = field;
      inEnv = key === "Environment";
      if (key === "Command") reg.command = value!.trim();
      else if (key === "Args") reg.args = value!.trim();
      else if (key === "Scope") {
        const v = value!.toLowerCase();
        reg.scope = v.startsWith("user") ? "user" : v.startsWith("local") ? "local" : v.startsWith("project") ? "project" : undefined;
      }
      continue;
    }
    const kv = inEnv ? /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line) : null;
    if (kv) reg.env[kv[1]!] = kv[2]!;
    else if (line === "") inEnv = false;
  }
  return reg.command ? reg : undefined;
}

/** Does an existing Claude Code registration launch exactly this server? */
export function sameRegistration(reg: ClaudeCodeRegistration, launch: ServerLaunch): boolean {
  const want = launch.env ?? {};
  return (
    reg.command === launch.command &&
    (reg.args ?? "") === launch.args.join(" ") &&
    Object.keys(reg.env).length === Object.keys(want).length &&
    Object.entries(want).every(([k, v]) => reg.env[k] === v)
  );
}

/** One display line for a registration: command and args, env names with values hidden. */
export function describeRegistration(r: { command?: string | undefined; args?: string | readonly string[] | undefined; env?: Record<string, string> | undefined; scope?: string | undefined }): string {
  const args = Array.isArray(r.args) ? r.args.join(" ") : (r.args ?? "");
  const env = Object.keys(r.env ?? {});
  return `${[r.command ?? "?", args].filter(Boolean).join(" ")}${env.length ? `  (env: ${env.map((k) => `${k}=<hidden>`).join(", ")})` : ""}${r.scope ? `  [scope: ${r.scope}]` : ""}`;
}

export function desktopEntry(launch: ServerLaunch): Record<string, unknown> {
  return { command: launch.command, args: launch.args, ...(launch.env && Object.keys(launch.env).length ? { env: launch.env } : {}) };
}

export interface DesktopMerge {
  /** The new file text (2-space JSON). */
  text: string;
  /** False when the file already has exactly this entry. */
  changed: boolean;
  /** True when an existing crawlmark entry is replaced. */
  replaced: boolean;
  /** The crawlmark entry being replaced, if any. */
  previous: unknown;
  /** Names of the other servers, kept unchanged. Only their names are ever shown: their config may hold secrets. */
  otherServers: string[];
}

/**
 * Add or replace `mcpServers.<name>` in an app's JSON config (Claude Desktop,
 * Cursor), keeping every other key and server. Throws on a file that isn't a
 * JSON object, so a hand-edited file is never clobbered; the message names the app.
 */
export function mergeMcpServersJson(existing: string | undefined, entry: Record<string, unknown>, opts: { app: string; name?: string }): DesktopMerge {
  const name = opts.name ?? SERVER_NAME;
  let config: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (err) {
      // Only the position: JSON.parse quotes the text around the error, which may be another server's secret.
      const where = /at position \d+(?: \(line \d+ column \d+\))?/.exec((err as Error).message)?.[0];
      throw new Error(`The ${opts.app} config isn't valid JSON${where ? ` (${where})` : ""}; fix it by hand first.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`The ${opts.app} config isn't a JSON object; fix it by hand first.`);
    config = parsed as Record<string, unknown>;
  }
  const servers = config.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error(`The ${opts.app} config's mcpServers isn't an object; fix it by hand first.`);
  }
  const current = (servers ?? {}) as Record<string, unknown>;
  const replaced = name in current;
  const changed = JSON.stringify(current[name]) !== JSON.stringify(entry);
  const next = { ...config, mcpServers: { ...current, [name]: entry } };
  return { text: JSON.stringify(next, null, 2) + "\n", changed, replaced, previous: current[name], otherServers: Object.keys(current).filter((k) => k !== name) };
}

/** Claude Desktop's merge (kept for existing callers): mergeMcpServersJson for "Claude Desktop". */
export function mergeDesktopConfig(existing: string | undefined, entry: Record<string, unknown>, name = SERVER_NAME): DesktopMerge {
  return mergeMcpServersJson(existing, entry, { app: "Claude Desktop", name });
}

/** Cursor's global MCP config (Cursor docs: `~/.cursor/mcp.json`). Project-level `.cursor/mcp.json` files are never touched. */
export function cursorConfigPath(userHome: string): string {
  return join(userHome, ".cursor", "mcp.json");
}

/** Cursor's `mcpServers` entry: like Claude Desktop's, with `type: "stdio"`. */
export function cursorEntry(launch: ServerLaunch): Record<string, unknown> {
  return { type: "stdio", ...desktopEntry(launch) };
}

/** A server entry with every env value replaced by `<hidden>`, for display. */
export function maskEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const e = entry as Record<string, unknown>;
  const args = Array.isArray(e.args)
    ? e.args.map((a) => (typeof a === "string" && /(key|token|secret|password)=/i.test(a) ? a.replace(/=.*/, "=<hidden>") : a))
    : e.args;
  const env = e.env;
  if (env === undefined) return { ...e, args };
  if (!env || typeof env !== "object" || Array.isArray(env)) return { ...e, args, env: "<hidden>" };
  return { ...e, args, env: Object.fromEntries(Object.keys(env).map((k) => [k, "<hidden>"])) };
}

function envKeys(entry: unknown): string[] {
  const env = (entry as { env?: unknown } | null | undefined)?.env;
  return env && typeof env === "object" && !Array.isArray(env) ? Object.keys(env) : [];
}

/**
 * What the Desktop change does, safe to print: only the crawlmark entry (env
 * values masked) and the names of the other servers, never their config.
 */
export function describeDesktopChange(merge: DesktopMerge, entry: Record<string, unknown>, keepEnvKeys: readonly string[] = ["CRAWLMARK_HOME"]): string[] {
  const indent = (v: unknown) => JSON.stringify(maskEntry(v), null, 2).split("\n").map((l) => `    ${l}`);
  const lines: string[] = [];
  lines.push(merge.otherServers.length ? `Other servers kept unchanged: ${merge.otherServers.join(", ")}` : "No other servers in the file.");
  if (merge.replaced) lines.push("Current crawlmark entry (replaced):", ...indent(merge.previous));
  lines.push(merge.replaced ? "New crawlmark entry:" : "Adds this crawlmark entry:", ...indent(entry));
  const dropped = envKeys(merge.previous).filter((k) => !keepEnvKeys.includes(k) && !envKeys(entry).includes(k));
  if (dropped.length) lines.push(`Warning: the current entry's env ${dropped.length > 1 ? "keys" : "key"} ${dropped.join(", ")} will be removed (they stay in the .bak copy).`);
  return lines;
}

/**
 * Write a config file atomically (temp file, then rename) after saving the
 * current file to `<path>.bak` the same way, with mode 0600 (it can hold other
 * servers' secrets). Keeps the existing file mode; a new file gets 0600. A
 * symlinked config is written through to its target. Returns the backup path,
 * or undefined when there was no file to back up.
 */
export function writeConfigWithBackup(file: string, text: string): string | undefined {
  // A symlinked config (e.g. from a dotfiles repo) is written through to its target, but the
  // .bak, which holds every server's secrets, stays next to the configured path, not in the repo.
  const target = existsSync(file) ? realpathSync(file) : file;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  let backup: string | undefined;
  let mode = 0o600;
  if (existsSync(target)) {
    mode = statSync(target).mode & 0o777;
    backup = backupFile(file);
  }
  writeFileAtomic(target, text, mode);
  return backup;
}

/** Copy `path` (following a symlink to read it) to `<path>.bak` next to the path itself (mode 0600, atomic). Returns the backup path. */
export function backupFile(path: string): string {
  const backup = `${path}.bak`;
  writeFileAtomic(backup, readFileSync(path), 0o600);
  return backup;
}

/** Claude Desktop's writer (kept for existing callers). */
export const writeDesktopConfig = writeConfigWithBackup;

export function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
