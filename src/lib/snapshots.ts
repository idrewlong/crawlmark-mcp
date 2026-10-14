/**
 * Dated SEO snapshots (Phase 13, spec 13.5.1 and D1-D3): backlinks and visibility figures per
 * (client, kind, target, provider, market), one row per day and source. Comparisons and trends read
 * these first, so month-over-month works for every provider and re-running a report costs nothing.
 *
 * Semrush rows are deleted 31 days after capture (Semrush API terms, research S5; the user's decision of
 * 2026-10-13): on every save and every read.
 */
import { db } from "./store.js";

export type SnapshotKind = "backlinks" | "visibility";
export type SnapshotProvider = "dataforseo" | "ahrefs" | "semrush";
export type SnapshotSource = "live" | "provider_history";

/** Semrush data is kept at most this many days after capture. */
export const SEMRUSH_RETENTION_DAYS = 31;
const DAY_MS = 86_400_000;

export interface SnapshotKey {
  client: string;
  kind: SnapshotKind;
  /** Bare domain: the client's or a competitor's. */
  target: string;
  provider: SnapshotProvider;
  /** Visibility: location code / country / database; backlinks: "global". */
  market: string;
}

export interface StoredSnapshot extends SnapshotKey {
  id: number;
  /** YYYY-MM-DD the figures describe. */
  day: string;
  source: SnapshotSource;
  capturedAt: number;
  /** The figures, without the `v` version field. */
  data: Record<string, unknown>;
}

interface Row {
  id: number;
  client: string;
  kind: string;
  target: string;
  provider: string;
  market: string;
  day: string;
  source: string;
  captured_at: number;
  data: string;
}

const fromRow = (r: Row): StoredSnapshot => {
  const { v: _v, ...data } = JSON.parse(r.data) as Record<string, unknown>;
  return {
    id: r.id,
    client: r.client,
    kind: r.kind as SnapshotKind,
    target: r.target,
    provider: r.provider as SnapshotProvider,
    market: r.market,
    day: r.day,
    source: r.source as SnapshotSource,
    capturedAt: r.captured_at,
    data,
  };
};

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const dayMs = (s: string) => Date.parse(`${s}T00:00:00Z`);
const shiftDay = (s: string, days: number) => new Date(dayMs(s) + days * DAY_MS).toISOString().slice(0, 10);

/** Delete Semrush rows captured more than SEMRUSH_RETENTION_DAYS ago. Returns the number deleted. */
export function pruneSnapshots(now = Date.now()): number {
  return Number(db.prepare("DELETE FROM seo_snapshots WHERE provider = 'semrush' AND captured_at < ?").run(now - SEMRUSH_RETENTION_DAYS * DAY_MS).changes);
}

/** Upsert one snapshot on its unique key (the latest capture of the day wins). Prunes old Semrush rows first. */
export function saveSnapshot(s: SnapshotKey & { day: string; source: SnapshotSource; capturedAt: number; data: Record<string, unknown> }, now = Date.now()): void {
  if (!isDay(s.day)) throw new Error(`snapshot day must be YYYY-MM-DD (got ${s.day})`);
  pruneSnapshots(now);
  db.prepare(
    `INSERT INTO seo_snapshots (client, kind, target, provider, market, day, source, captured_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (client, kind, target, provider, market, day, source) DO UPDATE SET captured_at = excluded.captured_at, data = excluded.data`,
  ).run(s.client, s.kind, s.target.toLowerCase(), s.provider, s.market, s.day, s.source, s.capturedAt, JSON.stringify({ v: 1, ...s.data }));
}

function rowsBetween(k: SnapshotKey, from: string, to: string): StoredSnapshot[] {
  const rows = db
    .prepare("SELECT * FROM seo_snapshots WHERE client = ? AND kind = ? AND target = ? AND provider = ? AND market = ? AND day >= ? AND day <= ? ORDER BY day ASC, id ASC")
    .all(k.client, k.kind, k.target.toLowerCase(), k.provider, k.market, from, to) as unknown as Row[];
  return rows.map(fromRow);
}

/**
 * The snapshot nearest `day` within ±toleranceDays (D3), for the same provider and market only. On a tie in
 * distance a `live` capture beats `provider_history` (`prefer`), then the later capture wins.
 */
export function nearestSnapshot(q: SnapshotKey & { day: string; toleranceDays: number; prefer?: SnapshotSource }, now = Date.now()): StoredSnapshot | undefined {
  if (!isDay(q.day)) throw new Error(`day must be YYYY-MM-DD (got ${q.day})`);
  pruneSnapshots(now);
  const prefer = q.prefer ?? "live";
  const target = dayMs(q.day);
  const rows = rowsBetween(q, shiftDay(q.day, -q.toleranceDays), shiftDay(q.day, q.toleranceDays));
  rows.sort((a, b) => Math.abs(dayMs(a.day) - target) - Math.abs(dayMs(b.day) - target) || Number(b.source === prefer) - Number(a.source === prefer) || b.capturedAt - a.capturedAt);
  return rows[0];
}

/** Every stored point from `sinceDay` on, oldest first, one per day (a live capture over provider history on the same day). */
export function seriesSince(k: SnapshotKey, sinceDay: string, now = Date.now()): StoredSnapshot[] {
  if (!isDay(sinceDay)) throw new Error(`sinceDay must be YYYY-MM-DD (got ${sinceDay})`);
  pruneSnapshots(now);
  const byDay = new Map<string, StoredSnapshot>();
  for (const s of rowsBetween(k, sinceDay, "9999-12-31")) {
    const cur = byDay.get(s.day);
    if (!cur || (cur.source !== "live" && s.source === "live") || (cur.source === s.source && s.capturedAt > cur.capturedAt)) byDay.set(s.day, s);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}
