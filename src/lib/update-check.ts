/**
 * Phase 10: "Update available" notice for the CLI installer, `--help` and `--version`.
 *
 * - At most one request a day: GET https://registry.npmjs.org/crawlmark-mcp/latest with
 *   no added headers and no query, a 1.5 s timeout, redirects refused. The body is streamed and
 *   the read is cancelled once it passes 64 KB (a chunked answer has no content-length to trust).
 *   The result and the time are cached in `update-check.json` (in DATA_DIR), also after a
 *   failure, so an offline machine isn't retried on every run.
 * - Never in CI, without a TTY, with --json, or with CRAWLMARK_NO_UPDATE_CHECK / NO_UPDATE_NOTIFIER set.
 * - Never throws, never takes longer than the timeout, never changes an exit code.
 * - The MCP server never imports this module (a test walks its import graph).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { styleText } from "node:util";
import { readEnvFile } from "./env-file.js";
import { resolveHome } from "./home.js";
import { projectRoot, resolveFromRoot } from "./paths.js";
import { stripControl } from "./terminal-text.js";

export const REGISTRY_LATEST_URL = "https://registry.npmjs.org/crawlmark-mcp/latest";
export const UPDATE_CHECK_TIMEOUT_MS = 1_500;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CACHE_FILE = "update-check.json";
const MAX_BODY_BYTES = 64 * 1024;

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const SEMVER_RE = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** A semver version, or undefined (pure). Build metadata is ignored. */
export function parseSemver(v: string): Semver | undefined {
  if (typeof v !== "string" || v.length > 64) return undefined;
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/** Semver precedence (pure): negative, 0 or positive. */
export function compareSemver(a: Semver, b: Semver): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  // A version without a prerelease ranks above the same version with one.
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** True when `latest` is newer than `current` (pure). A prerelease `latest` counts only when `current` is a prerelease too. */
export function isNewer(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (!l || !c) return false;
  if (l.pre.length && !c.pre.length) return false;
  return compareSemver(l, c) > 0;
}

const isSet = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/** Whether to check at all (pure): a TTY, no --json, not CI, and neither opt-out variable set. */
export function updateCheckAllowed(i: { env: Record<string, string | undefined>; stdoutTTY: boolean | undefined; json?: boolean }): boolean {
  if (i.json || !i.stdoutTTY) return false;
  if (isSet(i.env.CI)) return false;
  if (isSet(i.env.CRAWLMARK_NO_UPDATE_CHECK) || isSet(i.env.NO_UPDATE_NOTIFIER)) return false;
  return true;
}

export interface CacheEntry {
  checkedAt: number;
  latest?: string | undefined;
}

function readCache(file: string): CacheEntry | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return undefined;
    const { checkedAt, latest } = raw as Record<string, unknown>;
    if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return undefined;
    return { checkedAt, latest: typeof latest === "string" && parseSemver(latest) ? latest : undefined };
  } catch {
    return undefined;
  }
}

/**
 * Write the cache (0600, via a temp file with a random name, created exclusively so an existing
 * file or symlink at that path is never followed or overwritten). The data folder may be created,
 * but never its parent (the config home). Exported for tests, which pass the suffix.
 */
export function writeCache(file: string, entry: CacheEntry, suffix: string = randomBytes(8).toString("hex")): void {
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) {
      if (!existsSync(dirname(dir))) return;
      mkdirSync(dir, { mode: 0o700 });
    }
    const tmp = `${file}.${process.pid}.${suffix}.tmp`;
    let created = false;
    try {
      writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { mode: 0o600, flag: "wx" });
      created = true;
      renameSync(tmp, file);
    } catch {
      // Only remove what this call created; something already at the temp path is left alone.
      if (created) rmSync(tmp, { force: true });
    }
  } catch {
    /* a cache that can't be written only means checking again next time */
  }
}

/** The body as text, or undefined (and the stream cancelled) once it passes `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<string | undefined> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The registry's latest version, or undefined on any problem. */
async function fetchLatest(fetchFn: typeof fetch, timeoutMs: number): Promise<string | undefined> {
  try {
    // No headers, query or body: nothing about the user or their clients leaves the machine.
    const res = await fetchFn(REGISTRY_LATEST_URL, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      await res.body?.cancel().catch(() => {});
      return undefined;
    }
    const text = await readCapped(res, MAX_BODY_BYTES);
    if (text === undefined) return undefined;
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === "string" && parseSemver(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

export interface UpdateCheckOptions {
  current: string;
  cacheFile: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** false in a dry run: read the cache but never write it. */
  write?: boolean;
  timeoutMs?: number;
}

/**
 * The newer version, or undefined. Uses the cache when it is under a day old; otherwise asks
 * the registry once and records the time (after a failure too). Never throws, and gives up
 * after the timeout.
 */
export async function checkForUpdate(o: UpdateCheckOptions): Promise<string | undefined> {
  const timeoutMs = o.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  const work = async (): Promise<string | undefined> => {
    const now = o.now ?? Date.now;
    const cache = readCache(o.cacheFile);
    let latest = cache?.latest;
    const age = cache ? now() - cache.checkedAt : Infinity;
    if (!(age >= 0 && age < UPDATE_CHECK_INTERVAL_MS)) {
      latest = (await fetchLatest(o.fetch ?? fetch, timeoutMs)) ?? cache?.latest;
      if (o.write !== false) writeCache(o.cacheFile, { checkedAt: now(), latest });
    }
    return latest && isNewer(latest, o.current) ? latest : undefined;
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    // A backstop on top of the fetch's own timeout, so nothing here can hold up the command.
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs + 250);
      timer.unref();
    });
    return await Promise.race([work().catch(() => undefined), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The notice text (pure). */
export function updateNotice(current: string, latest: string): string {
  return `Update available ${stripControl(current)} → ${stripControl(latest)} · run npx crawlmark-mcp@latest init`;
}

/** `<dataDir>/update-check.json`. */
export function updateCacheFile(dataDir: string): string {
  return join(dataDir, UPDATE_CACHE_FILE);
}

/** The only .env keys `crawlmark-mcp --version` reads (it loads no other config). */
const KEYS_WITHOUT_CONFIG = ["DATA_DIR", "CRAWLMARK_NO_UPDATE_CHECK", "NO_UPDATE_NOTIFIER"] as const;

/**
 * The cache file and opt-out settings for `crawlmark-mcp --version`, which loads no config: the
 * config home is resolved as usual, and DATA_DIR and the two opt-out variables are taken from the
 * shell, else from the home's .env (as the CLI would see them). Undefined when the home can't be resolved.
 */
export function updateContextWithoutConfig(moduleUrl: string, shell: NodeJS.ProcessEnv = process.env): { cacheFile: string; env: Record<string, string | undefined> } | undefined {
  try {
    const home = resolveHome({ crawlmarkHome: shell.CRAWLMARK_HOME, projectRoot: projectRoot(moduleUrl), userHome: homedir(), cwd: process.cwd(), exists: existsSync });
    const fromFile = readEnvFile(join(home.dir, ".env"));
    const env: Record<string, string | undefined> = { ...shell };
    for (const k of KEYS_WITHOUT_CONFIG) if (env[k] === undefined && fromFile[k] !== undefined) env[k] = fromFile[k];
    return { cacheFile: updateCacheFile(resolveFromRoot(home.dir, env.DATA_DIR || "./data")), env };
  } catch {
    return undefined;
  }
}

/**
 * Check and print the notice (dim) to `stream` when allowed. For `--help` and `--version`.
 * Never throws.
 */
export async function printUpdateNotice(o: {
  current: string;
  cacheFile: string | undefined;
  json?: boolean;
  env?: Record<string, string | undefined>;
  stdoutTTY?: boolean | undefined;
  stream?: NodeJS.WriteStream;
  fetch?: typeof fetch;
}): Promise<void> {
  try {
    if (!o.cacheFile) return;
    if (!updateCheckAllowed({ env: o.env ?? process.env, stdoutTTY: o.stdoutTTY ?? process.stdout.isTTY, json: o.json ?? false })) return;
    const latest = await checkForUpdate({ current: o.current, cacheFile: o.cacheFile, ...(o.fetch ? { fetch: o.fetch } : {}) });
    if (!latest) return;
    const stream = o.stream ?? process.stderr;
    stream.write(`${styleText("dim", updateNotice(o.current, latest), { stream })}\n`);
  } catch {
    /* never fails the command */
  }
}
