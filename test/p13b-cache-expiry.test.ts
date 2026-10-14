// Expired cache rows (e.g. Ahrefs row lists, cached for at most a day) are deleted
// when a process starts, not just ignored until someone runs purge_cache.
import { describe, expect, it } from "vitest";
import { db } from "../src/lib/store.js";
import { reconcileOnce } from "../src/lib/provider-data.js";

describe("startup cache expiry", () => {
  it("reconcileOnce deletes expired cache rows and keeps fresh ones", () => {
    const now = Math.floor(Date.now() / 1000);
    const ins = db.prepare("INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)");
    ins.run("test:expired-ahrefs-rows", JSON.stringify({ rows: ["example keyword"] }), now - 60);
    ins.run("test:fresh-entry", JSON.stringify({ ok: true }), now + 3600);
    reconcileOnce();
    const keys = (db.prepare("SELECT key FROM cache WHERE key LIKE 'test:%'").all() as { key: string }[]).map((r) => r.key);
    expect(keys).toEqual(["test:fresh-entry"]);
  });
});
