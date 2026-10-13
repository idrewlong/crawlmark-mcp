/**
 * Saved local crawls (Phase 12 C1, table local_crawls). Only the newest
 * CRAWLS_KEPT per client are kept: older rows are deleted in the same
 * transaction as the insert.
 */
import { randomBytes } from "node:crypto";
import type { CrawlPage } from "../analysis/crawl.js";
import { db } from "./store.js";

export const CRAWLS_KEPT = 10;

export interface StoredCrawl {
  id: string;
  client: string;
  ranAt: number;
  settings: unknown;
  summary: unknown;
  exhaustive: boolean;
  pages: CrawlPage[];
}

interface Row {
  id: string;
  client: string;
  ran_at: number;
  settings: string | null;
  summary: string | null;
  exhaustive: number;
  pages: string;
}

/** Sortable ID: `crawl_` + UTC timestamp to the millisecond + 4 random bytes. */
export function newCrawlId(ranAt: number): string {
  return `crawl_${new Date(ranAt).toISOString().replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}`;
}

const fromRow = (r: Row): StoredCrawl => ({
  id: r.id,
  client: r.client,
  ranAt: r.ran_at,
  settings: r.settings ? JSON.parse(r.settings) : null,
  summary: r.summary ? JSON.parse(r.summary) : null,
  exhaustive: r.exhaustive === 1,
  pages: JSON.parse(r.pages) as CrawlPage[],
});

export function saveCrawl(c: StoredCrawl): void {
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO local_crawls (id, client, ran_at, settings, summary, exhaustive, pages) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      c.id,
      c.client,
      c.ranAt,
      JSON.stringify(c.settings),
      JSON.stringify(c.summary),
      c.exhaustive ? 1 : 0,
      JSON.stringify(c.pages),
    );
    db.prepare(
      "DELETE FROM local_crawls WHERE client = ? AND id NOT IN (SELECT id FROM local_crawls WHERE client = ? ORDER BY ran_at DESC, id DESC LIMIT ?)",
    ).run(c.client, c.client, CRAWLS_KEPT);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getCrawl(id: string): StoredCrawl | undefined {
  const row = db.prepare("SELECT * FROM local_crawls WHERE id = ?").get(id) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

/** The client's newest crawl (exhaustive ones only, and ones seeded from the homepage only, when asked). */
export function latestCrawl(client: string, opts: { exhaustiveOnly?: boolean; seededFromHomepageOnly?: boolean } = {}): StoredCrawl | undefined {
  const row = db
    .prepare(
      `SELECT * FROM local_crawls WHERE client = ?${opts.exhaustiveOnly ? " AND exhaustive = 1" : ""}${opts.seededFromHomepageOnly ? " AND json_extract(settings, '$.seededFromHomepage') = 1" : ""} ORDER BY ran_at DESC, id DESC LIMIT 1`,
    )
    .get(client) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

/** Newest first, without the page lists. */
export function listCrawls(client: string): { id: string; ranAt: number; exhaustive: boolean; summary: unknown }[] {
  const rows = db.prepare("SELECT id, ran_at, exhaustive, summary FROM local_crawls WHERE client = ? ORDER BY ran_at DESC, id DESC").all(client) as unknown as Pick<Row, "id" | "ran_at" | "exhaustive" | "summary">[];
  return rows.map((r) => ({ id: r.id, ranAt: r.ran_at, exhaustive: r.exhaustive === 1, summary: r.summary ? JSON.parse(r.summary) : null }));
}
