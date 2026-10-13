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
