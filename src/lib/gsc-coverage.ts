/**
 * Release 0.5.0 (C2): can Search Console answer a date range in full? Google keeps 16 months (to the day); older
 * ranges are answered only from saved monthly history, and only when every whole month is saved. Anything else is
 * incomplete, and the report leaves that range out with a note instead of showing Google's partial numbers.
 * The provider (src/providers/gsc.ts fromHistory) uses the same window, so "stored" here means it reads history.
 */
import type { Client } from "../config.js";
import type { DateRange } from "./dates.js";
import { storedMonths, wholeMonths, windowStart } from "./gsc-monthly.js";
import { monthSpanLabel, periodName } from "../reports/templates/period.js";
import { monthRange } from "./dates.js";

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

/**
 * Release 0.5.0 (C2a, user decision C-D6): the part of an incomplete current range Search Console can answer in full,
 * from one source: what its sections show instead, labelled, with no comparison.
 */
export interface GscPartial {
  /** The period's current range. */
  requested: DateRange;
  /** What Search Console sections use instead. */
  range: DateRange;
  /** One source for the whole partial range (what the provider will actually do). */
  source: "google" | "stored";
  /** YYYY-MM covered, oldest first. */
  months: string[];
  /** YYYY-MM of the requested range left out, oldest first. */
  missing: string[];
  /** monthSpanLabel(range), e.g. "Jul–Dec 2025". */
  label: string;
}

/** The YYYY-MM after a YYYY-MM. */
const nextMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/**
 * C2a: for a current range Search Console can't answer in full, the longest run of whole months ending at the range's
 * end that one source answers in full, or null when there is none (the sections are then unavailable, C2).
 * Two candidates, the earlier start wins and Google wins ties (it has daily rows):
 * - Google: from the first month that starts on or after Google's window start, to the range's own end day.
 * - Saved history (whole-month ranges only): the saved months walking back from the range's last month, stopping at
 *   the first month that isn't saved (a gap is never bridged).
 * `now` is the run's clock, as for gscRangeCoverage.
 */
export function gscPartialRange(c: Pick<Client, "slug" | "gscProperty">, range: DateRange, now: number): GscPartial | null {
  if (gscRangeCoverage(c, range, now).complete) return null;
  const start = windowStart(now);
  const firstWhole = start.endsWith("-01") ? start : `${nextMonth(start.slice(0, 7))}-01`;
  const google: DateRange | null = firstWhole <= range.endDate && firstWhole > range.startDate ? { startDate: firstWhole, endDate: range.endDate } : null;

  let stored: DateRange | null = null;
  const whole = wholeMonths(range);
  if (whole && c.gscProperty) {
    const have = new Set(storedMonths(c.slug, c.gscProperty));
    let i = whole.length;
    while (i > 0 && have.has(whole[i - 1]!)) i -= 1;
    if (i < whole.length) stored = { startDate: `${whole[i]!}-01`, endDate: monthRange(whole.at(-1)!).endDate };
  }

  const pick: { range: DateRange; source: "google" | "stored" } | null =
    google && (!stored || google.startDate <= stored.startDate) ? { range: google, source: "google" } : stored ? { range: stored, source: "stored" } : null;
  if (!pick) return null;
  const months = monthsTouched(pick.range);
  const covered = new Set(months);
  return {
    requested: range,
    range: pick.range,
    source: pick.source,
    months,
    missing: monthsTouched(range).filter((m) => !covered.has(m)),
    label: monthSpanLabel(pick.range),
  };
}

/** `2025-01…2025-06`, or the month once. */
const monthSpan = (months: readonly string[]) => {
  const first = months[0] ?? "";
  const last = months[months.length - 1] ?? "";
  return first === last ? first : `${first}…${last}`;
};

/** C2a: the report note for a labelled partial range. */
export function partialNote(p: Pick<GscPartial, "label" | "missing">): string {
  return `Search Console: ${p.label} only. Google keeps 16 months of data and the saved history doesn't cover ${monthSpan(p.missing)}, so Search Console figures cover ${p.label} and aren't compared with an earlier period.`;
}

/** C2a: why a section that needs a comparison is unavailable on a labelled partial range. */
export function partialNoComparisonReason(label: string): string {
  return `Search Console covers only ${label} of this period, so there's nothing to compare with (Google keeps 16 months)`;
}
