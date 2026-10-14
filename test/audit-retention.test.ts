/** Saved audits: 400 days of history, but the newest two per client always stay (fake dates). */
import { describe, expect, it } from "vitest";
import type { StoredAudit } from "../src/analysis/diff.js";
import { getAudit, listAudits, saveAudit } from "../src/lib/audits.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-14T12:00:00Z");
const audit = (client: string, id: string, ranAt: number): StoredAudit => ({ id, client, ranAt, settings: {}, summary: {}, findings: [], checked: [], result: {} }) as unknown as StoredAudit;

describe("audit retention", () => {
  it("drops audits older than 400 days when a new one is saved, keeping the newer ones", () => {
    const c = "ret1.example.com";
    saveAudit(audit(c, "old", NOW - 500 * DAY));
    saveAudit(audit(c, "mid", NOW - 399 * DAY));
    saveAudit(audit(c, "recent", NOW - 30 * DAY));
    saveAudit(audit(c, "new", NOW));
    expect(getAudit("old")).toBeUndefined();
    expect(listAudits(c).map((a) => a.id)).toEqual(["new", "recent", "mid"]);
  });

  it("always keeps the newest two, however old", () => {
    const c = "ret2.example.com";
    saveAudit(audit(c, "a", NOW - 900 * DAY));
    saveAudit(audit(c, "b", NOW - 800 * DAY));
    saveAudit(audit(c, "c", NOW - 300 * DAY));
    expect(listAudits(c).map((a) => a.id)).toEqual(["c", "b"]);
  });

  it("never touches another client's audits", () => {
    saveAudit(audit("ret3.example.com", "x", NOW - 900 * DAY));
    saveAudit(audit("ret4.example.com", "y", NOW));
    saveAudit(audit("ret4.example.com", "z", NOW + 1));
    saveAudit(audit("ret4.example.com", "w", NOW + 2));
    expect(getAudit("x")).toBeDefined();
  });
});
