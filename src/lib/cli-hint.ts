import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { shellQuote } from "./claude-config.js";
import { sourceCheckoutMarker, USER_HOME_DIRNAME, type HomeInfo, type HomeSource } from "./home.js";
import { projectRoot } from "./paths.js";

/**
 * The one place that decides how a user-facing "run this command" hint is written.
 * Every message that names a crawlmark command builds it from `cliHint()` (or `cliPrefix()`),
 * so the hint matches how crawlmark is installed.
 */

/** The form used when nothing better is known. `crawlmark-mcp` runs CLI subcommands when given arguments (see lib/entry.ts). */
export const NPX_COMMAND = "npx -y crawlmark-mcp@latest";

/** True when `name` is an executable on PATH (no shell, no exec). */
export function onPath(name: string, pathEnv = process.env.PATH ?? "", platform = process.platform): boolean {
  const exts = platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, name + ext), constants.X_OK);
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}

export interface CommandPrefixInputs {
  /** Running from a source checkout (npm run cli works in its root). */
  checkout: boolean;
  /** `crawlmark-cli` is on PATH (a global install). */
  cliOnPath: boolean;
  homeSource: HomeSource;
  homeDir: string;
  /** The home this install uses without CRAWLMARK_HOME: the project root for a checkout, ~/.crawlmark otherwise. */
  defaultHomeDir: string;
  /** The user's home directory, shown as `~` in the printed CRAWLMARK_HOME. */
  userHome?: string | undefined;
}

/** CRAWLMARK_HOME's value for a printed command: `~/rest` when it's under the user's home and needs no quoting. */
function displayHome(dir: string, userHome: string | undefined): string {
  if (userHome) {
    const rel = relative(userHome, dir);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel) && /^[A-Za-z0-9_./-]+$/.test(rel.split(sep).join("/"))) return `~/${rel.split(sep).join("/")}`;
  }
  return shellQuote(dir);
}

/**
 * The short command for printed next steps (pure): `npm run cli --` in a source
 * checkout, `crawlmark-cli` for a global install, else `npx -y crawlmark-mcp@latest`.
 * `CRAWLMARK_HOME=<dir>` goes in front only when the home came from the env and
 * isn't this install's default.
 */
export function commandPrefix(i: CommandPrefixInputs): string {
  const base = i.checkout ? "npm run cli --" : i.cliOnPath ? "crawlmark-cli" : NPX_COMMAND;
  if (i.homeSource !== "env" || resolve(i.homeDir) === resolve(i.defaultHomeDir)) return base;
  return `CRAWLMARK_HOME=${displayHome(i.homeDir, i.userHome)} ${base}`;
}

/**
 * config.ts hands over the resolved config home. This module can't import config.ts: config.ts loads
 * lib/google-auth.ts, which builds its messages with `cliHint()`.
 */
let cached: string | undefined;
let context: { home: HomeInfo | undefined; root: string } = { home: undefined, root: projectRoot(import.meta.url) };

export function configureCliHint(home: HomeInfo, root: string): void {
  context = { home, root };
  cached = undefined;
}

/** Test seam for the install checks. */
export const cliHintDeps = {
  isCheckout: (): boolean => sourceCheckoutMarker(context.root, existsSync) !== undefined,
  onPath: (name: string): boolean => onPath(name),
};

/** True when this process runs from a source checkout (not an installed package). */
export function isCheckout(): boolean {
  return cliHintDeps.isCheckout();
}

/** commandPrefix for this process. `withHome: false` leaves out any CRAWLMARK_HOME prefix. */
export function cliPrefix(opts: { withHome?: boolean } = {}): string {
  const checkout = isCheckout();
  const userHome = homedir();
  return commandPrefix({
    checkout,
    cliOnPath: cliHintDeps.onPath("crawlmark-cli"),
    homeSource: opts.withHome === false || !context.home ? "user" : context.home.source,
    homeDir: context.home?.dir ?? "",
    defaultHomeDir: checkout ? context.root : join(userHome, USER_HOME_DIRNAME),
    userHome,
  });
}

/** The command prefix for a hint, worked out once per process. Never throws: falls back to the npx form. */
export function cliHint(): string {
  if (cached === undefined) {
    try {
      cached = cliPrefix();
    } catch {
      return NPX_COMMAND;
    }
  }
  return cached;
}

/** Forget the cached prefix (tests). */
export function resetCliHint(): void {
  cached = undefined;
}
