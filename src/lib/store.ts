import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "../config.js";

/**
 * One SQLite file holds the response cache, the spend ledger, saved audits and the tool-call log.
 * node:sqlite ships with Node 22.13+, so there is no native module to build.
 */
// 0700: a new data/ holds the OAuth token and cached client data. An existing directory keeps its mode.
mkdirSync(resolve(env.DATA_DIR), { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(join(resolve(env.DATA_DIR), "crawlmark.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS spend (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client     TEXT NOT NULL,
    provider   TEXT NOT NULL,
    endpoint   TEXT NOT NULL,
    cost_usd   REAL NOT NULL,
    month      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS spend_month ON spend (month, client);
  CREATE TABLE IF NOT EXISTS audits (
    id       TEXT PRIMARY KEY,
    client   TEXT NOT NULL,
    ran_at   INTEGER NOT NULL,
    settings TEXT NOT NULL,
    summary  TEXT NOT NULL,
    findings TEXT NOT NULL,
    checked  TEXT NOT NULL,
    result   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audits_client ON audits (client, ran_at DESC);
  -- One row per tool call. No arguments beyond the client: URLs and queries can be sensitive.
  CREATE TABLE IF NOT EXISTS tool_calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tool        TEXT NOT NULL,
    client      TEXT,
    duration_ms INTEGER NOT NULL,
    ok          INTEGER NOT NULL,
    error_class TEXT,
    ts          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tool_calls_ts ON tool_calls (ts);
`);

/**
 * Phase 9: the spend ledger records Ahrefs/Semrush units next to cost_usd. Adds the
 * column once (guarded by PRAGMA table_info); existing rows get 0. Older builds keep
 * working on a migrated file because their INSERT names its columns. No rollback is
 * needed: the column is ignored by older code and never dropped.
 */
export function migrateSpendUnits(database: DatabaseSync): boolean {
  const cols = database.prepare("PRAGMA table_info(spend)").all() as { name: string }[];
  if (cols.some((c) => c.name === "units")) return false;
  database.exec("ALTER TABLE spend ADD COLUMN units INTEGER NOT NULL DEFAULT 0");
  return true;
}

migrateSpendUnits(db);

/**
 * Phase 12 B: stored rank history for tracked keywords (spec 12.B.2). Additive and idempotent:
 * CREATE ... IF NOT EXISTS on every start, so an existing database gains the table and index once
 * and a migrated one is left alone. Older builds never read the table, so no rollback step is needed.
 * One row per (client, keyword, source, day, market, language, device); a later check of the same day
 * replaces the earlier one (upsert in rank-history.ts).
 */
export function migrateRankHistory(database: DatabaseSync): boolean {
  const existed = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rank_history'").get() !== undefined;
  database.exec(`
    CREATE TABLE IF NOT EXISTS rank_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client      TEXT NOT NULL,
      keyword     TEXT NOT NULL,
      source      TEXT NOT NULL,
      day         TEXT NOT NULL,
      checked_at  INTEGER NOT NULL,
      rank        REAL,
      url         TEXT,
      depth       INTEGER,
      market      TEXT NOT NULL,
      language    TEXT NOT NULL,
      device      TEXT NOT NULL DEFAULT 'desktop',
      clicks      INTEGER,
      impressions INTEGER,
      UNIQUE (client, keyword, source, day, market, language, device)
    );
    CREATE INDEX IF NOT EXISTS rank_history_lookup ON rank_history (client, keyword, source, day);
  `);
  return !existed;
}

migrateRankHistory(db);

/**
 * Phase 12 C1: saved local crawls (local_crawl, crawlmark-cli crawl, run_audit with localCrawl).
 * Additive and idempotent like rank_history: CREATE ... IF NOT EXISTS on every start; older
 * builds never read the table, so no rollback step is needed. `pages` is the JSON page list.
 * crawls.ts keeps the newest 10 per client.
 */
export function migrateLocalCrawls(database: DatabaseSync): boolean {
  const existed = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_crawls'").get() !== undefined;
  database.exec(`
    CREATE TABLE IF NOT EXISTS local_crawls (
      id         TEXT PRIMARY KEY,
      client     TEXT NOT NULL,
      ran_at     INTEGER NOT NULL,
      settings   TEXT,
      summary    TEXT,
      exhaustive INTEGER NOT NULL,
      pages      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS local_crawls_client ON local_crawls (client, ran_at DESC);
  `);
  return !existed;
}

migrateLocalCrawls(db);

/**
 * Phase 13 A (spec 13.5.1): dated SEO snapshots (backlinks and visibility figures) for trends and comparisons.
 * Stage A creates the table; Stage B's provider sections write it. Additive and idempotent like rank_history:
 * CREATE ... IF NOT EXISTS on every start; older builds never read it, so no rollback step is needed.
 */
export function migrateSeoSnapshots(database: DatabaseSync): boolean {
  const existed = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seo_snapshots'").get() !== undefined;
  database.exec(`
    CREATE TABLE IF NOT EXISTS seo_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client      TEXT NOT NULL,
      kind        TEXT NOT NULL,
      target      TEXT NOT NULL,
      provider    TEXT NOT NULL,
      market      TEXT NOT NULL,
      day         TEXT NOT NULL,
      source      TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      data        TEXT NOT NULL,
      UNIQUE (client, kind, target, provider, market, day, source)
    );
    CREATE INDEX IF NOT EXISTS seo_snapshots_lookup ON seo_snapshots (client, kind, target, provider, market, day);
  `);
  return !existed;
}

migrateSeoSnapshots(db);

/**
 * Phase 13 A (spec 13.5.2): technical-issue snapshots, one per technical_issues run (the base for the next
 * run's new/resolved/persistent/unverified). Additive and idempotent; issue-snapshots.ts keeps the newest 24 per client.
 */
export function migrateIssueSnapshots(database: DatabaseSync): boolean {
  const existed = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'issue_snapshots'").get() !== undefined;
  database.exec(`
    CREATE TABLE IF NOT EXISTS issue_snapshots (
      id          TEXT PRIMARY KEY,
      client      TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      items       TEXT NOT NULL,
      checked     TEXT NOT NULL,
      settings    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS issue_snapshots_client ON issue_snapshots (client, captured_at DESC);
  `);
  return !existed;
}

migrateIssueSnapshots(db);

/**
 * Phase 13 A (spec 13.5.4): stored URL Inspection results and the per-property daily inspection count
 * (Pacific-time day). Additive and idempotent. inspections.ts deletes inspections older than 400 days and
 * quota rows older than 7 days on insert.
 */
export function migrateUrlInspections(database: DatabaseSync): boolean {
  const existed = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'url_inspections'").get() !== undefined;
  database.exec(`
    CREATE TABLE IF NOT EXISTS url_inspections (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      client           TEXT NOT NULL,
      property         TEXT NOT NULL,
      url              TEXT NOT NULL,
      inspected_at     INTEGER NOT NULL,
      origin           TEXT NOT NULL,
      verdict          TEXT,
      coverage_state   TEXT,
      indexing_state   TEXT,
      page_fetch_state TEXT,
      robots_txt_state TEXT,
      google_canonical TEXT,
      user_canonical   TEXT,
      last_crawl_time  TEXT,
      crawled_as       TEXT,
      in_sitemap       INTEGER NOT NULL DEFAULT 0,
      failed           INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS url_inspections_latest ON url_inspections (client, url, inspected_at DESC);
    CREATE TABLE IF NOT EXISTS gsc_inspection_quota (
      property  TEXT NOT NULL,
      day       TEXT NOT NULL,
      used      INTEGER NOT NULL DEFAULT 0,
      exhausted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (property, day)
    );
  `);
  // Added in the Stage A fix round: a failed inspection is recorded (so the URL rotates) but never read as a result.
  const cols = database.prepare("PRAGMA table_info(url_inspections)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "failed")) {
    try {
      database.exec("ALTER TABLE url_inspections ADD COLUMN failed INTEGER NOT NULL DEFAULT 0");
    } catch (err) {
      // Another process starting at the same moment may have added it first.
      if (!/duplicate column/i.test((err as Error).message)) throw err;
    }
  }
  return !existed;
}

migrateUrlInspections(db);

/**
 * Phase 13 B (Ahrefs storage decision, docs/research/2026-10-13-ahrefs-storage-terms.md): which cache entries hold a
 * unit provider's data (so they can be purged with it), and where the provider's key came from when its data was
 * last stored (so a removed key can be detected safely). Additive and idempotent; older builds never read them.
 */
export function migrateProviderData(database: DatabaseSync): boolean {
  const existed = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_cache_keys'").get() !== undefined;
  database.exec(`
    CREATE TABLE IF NOT EXISTS provider_cache_keys (
      key      TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      client   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_cache_keys_provider ON provider_cache_keys (provider, client);
    CREATE TABLE IF NOT EXISTS provider_data_marks (
      provider   TEXT PRIMARY KEY,
      key_source TEXT NOT NULL,
      entry      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return !existed;
}

migrateProviderData(db);

/**
 * Phase 13 B fix round (R-3, R-4): provider-history purchases per series, with how far back each reached, so a
 * purchase that returned nothing (or less than asked) isn't bought again every run, and a later report that needs an
 * older month can still buy it. Additive and idempotent.
 */
export function migrateHistoryPurchases(database: DatabaseSync): boolean {
  const existed = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seo_history_purchases'").get() !== undefined;
  database.exec(`
    CREATE TABLE IF NOT EXISTS seo_history_purchases (
      client      TEXT NOT NULL,
      kind        TEXT NOT NULL,
      target      TEXT NOT NULL,
      provider    TEXT NOT NULL,
      market      TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      date_from   TEXT NOT NULL,
      PRIMARY KEY (client, kind, target, provider, market)
    );
  `);
  return !existed;
}

migrateHistoryPurchases(db);
