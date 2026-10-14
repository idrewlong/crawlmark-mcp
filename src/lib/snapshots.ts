/**
 * Dated SEO snapshots (Phase 13, spec 13.5.1 and D1-D3): backlinks and visibility figures per
 * (client, kind, target, provider, market), one row per day and source. Comparisons and trends read
 * these first, so month-over-month works for every provider and re-running a report costs nothing.
 *
 * Semrush rows are deleted 31 days after capture (Semrush API terms, research S5; the user's decision of
 * 2026-10-13): on every save and every read. Ahrefs rows (counts per site, metric and date only; never link or
 * keyword lists) are kept for AHREFS_RETENTION_MONTHS by the day they describe (the Ahrefs storage decision).
 */
import { markProviderData } from "./provider-data.js";
import { db } from "./store.js";

export type SnapshotKind = "backlinks" | "visibility";
export type SnapshotProvider = "dataforseo" | "ahrefs" | "semrush";
export type SnapshotSource = "live" | "provider_history";

/** Semrush data is kept at most this many days after capture. */
export const SEMRUSH_RETENTION_DAYS = 31;
/** Ahrefs aggregates are kept this many months (enough for year-over-year). */
export const AHREFS_RETENTION_MONTHS = 25;
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

/** The first day of the month AHREFS_RETENTION_MONTHS before `now`'s month: older Ahrefs days are deleted. */
export function ahrefsOldestDay(now = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - AHREFS_RETENTION_MONTHS, 1)).toISOString().slice(0, 10);
}

/** Delete Semrush rows captured more than SEMRUSH_RETENTION_DAYS ago and Ahrefs rows about days older than 25 months. Returns the number deleted. */
export function pruneSnapshots(now = Date.now()): number {
  const semrush = Number(db.prepare("DELETE FROM seo_snapshots WHERE provider = 'semrush' AND captured_at < ?").run(now - SEMRUSH_RETENTION_DAYS * DAY_MS).changes);
  const ahrefs = Number(db.prepare("DELETE FROM seo_snapshots WHERE provider = 'ahrefs' AND (day < ? OR captured_at < ?)").run(ahrefsOldestDay(now), Date.parse(`${ahrefsOldestDay(now)}T00:00:00Z`)).changes);
  return semrush + ahrefs;
}

/** Upsert one snapshot on its unique key (the latest capture of the day wins). Prunes old Semrush rows first. */
export function saveSnapshot(s: SnapshotKey & { day: string; source: SnapshotSource; capturedAt: number; data: Record<string, unknown> }, now = Date.now()): void {
  if (!isDay(s.day)) throw new Error(`snapshot day must be YYYY-MM-DD (got ${s.day})`);
  pruneSnapshots(now);
  db.prepare(
    `INSERT INTO seo_snapshots (client, kind, target, provider, market, day, source, captured_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (client, kind, target, provider, market, day, source) DO UPDATE SET captured_at = excluded.captured_at, data = excluded.data`,
  ).run(s.client, s.kind, s.target.toLowerCase(), s.provider, s.market, s.day, s.source, s.capturedAt, JSON.stringify({ v: 1, ...s.data }));
  markProviderData(s.provider, now);
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

/** Providers other than `provider` with snapshots of this client, kind and target from `sinceDay` on (a provider change: D4). */
export function otherProvidersSince(k: Omit<SnapshotKey, "market">, sinceDay: string, now = Date.now()): SnapshotProvider[] {
  pruneSnapshots(now);
  const rows = db.prepare("SELECT DISTINCT provider FROM seo_snapshots WHERE client = ? AND kind = ? AND target = ? AND provider <> ? AND day >= ?").all(k.client, k.kind, k.target.toLowerCase(), k.provider, sinceDay) as { provider: string }[];
  return rows.map((r) => r.provider as SnapshotProvider);
}

/**
 * The newest live competitor snapshots (visibility rows for targets other than `own` with a commonKeywords field)
 * captured since `sinceMs`, for the same provider and market: a competitor overview's reuse window (D2).
 */
export function competitorSnapshotsSince(k: { client: string; provider: SnapshotProvider; market: string; own: string }, sinceMs: number, now = Date.now()): StoredSnapshot[] {
  pruneSnapshots(now);
  const rows = db
    .prepare("SELECT * FROM seo_snapshots WHERE client = ? AND kind = 'visibility' AND provider = ? AND market = ? AND source = 'live' AND target <> ? AND captured_at >= ? ORDER BY captured_at DESC, id DESC")
    .all(k.client, k.provider, k.market, k.own.toLowerCase(), sinceMs) as unknown as Row[];
  const out = new Map<string, StoredSnapshot>();
  for (const r of rows.map(fromRow)) if (!out.has(r.target) && "commonKeywords" in r.data) out.set(r.target, r);
  return [...out.values()];
}

/** The (provider, market) series stored for a client, kind and target, newest capture first (seo_trends). */
export function seriesKeys(client: string, kind: SnapshotKind, target: string, now = Date.now()): { provider: SnapshotProvider; market: string }[] {
  pruneSnapshots(now);
  return (db.prepare("SELECT provider, market, MAX(captured_at) AS m FROM seo_snapshots WHERE client = ? AND kind = ? AND target = ? GROUP BY provider, market ORDER BY m DESC").all(client, kind, target.toLowerCase()) as { provider: string; market: string }[]).map((r) => ({
    provider: r.provider as SnapshotProvider,
    market: r.market,
  }));
}

/** The provider-history point for the month `day` falls in (a monthly point describes its own month). */
export function historyForMonth(k: SnapshotKey, day: string, now = Date.now()): StoredSnapshot | undefined {
  if (!isDay(day)) throw new Error(`day must be YYYY-MM-DD (got ${day})`);
  pruneSnapshots(now);
  const month = day.slice(0, 7);
  return rowsBetween(k, `${month}-01`, `${month}-31`).filter((r) => r.source === "provider_history").sort((a, b) => b.capturedAt - a.capturedAt)[0];
}

/** When provider history was last bought for this series (ms), or null. */
export function lastHistoryCapture(k: SnapshotKey, now = Date.now()): number | null {
  pruneSnapshots(now);
  const r = db.prepare("SELECT MAX(captured_at) AS m FROM seo_snapshots WHERE client = ? AND kind = ? AND target = ? AND provider = ? AND market = ? AND source = 'provider_history'").get(k.client, k.kind, k.target.toLowerCase(), k.provider, k.market) as { m: number | null };
  return r.m ?? null;
}

/** The newest live capture of a series made since `sinceMs` (D2 reuse window), or undefined. */
export function latestLiveSince(k: SnapshotKey, sinceMs: number, now = Date.now()): StoredSnapshot | undefined {
  pruneSnapshots(now);
  const row = db
    .prepare("SELECT * FROM seo_snapshots WHERE client = ? AND kind = ? AND target = ? AND provider = ? AND market = ? AND source = 'live' AND captured_at >= ? ORDER BY captured_at DESC, id DESC LIMIT 1")
    .get(k.client, k.kind, k.target.toLowerCase(), k.provider, k.market, sinceMs) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

/** Record a provider-history purchase for a series: when, and the first day it asked for (R-3). */
export function recordHistoryPurchase(k: SnapshotKey, dateFrom: string, capturedAt: number): void {
  db.prepare(
    `INSERT INTO seo_history_purchases (client, kind, target, provider, market, captured_at, date_from) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (client, kind, target, provider, market) DO UPDATE SET captured_at = excluded.captured_at, date_from = excluded.date_from`,
  ).run(k.client, k.kind, k.target.toLowerCase(), k.provider, k.market, capturedAt, dateFrom);
}

/** The latest purchase for a series, or undefined. Semrush purchases follow the 31-day rule like its rows. */
export function lastHistoryPurchase(k: SnapshotKey, now = Date.now()): { capturedAt: number; dateFrom: string } | undefined {
  db.prepare("DELETE FROM seo_history_purchases WHERE provider = 'semrush' AND captured_at < ?").run(now - SEMRUSH_RETENTION_DAYS * DAY_MS);
  const r = db.prepare("SELECT captured_at, date_from FROM seo_history_purchases WHERE client = ? AND kind = ? AND target = ? AND provider = ? AND market = ?").get(k.client, k.kind, k.target.toLowerCase(), k.provider, k.market) as { captured_at: number; date_from: string } | undefined;
  return r ? { capturedAt: r.captured_at, dateFrom: r.date_from } : undefined;
}

/** The oldest provider-history day stored for a series, or undefined. */
export function oldestHistoryDay(k: SnapshotKey, now = Date.now()): string | undefined {
  pruneSnapshots(now);
  const r = db.prepare("SELECT MIN(day) AS d FROM seo_snapshots WHERE client = ? AND kind = ? AND target = ? AND provider = ? AND market = ? AND source = 'provider_history'").get(k.client, k.kind, k.target.toLowerCase(), k.provider, k.market) as { d: string | null };
  return r.d ?? undefined;
}
