/**
 * Stored Search Console Pages report imports (import_index_report, `crawlmark-cli index-coverage import`). Every
 * value was cleaned by the parser (analysis/gsc-pages-export.ts) before it gets here; this module only stores and
 * reads. Importing the same export again (same client, property, kind, reason and export date) replaces it.
 */
import type { ReasonGroup } from "../analysis/gsc-pages-export.js";
import { db } from "./store.js";

/** Imports older than this are deleted on insert. */
export const PAGES_EXPORT_RETENTION_DAYS = 400;
const DAY_MS = 86_400_000;

export interface SummaryData {
  totals: { date: string; indexed: number | null; notIndexed: number | null } | null;
  reasons: { reason: string; group: ReasonGroup; source: string | null; validation: string | null; pages: number }[];
}
export interface DrilldownData {
  group: ReasonGroup;
  /** Unique in-property URLs in the export (the examples are the first of them, capped). */
  rows: number;
  urls: { url: string; lastCrawled: string | null }[];
}

export interface StoredExport<T> {
  id: number;
  client: string;
  property: string;
  reason: string;
  exportedOn: string;
  importedAt: number;
  sourceName: string;
  data: T;
}

interface Row {
  id: number;
  client: string;
  property: string;
  kind: string;
  reason: string;
  exported_on: string;
  imported_at: number;
  source_name: string;
  data: string;
}

function save(kind: "summary" | "drilldown", o: { client: string; property: string; reason: string; exportedOn: string; importedAt: number; sourceName: string; data: unknown }): void {
  db.prepare("DELETE FROM gsc_pages_exports WHERE imported_at < ?").run(o.importedAt - PAGES_EXPORT_RETENTION_DAYS * DAY_MS);
  db.prepare(
    `INSERT INTO gsc_pages_exports (client, property, kind, reason, exported_on, imported_at, source_name, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (client, property, kind, reason, exported_on) DO UPDATE SET imported_at = excluded.imported_at, source_name = excluded.source_name, data = excluded.data`,
  ).run(o.client, o.property, kind, o.reason, o.exportedOn, o.importedAt, o.sourceName, JSON.stringify(o.data));
}

export const saveSummary = (o: { client: string; property: string; exportedOn: string; importedAt: number; sourceName: string; data: SummaryData }) => save("summary", { ...o, reason: "" });
export const saveDrilldown = (o: { client: string; property: string; reason: string; exportedOn: string; importedAt: number; sourceName: string; data: DrilldownData }) => save("drilldown", o);

function fromRow<T>(r: Row): StoredExport<T> | null {
  try {
    return { id: r.id, client: r.client, property: r.property, reason: r.reason, exportedOn: r.exported_on, importedAt: Number(r.imported_at), sourceName: r.source_name, data: JSON.parse(r.data) as T };
  } catch {
    return null;
  }
}

/** The newest imported summary (by export date, then import time), or null. */
export function latestSummary(client: string, property: string): StoredExport<SummaryData> | null {
  const r = db.prepare("SELECT * FROM gsc_pages_exports WHERE client = ? AND property = ? AND kind = 'summary' ORDER BY exported_on DESC, imported_at DESC, id DESC LIMIT 1").get(client, property) as Row | undefined;
  return r ? fromRow<SummaryData>(r) : null;
}

/** The newest imported drilldown per reason. */
export function latestDrilldowns(client: string, property: string): StoredExport<DrilldownData>[] {
  const rows = db
    .prepare(
      `SELECT * FROM gsc_pages_exports d WHERE client = ? AND property = ? AND kind = 'drilldown'
       AND id = (SELECT id FROM gsc_pages_exports e WHERE e.client = d.client AND e.property = d.property AND e.kind = 'drilldown' AND e.reason = d.reason ORDER BY exported_on DESC, imported_at DESC, id DESC LIMIT 1)
       ORDER BY reason`,
    )
    .all(client, property) as unknown as Row[];
  return rows.flatMap((r) => fromRow<DrilldownData>(r) ?? []);
}
