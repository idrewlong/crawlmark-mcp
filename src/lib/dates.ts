/** Date helpers. All ranges are inclusive YYYY-MM-DD strings. */

export interface DateRange {
  startDate: string;
  endDate: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** "2026-09" → { startDate: "2026-09-01", endDate: "2026-09-30" } */
export function monthRange(month: string): DateRange {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`Month must be YYYY-MM, got "${month}"`);
  const year = Number(match[1]);
  const m = Number(match[2]) - 1;
  return {
    startDate: iso(new Date(Date.UTC(year, m, 1))),
    endDate: iso(new Date(Date.UTC(year, m + 1, 0))),
  };
}

export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 2, 1));
  return d.toISOString().slice(0, 7);
}

export function sameMonthLastYear(month: string): string {
  const [y, m] = month.split("-");
  return `${Number(y) - 1}-${m}`;
}

/** The last fully completed month, e.g. on 2026-10-12 → "2026-09". */
export function lastCompleteMonth(today = new Date()): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

/**
 * The last `days` days of Search Console data, ending `lagDays` before today
 * (GSC data lags ~2-3 days). On 2026-10-12, lastDays(28) is 2026-09-12..2026-10-09.
 */
export function lastDays(days: number, lagDays = 3, today = new Date()): DateRange {
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - lagDays));
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { startDate: iso(start), endDate: iso(end) };
}

const MS_DAY = 86_400_000;
const parseDay = (s: string) => Date.parse(`${s}T00:00:00Z`);

/** Number of days in an inclusive range. */
export function rangeDays(r: DateRange): number {
  return Math.round((parseDay(r.endDate) - parseDay(r.startDate)) / MS_DAY) + 1;
}

/** The range of equal length ending the day before `r` starts. */
export function previousRange(r: DateRange): DateRange {
  const days = rangeDays(r);
  const end = parseDay(r.startDate) - MS_DAY;
  return { startDate: iso(new Date(end - (days - 1) * MS_DAY)), endDate: iso(new Date(end)) };
}
