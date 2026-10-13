import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// A ledger file created before Phase 9 (no units column), with one DataForSEO row. src/lib/store.ts
// is imported only after DATA_DIR points at it, so opening it runs the migration.
const dataDir = mkdtempSync(join(tmpdir(), "crawlmark-units-"));
mkdirSync(dataDir, { recursive: true });
const month = new Date().toISOString().slice(0, 7);
{
  const old = new DatabaseSync(join(dataDir, "crawlmark.db"));
  old.exec(`CREATE TABLE spend (id INTEGER PRIMARY KEY AUTOINCREMENT, client TEXT NOT NULL, provider TEXT NOT NULL,
    endpoint TEXT NOT NULL, cost_usd REAL NOT NULL, month TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  old.prepare("INSERT INTO spend (client, provider, endpoint, cost_usd, month, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("example.com", "dataforseo", "/old", 1.25, month, Date.now());
  old.close();
}
process.env.DATA_DIR = dataDir;
process.env.GLOBAL_MONTHLY_BUDGET_USD = "2";
process.env.AHREFS_MONTHLY_UNIT_CAP = "1000";
process.env.SEMRUSH_MONTHLY_UNIT_CAP = "500";

const { db, migrateSpendUnits } = await import("../src/lib/store.js");
const { assertBudget, assertUnits, BudgetExceededError, recordSpend, recordUnits, spendSummary, unitsThisMonth } = await import("../src/lib/budget.js");

const client = { slug: "example.com", domain: "example.com", aliases: ["old-slug"], monthlyBudgetUsd: 2, monthlyUnits: { ahrefs: 300, semrush: 100 } };

describe("ledger migration", () => {
  it("adds the units column once and keeps old rows with 0 units", () => {
    const cols = (db.prepare("PRAGMA table_info(spend)").all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => c === "units")).toHaveLength(1);
    expect(migrateSpendUnits(db)).toBe(false);
    expect(db.prepare("SELECT endpoint, cost_usd, units FROM spend WHERE endpoint = '/old'").get()).toEqual({ endpoint: "/old", cost_usd: 1.25, units: 0 });
  });

  it("an older build's INSERT (columns named, no units) still works on the migrated file", () => {
    recordSpend("example.com", "dataforseo", "/new", 0.25);
    expect(db.prepare("SELECT units FROM spend WHERE endpoint = '/new'").get()).toEqual({ units: 0 });
  });
});

describe("unit caps", () => {
  it("assertUnits blocks at the client cap, counting alias rows, with the documented message", () => {
    recordUnits("old-slug", "ahrefs", "/site-explorer/organic-keywords", 200);
    expect(unitsThisMonth(["example.com", "old-slug"], "ahrefs")).toBe(200);
    expect(() => assertUnits(client, "ahrefs", 100)).not.toThrow();
    expect(() => assertUnits(client, "ahrefs", 101)).toThrow(BudgetExceededError);
    expect(() => assertUnits(client, "ahrefs", 101)).toThrow(
      "Ahrefs unit cap hit for example.com: 200 of 300 units this month. Raise monthlyUnits.ahrefs in clients.yaml (or DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS) to continue.",
    );
  });

  it("assertUnits blocks at the global cap", () => {
    recordUnits("other.example", "semrush", "domain_organic", 450);
    const roomy = { ...client, monthlyUnits: { ahrefs: 10_000, semrush: 10_000 } };
    expect(() => assertUnits(roomy, "semrush", 50)).not.toThrow();
    expect(() => assertUnits(roomy, "semrush", 51)).toThrow("Global Semrush unit cap hit: 450 of 500 units this month. Raise SEMRUSH_MONTHLY_UNIT_CAP to continue.");
  });

  it("USD and unit caps are independent", () => {
    // A full unit cap doesn't stop a DataForSEO call that fits its USD budget...
    const fresh = { ...client, slug: "fresh.example", domain: "fresh.example", aliases: [], monthlyBudgetUsd: 5, monthlyUnits: { ahrefs: 1, semrush: 1 } };
    expect(() => assertUnits(fresh, "ahrefs", 2)).toThrow(BudgetExceededError);
    expect(() => assertBudget(fresh as never, 0.1)).not.toThrow();
    // ...and a spent USD budget (1.25 + 0.25 + 0.5 = 2 of 2) doesn't stop an Ahrefs call that fits its unit cap.
    recordSpend("example.com", "dataforseo", "/more", 0.5);
    expect(() => assertBudget(client as never, 0.01)).toThrow(BudgetExceededError);
    expect(() => assertUnits(client, "ahrefs", 50)).not.toThrow();
  });

  it("spend_summary adds units per row and per provider without changing totalUsd", () => {
    const s = spendSummary(new Map([["old-slug", "example.com"]]));
    expect(s.totalUsd).toBe(2);
    expect(s.units).toEqual({ ahrefs: { used: 200, globalCap: 1000 }, semrush: { used: 450, globalCap: 500 } });
    expect(s.byClient).toContainEqual({ client: "example.com", provider: "ahrefs", calls: 1, cost_usd: 0, units: 200 });
    expect(s.byClient).toContainEqual({ client: "example.com", provider: "dataforseo", calls: 3, cost_usd: 2, units: 0 });
  });
});
