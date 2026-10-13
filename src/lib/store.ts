import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "../config.js";

/**
 * One SQLite file holds the response cache, the spend ledger and saved audits.
 * node:sqlite ships with Node 22.13+, so there is no native module to build.
 */
mkdirSync(resolve(env.DATA_DIR), { recursive: true });
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
`);
