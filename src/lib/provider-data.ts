/**
 * Stored provider data and its purge (Phase 13 B; the user's Ahrefs storage decision of 2026-10-13, research
 * docs/research/2026-10-13-ahrefs-storage-terms.md):
 *
 * - Ahrefs data is kept only as small derived aggregates (counts per site, metric and date) for at most 25 months
 *   (snapshots.ts prunes older rows), and is purged on demand (`crawlmark-cli data purge`), when a client is removed,
 *   and when the Ahrefs key is removed.
 * - A removed key is detected from where the key came from when Ahrefs data was last stored: the config home's `.env`
 *   (shared by every process, so its absence is a real removal) or the MCP server's own environment (Claude Desktop's
 *   extension settings; only the MCP server can tell it's gone). A CLI run that simply wasn't given a key never purges.
 * - No key, and nothing derived from one, is ever stored: the mark records only the key's source.
 */
import { ENV_FILE_KEYS, env } from "../config.js";
import type { IssueSource } from "../reports/report-types.js";
import { stripSourceFromIssueSnapshots } from "./issue-snapshots.js";
import { purgeExpired } from "./cache.js";
import { db } from "./store.js";

export type DataProvider = "dataforseo" | "ahrefs" | "semrush";
export type ProcessEntry = "mcp" | "cli";

let processEntry: ProcessEntry = "cli";
/** Which program this process is (set by the MCP server at start; the CLI is the default). */
export function setProcessEntry(e: ProcessEntry): void {
  processEntry = e;
}

const SITE_AUDIT_SOURCE: Partial<Record<DataProvider, string>> = { ahrefs: "ahrefs_site_audit", semrush: "semrush_site_audit" };
const KEY_VAR: Partial<Record<DataProvider, keyof typeof env>> = { ahrefs: "AHREFS_API_KEY", semrush: "SEMRUSH_API_KEY" };

/** Remember that a cache entry holds this provider's data for this client, so a purge can delete it. */
export function trackCacheKey(provider: DataProvider, client: string, key: string): void {
  db.prepare("INSERT OR REPLACE INTO provider_cache_keys (key, provider, client) VALUES (?, ?, ?)").run(key, provider, client);
}

/** Record where the provider's key comes from now (called whenever its data is stored). */
export function markProviderData(provider: DataProvider, now = Date.now()): void {
  const v = KEY_VAR[provider];
  if (!v || !env[v]) return;
  const source = ENV_FILE_KEYS.has(v) ? "envfile" : "process";
  db.prepare("INSERT OR REPLACE INTO provider_data_marks (provider, key_source, entry, updated_at) VALUES (?, ?, ?, ?)").run(provider, source, processEntry, now);
}

export interface PurgeResult {
  provider: DataProvider;
  client: string | null;
  snapshots: number;
  issueSnapshotsEdited: number;
  cacheEntries: number;
}

/**
 * Delete a provider's stored data: its trend snapshots, its Site Audit items in technical-issue snapshots (the rest of
 * each snapshot is kept), and the cache entries tracked for it. `client` limits it to one client (slug). Idempotent.
 */
export function purgeProviderData(provider: DataProvider, client?: string | null): PurgeResult {
  const c = client ?? null;
  let snapshots = 0;
  let issueSnapshotsEdited = 0;
  let cacheEntries = 0;
  db.exec("BEGIN");
  try {
    snapshots = Number(
      (c ? db.prepare("DELETE FROM seo_snapshots WHERE provider = ? AND client = ?").run(provider, c) : db.prepare("DELETE FROM seo_snapshots WHERE provider = ?").run(provider)).changes,
    );
    if (c) db.prepare("DELETE FROM seo_history_purchases WHERE provider = ? AND client = ?").run(provider, c);
    else db.prepare("DELETE FROM seo_history_purchases WHERE provider = ?").run(provider);
    const source = SITE_AUDIT_SOURCE[provider];
    if (source) issueSnapshotsEdited = stripSourceFromIssueSnapshots(source as IssueSource, { client: c });
    const keys = (c ? db.prepare("SELECT key FROM provider_cache_keys WHERE provider = ? AND client = ?").all(provider, c) : db.prepare("SELECT key FROM provider_cache_keys WHERE provider = ?").all(provider)) as { key: string }[];
    for (const k of keys) cacheEntries += Number(db.prepare("DELETE FROM cache WHERE key = ?").run(k.key).changes);
    if (c) db.prepare("DELETE FROM provider_cache_keys WHERE provider = ? AND client = ?").run(provider, c);
    else {
      db.prepare("DELETE FROM provider_cache_keys WHERE provider = ?").run(provider);
      db.prepare("DELETE FROM provider_data_marks WHERE provider = ?").run(provider);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { provider, client: c, snapshots, issueSnapshotsEdited, cacheEntries };
}

/** True when this provider has anything stored (snapshots, tracked cache entries). */
export function hasProviderData(provider: DataProvider): boolean {
  return (
    db.prepare("SELECT 1 FROM seo_snapshots WHERE provider = ? LIMIT 1").get(provider) !== undefined ||
    db.prepare("SELECT 1 FROM provider_cache_keys WHERE provider = ? LIMIT 1").get(provider) !== undefined
  );
}

/**
 * The Ahrefs key-removal check: when this process has no AHREFS_API_KEY and the key that stored Ahrefs data came from
 * the `.env` file (every process reads it) or from the MCP server's own environment (and this is the MCP server), the
 * key was removed: purge every stored Ahrefs row. Returns the purge, or null when nothing was done.
 */
export function reconcileRemovedKeys(entry: ProcessEntry = processEntry): PurgeResult | null {
  if (env.AHREFS_API_KEY) return null;
  const mark = db.prepare("SELECT key_source, entry FROM provider_data_marks WHERE provider = 'ahrefs'").get() as { key_source: string; entry: string } | undefined;
  if (!mark) return null;
  const removed = mark.key_source === "envfile" || (mark.entry === "mcp" && entry === "mcp");
  if (!removed) return null;
  return purgeProviderData("ahrefs");
}

let reconciled = false;
/** reconcileRemovedKeys once per process; a purge is reported on stderr (never stdout: the MCP channel). */
export function reconcileOnce(): void {
  if (reconciled) return;
  reconciled = true;
  try {
    // Expired cache rows (including Ahrefs row lists, kept for at most a day) are deleted, not just ignored.
    purgeExpired();
    const r = reconcileRemovedKeys();
    if (r) console.error(`crawlmark: the Ahrefs key was removed, so stored Ahrefs data was deleted (${r.snapshots} snapshot rows, ${r.cacheEntries} cache entries).`);
  } catch (err) {
    console.error(`crawlmark: couldn't check stored Ahrefs data: ${(err as Error).message}`);
  }
}
