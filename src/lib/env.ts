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
