import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StoredAudit } from "../src/analysis/diff.js";

// Real SQLite in a throwaway DATA_DIR; config is imported only after it is set.
const dataDir = mkdtempSync(join(tmpdir(), "crawlmark-audits-"));
process.env.DATA_DIR = dataDir;

const mk = (id: string, client: string, ranAt: number): StoredAudit => ({
  id,
  client,
  ranAt,
  settings: { pages: 1 },
  summary: { avgScores: { performance: 90 } },
  findings: [{ id: "f1", source: "onpage", rule: "no_title", url: "https://example.com/", severity: "high", title: "t" }],
  checked: [{ url: "https://example.com", source: "onpage" }],
  result: { pages: [] },
});

describe("audit storage (SQLite)", () => {
  it("round-trips an audit and lists newest first, per client", async () => {
    const { env } = await import("../src/config.js");
    expect(env.DATA_DIR).toBe(dataDir);
    const { getAudit, latestAudit, latestAuditBefore, listAudits, newAuditId, saveAudit } = await import("../src/lib/audits.js");

    saveAudit(mk("a1", "example.com", 1000));
    saveAudit(mk("a2", "example.com", 3000));
    saveAudit(mk("a3", "example.com", 2000));
    saveAudit(mk("b1", "example.org", 5000));

    expect(getAudit("a1")).toEqual(mk("a1", "example.com", 1000));
    expect(getAudit("missing")).toBeUndefined();
    expect(listAudits("example.com").map((a) => a.id)).toEqual(["a2", "a3", "a1"]);
    expect(listAudits("example.com")[0]).toEqual({ id: "a2", ranAt: 3000, settings: { pages: 1 }, summary: { avgScores: { performance: 90 } }, findingCount: 1 });
    expect(listAudits("example.com", 2)).toHaveLength(2);
    expect(listAudits("example.org").map((a) => a.id)).toEqual(["b1"]);
    expect(listAudits("none.example")).toEqual([]);
    expect(latestAuditBefore("example.com", 2500)?.id).toBe("a3");
    expect(latestAudit("example.com")?.id).toBe("a2");
    expect(latestAuditBefore("example.com", 1000)).toBeUndefined();

    const x = newAuditId(1_700_000_000_000);
    const y = newAuditId(1_700_000_001_000);
    expect(x < y).toBe(true);
    expect(newAuditId(1)).not.toBe(newAuditId(1));
  });
});
