/**
 * BUG-1: another process holding the write lock for a moment (a cron crawlmark-cli next to an MCP server) makes a
 * write wait, not fail with "database is locked". A child process holds BEGIN IMMEDIATE for about a second.
 */
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { env } from "../src/config.js";
import { recordSpend, spentThisMonth } from "../src/lib/budget.js";
import { db, migrateSpendUnits } from "../src/lib/store.js";

const dbFile = join(resolve(env.DATA_DIR), "crawlmark.db");

const HOLDER = `
const { DatabaseSync } = require("node:sqlite");
const d = new DatabaseSync(process.argv[1]);
d.exec("PRAGMA busy_timeout = 5000");
d.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => { d.exec("COMMIT"); d.close(); }, 1000);
`;

describe("SQLite busy timeout", () => {
  it("recordSpend waits for another process's write lock instead of throwing", async () => {
    const child = spawn(process.execPath, ["-e", HOLDER, dbFile], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((ok, fail) => {
      child.stdout.once("data", () => ok());
      child.once("error", fail);
    });
    const before = spentThisMonth("busy.example.com");
    const t0 = Date.now();
    expect(() => recordSpend("busy.example.com", "dataforseo", "/probe", 0.01)).not.toThrow();
    expect(Date.now() - t0).toBeGreaterThan(300);
    expect(spentThisMonth("busy.example.com")).toBeCloseTo(before + 0.01, 6);
    await new Promise((r) => child.once("exit", r));
  }, 15_000);

  it("runs with a 5 s busy timeout", () => {
    expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
  });

  it("migrateSpendUnits is idempotent", () => {
    expect(migrateSpendUnits(db)).toBe(false);
  });
});
