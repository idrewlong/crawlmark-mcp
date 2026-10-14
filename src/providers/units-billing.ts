/**
 * Shared plumbing for the unit-billed providers (Ahrefs and Semrush, Phase 9):
 * secret redaction for anything shown or thrown, the cached + unit-capped call
 * wrapper, timeout detection and Retry-After parsing. No provider-specific logic.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Client } from "../config.js";
import { assertUnits, globalUnitCap, unitsThisMonth, type UnitProvider } from "../lib/budget.js";
import { cached, cacheKey } from "../lib/cache.js";
import { spendKeys } from "../lib/spend.js";
import { stripControl } from "../lib/terminal-text.js";

/**
 * Untrusted vendor text made safe to show or throw: every secret (and any `key=...`
 * query parameter, since Semrush keys travel in the URL) replaced, control characters
 * stripped, whitespace collapsed and the length capped.
 */
export function redact(text: string, secrets: readonly (string | undefined)[], max = 300): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("<redacted>");
  out = out.replace(/([?&;](?:api)?key=)[^&\s"'<>]*/gi, "$1<redacted>");
  out = stripControl(out).replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

/** A fetch that gave up (our timeout) or was aborted: the provider may still have run, and billed, the call. */
export function isTimeoutOrAbort(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** Milliseconds to wait from a Retry-After header (seconds or an HTTP date), else `fallbackMs`; capped at 60 s. */
export function retryAfterMs(header: string | null, fallbackMs = 2_000, now = Date.now()): number {
  if (header) {
    const secs = Number(header.trim());
    if (Number.isFinite(secs) && secs >= 0) return Math.min(60_000, secs * 1000);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.min(60_000, Math.max(0, at - now));
  }
  return fallbackMs;
}

/** Today's date in UTC, `YYYY-MM-DD` (Ahrefs `date`; left out of cache keys, D5). */
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

interface Reservation {
  provider: UnitProvider;
  keys: string[];
  units: number;
  /** A per-call reservation made inside a whole-run reservation for the same provider and client: the run's reservation already counts it. */
  covered?: boolean;
}

/**
 * Estimates of unit calls in progress in this process. assertUnits counts them, so calls started
 * together (Promise.all in reports) can't each pass a check the sum of them would fail. A
 * reservation is released when its call ends; while a call records units it is counted twice,
 * which can only make the check stricter.
 */
const inFlight = new Set<Reservation>();
/** The whole-run reservations (withUnitsReservation) the code running here is inside: never counted against itself (D16). */
const currentUnitReservation = new AsyncLocalStorage<ReadonlySet<Reservation>>();

/** Reserved units of calls in progress, other than the caller's own whole-run reservations and the calls they cover. */
export function pendingFor(provider: UnitProvider, keys: readonly string[]): { client: number; global: number } {
  const own = currentUnitReservation.getStore();
  let client = 0;
  let global = 0;
  for (const r of inFlight) {
    if (r.provider !== provider || r.covered || own?.has(r)) continue;
    global += r.units;
    if (r.keys.some((k) => keys.includes(k))) client += r.units;
  }
  return { client, global };
}

/** True when the code running here is inside a whole-run reservation for this provider that covers one of these ledger keys. */
function coveredByRun(provider: UnitProvider, keys: readonly string[]): boolean {
  for (const r of currentUnitReservation.getStore() ?? []) if (r.provider === provider && r.keys.some((k) => keys.includes(k))) return true;
  return false;
}

/**
 * Check a whole operation's unit estimate against the client's and the global monthly caps (counting other
 * operations in progress), then reserve it for as long as `fn` runs (D16, the units mirror of withUsdReservation).
 * Unit calls made inside `fn` still check their own estimate, but never count this reservation, and other
 * operations count this reservation instead of the calls inside it, so nothing is counted twice.
 * Per process: a cron run and the MCP server each hold their own reservations.
 */
export async function withUnitsReservation<T>(client: Pick<Client, "slug" | "aliases" | "domain" | "monthlyUnits">, provider: UnitProvider, units: number, fn: () => Promise<T>): Promise<T> {
  const keys = spendKeys(client);
  assertUnits(client, provider, units, pendingFor(provider, keys));
  const r: Reservation = { provider, keys, units };
  inFlight.add(r);
  try {
    return await currentUnitReservation.run(new Set([...(currentUnitReservation.getStore() ?? []), r]), fn);
  } finally {
    inFlight.delete(r);
  }
}

export interface UnitsCallResult<T> {
  value: T;
  /** Units recorded by this call; 0 when served from cache. */
  units: number;
  fromCache: boolean;
}

/**
 * A cached, unit-capped paid call. On a miss, `assertUnits` checks the whole
 * pre-flight `estimate` (for a batch: every request in it), plus the estimates of calls
 * still in progress, before anything is sent, and reserves it until the call ends;
 * `run` makes the requests, records each one's units in the ledger itself, and returns
 * the total. A hit records nothing and reports 0 units.
 */
export async function unitsCall<T>(o: {
  client: Pick<Client, "slug" | "aliases" | "domain" | "monthlyUnits">;
  provider: UnitProvider;
  capability: string;
  keyParts: Record<string, unknown>;
  ttl: number;
  estimate: number;
  refresh?: boolean | undefined;
  run: () => Promise<{ value: T; units: number }>;
}): Promise<UnitsCallResult<T>> {
  const key = cacheKey("seo", o.provider, o.capability, o.keyParts);
  const { value, fromCache } = await cached(
    key,
    o.ttl,
    async () => {
      const keys = spendKeys(o.client);
      assertUnits(o.client, o.provider, o.estimate, pendingFor(o.provider, keys));
      const reservation: Reservation = { provider: o.provider, keys, units: o.estimate, ...(coveredByRun(o.provider, keys) ? { covered: true } : {}) };
      inFlight.add(reservation);
      try {
        return await o.run();
      } finally {
        inFlight.delete(reservation);
      }
    },
    { refresh: o.refresh ?? false },
  );
  return { value: value.value, units: fromCache ? 0 : value.units, fromCache };
}

/**
 * Units left this month for a client (client.monthlyUnits) and for everyone (<PROVIDER>_MONTHLY_UNIT_CAP),
 * after what is recorded and what calls in progress have reserved; never below 0. Phase 12 B estimates.
 */
export function remainingUnits(client: Pick<Client, "slug" | "aliases" | "monthlyUnits">, provider: UnitProvider): { client: number; global: number } {
  const keys = spendKeys(client);
  const pending = pendingFor(provider, keys);
  return {
    client: Math.max(0, client.monthlyUnits[provider] - unitsThisMonth(keys, provider) - pending.client),
    global: Math.max(0, globalUnitCap(provider) - unitsThisMonth(undefined, provider) - pending.global),
  };
}
