import { isUnsetValue } from "./env.js";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Where crawlmark keeps its per-user files (`.env`, `config/clients.yaml`,
 * `data/`, `secrets/`). Pure: every input is passed in, so the order is unit tested.
 *
 * 1. `CRAWLMARK_HOME` when set: an absolute path or one starting with `~`. A
 *    relative value is refused, so the home (and its `.env`) never depends on
 *    whichever directory the process was started in.
 * 2. The project root when running from a source checkout: a `.git` directory,
 *    `src/` next to `dist/`, or an existing `.env` or `config/clients.yaml` at the
 *    root (so an existing setup keeps working unchanged). Never inside `node_modules`.
 * 3. `~/.crawlmark` (an installed package).
 */
export type HomeSource = "env" | "project" | "user";

export interface HomeInfo {
  dir: string;
  source: HomeSource;
  /** Why this directory was picked, for `auth status` and `setup_status`. */
  reason: string;
}

export interface HomeInputs {
  /** process.env.CRAWLMARK_HOME */
  crawlmarkHome: string | undefined;
  /** Directory above src/ or dist/. */
  projectRoot: string;
  /** os.homedir() */
  userHome: string;
  cwd: string;
  exists: (path: string) => boolean;
}

export const USER_HOME_DIRNAME = ".crawlmark";

/** Expand a leading `~` and resolve a relative path against `cwd`. */
export function expandPath(p: string, userHome: string, cwd: string): string {
  let out = p.trim();
  if (out === "~") out = userHome;
  else if (out.startsWith("~/") || out.startsWith("~\\")) out = join(userHome, out.slice(2));
  return isAbsolute(out) ? resolve(out) : resolve(cwd, out);
}

/** The project-root markers that make it a source checkout, or undefined. */
export function sourceCheckoutMarker(root: string, exists: (p: string) => boolean): string | undefined {
  if (root.split(sep).includes("node_modules")) return undefined;
  if (exists(join(root, ".git"))) return ".git";
  if (exists(join(root, "src")) && exists(join(root, "dist"))) return "src/ next to dist/";
  if (exists(join(root, ".env"))) return ".env";
  if (exists(join(root, "config", "clients.yaml"))) return "config/clients.yaml";
  return undefined;
}

export class InvalidHomeError extends Error {
  constructor(value: string) {
    super(`CRAWLMARK_HOME must be an absolute path or start with ~ (got ${JSON.stringify(value)}). A relative path would depend on the directory crawlmark is started from.`);
    this.name = "InvalidHomeError";
  }
}

/** True for `~`, `~/x` (or `~\\x`) and absolute paths. */
export function isAnchoredPath(p: string): boolean {
  const v = p.trim();
  return v === "~" || v.startsWith("~/") || v.startsWith("~\\") || isAbsolute(v);
}

export function resolveHome(i: HomeInputs): HomeInfo {
  const fromEnv = isUnsetValue(i.crawlmarkHome) ? undefined : i.crawlmarkHome!.trim();
  if (fromEnv) {
    if (!isAnchoredPath(fromEnv)) throw new InvalidHomeError(fromEnv);
    return { dir: expandPath(fromEnv, i.userHome, i.cwd), source: "env", reason: "CRAWLMARK_HOME is set" };
  }
  const marker = sourceCheckoutMarker(i.projectRoot, i.exists);
  if (marker) return { dir: i.projectRoot, source: "project", reason: `source checkout (found ${marker} in the project root)` };
  return { dir: join(i.userHome, USER_HOME_DIRNAME), source: "user", reason: "installed package (no CRAWLMARK_HOME, not a source checkout)" };
}

/** One line for `auth status` and the wizard. */
export function describeHome(h: HomeInfo): string {
  return `${h.dir} (${h.reason})`;
}
