/** True for an empty value or a leftover `${user_config.x}` placeholder (a blank Claude Desktop bundle field the host didn't substitute). */
export function isUnsetValue(v: string | undefined): boolean {
  if (v === undefined) return true;
  const t = v.trim();
  return t === "" || /^\$\{user_config\.[A-Za-z0-9_]+\}$/.test(t);
}

/** Drop keys whose value is unset (see isUnsetValue), so `FOO=` in .env counts as unset. */
export function stripEmptyValues(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && !isUnsetValue(v)) out[k] = v;
  }
  return out;
}

export const DFS_SANDBOX_URL = "https://sandbox.dataforseo.com/v3";
export const DFS_LIVE_URL = "https://api.dataforseo.com/v3";

/** true/false from true|false|1|0|yes|no (any case); undefined when unset or unrecognised. */
export function parseBoolish(v: string | undefined): boolean | undefined {
  const t = v?.trim().toLowerCase();
  if (t === "true" || t === "1" || t === "yes") return true;
  if (t === "false" || t === "0" || t === "no") return false;
  return undefined;
}

export interface DataForSeoUrlInputs {
  baseUrl: string | undefined;
  /** The URL came from the config home's .env (not the shell / client env). */
  baseUrlFromFile: boolean;
  live: string | undefined;
  liveFromFile: boolean;
}

/**
 * DataForSEO API base URL. DATAFORSEO_LIVE (the Claude Desktop bundle checkbox) is the user's latest choice:
 * - live=false never gives the live host unless DATAFORSEO_BASE_URL was set in the shell/client env;
 * - live=true from the shell/client env beats a URL from .env (a shell URL still wins);
 * - otherwise an explicit URL wins, else live=true picks the live API, else the free sandbox.
 */
export function dataForSeoBaseUrl(i: DataForSeoUrlInputs): string {
  const live = parseBoolish(i.live);
  const urlFromShell = i.baseUrl !== undefined && !i.baseUrlFromFile;
  if (live === false) return urlFromShell ? i.baseUrl! : DFS_SANDBOX_URL;
  if (live === true) {
    if (urlFromShell) return i.baseUrl!;
    if (!i.liveFromFile || i.baseUrl === undefined) return DFS_LIVE_URL;
  }
  return i.baseUrl ?? DFS_SANDBOX_URL;
}

/**
 * Phase 9 variables a blank Claude Desktop bundle field must not hide. loadEnvFile never
 * overrides a key that already exists, so a bundle field passed as "" (or as the literal
 * `${user_config.x}` placeholder) would stop .env from supplying the value. config.ts drops
 * these keys from the process env, when unset, before loading .env (D11).
 */
export const PHASE9_ENV_KEYS = [
  "SEO_DATA_PROVIDER",
  "AHREFS_API_KEY",
  "SEMRUSH_API_KEY",
  "SEMRUSH_V4_API_KEY",
  "AHREFS_MONTHLY_UNIT_CAP",
  "SEMRUSH_MONTHLY_UNIT_CAP",
  "DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS",
  "DEFAULT_CLIENT_MONTHLY_SEMRUSH_UNITS",
] as const;

/** Delete `keys` from `target` where their value is unset (see isUnsetValue). Returns the keys removed. */
export function dropUnsetKeys(target: Record<string, string | undefined>, keys: readonly string[]): string[] {
  const dropped: string[] = [];
  for (const k of keys) {
    if (k in target && isUnsetValue(target[k])) {
      delete target[k];
      dropped.push(k);
    }
  }
  return dropped;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** One line naming each overridden provider URL by origin only (no path or query), or undefined when none is. */
export function urlOverrideNotice(overrides: { name: string; value: string; fallback: string }[]): string | undefined {
  const changed = overrides.filter((o) => o.value !== o.fallback);
  if (!changed.length) return undefined;
  return `crawlmark: test-only provider URL override in use: ${changed.map((o) => `${o.name} -> ${new URL(o.value).origin}`).join(", ")}. Unset it unless you are testing against a fake server.`;
}

/**
 * A test-only base URL override (AHREFS_BASE_URL and friends): used only when it came
 * from the shell (never from .env, so a stray line there can't redirect a key) and is an
 * https URL, or plain http to a loopback host (127.0.0.1, localhost, [::1]) for a local
 * fake server, since the keys travel with every request. Returns `fallback` otherwise.
 * Trailing slashes are dropped.
 */
export function shellUrlOverride(value: string | undefined, fromEnvFile: boolean, fallback: string): string {
  if (fromEnvFile || isUnsetValue(value)) return fallback;
  try {
    const u = new URL(value!.trim());
    if (u.protocol === "http:" ? !LOOPBACK_HOSTS.has(u.hostname) : u.protocol !== "https:") return fallback;
    return value!.trim().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}
