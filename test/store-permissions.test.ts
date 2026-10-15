/** SEC-3: the database and its SQLite side files are owner-only, even when an older build created them 0644. */
import { chmodSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { env } from "../src/config.js";
import { db, secureDataFiles } from "../src/lib/store.js";
import { POSIX_MODES } from "./platform.js";

const dbFile = join(resolve(env.DATA_DIR), "crawlmark.db");
const mode = (p: string) => statSync(p).mode & 0o777;

describe("database file permissions", () => {
  it("opens as 0600 and the data directory as 0700", () => {
    db.prepare("SELECT 1").get();
    if (POSIX_MODES) expect(mode(dbFile)).toBe(0o600);
    if (POSIX_MODES) expect(mode(resolve(env.DATA_DIR))).toBe(0o700);
  });

  it("narrows a database left 0644 by an older build", () => {
    chmodSync(dbFile, 0o644);
    secureDataFiles();
    if (POSIX_MODES) expect(mode(dbFile)).toBe(0o600);
  });
});
