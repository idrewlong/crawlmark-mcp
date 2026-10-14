/**
 * BUG-2: crawlmark-cli commands that return early (report, audit, check-ranks) still reconcile stored provider data
 * first: a cron-only install that removed the Ahrefs key must not keep Ahrefs rows, and expired cache is purged.
 * The CLI runs as a child process on this test's temp DATA_DIR, with no Ahrefs key and an empty config home.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { env } from "../src/config.js";
import { db } from "../src/lib/store.js";
import { saveSnapshot } from "../src/lib/snapshots.js";

const root = join(import.meta.dirname, "..");
const SPAWN_TIMEOUT_MS = 45_000;

function runCli(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "crawlmark-reconcile-"));
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(root, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: { ...process.env, CRAWLMARK_HOME: home, CLIENTS_FILE: join(home, "clients.yaml"), DATA_DIR: env.DATA_DIR, AHREFS_API_KEY: "" },
  });
}

let n = 0;
function seedAhrefs() {
  const client = `rec${++n}.example.com`;
  saveSnapshot({ client, kind: "backlinks", target: client, provider: "ahrefs", market: "global", day: "2026-09-01", source: "live", capturedAt: Date.now(), data: { backlinks: 10 } });
  db.prepare("INSERT OR REPLACE INTO provider_data_marks (provider, key_source, entry, updated_at) VALUES ('ahrefs', 'envfile', 'cli', ?)").run(Date.now());
  return client;
}
const rows = (client: string) => Number((db.prepare("SELECT COUNT(*) AS c FROM seo_snapshots WHERE client = ?").get(client) as { c: number }).c);

describe("crawlmark-cli reconciles stored provider data before it dispatches", () => {
  it.each([
    ["report", ["report", "templates", "list"]],
    ["audit", ["audit"]],
    ["check-ranks", ["check-ranks"]],
  ])("%s", (_name, args) => {
    const client = seedAhrefs();
    expect(rows(client)).toBe(1);
    const r = runCli(args);
    expect(r.stderr).toContain("the Ahrefs key was removed");
    expect(rows(client)).toBe(0);
  }, 60_000);

  it("help and setup leave stored data alone", () => {
    const client = seedAhrefs();
    runCli(["help"]);
    runCli(["setup", "status", "--only", "home", "--json"]);
    expect(rows(client)).toBe(1);
  }, 120_000);
});
