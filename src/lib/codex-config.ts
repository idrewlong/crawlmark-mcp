import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { SERVER_NAME, shellQuote, type ServerLaunch } from "./claude-config.js";

/**
 * Registering crawlmark with Codex. Codex's own CLI (`codex mcp add/get/remove`)
 * owns its file format and is preferred; when only the config directory exists
 * (the IDE extension or desktop app without the CLI on PATH), planCodexTomlEdit
 * makes a guarded text edit of `config.toml` that leaves every other byte alone.
 * Everything here is pure; the writer is claude-config's writeConfigWithBackup.
 */

/** `mcp_servers.crawlmark` as Codex stores it. */
export interface CodexEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`. */
export function codexConfigPath(env: Record<string, string | undefined>, userHome: string): string {
  const home = env.CODEX_HOME?.trim();
  return join(home ? home : join(userHome, ".codex"), "config.toml");
}

export function codexEntry(launch: ServerLaunch): CodexEntry {
  return { command: launch.command, args: [...launch.args], ...(launch.env && Object.keys(launch.env).length ? { env: { ...launch.env } } : {}) };
}

/** argv for `codex mcp add`: the name first, then the `--env` pairs, then `--` and the command. */
export function codexAddArgs(launch: ServerLaunch): string[] {
  const envArgs = Object.entries(launch.env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  return ["mcp", "add", SERVER_NAME, ...envArgs, "--", launch.command, ...launch.args];
}

/** The `codex mcp add` command line for display, with env values as `<hidden>`. */
export function codexAddDisplay(launch: ServerLaunch, bin = "codex"): string {
  const masked = { ...launch, ...(launch.env ? { env: Object.fromEntries(Object.keys(launch.env).map((k) => [k, "<hidden>"])) } : {}) };
  return [bin, ...codexAddArgs(masked)].map((a) => (a.endsWith("=<hidden>") ? a : shellQuote(a))).join(" ");
}

/**
 * Structural equality for parsed TOML: smol-toml's tables may not be plain
 * objects (isDeepStrictEqual compares prototypes), and dates compare by value.
 */
export function tomlEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && String(a) === String(b) && a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => tomlEqual(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && tomlEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return Object.is(a, b);
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isStringRecord = (v: unknown): v is Record<string, string> => isRecord(v) && Object.values(v).every((x) => typeof x === "string");

/**
 * Parse `codex mcp get <name> --json`: a stdio server's command, args and env,
 * from a `transport` object or top-level fields. Anything else (an HTTP server,
 * an unknown shape, not JSON) is undefined: "can't read it, leave it alone".
 */
export function parseCodexMcpGet(stdout: string): CodexEntry | undefined {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(data)) return undefined;
  const t = isRecord(data.transport) ? data.transport : data;
  if (t.type !== undefined && t.type !== "stdio") return undefined;
  if (typeof t.command !== "string" || !t.command) return undefined;
  const args = t.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return undefined;
  const env = t.env ?? undefined;
  if (env !== undefined && env !== null && !isStringRecord(env)) return undefined;
  return { command: t.command, args: args as string[], ...(env && Object.keys(env).length ? { env } : {}) };
}

/** What Codex has registered under crawlmark: nothing, a readable stdio entry, or something the wizard can't read. */
export type CodexRegistration = { kind: "absent" } | { kind: "entry"; entry: CodexEntry } | { kind: "unreadable" };

/**
 * True only when a failed `codex mcp get` clearly says crawlmark isn't registered:
 * a not-found phrase on the same line as the server's name. Any other failure
 * proves nothing, and the caller falls back to reading config.toml.
 */
export function codexGetSaysNotFound(output: string): boolean {
  const notFound = /\b(?:not found|no (?:mcp )?server|no such|does(?:n't| not) exist|unknown (?:mcp )?server)\b/i;
  const named = new RegExp(`(^|[^\\w-])['"\`]?${SERVER_NAME}['"\`]?(?![\\w-])`);
  return output.split(/\r?\n/).some((line) => notFound.test(line) && named.test(line));
}

/** mcp_servers.crawlmark as config.toml has it (pure, read-only). A missing or empty file is "absent". */
export function readCodexTomlEntry(text: string | undefined): CodexRegistration {
  if (text === undefined || text.trim() === "") return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    return { kind: "unreadable" };
  }
  const servers = isRecord(parsed) ? parsed.mcp_servers : undefined;
  if (servers === undefined) return { kind: "absent" };
  if (!isRecord(servers)) return { kind: "unreadable" };
  const e = servers[SERVER_NAME];
  if (e === undefined) return { kind: "absent" };
  if (!isRecord(e) || typeof e.command !== "string") return { kind: "unreadable" };
  const args = e.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return { kind: "unreadable" };
  if (e.env !== undefined && !isStringRecord(e.env)) return { kind: "unreadable" };
  const env = e.env as Record<string, string> | undefined;
  return { kind: "entry", entry: { command: e.command, args: args as string[], ...(env && Object.keys(env).length ? { env: { ...env } } : {}) } };
}

/** Does an existing Codex entry launch exactly this server? */
export function sameCodexEntry(a: CodexEntry, b: CodexEntry): boolean {
  return a.command === b.command && isDeepStrictEqual(a.args, b.args) && isDeepStrictEqual(a.env ?? {}, b.env ?? {});
}

// ---------------------------------------------------------------- TOML text edit

export type CodexTomlPlan =
  | {
      ok: true;
      /** The whole new file. Equal to the input when nothing changes. */
      text: string;
      changed: boolean;
      replaced: boolean;
      /** The current crawlmark entry, if any (for display, masked). */
      previous: unknown;
      /** Names of the other MCP servers, kept byte-for-byte. Only names are ever shown. */
      otherServers: string[];
    }
  | { ok: false; reason: string };

const tomlString = (s: string) => JSON.stringify(s);
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));

/** The crawlmark block, as lines (no line endings). */
export function codexTomlBlock(entry: CodexEntry): string[] {
  const lines = [`[mcp_servers.${SERVER_NAME}]`, `command = ${tomlString(entry.command)}`, `args = [${entry.args.map(tomlString).join(", ")}]`];
  if (entry.env && Object.keys(entry.env).length) {
    lines.push("", `[mcp_servers.${SERVER_NAME}.env]`);
    for (const [k, v] of Object.entries(entry.env)) lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
  }
  return lines;
}

/** The block a user can paste into config.toml themselves. */
export function codexTomlSnippet(entry: CodexEntry): string {
  return codexTomlBlock(entry).join("\n");
}

const HEADER_RE = /^\s*\[/;
const COMMENT_OR_BLANK_RE = /^\s*(#.*)?$/;
const ENTRY_HEADER_RE = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${SERVER_NAME}\\s*\\]\\s*(#.*)?$`);
const ENV_HEADER_RE = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${SERVER_NAME}\\s*\\.\\s*env\\s*\\]\\s*(#.*)?$`);
/**
 * Any `mcp_servers.crawlmark` header, in any spelling: quoted keys, an array of
 * tables, a sub-table. Only crawlmark's own key counts, so `[mcp_servers.crawlmark_old]`
 * or a `[projects."/x/crawlmark-mcp"]` trust table never block the edit.
 */
const OTHER_MENTION_RE = new RegExp(`^\\s*\\[\\[?\\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\\s*\\.\\s*(?:${SERVER_NAME}|"${SERVER_NAME}"|'${SERVER_NAME}')(?![\\w-])`);

const refuse = (reason: string): CodexTomlPlan => ({ ok: false, reason });

/**
 * Add or replace `[mcp_servers.crawlmark]` in config.toml text (pure).
 *
 * The entry must be absent, or exactly a `[mcp_servers.crawlmark]` header plus an
 * optional `[mcp_servers.crawlmark.env]` sub-table right after it; any other
 * spelling is refused. That span (from the header to the line before the next
 * header that isn't the env sub-table, minus trailing blank and comment lines) is
 * replaced; with no entry, one is appended after a blank line. The result is
 * re-parsed: every other server and top-level key must be deep-equal to before,
 * and the crawlmark entry must equal `entry`, or nothing is planned.
 */
export function planCodexTomlEdit(existing: string | undefined, entry: CodexEntry): CodexTomlPlan {
  const source = existing ?? "";
  let before: Record<string, unknown>;
  try {
    before = parseToml(source) as Record<string, unknown>;
  } catch (err) {
    return refuse(`The Codex config isn't valid TOML (${(err as Error).message.split("\n")[0]}); fix it by hand first.`);
  }
  const servers = before.mcp_servers;
  if (servers !== undefined && !isRecord(servers)) return refuse("The Codex config's mcp_servers isn't a table; fix it by hand first.");
  const currentServers = (servers ?? {}) as Record<string, unknown>;
  const previous = currentServers[SERVER_NAME];
  const otherServers = Object.keys(currentServers).filter((k) => k !== SERVER_NAME);
  const intended = { command: entry.command, args: entry.args, ...(entry.env && Object.keys(entry.env).length ? { env: entry.env } : {}) };

  if (previous !== undefined && tomlEqual(previous, intended)) {
    return { ok: true, text: source, changed: false, replaced: true, previous, otherServers };
  }

  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  // Each raw line keeps its own terminator, so untouched lines are copied byte for byte.
  const raw = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const lines = raw.map((l) => l.replace(/\r?\n$/, ""));
  const blockText = codexTomlBlock(entry).map((l) => l + eol).join("");
  const starts = lines.flatMap((l, i) => (ENTRY_HEADER_RE.test(l) ? [i] : []));

  let text: string;
  if (previous === undefined) {
    if (lines.some((l) => OTHER_MENTION_RE.test(l))) return refuse(`The Codex config mentions ${SERVER_NAME} in a table header the wizard can't edit safely.`);
    if (raw.length === 0) text = blockText;
    else {
      const last = raw[raw.length - 1]!;
      const terminated = /\n$/.test(last);
      const endsBlank = terminated && lines[lines.length - 1]!.trim() === "";
      text = source + (terminated ? "" : eol) + (endsBlank ? "" : eol) + blockText;
    }
  } else {
    if (starts.length !== 1) return refuse(`The Codex config defines ${SERVER_NAME} in a form the wizard can't edit safely (not a single [mcp_servers.${SERVER_NAME}] table).`);
    const start = starts[0]!;
    let end = start + 1;
    for (; end < lines.length; end++) {
      const l = lines[end]!;
      if (HEADER_RE.test(l) && !ENV_HEADER_RE.test(l)) break;
    }
    // Leave trailing blank and comment lines in place: they usually belong to the next table.
    while (end - 1 > start && COMMENT_OR_BLANK_RE.test(lines[end - 1]!)) end--;
    // The env sub-table (or any other mention) anywhere outside the span is a spelling we don't edit.
    if ([...lines.slice(0, start), ...lines.slice(end)].some((l) => OTHER_MENTION_RE.test(l))) {
      return refuse(`The Codex config splits the ${SERVER_NAME} entry across the file; edit it by hand.`);
    }
    // Keep a missing final newline missing when the entry is the last thing in the file.
    const lastReplaced = raw[end - 1]!;
    const replacement = end === raw.length && !/\n$/.test(lastReplaced) ? blockText.slice(0, -eol.length) : blockText;
    text = raw.slice(0, start).join("") + replacement + raw.slice(end).join("");
  }

  let after: Record<string, unknown>;
  try {
    after = parseToml(text) as Record<string, unknown>;
  } catch {
    return refuse("The edited Codex config wouldn't parse, so nothing was changed. Add the entry by hand.");
  }
  if (!verifyCodexEdit(before, after, intended)) return refuse("The edit would have changed more than the crawlmark entry, so nothing was changed. Add the entry by hand.");
  return { ok: true, text, changed: true, replaced: previous !== undefined, previous, otherServers };
}

/** The post-parse guard: everything but mcp_servers.crawlmark unchanged, and crawlmark equal to the intended entry. */
export function verifyCodexEdit(before: Record<string, unknown>, after: Record<string, unknown>, intended: unknown): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (k === "mcp_servers") continue;
    if (!tomlEqual(before[k], after[k])) return false;
  }
  const b = (isRecord(before.mcp_servers) ? before.mcp_servers : {}) as Record<string, unknown>;
  const a = (isRecord(after.mcp_servers) ? after.mcp_servers : undefined) as Record<string, unknown> | undefined;
  if (!a) return false;
  const names = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const n of names) {
    if (n === SERVER_NAME) continue;
    if (!tomlEqual(b[n], a[n])) return false;
  }
  return tomlEqual(a[SERVER_NAME], intended);
}

/** What the TOML edit does, safe to print: the crawlmark block with env values hidden, and the other servers' names only. */
export function describeCodexChange(plan: Extract<CodexTomlPlan, { ok: true }>, entry: CodexEntry): string[] {
  const masked: CodexEntry = { ...entry, ...(entry.env ? { env: Object.fromEntries(Object.keys(entry.env).map((k) => [k, "<hidden>"])) } : {}) };
  const lines = [plan.otherServers.length ? `Other servers kept unchanged: ${plan.otherServers.join(", ")}` : "No other servers in the file."];
  lines.push(plan.replaced ? "Replaces the crawlmark entry with:" : "Adds this crawlmark entry:");
  for (const l of codexTomlBlock(masked)) lines.push(`    ${l.replace(/= "<hidden>"$/, "= <hidden>")}`);
  return lines;
}
