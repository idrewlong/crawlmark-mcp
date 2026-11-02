/**
 * Period resolution for report templates (12.A.2). Pure: `today` is injected.
 * Months and quarters follow monthly_report exactly (previous month, same month
 * last year); other ranges compare with the same length immediately before and
 * the same dates a year earlier.
 */
import { lastCompleteMonth, lastDays, monthRange, previousMonth, previousRange, rangeDays, sameMonthLastYear, type DateRange } from "../../lib/dates.js";
import { customRangeProblems, isRealDate, MAX_SPAN_DAYS, type Comparison, type Period } from "./schema.js";

export interface RunPeriodOverride {
  /** Release 0.5.0: "2025" (a past calendar year) or the current year (year to date). */
  year?: string | undefined;
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

/** The number of whole calendar months a range covers exactly (it starts on a 1st and ends on a month's last day), else null. */
function wholeMonthCount(r: DateRange): number | null {
  if (!r.startDate.endsWith("-01") || r.endDate < r.startDate) return null;
  const [ey, em] = r.endDate.split("-").map(Number) as [number, number];
  if (monthRange(r.endDate.slice(0, 7)).endDate !== r.endDate) return null;
  const [sy, sm] = r.startDate.split("-").map(Number) as [number, number];
  return (ey - sy) * 12 + (em - sm) + 1;
}

/** The calendar year a range covers exactly, if it is one. */
export function wholeYear(r: DateRange): number | undefined {
  const y = r.startDate.slice(0, 4);
  return r.startDate === `${y}-01-01` && r.endDate === `${y}-12-31` ? Number(y) : undefined;
}

/** File-name part for a period (D7): `2026-09`, `2026-q3`, `2025` (a calendar year) or `2026-07-01-to-2026-09-30`. */
export function periodSlug(r: DateRange): string {
  if (isWholeMonth(r)) return r.startDate.slice(0, 7);
  const y = wholeYear(r);
  if (y !== undefined) return String(y);
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

/** A calendar year against the year before (last_year, a past `year` override, year to date in January). */
function yearPeriod(year: number, label = String(year)): ResolvedPeriod {
  const current = { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
  return { current, label, folderMonth: `${year}-12`, comparisons: { previous_year: { startDate: `${year - 1}-01-01`, endDate: `${year - 1}-12-31` } } };
}

/** Year to date: January to the last complete month; in January (no complete month yet) last year in full (C-D1). */
function yearToDatePeriod(today: Date): ResolvedPeriod {
  const y = today.getUTCFullYear();
  const m = lastCompleteMonth(today);
  if (Number(m.slice(0, 4)) < y) return yearPeriod(y - 1, `${y - 1} (full year; no complete month of ${y} yet)`);
  const current = { startDate: `${y}-01-01`, endDate: monthRange(m).endDate };
  return { current, label: `${periodName(current)} (year to date)`, folderMonth: m, comparisons: { previous_year: minusOneYear(current) } };
}

/** The 12 whole months ending with the last complete month. */
function last12MonthsPeriod(today: Date): ResolvedPeriod {
  const m = lastCompleteMonth(today);
  const [y, mm] = m.split("-").map(Number) as [number, number];
  const start = iso(new Date(Date.UTC(y, mm - 12, 1)));
  const current = { startDate: start, endDate: monthRange(m).endDate };
  return { current, label: periodName(current), folderMonth: m, comparisons: { previous_year: minusOneYear(current) } };
}

function rangePeriod(current: DateRange): ResolvedPeriod {
  return { current, label: rangeLabel(current), folderMonth: current.endDate.slice(0, 7), comparisons: { previous_period: previousRange(current), previous_year: minusOneYear(current) } };
}

/**
 * Resolve a template's period, or a run override (`year` | `month` | `quarter` | `startDate`+`endDate`,
 * mutually exclusive), keeping only the comparisons the template asks for. A year-long period's previous period is
 * the previous year, so it only ever has `previous_year` (asked for as either comparison).
 */
export function resolvePeriod(period: Period, compare: readonly Comparison[], override: RunPeriodOverride = {}, today = new Date()): ResolvedPeriod {
  const given = [override.year !== undefined, override.month !== undefined, override.quarter !== undefined, override.startDate !== undefined || override.endDate !== undefined].filter(Boolean).length;
  if (given > 1) throw new PeriodError("Give only one of year, month, quarter, or startDate and endDate.");
  if ((override.startDate === undefined) !== (override.endDate === undefined)) throw new PeriodError("startDate and endDate go together.");

  let p: ResolvedPeriod;
  let yearLong = false;
  if (override.year !== undefined) {
    if (!/^\d{4}$/.test(override.year)) throw new PeriodError(`Year must be YYYY, got "${override.year}".`);
    const year = Number(override.year);
    const thisYear = today.getUTCFullYear();
    if (year > thisYear) throw new PeriodError(`${override.year} hasn't started yet.`);
    p = year === thisYear ? yearToDatePeriod(today) : yearPeriod(year);
    yearLong = true;
  } else if (override.month !== undefined) {
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
  } else if (period.range === "last_year") {
    p = yearPeriod(today.getUTCFullYear() - 1);
    yearLong = true;
  } else if (period.range === "year_to_date") {
    p = yearToDatePeriod(today);
    yearLong = true;
  } else if (period.range === "last_12_months") {
    p = last12MonthsPeriod(today);
    yearLong = true;
  } else {
    p = rangePeriod({ startDate: period.start, endDate: period.end });
  }
  if (rangeDays(p.current) > MAX_SPAN_DAYS) throw new PeriodError(`The period spans more than ${MAX_SPAN_DAYS} days.`);
  const comparisons: ResolvedPeriod["comparisons"] = {};
  if (yearLong) {
    if (compare.length && p.comparisons.previous_year) comparisons.previous_year = p.comparisons.previous_year;
  } else {
    for (const c of compare) if (p.comparisons[c]) comparisons[c] = p.comparisons[c];
  }
  return { ...p, comparisons };
}

/**
 * A period's name for sentences: "August 2026", "Q2 2026", "2025" (a calendar year), "Jan–Oct 2026" or
 * "Nov 2025 – Oct 2026" (4 to 24 whole months), else "1 Jul – 30 Sep 2025".
 */
export function periodName(r: DateRange): string {
  if (isWholeMonth(r)) return monthLabel(r.startDate.slice(0, 7));
  const q = wholeQuarter(r);
  if (q) return `Q${q.q} ${q.year}`;
  const y = wholeYear(r);
  if (y !== undefined) return String(y);
  const n = wholeMonthCount(r);
  if (n !== null && n >= 4 && n <= 24) {
    const [sy, sm] = [r.startDate.slice(0, 4), MONTHS[Number(r.startDate.slice(5, 7)) - 1]];
    const [ey, em] = [r.endDate.slice(0, 4), MONTHS[Number(r.endDate.slice(5, 7)) - 1]];
    return sy === ey ? `${sm}–${em} ${ey}` : `${sm} ${sy} – ${em} ${ey}`;
  }
  return rangeLabel(r);
}
