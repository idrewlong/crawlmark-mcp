import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "./paths.js";

/** First arguments that mean "run the admin CLI" when given to `crawlmark-mcp` (so `npx crawlmark-mcp setup` works). */
export const CLI_SUBCOMMANDS: readonly string[] = [
  "setup",
  "auth",
  "clients",
  "competitors",
  "keywords",
  "brand",
  "audit",
  "check-traffic",
  "help",
];

export type EntryAction = "server" | "cli" | "version";

/**
 * What `crawlmark-mcp` should do for its arguments (argv without node and the script).
 * No arguments starts the stdio server, so MCP clients are unaffected; anything else is
 * handed to the CLI (known subcommands, --help, or an unknown word that prints usage) so a typo
 * never silently starts a server that waits on stdin.
 */
export function entryAction(args: readonly string[]): EntryAction {
  const first = args[0];
  if (first === undefined) return "server";
  if (first === "--version" || first === "-v") return "version";
  return "cli";
}

/** The version in package.json (the directory above src/ or dist/). */
export function packageVersion(moduleUrl: string): string {
  const pkg = JSON.parse(readFileSync(join(projectRoot(moduleUrl), "package.json"), "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}
