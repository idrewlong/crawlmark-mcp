/**
 * Technical-issue snapshots (Phase 13, spec 13.5.2, D10): what each technical_issues run found and which
 * source runs it read, so the next run can say what's new, resolved, persistent or not re-checked.
 * The newest ISSUE_SNAPSHOTS_KEPT per client are kept, plus the newest of each calendar month for MONTHLY_KEPT months
 * (older rows deleted in the same transaction).
 */
import type { IssueSource, SourceRun, TechIssue } from "../reports/report-types.js";
import { db } from "./store.js";

export const ISSUE_SNAPSHOTS_KEPT = 24;
const DAY_MS = 86_400_000;

/**
 * Remove one source's items and source runs from stored issue snapshots (all of them, one client's, or only those
 * captured before `beforeMs`); an item left with no source is dropped. Runs in the caller's transaction (it opens
 * none). Returns the number of snapshots changed.
 */
export function stripSourceFromIssueSnapshots(source: string, o: { client?: string | null | undefined; beforeMs?: number | undefined } = {}): number {
  const where = ["(items LIKE ? OR checked LIKE ?)"];
  const args: (string | number)[] = [`%"${source}"%`, `%"${source}"%`];
  if (o.client) {
    where.push("client = ?");
    args.push(o.client);
  }
  if (o.beforeMs !== undefined) {
    where.push("captured_at < ?");
    args.push(o.beforeMs);
  }
  const rows = db.prepare(`SELECT id, items, checked FROM issue_snapshots WHERE ${where.join(" AND ")}`).all(...args) as { id: string; items: string; checked: string }[];
  let changed = 0;
  for (const r of rows) {
    const items = (JSON.parse(r.items) as { sources: { source: string }[]; seen?: { source: string }[] }[])
      .map((i) => ({ ...i, sources: i.sources.filter((x) => x.source !== source), ...(i.seen ? { seen: i.seen.filter((x) => x.source !== source) } : {}) }))
      .filter((i) => i.sources.length > 0);
    const checked = (JSON.parse(r.checked) as { source: string }[]).filter((x) => x.source !== source);
    db.prepare("UPDATE issue_snapshots SET items = ?, checked = ? WHERE id = ?").run(JSON.stringify(items), JSON.stringify(checked), r.id);
    changed++;
  }
  return changed;
}

/** The newest snapshot of each calendar month is also kept for this many months. */
export const MONTHLY_KEPT = 25;

/** The first millisecond of the month `back` months before the month of `ms` (UTC). */
const monthStartMs = (ms: number, back: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1);
};

export interface IssueSnapshot {
  id: string;
  client: string;
  capturedAt: number;
  /** Items without their change field, with the source runs that last reported each (R-1). */
  items: (Omit<TechIssue, "change"> & { seen?: SourceRun[] })[];
  checked: SourceRun[];
  settings: { sources: IssueSource[]; maxAgeDays: number };
}

interface Row {
  id: string;
  client: string;
  captured_at: number;
  items: string;
  checked: string;
  settings: string;
}

const fromRow = (r: Row): IssueSnapshot => ({
  id: r.id,
  client: r.client,
  capturedAt: r.captured_at,
  items: JSON.parse(r.items) as IssueSnapshot["items"],
  checked: JSON.parse(r.checked) as SourceRun[],
  settings: JSON.parse(r.settings) as IssueSnapshot["settings"],
});

export function saveIssueSnapshot(s: IssueSnapshot, now = Math.max(Date.now(), s.capturedAt)): void {
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO issue_snapshots (id, client, captured_at, items, checked, settings) VALUES (?, ?, ?, ?, ?, ?)").run(
      s.id,
      s.client,
      s.capturedAt,
      JSON.stringify(s.items),
      JSON.stringify(s.checked),
      JSON.stringify(s.settings),
    );
    // Kept: the newest ISSUE_SNAPSHOTS_KEPT, plus the newest of each calendar month (UTC) for MONTHLY_KEPT months, so a
    // report's base (the snapshot from the previous report) can't be pruned by frequent tool calls.
    const newest = Number((db.prepare("SELECT MAX(captured_at) AS m FROM issue_snapshots WHERE client = ?").get(s.client) as { m: number }).m);
    const since = monthStartMs(newest, MONTHLY_KEPT - 1);
    db.prepare(
      `DELETE FROM issue_snapshots WHERE client = ?
         AND id NOT IN (SELECT id FROM issue_snapshots WHERE client = ? ORDER BY captured_at DESC, id DESC LIMIT ?)
         AND id NOT IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY strftime('%Y-%m', captured_at / 1000, 'unixepoch') ORDER BY captured_at DESC, id DESC) AS rn
             FROM issue_snapshots WHERE client = ? AND captured_at >= ?
           ) WHERE rn = 1
         )`,
    ).run(s.client, s.client, ISSUE_SNAPSHOTS_KEPT, s.client, since);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** The client's newest snapshot captured strictly before `beforeMs`, leaving out `excludeIds` (the current run's own). */
export function latestIssueSnapshotBefore(client: string, beforeMs: number, excludeIds: readonly string[] = [], now = Date.now()): IssueSnapshot | undefined {
  const ex = excludeIds.length ? ` AND id NOT IN (${excludeIds.map(() => "?").join(", ")})` : "";
  const row = db.prepare(`SELECT * FROM issue_snapshots WHERE client = ? AND captured_at < ?${ex} ORDER BY captured_at DESC, id DESC LIMIT 1`).get(client, beforeMs, ...excludeIds) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

export function countIssueSnapshots(client: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM issue_snapshots WHERE client = ?").get(client) as { n: number }).n);
}
