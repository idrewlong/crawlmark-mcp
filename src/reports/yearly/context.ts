/**
 * Release 0.5.0 (C5): what a yearly section's fetcher gets from runTemplate. One module per section type
 * (channel-yoy, page-groups, content-by-year, wins-misses), each `(spec, ctx) => Promise<Data>`; they throw
 * SectionUnavailableError (from ../templates/run.js) when the section can't be shown. Report notes go through
 * `ctx.note`, so they land in "About this report" like every other note.
 */
import type { Client } from "../../lib/clients.js";
import type { DateRange } from "../../lib/dates.js";
import type { GscCoverage } from "../../lib/gsc-coverage.js";
import type { PeriodTotals } from "../report-types.js";
import type { ResolvedPeriod } from "../templates/period.js";
import type { RunDeps } from "../templates/run.js";

export interface YearlyCtx {
  client: Client;
  deps: RunDeps;
  /** The run's clock (opts.today ?? new Date()). */
  today: Date;
  /** The period as resolved, with every comparison the template asked for (GA4 uses it). */
  period: ResolvedPeriod;
  /** The same period with only the comparisons Search Console can answer in full (the coverage guard, C2). */
  gscPeriod: ResolvedPeriod;
  /** Search Console coverage of a range on the run's clock: "google", "stored" (saved monthly history) or incomplete. */
  coverage(r: DateRange): GscCoverage;
  /** The run's memo: one fetch per key across every section (yearly keys use their own prefixes, e.g. `wp:` / `wq:`). */
  once<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Search Console totals for a range (memoised with the other sections'). */
  totals(r: DateRange): Promise<PeriodTotals>;
  /** Add a report note ("About this report"); duplicates are dropped. */
  note(n: string): void;
}
