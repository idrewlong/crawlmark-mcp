import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "../config.js";

/**
 * One SQLite file holds the response cache, the spend ledger, saved audits and the tool-call log.
 * node:sqlite ships with Node 22.13+, so there is no native module to build.
 */
// 0700: a new data/ holds the OAuth token and cached client data. An existing directory keeps its mode.
mkdirSync(resolve(env.DATA_DIR), { recursive: true, mode: 0o700 });
const dbPath = join(resolve(env.DATA_DIR), "crawlmark.db");
export const db = new DatabaseSync(dbPath);

// BUG-1: a cron crawlmark-cli next to one or more MCP servers shares this file. Wait for a lock instead of failing
// at once with "database is locked" (a paid call that was billed would otherwise lose its ledger row and cache entry).
db.exec("PRAGMA busy_timeout = 5000");
// WAL: readers don't block the writer and the writer doesn't block readers. Best effort (a network filesystem may refuse).
try {
  db.exec("PRAGMA journal_mode = WAL");
} catch {
  /* keep the default rollback journal */
}

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
  try {
    database.exec("ALTER TABLE spend ADD COLUMN units INTEGER NOT NULL DEFAULT 0");
  } catch (err) {
    // Another process starting at the same moment may have added it first.
    if (!/duplicate column/i.test((err as Error).message)) throw err;
    return false;
  }
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
  // Release A: a database built through this function alone also gets the inspected_url column.
  migrateInspectedUrl(database);
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
      key      TEXT NOT NULL,
      provider TEXT NOT NULL,
      client   TEXT NOT NULL,
      PRIMARY KEY (key, client)
    );
    CREATE INDEX IF NOT EXISTS provider_cache_keys_provider ON provider_cache_keys (provider, client);
    CREATE TABLE IF NOT EXISTS provider_data_marks (
      provider   TEXT PRIMARY KEY,
      key_source TEXT NOT NULL,
      entry      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  // Fix round: a cache key can be shared by two clients (unit providers' keys don't name the client), so the tracking
  // key is (key, client). A table created with `key` alone as its primary key is rebuilt once, keeping its rows.
  const shape = () => (database.prepare("PRAGMA table_info(provider_cache_keys)").all() as { name: string; pk: number }[]).find((c) => c.name === "client")?.pk ?? 0;
  if (shape() === 0) {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (shape() === 0) {
        database.exec(`
          CREATE TABLE provider_cache_keys_new (key TEXT NOT NULL, provider TEXT NOT NULL, client TEXT NOT NULL, PRIMARY KEY (key, client));
          INSERT OR IGNORE INTO provider_cache_keys_new (key, provider, client) SELECT key, provider, client FROM provider_cache_keys;
          DROP TABLE provider_cache_keys;
          ALTER TABLE provider_cache_keys_new RENAME TO provider_cache_keys;
          CREATE INDEX IF NOT EXISTS provider_cache_keys_provider ON provider_cache_keys (provider, client);
        `);
      }
      database.exec("COMMIT");
    } catch (err) {
      database.exec("ROLLBACK");
      throw err;
    }
  }
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

/**
 * Indexing "check all pages" (2026-10-14): the newest sitemap URL set seen per client and Search Console property
 * (normalised, in-property, capped), so index_coverage can say how many sitemap URLs have been checked recently and
 * when the check is complete. One row per client and property, replaced on every inspection run. Additive and idempotent.
 */
export function migrateInspectionUrlSets(database: DatabaseSync): boolean {
  const existed = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inspection_url_sets'").get() !== undefined;
  database.exec(`
    CREATE TABLE IF NOT EXISTS inspection_url_sets (
      client      TEXT NOT NULL,
      property    TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      urls        TEXT NOT NULL,
      PRIMARY KEY (client, property)
    );
  `);
  return !existed;
}

migrateInspectionUrlSets(db);

/**
 * Search Console Pages report imports (2026-10-14, docs/research/2026-10-14-gsc-pages-export.md): one row per
 * imported export (a summary with per-reason counts, or one reason's drilldown with example URLs), keyed so that
 * importing the same export again replaces it. pages-exports.ts deletes rows older than 400 days on insert.
 * Additive and idempotent.
 */
export function migratePagesExports(database: DatabaseSync): boolean {
  const existed = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gsc_pages_exports'").get() !== undefined;
  database.exec(`
    CREATE TABLE IF NOT EXISTS gsc_pages_exports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client      TEXT NOT NULL,
      property    TEXT NOT NULL,
      kind        TEXT NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      exported_on TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      source_name TEXT NOT NULL,
      data        TEXT NOT NULL,
      UNIQUE (client, property, kind, reason, exported_on)
    );
    CREATE INDEX IF NOT EXISTS gsc_pages_exports_latest ON gsc_pages_exports (client, property, kind, exported_on DESC);
  `);
  return !existed;
}

migratePagesExports(db);

/**
 * Release A / D7 (C11): the exact URL sent to Google for an inspection, next to the normalised `url` key.
 * Nullable: rows from older builds stay NULL (see legacyUnknownUrls in inspections.ts). Added with the same
 * guarded ALTER as `failed`; older builds never name the column in their INSERTs, so no rollback step is needed.
 * Returns true when this call added the column.
 */
export function migrateInspectedUrl(database: DatabaseSync): boolean {
  // The table is created by migrateUrlInspections; a database without it has nothing to alter yet.
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'url_inspections'").get() === undefined) return false;
  const cols = database.prepare("PRAGMA table_info(url_inspections)").all() as { name: string }[];
  if (cols.some((c) => c.name === "inspected_url")) return false;
  try {
    database.exec("ALTER TABLE url_inspections ADD COLUMN inspected_url TEXT");
  } catch (err) {
    // Another process starting at the same moment may have added it first.
    if (!/duplicate column/i.test((err as Error).message)) throw err;
    return false;
  }
  return true;
}

migrateInspectedUrl(db);

/**
 * Release A / D5 (C8): Search Console history kept beyond Google's 16 months, one row per client, property, month,
 * kind and key (raw numbers, no exclusions or hostname scope; the `excluded` kind holds the exclusion's share).
 * src/lib/gsc-monthly.ts replaces a whole month in one transaction. Additive and idempotent; older builds never
 * read the table.
 */
export function migrateGscMonthly(database: DatabaseSync): boolean {
  const existed = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gsc_monthly'").get() !== undefined;
  database.exec(`
    CREATE TABLE IF NOT EXISTS gsc_monthly (
      client      TEXT NOT NULL,
      property    TEXT NOT NULL,
      month       TEXT NOT NULL,
      kind        TEXT NOT NULL,
      key         TEXT NOT NULL DEFAULT '',
      clicks      INTEGER NOT NULL,
      impressions INTEGER NOT NULL,
      ctr         REAL NOT NULL,
      position    REAL NOT NULL,
      complete    INTEGER NOT NULL DEFAULT 1,
      captured_at INTEGER NOT NULL,
      PRIMARY KEY (client, property, month, kind, key)
    );
    CREATE INDEX IF NOT EXISTS gsc_monthly_month ON gsc_monthly (client, property, month);
  `);
  return !existed;
}

migrateGscMonthly(db);

/**
 * SEC-3: the database holds cached client data and the spend ledger, so it (and SQLite's -wal and -shm files, when
 * they exist) is readable by the owner only; a database created by an older build was 0644. The data directory is
 * narrowed to 0700 when this user owns it. Best effort: a filesystem without modes just keeps what it has.
 */
export function secureDataFiles(): void {
  try {
    const dir = resolve(env.DATA_DIR);
    if (typeof process.getuid === "function" && statSync(dir).uid === process.getuid()) chmodSync(dir, 0o700);
  } catch {
    /* keep the directory's mode */
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      chmodSync(dbPath + suffix, 0o600);
    } catch {
      /* the file doesn't exist (yet), or modes aren't supported here */
    }
  }
}

secureDataFiles();
