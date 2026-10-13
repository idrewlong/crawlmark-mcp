import { randomBytes } from "node:crypto";
import type { StoredAudit } from "../analysis/diff.js";
import type { CheckedPair, Finding } from "../analysis/findings.js";
import { db } from "./store.js";

interface Row {
  id: string;
  client: string;
  ran_at: number;
  settings: string;
  summary: string;
  findings: string;
  checked: string;
  result: string;
}

/** Sortable ID: UTC timestamp to the millisecond plus 4 random bytes. */
export function newAuditId(ranAt: number): string {
  return `${new Date(ranAt).toISOString().replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}`;
}

const fromRow = (r: Row): StoredAudit => ({
  id: r.id,
  client: r.client,
  ranAt: r.ran_at,
  settings: JSON.parse(r.settings),
  summary: JSON.parse(r.summary),
  findings: JSON.parse(r.findings) as Finding[],
  checked: JSON.parse(r.checked) as CheckedPair[],
  result: JSON.parse(r.result),
});

export function saveAudit(a: StoredAudit): void {
  db.prepare(
    "INSERT INTO audits (id, client, ran_at, settings, summary, findings, checked, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(a.id, a.client, a.ranAt, JSON.stringify(a.settings), JSON.stringify(a.summary), JSON.stringify(a.findings), JSON.stringify(a.checked), JSON.stringify(a.result));
}

export function getAudit(id: string): StoredAudit | undefined {
  const row = db.prepare("SELECT * FROM audits WHERE id = ?").get(id) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

export interface AuditListItem {
  id: string;
  ranAt: number;
  settings: unknown;
  summary: unknown;
  findingCount: number;
}

/** Newest first. Skips the large findings/result blobs. */
export function listAudits(client: string, limit = 20): AuditListItem[] {
  const rows = db
    .prepare(
      "SELECT id, ran_at, settings, summary, json_array_length(findings) AS finding_count FROM audits WHERE client = ? ORDER BY ran_at DESC, id DESC LIMIT ?",
    )
    .all(client, limit) as unknown as { id: string; ran_at: number; settings: string; summary: string; finding_count: number }[];
  return rows.map((r) => ({ id: r.id, ranAt: r.ran_at, settings: JSON.parse(r.settings), summary: JSON.parse(r.summary), findingCount: r.finding_count }));
}

export function latestAudit(client: string): StoredAudit | undefined {
  return latestAuditBefore(client, Number.MAX_SAFE_INTEGER);
}

/** The most recent audit that ran strictly before `beforeMs`. */
export function latestAuditBefore(client: string, beforeMs: number): StoredAudit | undefined {
  const row = db
    .prepare("SELECT * FROM audits WHERE client = ? AND ran_at < ? ORDER BY ran_at DESC, id DESC LIMIT 1")
    .get(client, beforeMs) as Row | undefined;
  return row ? fromRow(row) : undefined;
}
