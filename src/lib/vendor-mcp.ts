import { parse as parseToml } from "smol-toml";
import { tomlEqual } from "./codex-config.js";

/**
 * Semrush's and Ahrefs' own remote MCP servers, which the setup wizard can add to a user's AI apps for ad-hoc
 * questions. crawlmark itself never calls them (its Semrush and Ahrefs integrations use API keys). Entries are
 * URL-only: sign-in is OAuth in the app, so no key or header is ever written to an app config.
 */

export const VENDOR_IDS = ["semrush", "ahrefs"] as const;
export type VendorId = (typeof VENDOR_IDS)[number];

export interface Vendor {
  id: VendorId;
  label: string;
  /** The entry name in each app's config. */
  name: VendorId;
  url: string;
  /** What its calls cost, said before anything is written. */
  notice: string;
}

export const VENDORS: Record<VendorId, Vendor> = {
  semrush: {
    id: "semrush",
    label: "Semrush",
    name: "semrush",
    url: "https://mcp.semrush.com/v2/mcp",
    notice:
      "This adds Semrush's own MCP server to your AI app. You sign in to Semrush in the app (OAuth). Its calls spend your Semrush API units directly; crawlmark's caps, cache and reports don't cover them.",
  },
  ahrefs: {
    id: "ahrefs",
    label: "Ahrefs",
    name: "ahrefs",
    url: "https://api.ahrefs.com/mcp/mcp",
    notice:
      "This adds Ahrefs' own MCP server to your AI app. You sign in to Ahrefs in the app (OAuth). Its calls spend your Ahrefs API units directly (per Ahrefs' docs, it needs a paid plan from Lite, and OAuth creates a key limited to 200,000 units a month by default); crawlmark's caps, cache and reports don't cover them.",
  },
};

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Claude Code: `claude mcp add --transport http -s user <name> <url>` (argv after `claude`). */
export function claudeCodeVendorArgs(v: Vendor): string[] {
  return ["mcp", "add", "--transport", "http", "-s", "user", v.name, v.url];
}

/** Codex: `codex mcp add <name> --url <url>` (argv after `codex`). */
export function codexVendorArgs(v: Vendor): string[] {
  return ["mcp", "add", v.name, "--url", v.url];
}

/** Cursor's `mcpServers` entry. */
export function cursorVendorEntry(v: Vendor): Record<string, unknown> {
  return { url: v.url };
}

/** What a vendor name holds in an app today. Never includes headers or env, so it is safe to print. */
export type VendorRegistration = { kind: "absent" } | { kind: "entry"; url?: string; command?: string; scope?: string } | { kind: "unreadable" };

/** Parse `claude mcp get <name>`: its URL (HTTP/SSE servers) or Command (stdio), and scope. */
export function parseClaudeVendorGet(stdout: string): { url?: string; command?: string; scope?: "user" | "local" | "project" } | undefined {
  const text = stdout.replace(/\u001b\[[0-9;]*m/g, "");
  const url = /^\s*URL:\s*(\S+)/im.exec(text)?.[1];
  const command = /^\s*Command:\s*(.+)$/im.exec(text)?.[1]?.trim();
  const scopeText = /^\s*Scope:\s*(\w+)/im.exec(text)?.[1]?.toLowerCase();
  const scope = scopeText?.startsWith("user") ? "user" : scopeText?.startsWith("local") ? "local" : scopeText?.startsWith("project") ? "project" : undefined;
  if (!url && !command) return undefined;
  return { ...(url ? { url } : {}), ...(command ? { command } : {}), ...(scope ? { scope } : {}) };
}

/** Parse `codex mcp get <name> --json`: a streamable-HTTP server's URL, or a stdio server's command. */
export function parseCodexVendorGet(stdout: string): { url?: string; command?: string } | undefined {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(data)) return undefined;
  const t = isRecord(data.transport) ? data.transport : data;
  if (typeof t.url === "string" && t.url) return { url: t.url };
  if (typeof t.command === "string" && t.command) return { command: t.command };
  return undefined;
}

/** `mcp_servers.<name>` in config.toml text (read-only). */
export function readCodexVendorToml(text: string | undefined, name: string): VendorRegistration {
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
  const e = servers[name];
  if (e === undefined) return { kind: "absent" };
  if (!isRecord(e)) return { kind: "unreadable" };
  if (typeof e.url === "string") return { kind: "entry", url: e.url };
  if (typeof e.command === "string") return { kind: "entry", command: e.command };
  return { kind: "unreadable" };
}

/** The block a user can paste into config.toml. */
export function codexVendorSnippet(v: Vendor): string {
  return `[mcp_servers.${v.name}]\nurl = ${JSON.stringify(v.url)}`;
}

export type CodexVendorTomlPlan = { ok: true; text: string; changed: boolean; otherServers: string[] } | { ok: false; reason: string };

/**
 * Add `[mcp_servers.<name>] url = "..."` to config.toml text (pure). Only an absent entry is added (appended after a
 * blank line, every other byte untouched, then re-parsed: other servers and keys must be deep-equal and the entry must
 * be the intended one). The same URL already there is "no change". A different entry is refused: with no CLI the wizard
 * never rewrites a table it didn't write.
 */
export function planCodexVendorTomlEdit(existing: string | undefined, v: Vendor): CodexVendorTomlPlan {
  const source = existing ?? "";
  let before: Record<string, unknown>;
  try {
    before = parseToml(source) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: `The Codex config isn't valid TOML (${(err as Error).message.split("\n")[0]}); fix it by hand first.` };
  }
  const servers = before.mcp_servers;
  if (servers !== undefined && !isRecord(servers)) return { ok: false, reason: "The Codex config's mcp_servers isn't a table; fix it by hand first." };
  const current = (servers ?? {}) as Record<string, unknown>;
  const otherServers = Object.keys(current).filter((k) => k !== v.name);
  const intended = { url: v.url };
  if (current[v.name] !== undefined) {
    if (tomlEqual(current[v.name], intended)) return { ok: true, text: source, changed: false, otherServers };
    return { ok: false, reason: `The Codex config already has a different ${v.name} entry; change it by hand.` };
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const block = codexVendorSnippet(v).split("\n").map((l) => l + eol).join("");
  const endsWithNewline = /\n$/.test(source);
  const endsWithBlankLine = /\n[ \t]*\r?\n$/.test(source);
  const lead = source === "" ? "" : (endsWithNewline ? "" : eol) + (endsWithBlankLine ? "" : eol);
  const text = source + lead + block;
  let after: Record<string, unknown>;
  try {
    after = parseToml(text) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "The edited Codex config wouldn't parse, so nothing was changed. Add the entry by hand." };
  }
  const afterServers = isRecord(after.mcp_servers) ? after.mcp_servers : {};
  const ok =
    [...new Set([...Object.keys(before), ...Object.keys(after)])].every((k) => k === "mcp_servers" || tomlEqual(before[k], after[k])) &&
    Object.keys(current).every((k) => tomlEqual(current[k], afterServers[k])) &&
    tomlEqual(afterServers[v.name], intended);
  if (!ok) return { ok: false, reason: "The edit would have changed more than the new entry, so nothing was changed. Add the entry by hand." };
  return { ok: true, text, changed: true, otherServers };
}

/** Claude Desktop can't take remote servers in its JSON config: the exact steps for the app's own UI. */
export function desktopConnectorSteps(v: Vendor): string[] {
  return [
    "1. Open Claude Desktop, then Settings > Connectors.",
    '2. Choose "Add custom connector".',
    `3. Name: ${v.label}`,
    `4. URL: ${v.url}`,
    `5. Save, then sign in to ${v.label} when Claude Desktop asks (OAuth).`,
  ];
}
