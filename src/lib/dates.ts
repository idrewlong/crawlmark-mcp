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
