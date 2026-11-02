/**
 * Release 0.5.0 (C2): can Search Console answer a date range in full? Google keeps 16 months (to the day); older
 * ranges are answered only from saved monthly history, and only when every whole month is saved. Anything else is
 * incomplete, and the report leaves that range out with a note instead of showing Google's partial numbers.
 * The provider (src/providers/gsc.ts fromHistory) uses the same window, so "stored" here means it reads history.
 */
import type { Client } from "../config.js";
import type { DateRange } from "./dates.js";
import { storedMonths, wholeMonths, windowStart } from "./gsc-monthly.js";
import { periodName } from "../reports/templates/period.js";

export type GscCoverage =
  | { complete: true; source: "google" | "stored" }
  | { complete: false; missingMonths: string[]; reason: "partial_window" | "not_whole_months" };

/** YYYY-MM of every month a range touches, oldest first. */
function monthsTouched(r: DateRange): string[] {
  const out: string[] = [];
  let [y, m] = r.startDate.split("-").map(Number) as [number, number];
  const end = r.endDate.slice(0, 7);
  for (let guard = 0; guard < 600; guard++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) break;
    out.push(key);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * `now` is epoch ms: the run's clock (opts.today ?? new Date()), never Date.now() directly, so tests stay stable as
 * the calendar moves.
 */
export function gscRangeCoverage(c: Pick<Client, "slug" | "gscProperty">, range: DateRange, now: number): GscCoverage {
  const start = windowStart(now);
  if (range.startDate >= start) return { complete: true, source: "google" };
  const stored = c.gscProperty ? new Set(storedMonths(c.slug, c.gscProperty)) : new Set<string>();
  const whole = wholeMonths(range);
  // A month that starts before the window can't come from Google in full.
  const beforeWindow = monthsTouched(range).filter((m) => `${m}-01` < start);
  if (!whole) return { complete: false, missingMonths: beforeWindow, reason: "not_whole_months" };
  if (whole.every((m) => stored.has(m))) return { complete: true, source: "stored" };
  const missing = beforeWindow.filter((m) => !stored.has(m));
  // The history path needs every month of the range, including ones inside the window that weren't saved.
  return { complete: false, missingMonths: missing.length ? missing : whole.filter((m) => !stored.has(m)), reason: "partial_window" };
}

/** The report note for a comparison that is left out. */
export function coverageNote(r: DateRange, cov: Extract<GscCoverage, { complete: false }>): string {
  const first = cov.missingMonths[0];
  const last = cov.missingMonths[cov.missingMonths.length - 1];
  const span = first === last ? (first ?? "") : `${first}…${last}`;
  return `Search Console: ${periodName(r)} is older than Google's 16 months and the saved history doesn't cover ${span}; that comparison is left out.`;
}
