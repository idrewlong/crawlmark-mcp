import { db } from "./store.js";

/**
 * Tool-call usage log: one row per call (tool, client, duration, ok, error class).
 * Arguments other than the client are never stored.
 */

export interface ToolCallRow {
  tool: string;
  client: string | null;
  durationMs: number;
  ok: boolean;
  errorClass: string | null;
  ts: number;
}

const insert = db.prepare("INSERT INTO tool_calls (tool, client, duration_ms, ok, error_class, ts) VALUES (?, ?, ?, ?, ?, ?)");
const since = db.prepare(
  "SELECT tool, client, duration_ms AS durationMs, ok, error_class AS errorClass, ts FROM tool_calls WHERE ts >= ? ORDER BY ts",
);

const purge = db.prepare("DELETE FROM tool_calls WHERE ts < ?");

export function recordToolCall(row: ToolCallRow): void {
  insert.run(row.tool, row.client, Math.round(row.durationMs), row.ok ? 1 : 0, row.errorClass, row.ts);
}

/** Usage rows are kept this long; purge_cache deletes older ones. */
export const USAGE_RETENTION_DAYS = 365;

/** Delete usage rows older than USAGE_RETENTION_DAYS. Returns the number removed. */
export function purgeOldToolCalls(now = Date.now()): number {
  return Number(purge.run(now - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000).changes);
}

export function toolCallsSince(ts: number): ToolCallRow[] {
  return (since.all(ts) as Array<Omit<ToolCallRow, "ok"> & { ok: number }>).map((r) => ({ ...r, ok: r.ok === 1 }));
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export interface ToolUsage {
  tool: string;
  calls: number;
  errors: number;
  /** errors / calls, 0..1, rounded to 3 places. */
  errorRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Error count per error class (TimeoutError, UrlRefusedError, ...). */
  errorClasses: Record<string, number>;
}

/** Per-tool counts, error rates and p50/p95 durations, busiest tool first. Pure. */
export function summarizeUsage(rows: ToolCallRow[]): ToolUsage[] {
  const byTool = new Map<string, ToolCallRow[]>();
  for (const r of rows) {
    const list = byTool.get(r.tool);
    if (list) list.push(r);
    else byTool.set(r.tool, [r]);
  }
  return [...byTool.entries()]
    .map(([tool, rs]) => {
      const durations = rs.map((r) => r.durationMs).sort((a, b) => a - b);
      const errors = rs.filter((r) => !r.ok);
      const errorClasses: Record<string, number> = {};
      for (const e of errors) {
        const k = e.errorClass ?? "Error";
        errorClasses[k] = (errorClasses[k] ?? 0) + 1;
      }
      return {
        tool,
        calls: rs.length,
        errors: errors.length,
        errorRate: Math.round((errors.length / rs.length) * 1000) / 1000,
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
        errorClasses,
      };
    })
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}
