/**
 * Release A (spec C8, C11): the inspected_url column and the gsc_monthly table. Additive and idempotent, on a fresh
 * database, on one built by 0.1.3, and when run twice. Temp SQLite only.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { db, migrateGscMonthly, migrateInspectedUrl, migrateUrlInspections } from "../src/lib/store.js";

const columns = (d: DatabaseSync, table: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/** url_inspections exactly as 0.1.3 created it (with the `failed` column, without inspected_url). */
const V013_INSPECTIONS = `
  CREATE TABLE url_inspections (
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
  CREATE INDEX url_inspections_latest ON url_inspections (client, url, inspected_at DESC);
`;

describe("migrateInspectedUrl", () => {
  it("adds a nullable inspected_url column on a fresh database, once", () => {
    const fresh = new DatabaseSync(":memory:");
    expect(migrateUrlInspections(fresh)).toBe(true);
    expect(columns(fresh, "url_inspections")).toContain("inspected_url");
    expect(migrateInspectedUrl(fresh)).toBe(false);
    expect(migrateInspectedUrl(fresh)).toBe(false);
    expect(migrateUrlInspections(fresh)).toBe(false);
  });

  it("keeps the rows of a 0.1.3 database and leaves inspected_url NULL", () => {
    const old = new DatabaseSync(":memory:");
    old.exec(V013_INSPECTIONS);
    old.prepare("INSERT INTO url_inspections (client, property, url, inspected_at, origin, coverage_state) VALUES (?, ?, ?, ?, ?, ?)").run(
      "example.com",
      "sc-domain:example.com",
      "https://example.com/about",
      1_700_000_000_000,
      "full_pass",
      "URL is unknown to Google",
    );
    expect(columns(old, "url_inspections")).not.toContain("inspected_url");
    expect(migrateInspectedUrl(old)).toBe(true);
    expect(migrateInspectedUrl(old)).toBe(false);
    expect(migrateUrlInspections(old)).toBe(false);
    const rows = old.prepare("SELECT url, inspected_url, coverage_state FROM url_inspections").all() as { url: string; inspected_url: string | null; coverage_state: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url: "https://example.com/about", inspected_url: null, coverage_state: "URL is unknown to Google" });
    // The 0.1.3 INSERT (no inspected_url) still works on the migrated table.
    old.prepare("INSERT INTO url_inspections (client, property, url, inspected_at, origin) VALUES ('example.com', 'p', 'https://example.com/', 1, 'audit')").run();
  });

  it("does nothing when the table doesn't exist yet", () => {
    const empty = new DatabaseSync(":memory:");
    expect(migrateInspectedUrl(empty)).toBe(false);
    expect(empty.prepare("SELECT 1 FROM sqlite_master WHERE name = 'url_inspections'").get()).toBeUndefined();
  });

  it("is already applied to the shared test database", () => {
    expect(columns(db, "url_inspections")).toContain("inspected_url");
    expect(migrateInspectedUrl(db)).toBe(false);
  });
});

describe("migrateGscMonthly", () => {
  it("creates the table and index on a fresh database, then is a no-op", () => {
    const fresh = new DatabaseSync(":memory:");
    expect(migrateGscMonthly(fresh)).toBe(true);
    expect(migrateGscMonthly(fresh)).toBe(false);
    expect(columns(fresh, "gsc_monthly")).toEqual(["client", "property", "month", "kind", "key", "clicks", "impressions", "ctr", "position", "complete", "captured_at"]);
    const idx = (fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'gsc_monthly'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toContain("gsc_monthly_month");
  });

  it("opens a 0.1.3 database (no gsc_monthly) without touching its other tables", () => {
    const old = new DatabaseSync(":memory:");
    old.exec(V013_INSPECTIONS);
    old.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL); INSERT INTO cache VALUES ('k', 'v', 1)");
    expect(migrateGscMonthly(old)).toBe(true);
    expect((old.prepare("SELECT value FROM cache WHERE key = 'k'").get() as { value: string }).value).toBe("v");
  });

  it("enforces the primary key and defaults complete to 1 and key to ''", () => {
    const fresh = new DatabaseSync(":memory:");
    migrateGscMonthly(fresh);
    const ins = fresh.prepare("INSERT INTO gsc_monthly (client, property, month, kind, clicks, impressions, ctr, position, captured_at) VALUES (?, ?, ?, ?, 1, 2, 3, 4, 5)");
    ins.run("example.com", "sc-domain:example.com", "2026-09", "totals");
    expect(() => ins.run("example.com", "sc-domain:example.com", "2026-09", "totals")).toThrow(/UNIQUE|constraint/i);
    expect(fresh.prepare("SELECT key, complete FROM gsc_monthly").get()).toMatchObject({ key: "", complete: 1 });
  });

  it("is already applied to the shared test database", () => {
    expect(migrateGscMonthly(db)).toBe(false);
  });
});
