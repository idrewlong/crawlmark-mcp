/**
 * Release A / D5: monthly Search Console snapshots. Google keeps 16 months of Search Analytics data; every month
 * crawlmark doesn't save is lost for good, so this stores one month at a time (raw numbers: no query exclusions,
 * no hostname scope) in the gsc_monthly table, plus one `excluded` row with the exclusions' share at capture time (its key is the exclusion regex used).
 *
 * fillGscMonths fetches the missing months through an injected gscQuery (so tests use no network), paces its
 * requests, backs off on quota errors, stops cleanly when Google refuses, and stores month by month, so a
 * stopped backfill is simply run again and carries on where it ended.
 */
import type { Client } from "../config.js";
import type { GscRow, gscQuery as gscQueryFn } from "../providers/gsc.js";
import { mapLimit } from "./concurrency.js";
import { monthRange } from "./dates.js";
import { exclusionRegex } from "./gsc-exclusions.js";
import { apiErrorInfo } from "./gtm.js";
import { createLimiter } from "./rate.js";
import { db } from "./store.js";

/** Rows kept per month. */
export const GSC_TOP_N = { page: 250, query: 250, country: 50 } as const;
/** Google keeps this many months of Search Analytics data. */
export const GSC_HISTORY_MONTHS = 16;

export type GscMonthlyKind = "totals" | "excluded" | "page" | "query" | "device" | "country";

const MS_DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const monthKey = (y: number, m0: number) => {
  const d = new Date(Date.UTC(y, m0, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};

/** Search Console data lags about this many days after a month's last day. */
const LAG_DAYS = 3;

/**
 * Complete months that are at least 3 days past their last day (Search Console's data lag), newest first,
 * as YYYY-MM. `now` is epoch milliseconds.
 */
export function capturableMonths(now: number, max: number = GSC_HISTORY_MONTHS): string[] {
  const d = new Date(now);
  const out: string[] = [];
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  // Walk back from the current month; a month is capturable once it's LAG_DAYS past its last day.
  for (let guard = 0; out.length < max && guard < 600; guard++, m--) {
    if (m < 0) {
      m += 12;
      y -= 1;
    }
    const firstOfNext = Date.UTC(y, m + 1, 1);
    if (now >= firstOfNext + (LAG_DAYS - 1) * MS_DAY) out.push(monthKey(y, m));
  }
  return out;
}

/** The first day of the month that is 16 months before the current UTC month: ranges starting before it are "older than Google's window". */
export function historyCutoff(now: number): string {
  const d = new Date(now);
  return `${monthKey(d.getUTCFullYear(), d.getUTCMonth() - GSC_HISTORY_MONTHS)}-01`;
}

/** Today minus 16 months (UTC, YYYY-MM-DD): the earliest day Google can still return. */
export function windowStart(now: number): string {
  const d = new Date(now);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() - GSC_HISTORY_MONTHS;
  const y = Math.floor(total / 12);
  const m0 = total % 12;
  const day = Math.min(d.getUTCDate(), new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate());
  return `${y}-${pad(m0 + 1)}-${pad(day)}`;
}

/** The months a range covers when it starts on a first day and ends on a last day of a month (at most `max`), else null. */
export function wholeMonths(range: { startDate: string; endDate: string }, max = 36): string[] | null {
  if (!/^\d{4}-\d{2}-01$/.test(range.startDate) || range.endDate < range.startDate) return null;
  const out: string[] = [];
  let month = range.startDate.slice(0, 7);
  while (out.length <= max) {
    const r = monthRange(month);
    out.push(month);
    if (r.endDate === range.endDate) return out;
    if (r.endDate > range.endDate) return null;
    const [y, m] = month.split("-").map(Number);
    month = monthKey(y!, m!);
  }
  return null;
}

// ----------------------------------------------------------------------------------------------- storage

export interface StoredMonthSummary {
  month: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  complete: boolean;
  capturedAt: number;
}

/** Months with a stored totals row, newest first. */
export function storedMonths(client: string, property: string): string[] {
  return (
    db.prepare("SELECT month FROM gsc_monthly WHERE client = ? AND property = ? AND kind = 'totals' ORDER BY month DESC").all(client, property) as {
      month: string;
    }[]
  ).map((r) => r.month);
}

/** The stored totals of every month, newest first (at most `limit`). */
export function storedSummary(client: string, property: string, limit = 60): StoredMonthSummary[] {
  const rows = db
    .prepare(
      "SELECT month, clicks, impressions, ctr, position, complete, captured_at FROM gsc_monthly WHERE client = ? AND property = ? AND kind = 'totals' ORDER BY month DESC LIMIT ?",
    )
    .all(client, property, limit) as { month: string; clicks: number; impressions: number; ctr: number; position: number; complete: number; captured_at: number }[];
  return rows.map((r) => ({ month: r.month, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, complete: r.complete === 1, capturedAt: r.captured_at }));
}

export interface MonthToSave {
  client: string;
  property: string;
  month: string;
  complete: boolean;
  capturedAt: number;
  totals: GscRow;
  excluded?: { clicks: number; impressions: number } | undefined;
  /** The exclusion regex `excluded` was computed with; stored as the key of the `excluded` row so a later read can tell whether it still matches the client's exclusions. */
  exclusionRegex?: string | undefined;
  pages: GscRow[];
  queries: GscRow[];
  devices: GscRow[];
  countries: GscRow[];
}

const pct = (clicks: number, impressions: number) => (impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0);

/** Replace one month: a single transaction, no await inside (the table never holds half a month). */
export function saveMonth(m: MonthToSave): void {
  const insert = db.prepare(
    "INSERT OR REPLACE INTO gsc_monthly (client, property, month, kind, key, clicks, impressions, ctr, position, complete, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const complete = m.complete ? 1 : 0;
  const put = (kind: GscMonthlyKind, key: string, r: { clicks: number; impressions: number; ctr: number; position: number }) =>
    insert.run(m.client, m.property, m.month, kind, key, Math.round(r.clicks), Math.round(r.impressions), r.ctr, r.position, complete, m.capturedAt);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM gsc_monthly WHERE client = ? AND property = ? AND month = ?").run(m.client, m.property, m.month);
    put("totals", "", m.totals);
    if (m.excluded) put("excluded", m.exclusionRegex ?? "", { clicks: m.excluded.clicks, impressions: m.excluded.impressions, ctr: pct(m.excluded.clicks, m.excluded.impressions), position: 0 });
    for (const r of m.pages.slice(0, GSC_TOP_N.page)) put("page", r.keys[0] ?? "", r);
    for (const r of m.queries.slice(0, GSC_TOP_N.query)) put("query", r.keys[0] ?? "", r);
    for (const r of m.devices) put("device", r.keys[0] ?? "", r);
    for (const r of m.countries.slice(0, GSC_TOP_N.country)) put("country", r.keys[0] ?? "", r);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Stored rows of one kind, by month. Months with no rows of that kind are absent from the map. */
export function readMonths(client: string, property: string, months: string[], kind: GscMonthlyKind): Map<string, GscRow[]> {
  const out = new Map<string, GscRow[]>();
  if (!months.length) return out;
  const rows = db
    .prepare(
      `SELECT month, key, clicks, impressions, ctr, position FROM gsc_monthly WHERE client = ? AND property = ? AND kind = ? AND month IN (${months.map(() => "?").join(",")}) ORDER BY month, clicks DESC, key`,
    )
    .all(client, property, kind, ...months) as { month: string; key: string; clicks: number; impressions: number; ctr: number; position: number }[];
  for (const r of rows) {
    const list = out.get(r.month) ?? [];
    list.push({ keys: r.key === "" ? [] : [r.key], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
    out.set(r.month, list);
  }
  return out;
}

/** Sum rows with the same keys: clicks and impressions add up, ctr is recomputed, position is the impressions-weighted mean. Sorted by clicks. */
export function mergeRows(rows: readonly GscRow[]): GscRow[] {
  const by = new Map<string, { keys: string[]; clicks: number; impressions: number; weighted: number }>();
  for (const r of rows) {
    const k = r.keys.join("\u0000");
    const a = by.get(k) ?? { keys: r.keys, clicks: 0, impressions: 0, weighted: 0 };
    a.clicks += r.clicks;
    a.impressions += r.impressions;
    a.weighted += r.position * r.impressions;
    by.set(k, a);
  }
  return [...by.values()]
    .map((a) => ({
      keys: a.keys,
      clicks: a.clicks,
      impressions: a.impressions,
      ctr: pct(a.clicks, a.impressions),
      position: a.impressions > 0 ? Number((a.weighted / a.impressions).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

// -------------------------------------------------------------------------------------------------- fill

export interface FillOptions {
  /** Most months fetched in this call. */
  max: number;
  /** Fetch months that are already stored too (a partial month is never replaced by less data). */
  refresh?: boolean;
  /** Newest missing month first (reports); default oldest first (the oldest is the next one Google drops). */
  newestFirst?: boolean;
  /** Only the most recent N capturable months count (default 16). */
  window?: number;
  signal?: AbortSignal | undefined;
}

export interface FillDeps {
  gscQuery: typeof gscQueryFn;
  now: () => number;
  /** Pause between retries and requests (tests inject an instant one). */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface FillResult {
  stored: string[];
  skipped: string[];
  failed: { month: string; error: string }[];
}

/** Waits before each retry of a rate-limited request (about 15 s in all, with jitter). */
const RETRY_WAITS_MS = [1000, 2000, 4000, 8000];
/** Search Console allows 1,200 queries a minute per site; stay far below it. */
const REQUEST_SPACING_MS = 150;
const MONTH_CONCURRENCY = 2;

/**
 * What a Search Console error means for a backfill: `daily` (the day's quota is used up), `rate` (slow down: retry),
 * `access` (401/403: stop), `setup` (Google isn't configured or signed in: every month would fail the same way, stop),
 * else `other`. Same rules as inspectionErrorKind in providers/gsc.ts, kept here so this
 * module (and the CLI) don't load the Google client just to classify an error.
 */
export function gscErrorKind(err: unknown): "daily" | "rate" | "access" | "setup" | "other" {
  // Matched by name/message so this module doesn't import the Google client (GoogleNotConfiguredError, noTokenMessage).
  const raw = err as { name?: string; message?: string } | null;
  if (raw?.name === "GoogleNotConfiguredError" || /^(Google isn't set up|Not signed in to Google)/.test(raw?.message ?? "")) return "setup";
  const info = apiErrorInfo(err);
  const text = `${info.message} ${(err as { message?: string } | null)?.message ?? ""} ${info.reasons.join(" ")}`;
  if (info.status === 429 || /RESOURCE_EXHAUSTED|quotaExceeded|rateLimitExceeded|dailyLimitExceeded|quota exceeded/i.test(text)) {
    return /per day|daily|perDay/i.test(text) ? "daily" : "rate";
  }
  return info.status === 401 || info.status === 403 ? "access" : "other";
}

const realSleep =(ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * MS_DAY).toISOString().slice(0, 10);
}

/**
 * Fetch and store up to `max` missing capturable months. Errors per month are returned, not thrown. A quota, access or
 * setup (not configured or signed in) refusal stops new months (they come back in `failed` as not attempted); nothing already
 * stored is lost, and running it again resumes with the months still missing.
 */
export async function fillGscMonths(client: Client, o: FillOptions, deps: FillDeps): Promise<FillResult> {
  const property = client.gscProperty;
  if (!property) throw new Error(`No Search Console property found for ${client.domain}, so there is no history to save.`);
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const now = deps.now();
  const items = client.gscExcludeQueries ?? [];
  const exclRe = exclusionRegex(items);

  const capturable = capturableMonths(now, Math.min(o.window ?? GSC_HISTORY_MONTHS, GSC_HISTORY_MONTHS));
  const have = new Set(storedMonths(client.slug, property));
  const result: FillResult = { stored: [], skipped: [], failed: [] };
  const wanted = capturable.filter((m) => o.refresh || !have.has(m));
  if (!o.refresh) result.skipped.push(...capturable.filter((m) => have.has(m)));
  const ordered = o.newestFirst ? wanted : [...wanted].reverse();
  const todo = ordered.slice(0, Math.max(0, o.max));

  const limiter = createLimiter({ maxInFlight: MONTH_CONCURRENCY, minSpacingMs: REQUEST_SPACING_MS, sleep, now: () => performance.now() });
  const windowFrom = windowStart(now);
  let stopped: string | null = null;

  /** One request: paced, and retried with backoff while Google says "slow down". */
  const request = (opts: Parameters<typeof gscQueryFn>[1]) =>
    limiter.run(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await deps.gscQuery(client, opts);
        } catch (err) {
          if (gscErrorKind(err) !== "rate" || attempt >= RETRY_WAITS_MS.length) throw err;
          await sleep(Math.round(RETRY_WAITS_MS[attempt]! * (0.75 + random() * 0.5)));
        }
      }
    });

  const fetchMonth = async (month: string, startDate: string, endDate: string, complete: boolean) => {
    const base = { startDate, endDate, includeExcludedQueries: true, live: true, ...(o.refresh ? { refresh: true } : {}) };
    const totalsRows = await request({ ...base, dimensions: [], rowLimit: 1 });
    const pages = await request({ ...base, dimensions: ["page"], rowLimit: GSC_TOP_N.page });
    const queries = await request({ ...base, dimensions: ["query"], rowLimit: GSC_TOP_N.query });
    const devices = await request({ ...base, dimensions: ["device"], rowLimit: 10 });
    const countries = await request({ ...base, dimensions: ["country"], rowLimit: GSC_TOP_N.country });
    let excluded: { clicks: number; impressions: number } | undefined;
    if (exclRe) {
      const [row] = await request({ ...base, dimensions: [], rowLimit: 1, queryRegex: exclRe });
      excluded = { clicks: row?.clicks ?? 0, impressions: row?.impressions ?? 0 };
    }
    const totals = totalsRows[0] ?? { keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 };
    return { month, complete, totals, excluded, ...(excluded && exclRe ? { exclusionRegex: exclRe } : {}), pages, queries, devices, countries };
  };

  await mapLimit(todo, MONTH_CONCURRENCY, async (month) => {
    if (stopped !== null || o.signal?.aborted) {
      result.failed.push({ month, error: `not attempted: ${stopped ?? "cancelled"}` });
      return;
    }
    const range = monthRange(month);
    const partial = range.startDate < windowFrom;
    try {
      let startDate = partial ? windowFrom : range.startDate;
      if (startDate > range.endDate) {
        // The whole month is already beyond what Google keeps.
        result.skipped.push(month);
        return;
      }
      let data;
      try {
        data = await fetchMonth(month, startDate, range.endDate, !partial);
      } catch (err) {
        // The edge of the window is fuzzy: a rejected start date on a partial month is retried a few days later.
        if (!partial || apiErrorInfo(err).status !== 400) throw err;
        startDate = addDays(startDate, 3);
        if (startDate > range.endDate) throw err;
        data = await fetchMonth(month, startDate, range.endDate, false);
      }
      if (partial && have.has(month)) {
        const old = db.prepare("SELECT impressions FROM gsc_monthly WHERE client = ? AND property = ? AND month = ? AND kind = 'totals'").get(client.slug, property, month) as
          | { impressions: number }
          | undefined;
        // Google has dropped more of this month since it was saved: keep the fuller copy.
        if (old && old.impressions >= data.totals.impressions) {
          result.skipped.push(month);
          return;
        }
      }
      saveMonth({ client: client.slug, property, capturedAt: deps.now(), ...data });
      result.stored.push(month);
    } catch (err) {
      const kind = gscErrorKind(err);
      if (kind === "daily" || kind === "rate" || kind === "access") stopped = `Search Console stopped answering at ${month} (${errText(err)})`;
      else if (kind === "setup") stopped = errText(err);
      result.failed.push({ month, error: errText(err) });
    }
  });

  const order = (a: string, b: string) => b.localeCompare(a);
  result.stored.sort(order);
  result.skipped.sort(order);
  result.failed.sort((a, b) => order(a.month, b.month));
  return result;
}

// ------------------------------------------------------------------------------------------------- view

export type HistoryDetail = "pages" | "queries" | "devices" | "countries";
const DETAIL_KIND: Record<HistoryDetail, GscMonthlyKind> = { pages: "page", queries: "query", devices: "device", countries: "country" };

/** What gsc_history shows: the stored months, and optionally one month's stored rows. Raw numbers (no exclusions). */
export function gscHistoryView(
  client: { slug: string; gscProperty?: string | undefined },
  o: { month?: string | undefined; detail?: readonly HistoryDetail[] | undefined; limit: number },
): { stored: StoredMonthSummary[]; detail?: Record<HistoryDetail, GscRow[]>; notes: string[] } {
  const property = client.gscProperty ?? "";
  const stored = storedSummary(client.slug, property, 200);
  const notes: string[] = [];
  if (!stored.length) notes.push("Nothing is saved yet. Call gsc_history with backfill: true to save the months Google still has (it keeps 16; older months can't be recovered).");
  if (stored.some((s) => !s.complete)) notes.push("A month marked complete: false was saved after Google had already dropped its first days, so it is partial.");
  notes.push("Stored numbers are raw Search Console figures; a client's gscExcludeQueries are applied to saved query rows when a report reads them. Saved totals are adjusted only for months saved under the same exclusions; otherwise they are read raw, with a note.");
  const out: { stored: StoredMonthSummary[]; detail?: Record<HistoryDetail, GscRow[]>; notes: string[] } = { stored, notes };
  if (o.detail?.length) {
    const month = o.month ?? stored[0]?.month;
    if (!month || !stored.some((s) => s.month === month)) {
      notes.push(`Month ${month ?? "(none)"} isn't saved, so there is no detail to show.`);
    } else {
      const detail = { pages: [], queries: [], devices: [], countries: [] } as Record<HistoryDetail, GscRow[]>;
      for (const d of o.detail) detail[d] = (readMonths(client.slug, property, [month], DETAIL_KIND[d]).get(month) ?? []).slice(0, o.limit);
      out.detail = detail;
      notes.push(`Detail is for ${month}.`);
    }
  }
  return out;
}
