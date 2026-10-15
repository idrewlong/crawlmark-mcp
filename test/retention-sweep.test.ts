// The storage rules run on everything stored, not only when snapshots are next read: retentionSweep deletes
// Semrush figures after 31 days and expired cache rows, and keeps fresh rows and other providers' figures.
import { describe, expect, it } from "vitest";
import { retentionSweep } from "../src/lib/provider-data.js";
import { db } from "../src/lib/store.js";

const DAY = 86_400_000;

describe("retentionSweep", () => {
  it("deletes Semrush snapshots older than 31 days and expired cache rows without any read", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    const ins = db.prepare(
      "INSERT INTO seo_snapshots (client, kind, target, provider, market, day, source, captured_at, data) VALUES (?, 'backlinks', 'example.com', ?, 'global', ?, 'live', ?, '{}')",
    );
    ins.run("sweep.example.com", "semrush", "2026-09-01", now - 40 * DAY);
    ins.run("sweep.example.com", "semrush", "2026-10-10", now - 5 * DAY);
    ins.run("sweep.example.com", "dataforseo", "2026-09-01", now - 40 * DAY);
    const sec = Math.floor(now / 1000);
    const cache = db.prepare("INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, '{}', ?)");
    cache.run("sweep:expired", sec - 60);
    cache.run("sweep:fresh", Math.floor(Date.now() / 1000) + 3600);

    retentionSweep(now);

    const rows = db.prepare("SELECT provider, day FROM seo_snapshots WHERE client = 'sweep.example.com' ORDER BY provider, day").all() as { provider: string; day: string }[];
    expect(rows).toEqual([
      { provider: "dataforseo", day: "2026-09-01" },
      { provider: "semrush", day: "2026-10-10" },
    ]);
    const keys = (db.prepare("SELECT key FROM cache WHERE key LIKE 'sweep:%'").all() as { key: string }[]).map((r) => r.key);
    expect(keys).toEqual(["sweep:fresh"]);
  });
});
