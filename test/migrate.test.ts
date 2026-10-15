import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { executeMigration, isSecretPath, planMigration } from "../src/lib/migrate.js";
import { POSIX_MODES } from "./platform.js";

/** The plan lists paths with the host separator; compare them in one spelling. */
const posixRel = (rel: string) => rel.split(sep).join("/");

function sourceHome(): string {
  const from = mkdtempSync(join(tmpdir(), "crawlmark-migrate-from-"));
  writeFileSync(join(from, ".env"), "DATAFORSEO_LOGIN=a@example.com\n", { mode: 0o644 });
  mkdirSync(join(from, "config"));
  writeFileSync(join(from, "config", "clients.yaml"), "example.com:\n  domain: example.com\n", { mode: 0o644 });
  writeFileSync(join(from, "config", "clients.example.yaml"), "# not copied\n");
  writeFileSync(join(from, "config", "competitor-denylist.txt"), "example.org\n", { mode: 0o644 });
  mkdirSync(join(from, "data", "nested"), { recursive: true });
  writeFileSync(join(from, "data", "crawlmark.db"), "db", { mode: 0o640 });
  writeFileSync(join(from, "data", "google-token.json"), "{}", { mode: 0o644 });
  writeFileSync(join(from, "data", "nested", "x.txt"), "x");
  mkdirSync(join(from, "secrets"));
  writeFileSync(join(from, "secrets", "key.json"), "{}", { mode: 0o644 });
  return from;
}

describe("setup migrate", () => {
  it("copies .env, clients.yaml, data/ and secrets/ (never moves) and makes secret files 0600", () => {
    const from = sourceHome();
    const to = join(mkdtempSync(join(tmpdir(), "crawlmark-migrate-to-")), "home");
    const plan = planMigration(from, to);
    expect(plan.files.map((f) => posixRel(f.rel)).sort()).toEqual([".env", "config/clients.yaml", "config/competitor-denylist.txt", "data/crawlmark.db", "data/google-token.json", "data/nested/x.txt", "secrets/key.json"]);
    expect(plan.files.every((f) => f.action === "copy")).toBe(true);
    expect(executeMigration(plan)).toEqual({ copied: 7, skipped: 0 });
    if (POSIX_MODES) for (const rel of [".env", "secrets/key.json", "data/google-token.json"]) expect(statSync(join(to, rel)).mode & 0o777, rel).toBe(0o600);
    if (POSIX_MODES) expect(statSync(join(to, "data", "crawlmark.db")).mode & 0o777).toBe(0o640);
    if (POSIX_MODES) expect(statSync(join(to, "config", "clients.yaml")).mode & 0o777).toBe(0o644);
    if (POSIX_MODES) expect(statSync(join(to, "config", "competitor-denylist.txt")).mode & 0o777).toBe(0o644);
    expect(readdirSync(join(to, "secrets")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(join(to, "config", "clients.example.yaml"))).toBe(false);
    // Originals untouched.
    expect(readFileSync(join(from, ".env"), "utf8")).toBe("DATAFORSEO_LOGIN=a@example.com\n");
    if (POSIX_MODES) expect(statSync(join(from, "secrets", "key.json")).mode & 0o777).toBe(0o644);
  });

  it("skips files that exist at the target unless --force", () => {
    const from = sourceHome();
    const to = mkdtempSync(join(tmpdir(), "crawlmark-migrate-to-"));
    writeFileSync(join(to, ".env"), "KEEP=1\n");
    const plan = planMigration(from, to);
    expect(plan.files.find((f) => f.rel === ".env")?.action).toBe("skip-exists");
    expect(executeMigration(plan)).toEqual({ copied: 6, skipped: 1 });
    expect(readFileSync(join(to, ".env"), "utf8")).toBe("KEEP=1\n");

    chmodSync(join(to, ".env"), 0o644);
    const forced = planMigration(from, to, { force: true });
    expect(forced.files.every((f) => f.action === "overwrite")).toBe(true);
    executeMigration(forced);
    expect(readFileSync(join(to, ".env"), "utf8")).toBe("DATAFORSEO_LOGIN=a@example.com\n");
    if (POSIX_MODES) expect(statSync(join(to, ".env")).mode & 0o777).toBe(0o600);
  });

  it("reports missing items, refuses copying onto itself or into a copied folder, and warns about absolute paths", () => {
    const from = mkdtempSync(join(tmpdir(), "crawlmark-migrate-from-"));
    writeFileSync(join(from, ".env"), `GOOGLE_APPLICATION_CREDENTIALS=${join(from, "secrets", "k.json")}\nDATA_DIR=./data\n`);
    const plan = planMigration(from, join(from, "..", "elsewhere-" + Date.now()));
    expect(plan.missing.map(posixRel)).toEqual(["config/clients.yaml", "config/competitor-denylist.txt", "data", "secrets"]);
    expect(plan.absolutePathWarnings).toHaveLength(1);
    expect(plan.absolutePathWarnings[0]).toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(() => planMigration(from, from)).toThrow(/current home/);
    expect(() => planMigration(from, join(from, "data", "x"))).toThrow(/inside the data/);
  });

  it("classifies secret paths", () => {
    expect(isSecretPath(".env")).toBe(true);
    expect(isSecretPath("secrets/a/b.json")).toBe(true);
    expect(isSecretPath("data/google-token.json")).toBe(true);
    expect(isSecretPath("data/crawlmark.db")).toBe(false);
  });
});
