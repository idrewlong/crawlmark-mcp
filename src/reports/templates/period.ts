/**
 * Period resolution for report templates (12.A.2). Pure: `today` is injected.
 * Months and quarters follow monthly_report exactly (previous month, same month
 * last year); other ranges compare with the same length immediately before and
 * the same dates a year earlier.
 */
import { lastCompleteMonth, lastDays, monthRange, previousMonth, previousRange, rangeDays, sameMonthLastYear, type DateRange } from "../../lib/dates.js";
import { customRangeProblems, isRealDate, MAX_SPAN_DAYS, type Comparison, type Period } from "./schema.js";

export interface RunPeriodOverride {
  month?: string | undefined;
  quarter?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
}

export interface ResolvedPeriod {
  current: DateRange;
  label: string;
  /** YYYY-MM of the period's end date: the folder the report files go in. */
  folderMonth: string;
  comparisons: { previous_period?: DateRange; previous_year?: DateRange };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const iso = (d: Date) => d.toISOString().slice(0, 10);

export class PeriodError extends Error {
  override name = "PeriodError";
}

/** "2026-Q3" → { year: 2026, q: 3 }. */
export function parseQuarter(s: string): { year: number; q: number } {
  const m = /^(\d{4})-Q([1-4])$/i.exec(s.trim());
  if (!m) throw new PeriodError(`Quarter must be YYYY-Qn (e.g. 2026-Q3), got "${s}".`);
  return { year: Number(m[1]), q: Number(m[2]) };
}

export function quarterRange(year: number, q: number): DateRange {
  const startMonth = (q - 1) * 3;
  return { startDate: iso(new Date(Date.UTC(year, startMonth, 1))), endDate: iso(new Date(Date.UTC(year, startMonth + 3, 0))) };
}

/** The last complete calendar quarter on `today`. */
export function lastCompleteQuarter(today = new Date()): { year: number; q: number } {
  const q = Math.floor(today.getUTCMonth() / 3) + 1;
  return q === 1 ? { year: today.getUTCFullYear() - 1, q: 4 } : { year: today.getUTCFullYear(), q: q - 1 };
}

/** The same dates one year earlier; 29 Feb becomes 28 Feb. */
export function minusOneYear(r: DateRange): DateRange {
  const shift = (s: string) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    const lastDay = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
    return iso(new Date(Date.UTC(y - 1, m - 1, Math.min(d, lastDay))));
  };
  return { startDate: shift(r.startDate), endDate: shift(r.endDate) };
}

const dayLabel = (s: string, withYear: boolean) => {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
};

/** "1–30 Sep 2026", "1 Jul – 30 Sep 2026", or "15 Dec 2025 – 14 Jan 2026" across a year boundary. */
export function rangeLabel(r: DateRange): string {
  const sameYear = r.startDate.slice(0, 4) === r.endDate.slice(0, 4);
  if (sameYear && r.startDate.slice(0, 7) === r.endDate.slice(0, 7)) return `${Number(r.startDate.slice(8, 10))}–${dayLabel(r.endDate, true)}`;
  return `${dayLabel(r.startDate, !sameYear)} – ${dayLabel(r.endDate, true)}`;
}

export const monthLabel = (month: string) => `${LONG_MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** True when the range is exactly one calendar month. */
export function isWholeMonth(r: DateRange): boolean {
  return r.startDate.endsWith("-01") && monthRange(r.startDate.slice(0, 7)).endDate === r.endDate;
}

/** The quarter a range covers exactly, if it is one. */
export function wholeQuarter(r: DateRange): { year: number; q: number } | undefined {
  const [y, m] = r.startDate.split("-").map(Number) as [number, number];
  if (!r.startDate.endsWith("-01") || (m - 1) % 3 !== 0) return undefined;
  const q = (m - 1) / 3 + 1;
  return quarterRange(y, q).endDate === r.endDate ? { year: y, q } : undefined;
}

/** File-name part for a period (D7): `2026-09`, `2026-q3` or `2026-07-01-to-2026-09-30`. */
export function periodSlug(r: DateRange): string {
  if (isWholeMonth(r)) return r.startDate.slice(0, 7);
  const q = wholeQuarter(r);
  if (q) return `${q.year}-q${q.q}`;
  return `${r.startDate}-to-${r.endDate}`;
}

function monthPeriod(month: string, label = monthLabel(month)): ResolvedPeriod {
  return {
    current: monthRange(month),
    label,
    folderMonth: month,
    comparisons: { previous_period: monthRange(previousMonth(month)), previous_year: monthRange(sameMonthLastYear(month)) },
  };
}

function quarterPeriod(year: number, q: number): ResolvedPeriod {
  const current = quarterRange(year, q);
  const prev = q === 1 ? quarterRange(year - 1, 4) : quarterRange(year, q - 1);
  return { current, label: `Q${q} ${year}`, folderMonth: current.endDate.slice(0, 7), comparisons: { previous_period: prev, previous_year: quarterRange(year - 1, q) } };
}

function rangePeriod(current: DateRange): ResolvedPeriod {
  return { current, label: rangeLabel(current), folderMonth: current.endDate.slice(0, 7), comparisons: { previous_period: previousRange(current), previous_year: minusOneYear(current) } };
}

/**
 * Resolve a template's period, or a run override (`month` | `quarter` | `startDate`+`endDate`,
 * mutually exclusive), keeping only the comparisons the template asks for.
 */
export function resolvePeriod(period: Period, compare: readonly Comparison[], override: RunPeriodOverride = {}, today = new Date()): ResolvedPeriod {
  const given = [override.month !== undefined, override.quarter !== undefined, override.startDate !== undefined || override.endDate !== undefined].filter(Boolean).length;
  if (given > 1) throw new PeriodError("Give only one of month, quarter, or startDate and endDate.");
  if ((override.startDate === undefined) !== (override.endDate === undefined)) throw new PeriodError("startDate and endDate go together.");

  let p: ResolvedPeriod;
  if (override.month !== undefined) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(override.month)) throw new PeriodError(`Month must be YYYY-MM, got "${override.month}".`);
    // A month on a quarter (or other) template makes it a one-month report; the label says so.
    const oneMonth = period.range !== "last_month";
    p = monthPeriod(override.month, oneMonth ? `${monthLabel(override.month)} (one month)` : undefined);
  } else if (override.quarter !== undefined) {
    const { year, q } = parseQuarter(override.quarter);
    p = quarterPeriod(year, q);
  } else if (override.startDate !== undefined && override.endDate !== undefined) {
    for (const d of [override.startDate, override.endDate]) if (!isRealDate(d)) throw new PeriodError(`Dates must be real YYYY-MM-DD dates, got "${d}".`);
    const problems = customRangeProblems(override.startDate, override.endDate, today);
    if (problems.length) throw new PeriodError(`Invalid period: ${problems.join("; ")}.`);
    p = rangePeriod({ startDate: override.startDate, endDate: override.endDate });
  } else if (period.range === "last_month") {
    p = monthPeriod(lastCompleteMonth(today));
  } else if (period.range === "last_quarter") {
    const { year, q } = lastCompleteQuarter(today);
    p = quarterPeriod(year, q);
  } else if (period.range === "last_n_days") {
    p = rangePeriod(lastDays(period.days, 3, today));
  } else {
    p = rangePeriod({ startDate: period.start, endDate: period.end });
  }
  if (rangeDays(p.current) > MAX_SPAN_DAYS) throw new PeriodError(`The period spans more than ${MAX_SPAN_DAYS} days.`);
  const comparisons: ResolvedPeriod["comparisons"] = {};
  for (const c of compare) if (p.comparisons[c]) comparisons[c] = p.comparisons[c];
  return { ...p, comparisons };
}

/** A comparison period's name for sentences: "August 2026", "Q2 2026" or "1 Jul – 30 Sep 2025". */
export function periodName(r: DateRange): string {
  if (isWholeMonth(r)) return monthLabel(r.startDate.slice(0, 7));
  const q = wholeQuarter(r);
  return q ? `Q${q.q} ${q.year}` : rangeLabel(r);
}
